#!/usr/bin/env node

const express = require('express');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();

const DAY_MS = 24 * 60 * 60 * 1000;

function readBoolean(envName, defaultValue = false) {
  const value = process.env[envName];
  if (value === undefined) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readDurationMs(msEnvName, daysEnvName, defaultDays) {
  if (process.env[msEnvName]) {
    return Number(process.env[msEnvName]);
  }
  const value = process.env[daysEnvName] === undefined ? defaultDays : process.env[daysEnvName];
  return Number(value) * DAY_MS;
}

/* ================== 基础配置 ================== */
const CONFIG = {
  PORT: Number(process.env.PORT || 9995),
  MEDIAMTX_BASE: process.env.MEDIAMTX_BASE || 'http://localhost:9996',
  CACHE_DIR: process.env.CACHE_DIR || path.join(__dirname, 'media_cache'),
  TEMP_DIR: process.env.TEMP_DIR || '/dev/shm',
  CACHE_KEEP_FOREVER: readBoolean('CACHE_KEEP_FOREVER'),
  CACHE_TTL_MS: readDurationMs('CACHE_TTL_MS', 'CACHE_TTL_DAYS', 90),
  CLEAN_INTERVAL_MS: readDurationMs('CLEAN_INTERVAL_MS', 'CLEAN_INTERVAL_DAYS', 1),
  FFMPEG_TIMEOUT_MS: Number(process.env.FFMPEG_TIMEOUT_MS || 60000),
  MAX_DURATION: Number(process.env.MAX_DURATION || 3600),
};

fs.ensureDirSync(CONFIG.CACHE_DIR);
fs.ensureDirSync(CONFIG.TEMP_DIR);

/* ================== 工具函数 ================== */

// 防止 path 参数注入，只允许摄像头名称使用字母、数字、下划线和短横线。
function validatePathParam(input) {
  return typeof input === 'string' && !input.includes('..') && /^[a-zA-Z0-9_-]+$/.test(input);
}

// 从 start 参数中提取 YYYY-MM-DD，用于按日期组织缓存目录。
function extractDate(start) {
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid start time');
  }
  return d.toISOString().slice(0, 10);
}

// 根据完整查询参数生成稳定的缓存文件路径。
function getCacheFile(query) {
  if (!validatePathParam(query.path)) {
    throw new Error('Invalid path parameter');
  }

  const camera = query.path;
  const date = extractDate(query.start);
  const sorted = Object.keys(query)
    .sort()
    .reduce((result, key) => {
      result[key] = query[key];
      return result;
    }, {});

  const hash = crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex');
  const dir = path.join(CONFIG.CACHE_DIR, camera, date);
  fs.ensureDirSync(dir);
  return path.join(dir, `${hash}.mp4`);
}

// 获取客户端 IP，兼容反向代理头和 IPv6 映射的 IPv4 地址。
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  let clientIP = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  clientIP = clientIP || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (clientIP.startsWith('::ffff:')) {
    clientIP = clientIP.slice(7);
  }
  return clientIP;
}

/* ================== FFmpeg 处理 ================== */

// 将 MediaMTX 回放片段整理为浏览器友好的 MP4，并兼容有无音频的输入。
function runFFmpeg(inputFile, outputFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '10000000',
      '-probesize',
      '10000000',
      '-i',
      inputFile,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-map',
      '0:a:0?',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      'faststart',
      outputFile,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('FFmpeg timeout'));
    }, timeoutMs);

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

/* ================== Range 播放 ================== */

// 支持 HTTP Range 请求，让浏览器可以拖动播放进度。
function serveRange(filePath, req, res, totalSize) {
  const range = req.headers.range;
  const baseHeaders = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
    'Content-Disposition': 'inline',
  };

  if (!range) {
    res.set({ ...baseHeaders, 'Content-Length': totalSize });
    return fs.createReadStream(filePath).pipe(res);
  }

  const [startText, endText] = range.replace(/bytes=/, '').split('-');
  const start = Number.parseInt(startText, 10);
  const end = endText ? Number.parseInt(endText, 10) : totalSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start >= totalSize || end >= totalSize || start > end) {
    return res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
  }

  res.status(206).set({
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    'Content-Length': end - start + 1,
  });

  return fs.createReadStream(filePath, { start, end }).pipe(res);
}

/* ================== 缓存清理 ================== */

// 递归清理超过 TTL 的缓存文件，同时移除空目录。
async function cleanCache(dir = CONFIG.CACHE_DIR) {
  if (CONFIG.CACHE_KEEP_FOREVER) {
    console.log('[SYSTEM] cache cleanup skipped, CACHE_KEEP_FOREVER is enabled');
    return;
  }

  const now = Date.now();
  const files = [];

  async function collect(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await collect(fullPath);
        const remain = await fs.readdir(fullPath);
        if (remain.length === 0) {
          await fs.rmdir(fullPath).catch(() => {});
        }
      } else {
        const stat = await fs.stat(fullPath);
        files.push({ fullPath, stat });
      }
    }
  }

  await collect(dir);

  let cleaned = 0;
  for (const { fullPath, stat } of files) {
    if (now - stat.mtimeMs > CONFIG.CACHE_TTL_MS) {
      await fs.unlink(fullPath).catch(() => {});
      cleaned += 1;
    }
  }

  console.log(`[SYSTEM] cache cleanup complete, deleted ${cleaned} files`);
}

// 从 MediaMTX playback 接口下载原始片段到临时文件。
function downloadFile(sourceUrl, targetFile) {
  return new Promise((resolve, reject) => {
    const client = sourceUrl.startsWith('https:') ? https : http;
    const request = client.get(sourceUrl, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`MediaMTX returned ${response.statusCode}`));
        return;
      }

      const writer = fs.createWriteStream(targetFile);
      response.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    request.on('error', reject);
    request.end();
  });
}

// 防止同一个视频片段被多个并发请求重复生成。
const generating = new Set();

/* ================== 主接口 ================== */

app.get('/get', async (req, res) => {
  const clientIP = getClientIP(req);
  console.log(`${clientIP} request: ${req.url}`);

  try {
    const query = req.query;
    if (!query.path || !query.start || !query.duration) {
      return res.status(400).send('Missing parameters: path, start, duration');
    }

    const duration = Number(query.duration);
    if (Number.isNaN(duration) || duration <= 0 || duration > CONFIG.MAX_DURATION) {
      return res.status(400).send(`duration must be positive and not exceed ${CONFIG.MAX_DURATION} seconds`);
    }

    let cacheFile;
    try {
      cacheFile = getCacheFile(query);
    } catch (error) {
      return res.status(400).send(error.message);
    }

    if (await fs.pathExists(cacheFile)) {
      const stat = await fs.stat(cacheFile);
      if (CONFIG.CACHE_KEEP_FOREVER || Date.now() - stat.mtimeMs < CONFIG.CACHE_TTL_MS) {
        return serveRange(cacheFile, req, res, stat.size);
      }
      await fs.unlink(cacheFile).catch(() => {});
    }

    if (generating.has(cacheFile)) {
      return res.status(202).send('Video is being generated');
    }

    generating.add(cacheFile);
    const tempFile = path.join(CONFIG.TEMP_DIR, `${crypto.randomBytes(16).toString('hex')}.tmp.mp4`);

    try {
      const enhancedQuery = { ...query, format: 'mp4' };
      const sourceUrl = `${CONFIG.MEDIAMTX_BASE}/get?${new URLSearchParams(enhancedQuery).toString()}`;

      await downloadFile(sourceUrl, tempFile);
      await runFFmpeg(tempFile, cacheFile, CONFIG.FFMPEG_TIMEOUT_MS);
      await fs.unlink(tempFile).catch(() => {});

      const stat = await fs.stat(cacheFile);
      return serveRange(cacheFile, req, res, stat.size);
    } catch (error) {
      await fs.unlink(tempFile).catch(() => {});
      await fs.unlink(cacheFile).catch(() => {});
      console.error(`${clientIP} video generation failed:`, error.message);
      return res.status(500).send('Video generation failed');
    } finally {
      generating.delete(cacheFile);
    }
  } catch (error) {
    console.error(`${clientIP} server error:`, error);
    return res.status(500).send('Internal server error');
  }
});

// 健康检查接口，方便 Docker/反向代理探活。
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

/* ================== 定时任务和启动 ================== */

setInterval(() => {
  cleanCache().catch((error) => console.error('[SYSTEM] cache cleanup failed:', error));
}, CONFIG.CLEAN_INTERVAL_MS);

app.listen(CONFIG.PORT, () => {
  console.log('===========================================');
  console.log('MediaMTX video proxy started');
  console.log(`Proxy: http://localhost:${CONFIG.PORT}`);
  console.log(`MediaMTX playback: ${CONFIG.MEDIAMTX_BASE}`);
  console.log(`Cache directory: ${CONFIG.CACHE_DIR}`);
  console.log('===========================================');
});
