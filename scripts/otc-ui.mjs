// Local web UI for INBREAZ OTC. Serves ./otc on 127.0.0.1 and hands the SC-Bridge address + token
// to same-origin pages only. Usage: node scripts/otc-ui.mjs <bridge-token> [bridge-port] [ui-port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../otc/', import.meta.url));
const [token, bridgePort = '49222', uiPort = '8787'] = process.argv.slice(2);
if (!token) { console.error('usage: node scripts/otc-ui.mjs <bridge-token> [bridge-port] [ui-port]'); process.exit(1); }
const channel = JSON.parse(fs.readFileSync(path.join(root, 'channel.json'), 'utf8'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const hosts = new Set([`127.0.0.1:${uiPort}`, `localhost:${uiPort}`]);

http.createServer((req, res) => {
  // Reject foreign Host headers (DNS rebinding) so other sites cannot read the bridge token.
  if (!hosts.has(req.headers.host)) { res.writeHead(403).end(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ bridge: `ws://127.0.0.1:${bridgePort}`, token, channel: channel.channel, owner: channel.owner }));
    return;
  }
  const file = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(Number(uiPort), '127.0.0.1', () => console.log(`INBREAZ OTC UI: http://127.0.0.1:${uiPort}`));
