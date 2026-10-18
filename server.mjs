import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, extname, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSystem, ApiError } from './lib/system.mjs';
import { reportCsv } from './lib/csv.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new ApiError('请求体不能超过 2 MiB', 413);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks).toString('utf8');
  if (!data.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(data); } catch { throw new ApiError('请求体必须是合法 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError('请求体必须是 JSON 对象');
  return parsed;
}

function within(root, path) {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

export function createApplication({ dbPath = join(ROOT, 'data', 'radar.sqlite'), publicDir = join(ROOT, 'public'), seed = true, durationScale = 1, system: providedSystem } = {}) {
  const system = providedSystem ?? new TestSystem({ dbPath, seed, durationScale });
  const clients = new Set();
  let broadcastTimer;
  const broadcast = () => {
    broadcastTimer = null;
    if (!clients.size) return;
    const packet = `data: ${JSON.stringify(system.state())}\n\n`;
    for (const client of clients) if (!client.destroyed && client.writableLength < 1024 * 1024) client.write(packet);
  };
  const onChange = () => { broadcastTimer ??= setTimeout(broadcast, 80); };
  system.on('change', onChange);
  const heartbeat = setInterval(() => {
    for (const client of clients) if (!client.destroyed && client.writableLength < 1024 * 1024) client.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);
  heartbeat.unref();

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(request.headers.host ?? '')) throw new ApiError('仅允许本机访问', 403);
      if (request.headers.origin) {
        let origin;
        try { origin = new URL(request.headers.origin); } catch { throw new ApiError('不允许的请求来源', 403); }
        if (origin.protocol !== 'http:' || origin.host !== request.headers.host) throw new ApiError('不允许跨来源操作本地测试系统', 403);
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError('URL 编码错误'); }
      const method = request.method;
      if (pathname === '/api/events' && method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(`retry: 1500\ndata: ${JSON.stringify(system.state())}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (pathname === '/api/health' && method === 'GET') return json(response, 200, { ok: true, service: 'radar-matrix-test-system', version: '1.0.0', mode: 'simulation', storage: 'sqlite', evaluation: 'threshold' });
      if (pathname === '/api/state' && method === 'GET') return json(response, 200, system.state());
      if (pathname === '/api/tasks' && method === 'GET') return json(response, 200, system.state().tasks);
      if (pathname === '/api/tasks' && method === 'POST') return json(response, 201, system.createTask(await body(request)));
      if (pathname === '/api/results' && method === 'GET') return json(response, 200, system.state().history);
      let match = /^\/api\/(?:tasks|results)\/([^/]+)$/.exec(pathname);
      if (match && method === 'GET') return json(response, 200, system.publicTask(system.findTask(match[1])));
      match = /^\/api\/tasks\/([^/]+)\/action$/.exec(pathname);
      if (match && method === 'POST') return json(response, 200, system.actOnTask(match[1], (await body(request)).action));
      match = /^\/api\/tasks\/([^/]+)\/report\.csv$/.exec(pathname);
      if (match && method === 'GET') {
        const task = system.findTask(match[1]);
        const filename = `${task.name.replace(/[\\/:*?"<>|]/g, '_')}-测试报告.csv`;
        response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="radar-report.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
        return response.end(reportCsv(task));
      }
      if (pathname === '/api/settings' && method === 'GET') return json(response, 200, system.state().settings);
      if (pathname === '/api/settings' && method === 'POST') return json(response, 200, system.updateSettings(await body(request)));
      if (pathname === '/api/thresholds' && method === 'GET') return json(response, 200, system.state().settings.thresholds);
      if (pathname === '/api/thresholds' && method === 'POST') return json(response, 200, system.updateSettings({ thresholds: await body(request) }).thresholds);
      match = /^\/api\/devices\/([^/]+)\/config$/.exec(pathname);
      if (match && method === 'POST') return json(response, 200, system.configureDevice(match[1], await body(request)));
      match = /^\/api\/devices\/([^/]+)\/connect$/.exec(pathname);
      if (match && method === 'POST') { const input = await body(request); return json(response, 200, system.connectDevice(match[1], input.connected ?? true)); }
      if (['/api/import', '/api/evaluate/import'].includes(pathname) && method === 'POST') return json(response, 201, system.importCsv(await body(request)));
      if ((pathname === '/api/history' && method === 'DELETE') || (pathname === '/api/history/clear' && method === 'POST')) return json(response, 200, system.clearHistory());
      if ((pathname === '/api/logs' && method === 'DELETE') || (pathname === '/api/logs/clear' && method === 'POST')) return json(response, 200, system.clearLogs());
      if (pathname.startsWith('/api/')) throw new ApiError('API 不存在或请求方法不支持', 404);
      if (method !== 'GET' && method !== 'HEAD') throw new ApiError('静态文件只支持 GET / HEAD', 405);
      const filePath = resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!within(resolve(publicDir), filePath)) throw new ApiError('禁止访问该路径', 403);
      let canonical, rootCanonical, fileStats;
      try { [canonical, rootCanonical, fileStats] = await Promise.all([realpath(filePath), realpath(publicDir), stat(filePath)]); }
      catch { throw new ApiError('页面不存在', 404); }
      if (!within(rootCanonical, canonical) || !fileStats.isFile()) throw new ApiError('页面不存在', 404);
      const content = method === 'HEAD' ? null : await readFile(canonical);
      response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(canonical).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': fileStats.size });
      response.end(content);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (!(error instanceof ApiError)) console.error('[server]', error);
      json(response, error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : '服务器内部错误，请查看终端日志' });
    }
  });

  async function close() {
    system.off('change', onChange);
    clearTimeout(broadcastTimer); clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    await system.close();
  }
  return { server, system, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT 必须为 1–65535 的整数'); process.exit(1); }
  const dbPath = process.env.RADAR_DATA_DIR ? join(resolve(process.env.RADAR_DATA_DIR), 'radar.sqlite') : join(ROOT, 'data', 'radar.sqlite');
  const app = createApplication({ dbPath });
  app.server.listen(port, '127.0.0.1', () => console.log(`雷达 T/R 智能矩阵测试系统已启动：http://127.0.0.1:${port}\n当前为模拟采集模式，结果使用配置阈值判定；数据保存至 ${dbPath}`));
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭已有实例或使用其他 PORT` : error.message); void app.close().finally(() => { process.exitCode = 1; }); });
  let shuttingDown = false;
  const shutdown = () => { if (shuttingDown) return; shuttingDown = true; void app.close().then(() => { process.exitCode = 0; }); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
