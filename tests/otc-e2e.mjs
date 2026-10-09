// End-to-end UI test: two running peers (start-otc.ps1 -Name admin / -Name bob -BridgePort 49223 -UiPort 8788),
// two headless Edge tabs. Bob posts an offer, admin takes it, bob accepts and reports a lock.
// Usage: node tests/otc-e2e.mjs [shotDir]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shotDir = process.argv[2] || tmpdir();
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

async function tab(url, port) {
  procs.push(spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'otc-e2e-'))}`, '--window-size=1200,900', url], { stdio: 'ignore' }));
  let tabs = [];
  for (let i = 0; i < 40 && !tabs.length; i++) { await sleep(500); try { tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page'); } catch {} }
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); let id = 0;
  const call = (method, params = {}) => new Promise((r) => { const my = ++id; ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener('message', h); r(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
  const ev = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const until = async (expression, what, secs = 60) => { for (let i = 0; i < secs * 2; i++) { if (await ev(expression)) return; await sleep(500); } throw new Error('timeout: ' + what); };
  const shot = async (name) => writeFileSync(join(shotDir, name), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  return { ev, until, shot };
}

const ADDR_A = 'bc1pxwww0ct9ue7e8tdnlmug5m2tamfn7q06sahstg39ys4c9f3340qqxrdu9k';
const ADDR_B = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const setup = (addr) => `localStorage.clear(); localStorage.setItem('otc.lang', '"en"'); localStorage.setItem('otc.settings', JSON.stringify({ addr: '${addr}', auth: 'testauthi0', indexer: '' })); location.reload(); true`;

try {
  const A = await tab('http://127.0.0.1:8787/', 9611), B = await tab('http://127.0.0.1:8788/', 9612);
  await sleep(1500); await A.ev(setup(ADDR_A)); await B.ev(setup(ADDR_B)); await sleep(1500);
  await A.until(`document.querySelector('#status').className.includes('on')`, 'admin online');
  await B.until(`document.querySelector('#status').className.includes('on')`, 'bob online');
  console.log('both online');

  await B.ev(`(() => { const f = document.querySelector('#offer'); f.gt.value = 'gib'; f.ga.value = '1000000'; f.wt.value = 'tap'; f.wa.value = '250'; f.note.value = 'e2e test'; f.requestSubmit(); return true; })()`);
  await A.until(`[...document.querySelectorAll('td')].some((td) => td.textContent.includes('e2e test'))`, 'offer reaches admin');
  console.log('offer visible on admin board'); await A.shot('otc-1-board.png');

  await A.ev(`document.querySelector('[data-act="take"]').click(), true`);
  await B.ev(`document.querySelector('[data-tab="deals"]').click(), true`);
  await B.until(`!!document.querySelector('[data-act="accept"]')`, 'take reaches bob');
  console.log('take received by maker');
  await B.ev(`document.querySelector('[data-act="accept"]').click(), true`);
  await A.until(`document.body.textContent.includes('Waiting for the maker to lock')`, 'accept reaches admin');
  console.log('accept received by taker');
  await B.until(`!!document.querySelector('[id^="lk-"]')`, 'maker lock step');
  await B.shot('otc-2-maker-lock.png');
  await B.ev(`(() => { const i = document.querySelector('[id^="lk-"]'); i.value = '${'ab'.repeat(32)}i0:0'; document.querySelector('[data-act="lock"]').click(); return true; })()`);
  await A.until(`!!document.querySelector('[data-act="verify"]')`, 'locked reaches admin');
  console.log('maker lock reported to taker');
  await A.ev(`document.querySelector('[data-act="verify"]').click(), true`); await sleep(1500);
  console.log('verify without indexer:', await A.ev(`document.querySelector('[id^="vf-"]').textContent`));
  await A.shot('otc-3-taker-verify.png');
  console.log('E2E OK');
} catch (e) { console.error('E2E FAIL', e.message); process.exitCode = 1; }
finally { procs.forEach((p) => p.kill()); }
