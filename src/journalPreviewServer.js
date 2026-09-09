import http from 'node:http';
import fs from 'node:fs/promises';
import { loadJournalPresentation } from './services/journalPresentation.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/day.html', ['day.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/viewModel.js', ['viewModel.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']],
  ['/base.css', ['../styles.css', 'text/css']]
]);
const safeError = { error: '论文库暂时无法通过校验。请保留现有文件，检查本地论文库；这不代表没有论文。' };

/** A loopback, read-only preview. No old server imports, directory serving, writes, secrets, or remote requests. */
export function createJournalPreviewServer({ config, root, loadData = () => loadJournalPresentation(config, { root }) }) {
  return http.createServer(async (request, response) => {
    const port = request.socket.localPort;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, body, type = 'text/plain') => {
      response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host) ||
        (request.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin))) {
      send(403, '仅允许本机同源访问'); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD'); send(405, '此预览只读，不支持修改数据'); return;
    }
    // Match the raw pathname, not a normalized filesystem path; no traversal or directory fallback.
    const pathname = request.url.split('?')[0];
    try {
      if (pathname === '/data.json') {
        send(200, JSON.stringify(await loadData()), 'application/json'); return;
      }
      const asset = assets.get(pathname);
      if (!asset) { send(404, '页面不存在'); return; }
      send(200, await fs.readFile(new URL(`../public/journals/${asset[0]}`, import.meta.url)), asset[1]);
    } catch { send(503, JSON.stringify(safeError), 'application/json'); }
  });
}
