// One-time setup for the board owner: asks the running owner peer (started with --sc-bridge-cli 1)
// to sign a welcome for the board channel and writes otc/channel.json for all joiners.
// Usage: node scripts/otc-welcome.mjs <bridge-token> [port]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const token = process.argv[2];
const port = process.argv[3] || '49222';
const CHANNEL = 'inbreaz-otc';
if (!token) {
  console.error('usage: node scripts/otc-welcome.mjs <bridge-token> [port]');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let peer = null;
const send = (o) => ws.send(JSON.stringify(o));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'hello') { peer = m.peer; send({ type: 'auth', token }); }
  else if (m.type === 'auth_ok') send({ id: 1, type: 'cli', command: `/sc_welcome --channel "${CHANNEL}" --text "INBREAZ OTC board v1. Non-custodial: settle with TAP hashlock locks only. Never send first."` });
  else if (m.type === 'cli_result') {
    const text = (m.output || []).join('\n');
    const b64 = (text.match(/welcome_b64[^A-Za-z0-9+/=]*([A-Za-z0-9+/=]{40,})/) || [])[1];
    if (!m.ok || !b64) { console.error('could not create welcome:', m.error || text); process.exit(1); }
    const out = { channel: CHANNEL, owner: peer, welcome: b64 };
    fs.writeFileSync(path.join(root, 'otc', 'channel.json'), JSON.stringify(out, null, 2) + '\n');
    console.log('wrote otc/channel.json for owner', peer);
    ws.close();
  } else if (m.type === 'error') { console.error(m); process.exit(1); }
};
ws.onerror = (e) => { console.error('bridge connection failed', e.message || e); process.exit(1); };
