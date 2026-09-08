#!/usr/bin/env node

const express = require('express');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

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
  MEDIAMTX_BASE: (process.env.MEDIAMTX_BASE || 'http://localhost:9996').replace(/\/$/, ''),
  CACHE_DIR: process.env.CACHE_DIR || path.join(__dirname, 'media_cache'),
  TEMP_DIR: process.env.TEMP_DIR || '/dev/shm',
  CACHE_KEEP_FOREVER: readBoolean('CACHE_KEEP_FOREVER'),
  CACHE_TTL_MS: readDurationMs('CACHE_TTL_MS', 'CACHE_TTL_DAYS', 90),
  CLEAN_INTERVAL_MS: readDurationMs('CLEAN_INTERVAL_MS', 'CLEAN_INT_DAYS', 1),
  FFMPEG_TIMEOUT_MS: Number(process.env.FFMPEG_TIMEOUT_MS || 60000),
  DOWNLOAD_TIMEOUT_MS: Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000),
  MAX_DURATION: Number(process.env.MAX_DURATION || 3600),
};

for (const key of ['CACHE_TTL_MS', 'CLEAN_INTERVAL_MS', 'FFMPEG_TIMEOUT_MS', 'DOWNLOAD_TIMEOUT_MS', 'MAX_DURATION']) {
  if (!Number.isFinite(CONFIG[key]) || CONFIG[key] <= 0) {
    throw new Error(`${key} must be a positive finite number`);
  }
}
for (const key of ['CLEAN_INTERVAL_MS', 'FFMPEG_TIMEOUT_MS', 'DOWNLOAD_TIMEOUT_MS']) {
  if (CONFIG[key] > 2147483647) throw new Error(`${key} exceeds the Node.js timer limit`);
}
if (!Number.isInteger(CONFIG.PORT) || CONFIG.PORT < 1 || CONFIG.PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

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

function parseQuery(query) {
  if (Object.values(query).some((value) => typeof value !== 'string')) {
    throw new Error('Query parameters must be single string values');
  }
  if (!query.path || !query.start || !query.duration) {
    throw new Error('Missing parameters: path, start, duration');
  }
  if (!validatePathParam(query.path)) {
    throw new Error('Invalid path parameter');
  }
  extractDate(query.start);

  const duration = Number(query.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > CONFIG.MAX_DURATION) {
    throw new Error(`duration must be positive and not exceed ${CONFIG.MAX_DURATION} seconds`);
  }
  return query;
}

// 获取客户端 IP，兼容反向代理头和 IPv6 映射的 IPv4 地址。
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  let clientIP = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  clientIP = clientIP || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  clientIP = clientIP.split(',')[0].trim();
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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-65536);
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('FFmpeg timeout'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

/* ================== Range 播放 ================== */

// 支持 HTTP Range 请求，让浏览器可以拖动播放进度。
async function serveRange(filePath, req, res, totalSize) {
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
    return sendFileStream(filePath, res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  // 不支持多区间或无法识别的 Range 时，忽略该头并返回完整文件。
  if (!match || (!match[1] && !match[2])) {
    res.set({ ...baseHeaders, 'Content-Length': totalSize });
    return sendFileStream(filePath, res);
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, totalSize - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= totalSize || start > end) {
    return res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
  }

  res.status(206).set({
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    'Content-Length': end - start + 1,
  });

  return sendFileStream(filePath, res, { start, end });
}

async function sendFileStream(filePath, res, options) {
  try {
    await pipeline(fs.createReadStream(filePath, options), res);
  } catch (error) {
    // pipeline 同时关闭文件和响应，客户端断开或文件读取失败不会成为未处理异常。
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('File streaming failed:', error.message);
  }
}

/* ================== 缓存清理 ================== */

// 递归清理超过 TTL 的缓存文件，同时移除空目录。
async function cleanCache(dir = CONFIG.CACHE_DIR) {
  if (CONFIG.CACHE_KEEP_FOREVER) {
    console.log('[SYSTEM] cache cleanup skipped, CACHE_KEEP_FOREVER is enabled');
    return;
  }

  const expiresBefore = Date.now() - CONFIG.CACHE_TTL_MS;
  let cleaned = 0;

  async function cleanDirectory(currentDir, isRoot = false) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await cleanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.mp4') && !entry.name.endsWith('.partial.mp4')) {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs < expiresBefore) {
          try {
            await fs.unlink(fullPath);
            cleaned += 1;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
    }

    if (!isRoot && (await fs.readdir(currentDir)).length === 0) {
      await fs.rmdir(currentDir).catch(() => {});
    }
  }

  await cleanDirectory(dir, true);
  console.log(`[SYSTEM] cache cleanup complete, deleted ${cleaned} files`);
}

// 从 MediaMTX playback 接口下载原始片段到临时文件。
async function downloadFile(sourceUrl, targetFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.DOWNLOAD_TIMEOUT_MS);
  try {
    await new Promise((resolve, reject) => {
      const client = sourceUrl.startsWith('https:') ? https : http;
      const request = client.get(sourceUrl, { signal: controller.signal }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`MediaMTX returned ${response.statusCode}`));
          return;
        }
        pipeline(response, fs.createWriteStream(targetFile), { signal: controller.signal }).then(resolve, reject);
      });
      request.on('error', reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

const generating = new Set();

async function getCachedFile(cacheFile) {
  if (!(await fs.pathExists(cacheFile))) return null;

  let stat;
  try {
    stat = await fs.stat(cacheFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const fresh = CONFIG.CACHE_KEEP_FOREVER || Date.now() - stat.mtimeMs < CONFIG.CACHE_TTL_MS;
  if (fresh) return stat;

  await fs.unlink(cacheFile).catch(() => {});
  return null;
}

async function generateVideo(query, cacheFile) {
  const id = crypto.randomBytes(16).toString('hex');
  const tempFile = path.join(CONFIG.TEMP_DIR, `${id}.tmp.mp4`);
  const stagingFile = `${cacheFile}.${id}.partial.mp4`;

  try {
    await fs.ensureDir(path.dirname(cacheFile));
    const params = new URLSearchParams({ ...query, format: 'mp4' });
    await downloadFile(`${CONFIG.MEDIAMTX_BASE}/get?${params}`, tempFile);
    await runFFmpeg(tempFile, stagingFile, CONFIG.FFMPEG_TIMEOUT_MS);
    await fs.rename(stagingFile, cacheFile);
    return await fs.stat(cacheFile);
  } finally {
    await Promise.all([
      fs.unlink(tempFile).catch(() => {}),
      fs.unlink(stagingFile).catch(() => {}),
    ]);
  }
}

/* ================== 主接口 ================== */

app.get('/get', async (req, res) => {
  const clientIP = getClientIP(req);
  console.log(`${clientIP} request: ${req.url}`);

  try {
    let query;
    let cacheFile;
    try {
      query = parseQuery(req.query);
      cacheFile = getCacheFile(query);
    } catch (error) {
      return res.status(400).send(error.message);
    }

    const cached = await getCachedFile(cacheFile);
    if (cached) return serveRange(cacheFile, req, res, cached.size);

    if (generating.has(cacheFile)) {
      return res.status(202).send('Video is being generated');
    }

    generating.add(cacheFile);
    try {
      const stat = await generateVideo(query, cacheFile);
      return serveRange(cacheFile, req, res, stat.size);
    } catch (error) {
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
