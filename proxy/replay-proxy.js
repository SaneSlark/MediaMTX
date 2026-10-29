#!/usr/bin/env node

const express = require('express');
const fs = require('fs-extra');
const fileSystem = require('fs/promises');
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
  MEMORY_DIR: process.env.MEMORY_DIR || '/dev/shm',
  MAX_MEMORY_JOBS: Number(process.env.MAX_MEMORY_JOBS || 2),
  CACHE_KEEP_FOREVER: readBoolean('CACHE_KEEP_FOREVER', true),
  CACHE_TTL_MS: readDurationMs('CACHE_TTL_MS', 'CACHE_TTL_DAYS', 90),
  CLEAN_INTERVAL_MS: readDurationMs('CLEAN_INTERVAL_MS', 'CLEAN_INT_DAYS', 1),
  FFMPEG_TIMEOUT_MS: Number(process.env.FFMPEG_TIMEOUT_MS || 60000),
  DOWNLOAD_TIMEOUT_MS: Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000),
  MAX_DURATION: Number(process.env.MAX_DURATION || 3600),
};

const upstream = new URL(CONFIG.MEDIAMTX_BASE);
if (!['http:', 'https:'].includes(upstream.protocol) || upstream.search || upstream.hash) {
  throw new Error('MEDIAMTX_BASE must be an HTTP(S) base URL without a query or fragment');
}

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
if (!Number.isInteger(CONFIG.MAX_MEMORY_JOBS) || CONFIG.MAX_MEMORY_JOBS < 1) {
  throw new Error('MAX_MEMORY_JOBS must be a positive integer');
}

fs.ensureDirSync(CONFIG.CACHE_DIR);
fs.ensureDirSync(CONFIG.MEMORY_DIR);

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
    }, Object.create(null));

  const hash = crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex');
  return path.join(CONFIG.CACHE_DIR, camera, date, `${hash}.mp4`);
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
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(query.start);
  if (!timestamp) {
    throw new Error('start must be an RFC3339 timestamp with a timezone');
  }
  const [year, month, day, hour, minute, second] = timestamp.slice(1).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59) {
    throw new Error('Invalid start time');
  }
  extractDate(query.start);

  const duration = Number(query.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > CONFIG.MAX_DURATION) {
    throw new Error(`duration must be positive and not exceed ${CONFIG.MAX_DURATION} seconds`);
  }
  // The upstream is always requested as MP4; avoid separate cache entries for format.
  const { format, ...params } = query;
  return params;
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
async function runFFmpeg(input, outputFile, timeoutMs) {
  const streaming = typeof input !== 'string';
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts',
    '-analyzeduration',
    '10000000',
    '-probesize',
    '10000000',
    '-i',
    streaming ? 'pipe:0' : input,
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

  const proc = spawn('ffmpeg', args, { stdio: [streaming ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let timedOut = false;
  const killOnTimeout = () => {
    timedOut = true;
    proc.kill('SIGKILL');
  };
  // While stdin is active, downloadFile owns the download timeout. Once the
  // response ends, bound FFmpeg finishing even if its stdin is backpressured.
  let timer = streaming ? null : setTimeout(killOnTimeout, timeoutMs);
  const inputEnded = () => {
    clearTimeout(timer);
    timer = setTimeout(killOnTimeout, timeoutMs);
  };
  if (streaming) input.once('end', inputEnded);

  proc.stderr.on('data', (data) => {
    stderr = (stderr + data.toString()).slice(-65536);
  });

  const exited = new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (timedOut) reject(new Error('FFmpeg timeout'));
      else if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
  const supplied = streaming
    ? pipeline(input, proc.stdin)
    : Promise.resolve();
  try {
    await Promise.all([exited, supplied]);
  } catch (error) {
    // Stop both sides, then wait for all handles to close before removing
    // staging output. This also handles an upstream disconnect or EPIPE.
    if (streaming) input.destroy();
    proc.kill('SIGKILL');
    await Promise.allSettled([exited, supplied]);
    throw error;
  } finally {
    if (streaming) input.removeListener('end', inputEnded);
    clearTimeout(timer);
  }
}

/* ================== Range 播放 ================== */

// 支持 HTTP Range 请求，让浏览器可以拖动播放进度。
async function serveRange(file, req, res, totalSize) {
  const range = req.headers.range;
  const baseHeaders = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
    'Content-Disposition': 'inline',
  };

  if (!range || req.method === 'HEAD') {
    res.set({ ...baseHeaders, 'Content-Length': totalSize });
    if (req.method === 'HEAD') return res.end();
    return sendFileStream(file, res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  // 不支持多区间或无法识别的 Range 时，忽略该头并返回完整文件。
  if (!match || (!match[1] && !match[2])) {
    res.set({ ...baseHeaders, 'Content-Length': totalSize });
    return sendFileStream(file, res);
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, totalSize - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= totalSize || start > end) {
    return res.status(416).set({ ...baseHeaders, 'Content-Range': `bytes */${totalSize}` }).end();
  }

  res.status(206).set({
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    'Content-Length': end - start + 1,
  });

  return sendFileStream(file, res, { start, end });
}

async function sendFileStream(file, res, options) {
  try {
    await pipeline(file.createReadStream({ ...options, autoClose: false }), res);
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
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await cleanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.mp4') && !entry.name.endsWith('.partial.mp4')) {
        if (generating.has(fullPath)) continue;
        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (stat.mtimeMs < expiresBefore && !generating.has(fullPath)) {
          try {
            await fs.unlink(fullPath);
            cleaned += 1;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
    }

    if (!isRoot && ![...generating].some((file) => file.startsWith(currentDir + path.sep))) {
      // rmdir only removes empty directories; concurrent generation may add a file.
      await fs.rmdir(currentDir).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      });
    }
  }

  await cleanDirectory(dir, true);
  console.log(`[SYSTEM] cache cleanup complete, deleted ${cleaned} files`);
}

// Stream fragmented MP4 from playback straight into FFmpeg. Downloading and
// audio conversion overlap, without a second full-size raw temporary file.
async function downloadFile(sourceUrl, outputFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await new Promise((resolve, reject) => {
      const client = sourceUrl.startsWith('https:') ? https : http;
      const request = client.get(sourceUrl, { signal: controller.signal }, resolve);
      request.on('error', reject);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`MediaMTX returned ${response.statusCode}`);
    }
    response.once('end', () => clearTimeout(timer));
    await runFFmpeg(response, outputFile, CONFIG.FFMPEG_TIMEOUT_MS);
  } finally {
    clearTimeout(timer);
  }
}

const generating = new Set();
const memoryFiles = new Map();
const memoryJobs = new Set();

async function releaseMemory(entry) {
  if (!entry.finished || entry.readers !== 0 || entry.removing) return;
  entry.removing = true;
  try {
    await fs.unlink(entry.filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    memoryJobs.delete(entry);
  } catch (error) {
    entry.removing = false;
    console.error('[MEMORY] cleanup failed:', error.message);
  }
}

function persistInBackground(entry) {
  if (entry.persistence) return;
  const stagingFile = `${entry.cacheFile}.${crypto.randomBytes(16).toString('hex')}.partial.mp4`;
  entry.persistence = (async () => {
    try {
      await fs.ensureDir(path.dirname(entry.cacheFile));
      await fs.copyFile(entry.filePath, stagingFile);
      // Publish only a complete copy; Range readers never see a partial file.
      await fs.rename(stagingFile, entry.cacheFile);
      console.log(`[CACHE] persisted ${entry.cacheFile}`);
    } catch (error) {
      // Persistence failure must not interrupt a successful memory response.
      console.error('[CACHE] background persistence failed:', error.message);
    } finally {
      await fs.unlink(stagingFile).catch(() => {});
      if (memoryFiles.get(entry.cacheFile) === entry) memoryFiles.delete(entry.cacheFile);
      entry.finished = true;
      await releaseMemory(entry);
    }
  })();
}

async function serveMemory(entry, req, res) {
  // Acquire synchronously before opening: background persistence cannot delete
  // the file while this request is waiting for its descriptor.
  entry.readers++;
  let file;
  try {
    file = await fileSystem.open(entry.filePath, 'r');
    const stat = await file.stat();
    const response = serveRange(file, req, res, stat.size);
    persistInBackground(entry);
    return await response;
  } finally {
    try {
      if (file) await file.close();
    } finally {
      // Also persist when the initiating client disconnects before playback.
      persistInBackground(entry);
      entry.readers--;
      await releaseMemory(entry);
    }
  }
}

async function getCachedFile(cacheFile) {
  let stat;
  try {
    stat = await fs.stat(cacheFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const fresh = CONFIG.CACHE_KEEP_FOREVER || Date.now() - stat.mtimeMs < CONFIG.CACHE_TTL_MS;
  if (fresh && stat.isFile() && stat.size > 0) return stat;

  await fs.unlink(cacheFile).catch(() => {});
  return null;
}

async function generateVideo(query, cacheFile) {
  if (memoryJobs.size >= CONFIG.MAX_MEMORY_JOBS) {
    const error = new Error('Memory generation slots are busy');
    error.code = 'MEMORY_BUSY';
    throw error;
  }
  const id = crypto.randomBytes(16).toString('hex');
  const entry = {
    cacheFile, filePath: path.join(CONFIG.MEMORY_DIR, `${id}.mp4`),
    readers: 0, finished: false, removing: false, persistence: null,
  };
  memoryJobs.add(entry);

  try {
    const params = new URLSearchParams({ ...query, format: 'fmp4' });
    const started = Date.now();
    await downloadFile(`${CONFIG.MEDIAMTX_BASE}/get?${params}`, entry.filePath);
    if ((await fs.stat(entry.filePath)).size === 0) throw new Error('FFmpeg produced an empty file');
    memoryFiles.set(cacheFile, entry);
    console.log(`[PERF] ${query.path} generated in memory in ${Date.now() - started}ms`);
    return entry;
  } catch (error) {
    entry.finished = true;
    await releaseMemory(entry);
    throw error;
  }
}

/* ================== 主接口 ================== */

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Retry-After',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/get', async (req, res) => {
  const clientIP = getClientIP(req);
  console.log(`${clientIP} request: ${req.url}`);

  try {
    let query;
    let cacheFile;
    try {
      query = parseQuery(req.query);
    } catch (error) {
      return res.status(400).send(error.message);
    }
    cacheFile = getCacheFile(query);
    const ready = memoryFiles.get(cacheFile);
    if (ready) return await serveMemory(ready, req, res);

    // Acquire before the first asynchronous cache operation so expired-cache
    // requests cannot delete or replace a file another request just generated.
    if (generating.has(cacheFile)) {
      return res.status(202).set('Retry-After', '1').send('Video is being generated');
    }

    generating.add(cacheFile);
    let file;
    let memory;
    try {
      if (!(await getCachedFile(cacheFile))) {
        memory = await generateVideo(query, cacheFile);
      } else {
        // Open once so a pathname replacement cannot affect this response.
        try {
          file = await fileSystem.open(cacheFile, 'r');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          memory = await generateVideo(query, cacheFile);
        }
      }
    } catch (error) {
      console.error(`${clientIP} video generation failed:`, error.message);
      if (error.code === 'MEMORY_BUSY') {
        return res.status(503).set('Retry-After', '1').send('Memory generation slots are busy; retry later');
      }
      return res.status(500).send('Video generation failed');
    } finally {
      generating.delete(cacheFile);
    }
    if (memory) return await serveMemory(memory, req, res);
    try {
      const stat = await file.stat();
      return await serveRange(file, req, res, stat.size);
    } finally {
      await file.close();
    }
  } catch (error) {
    console.error(`${clientIP} server error:`, error);
    if (!res.headersSent && !res.destroyed) return res.status(500).send('Internal server error');
    res.destroy();
  }
});

// 健康检查接口，方便 Docker/反向代理探活。
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

/* ================== 定时任务和启动 ================== */

if (require.main === module) {
  let cleaning = false;
  setInterval(async () => {
    if (cleaning) return;
    cleaning = true;
    try {
      await cleanCache();
    } catch (error) {
      console.error('[SYSTEM] cache cleanup failed:', error);
    } finally {
      cleaning = false;
    }
  }, CONFIG.CLEAN_INTERVAL_MS).unref();

  app.listen(CONFIG.PORT, () => {
    console.log('===========================================');
    console.log('MediaMTX Video Proxy Started');
    console.log(`Proxy: http://localhost:${CONFIG.PORT}`);
    console.log(`MediaMTX Playback: ${CONFIG.MEDIAMTX_BASE}`);
    console.log(`Cache Directory: ${CONFIG.CACHE_DIR}`);
    console.log(`Memory Directory: ${CONFIG.MEMORY_DIR}`);
    console.log('===========================================');
  });
}

module.exports = { app, cleanCache, CONFIG, runFFmpeg };
