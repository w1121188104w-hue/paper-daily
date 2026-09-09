import http from 'node:http';
import fs from 'node:fs/promises';
import { loadJournalConfig } from '../../src/services/journals.js';
import { loadJournalPresentation } from '../../src/services/journalPresentation.js';
import { journalUiFixture } from './journal-ui-fixture.js';

const assets = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/day.html', 'day.html'],
  ['/app.js', 'app.js'], ['/viewModel.js', 'viewModel.js'], ['/styles.css', 'styles.css'], ['/base.css', '../styles.css']]);

// An isolated read-only QA server: no production changes and no HTTP controls for mutating a scenario.
export async function createJournalUiQaServer() {
  const config = await loadJournalConfig(), fixture = journalUiFixture(config);
  let scenario = 'real';
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const port = request.socket.localPort;
    if (request.method !== 'GET' || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host) ||
      (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${port}`)) { response.writeHead(403).end(); return; }
    const pathname = request.url.split('?')[0];
    try {
      if (pathname === '/data.json') {
        if (scenario === 'failure') throw new Error('Synthetic read failure');
        const data = scenario === 'real' ? await loadJournalPresentation(config) : structuredClone(fixture);
        if (scenario === 'empty') { data.initialized = false; data.papers = []; data.runs = []; data.snapshot_at = null; data.pending = { paper_count: 0, field_count: 0 }; }
        if (scenario === 'unconfirmed') data.attempt_warning = { status: 'unconfirmed', started_at: new Date().toISOString() };
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data)); return;
      }
      const name = assets.get(pathname);
      if (!name) { response.writeHead(404).end(); return; }
      let content = await fs.readFile(new URL(`../../public/journals/${name}`, import.meta.url), 'utf8');
      if (name.endsWith('.html')) {
        content = content.replace(/(<main\b[^>]*>)/, '$1\n<section class="panel notice" aria-label="验收环境说明">隔离验收环境：除“真实空库”检查外，论文均为虚构测试材料，不进入正式论文库。</section>');
      }
      response.writeHead(200, { 'Content-Type': `${name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8` }).end(content);
    } catch { response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"error":"QA read failure"}'); }
  });
  return { server, fixture, setScenario(value) {
    if (!['real', 'fixture', 'empty', 'failure', 'unconfirmed'].includes(value)) throw new Error('Invalid QA scenario');
    scenario = value;
  } };
}
