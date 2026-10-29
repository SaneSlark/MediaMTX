const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

let root, upstream, server, base, api, upstreamHandler;
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const realMedia = { skip: !ffmpegAvailable && !process.env.REQUIRE_FFMPEG_TESTS };
let nextCamera = 0;

function query() {
  return { path: `camera${++nextCamera}`, start: '2026-10-29T10:00:00Z', duration: '1' };
}

function cachePath(params) {
  const sorted = Object.fromEntries(Object.keys(params).sort().map(key => [key, params[key]]));
  const hash = crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex');
  return path.join(root, 'cache', params.path, '2026-10-29', `${hash}.mp4`);
}

async function seed(params, content = '0123456789', expired = false) {
  const file = cachePath(params);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (expired) await fs.utimes(file, new Date(0), new Date(0));
  return file;
}

function get(params, options) {
  return fetch(`${base}/get?${new URLSearchParams(params)}`, options);
}

async function listen(instance) {
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${instance.address().port}`;
}

async function close(instance) {
  instance.closeAllConnections();
  await new Promise(resolve => instance.close(resolve));
}

async function noTemporaryFiles() {
  assert.deepEqual(await fs.readdir(path.join(root, 'temp')), []);
  const files = await fs.readdir(path.join(root, 'cache'), { recursive: true });
  assert(!files.some(file => file.endsWith('.partial.mp4')));
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-tests-'));
  upstream = http.createServer((req, res) => upstreamHandler(req, res));
  const upstreamBase = await listen(upstream);
  Object.assign(process.env, {
    CACHE_DIR: path.join(root, 'cache'), TEMP_DIR: path.join(root, 'temp'),
    MEDIAMTX_BASE: upstreamBase, CACHE_TTL_MS: '60000', DOWNLOAD_TIMEOUT_MS: '300',
    FFMPEG_TIMEOUT_MS: '10000', CACHE_KEEP_FOREVER: 'false',
  });
  api = require('../replay-proxy');
  server = http.createServer(api.app);
  base = await listen(server);
});

after(async () => {
  if (server) await close(server);
  if (upstream) await close(upstream);
  if (root) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('replay-tests-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('health, CORS preflight and error responses are accessible to browsers', async () => {
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'OK');
  const preflight = await fetch(base + '/get', { method: 'OPTIONS', headers: {
    Origin: 'https://player.example', 'Access-Control-Request-Headers': 'range',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Range');
  const bad = await get({});
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('access-control-allow-origin'), '*');
});

test('reject invalid, repeated and ambiguous query values without creating cache folders', async () => {
  const before = await fs.readdir(api.CONFIG.CACHE_DIR);
  for (const patch of [
    { path: '../camera' }, { path: 'camera/a' }, { start: 'invalid' }, { start: '1' },
    { start: '2026-02-30T10:00:00Z' }, { start: '2026-10-29T24:00:00Z' },
    { duration: '0' }, { duration: '-1' }, { duration: '3601' }, { duration: 'Infinity' },
  ]) {
    assert.equal((await get({ ...query(), ...patch })).status, 400);
  }
  const params = new URLSearchParams(query());
  params.append('duration', '2');
  assert.equal((await fetch(base + '/get?' + params)).status, 400);
  assert.deepEqual(await fs.readdir(api.CONFIG.CACHE_DIR), before);
});

test('cached MP4 supports full, closed, open and suffix ranges, HEAD and invalid ranges', async () => {
  const params = query();
  await seed(params);
  const full = await get(params);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789');
  for (const [range, status, expected, contentRange] of [
    ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=7-', 206, '789', 'bytes 7-9/10'],
    ['bytes=-3', 206, '789', 'bytes 7-9/10'],
    ['bytes=-100', 206, '0123456789', 'bytes 0-9/10'],
    ['bytes=0-100', 206, '0123456789', 'bytes 0-9/10'],
    ['bytes=10-', 416, '', 'bytes */10'],
    ['bytes=4-2', 416, '', 'bytes */10'],
    ['bytes=-0', 416, '', 'bytes */10'],
    ['bytes=0-1,4-5', 200, '0123456789', null],
    ['garbage', 200, '0123456789', null],
  ]) {
    const result = await get(params, { headers: { Range: range } });
    assert.equal(result.status, status, range);
    assert.equal(result.headers.get('content-range'), contentRange, range);
    assert.equal(await result.text(), expected, range);
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
  }
  const head = await get(params, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  const forcedFormat = await get({ ...params, format: 'fmp4' });
  assert.equal(forcedFormat.status, 200);
  assert.equal(await forcedFormat.text(), '0123456789');
});

test('expired-cache concurrent requests share one generation; failures unlock retries', async () => {
  const params = query();
  await seed(params, 'expired', true);
  let requests = 0, fail, received;
  const started = new Promise(resolve => { received = resolve; });
  upstreamHandler = (req, res) => {
    requests++;
    fail = () => res.writeHead(503).end();
    received();
  };
  const first = get(params);
  await started;
  const others = await Promise.all(Array.from({ length: 12 }, () => get(params)));
  for (const response of others) {
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('retry-after'), '1');
    await response.text();
  }
  fail();
  assert.equal((await first).status, 500);
  assert.equal(requests, 1);
  upstreamHandler = (req, res) => { requests++; res.writeHead(404).end(); };
  assert.equal((await get(params)).status, 500);
  assert.equal(requests, 2);
  await noTemporaryFiles();
});

test('stalled and truncated upstream downloads fail and remove temporary files', async () => {
  upstreamHandler = () => {};
  assert.equal((await get(query())).status, 500);
  await noTemporaryFiles();
  upstreamHandler = (req, res) => {
    res.writeHead(200, { 'Content-Length': '100' });
    res.write('short');
    setTimeout(() => res.destroy(), 10);
  };
  assert.equal((await get(query())).status, 500);
  await noTemporaryFiles();
});

test('cleanup expires completed MP4 only and honors permanent retention', async () => {
  const stale = await seed(query(), 'old', true);
  const fresh = await seed(query());
  const partial = stale + '.id.partial.mp4';
  await fs.writeFile(partial, 'partial');
  await fs.utimes(partial, new Date(0), new Date(0));
  api.CONFIG.CACHE_KEEP_FOREVER = true;
  try { await api.cleanCache(); assert.equal(await fs.readFile(stale, 'utf8'), 'old'); }
  finally { api.CONFIG.CACHE_KEEP_FOREVER = false; }
  await api.cleanCache();
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  assert.equal((await fs.stat(fresh)).size, 10);
  assert.equal((await fs.stat(partial)).size, 7);
  await fs.unlink(partial);
});

for (const audio of [false, true]) {
  test(`real FFmpeg generates playable MP4 ${audio ? 'with' : 'without'} audio and reuses cache`, realMedia, async () => {
    assert(ffmpegAvailable, 'FFmpeg is required in CI');
    const fixture = path.join(root, `fixture-${audio}.mp4`);
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10'];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440');
    args.push('-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p');
    if (audio) args.push('-c:a', 'aac');
    args.push(fixture);
    const fixtureResult = spawnSync('ffmpeg', args, { windowsHide: true, timeout: 30000 });
    assert.equal(fixtureResult.status, 0, fixtureResult.stderr?.toString());
    const media = await fs.readFile(fixture);
    let calls = 0;
    upstreamHandler = (req, res) => {
      calls++;
      assert.equal(new URL(req.url, 'http://localhost').searchParams.get('format'), 'mp4');
      res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(media);
    };
    const params = query();
    // A zero-byte cache is invalid and must be regenerated.
    await seed(params, '');
    const result = await get(params);
    assert.equal(result.status, 200);
    const body = Buffer.from(await result.arrayBuffer());
    const output = path.join(root, `output-${audio}.mp4`);
    await fs.writeFile(output, body);
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 30000, windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr?.toString());
    assert(body.indexOf(Buffer.from('moov')) < body.indexOf(Buffer.from('mdat')), 'faststart metadata must precede media');
    const cached = await get(params);
    assert.equal(cached.status, 200);
    assert.deepEqual(Buffer.from(await cached.arrayBuffer()), body);
    assert.equal(calls, 1);
    await noTemporaryFiles();
  });
}

test('invalid media and FFmpeg timeout do not leave failed cache entries', realMedia, async () => {
  assert(ffmpegAvailable, 'FFmpeg is required in CI');
  upstreamHandler = (req, res) => res.end('not a video');
  const params = query();
  assert.equal((await get(params)).status, 500);
  await assert.rejects(fs.stat(cachePath(params)), { code: 'ENOENT' });
  await noTemporaryFiles();
  await assert.rejects(api.runFFmpeg(path.join(root, 'fixture-false.mp4'), path.join(root, 'timeout.mp4'), 1), /timeout/);
});
