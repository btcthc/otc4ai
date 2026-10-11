// Mainnet pilot of live mode: one small deal between two bot wallets of the same owner, settled on Bitcoin
// and checked through the public TAP reader (no own indexer needed). Run it again after any interruption:
// progress, including the maker's secret, is kept in agent/state/pilot.json (gitignored).
//
//   node scripts/pilot.mjs status              what each wallet holds and what is still missing
//   node scripts/pilot.mjs run --mainnet       set up both authorities if needed, then run the deal
//
// Wallets: pilot-a is the maker (gives GIB), pilot-b the taker (gives TAP). Create them with
//   node agent/wallet-cli.mjs new pilot-a --network mainnet   (and pilot-b)
// Afterwards return the coins with wallet-cli send-token and withdraw.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hex } from '@scure/base';
import * as tap from '../otc/tap.js';
import { wallet, DUST_GUARD } from '../agent/inscribe.mjs';
import { liveSettle } from '../agent/settle.mjs';
import { limiter } from '../agent/limits.mjs';
import { chainFor } from '../agent/chains.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = process.env.OTC4AI_STATE || path.join(root, 'agent/state');
const READER = process.env.TAP_READER || 'https://tap-reader-tw.tap-hosting.xyz';
const DEAL = { give: { tick: 'gib', amt: '1' }, want: { tick: 'tap', amt: '1' } }; // maker gives 1 GIB for 1 TAP
const LIMITS = { perDealTap: 5, perDayTap: 10, maxOpenTap: 5, ticks: ['gib', 'tap'] };
const progressFile = path.join(state, 'pilot.json');
const cmd = process.argv[2];
const log = (s) => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')}  ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chain = chainFor('mainnet');

const load = (name) => {
  const f = path.join(state, `${name}.wallet.json`);
  if (!fs.existsSync(f)) { console.error(`no wallet ${name}: node agent/wallet-cli.mjs new ${name} --network mainnet`); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (wf.network !== 'mainnet') { console.error(`${name} is a ${wf.network} wallet; the pilot runs on mainnet`); process.exit(1); }
  const priv = hex.decode(wf.priv);
  return { name, wf, priv, w: wallet(priv, 'mainnet') };
};
const tokens = async (addr, tick) => {
  const j = await fetch(`${READER}/getBalance/${addr}/${encodeURIComponent(tick)}`).then((r) => r.json()).catch(() => ({}));
  return Number(BigInt(j.result || 0) / 10n ** 12n) / 1e6; // TAP tokens here have 18 decimals
};
async function holdings(b) {
  const utxos = await chain.utxos(b.w.address);
  const fees = utxos.filter((u) => u.value > Number(DUST_GUARD)).reduce((a, u) => a + u.value, 0);
  return { fees, gib: await tokens(b.w.address, 'gib'), tap: await tokens(b.w.address, 'tap') };
}
const progress = () => { try { return JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch { return {}; } };
const save = (p) => fs.writeFileSync(progressFile, JSON.stringify(p, null, 2), { mode: 0o600 });

const a = load('pilot-a'), b = load('pilot-b');

async function status() {
  const p = progress();
  for (const [x, role, need] of [[a, 'maker', 'gib'], [b, 'taker', 'tap']]) {
    const h = await holdings(x);
    const missing = [h.fees < 5000 && 'BTC for fees (one payment above 10,000 sats)', h[need] < Number(DEAL[role === 'maker' ? 'give' : 'want'].amt) && need.toUpperCase()].filter(Boolean);
    log(`${x.name} (${role}) ${x.w.address}: ${h.fees} sats for fees, ${h.gib} GIB, ${h.tap} TAP, authority ${x.wf.auth || 'not set up'}${missing.length ? ' · missing: ' + missing.join(', ') : ' · ready'}`);
  }
  if (p.deal) log(`deal ${p.deal.id}: ${['makerLock', 'takerLock', 'makerClaim', 'takerClaim'].map((k) => `${k} ${p[k] ? '✔' : '…'}`).join(', ')}`);
}

function cli(...args) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'agent/wallet-cli.mjs'), ...args], { env: process.env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; process.stdout.write(d); }); c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim()))));
  });
}
async function confirmed(txidOrIns) {
  const txid = txidOrIns.slice(0, 64);
  while (!(await chain.confirmed(txid))) await sleep(60e3);
}

async function run() {
  if (!process.argv.includes('--mainnet')) { console.error('this spends real BTC: add --mainnet'); process.exit(1); }
  for (const [x, need] of [[a, 'gib'], [b, 'tap']]) {
    const h = await holdings(x);
    if (h.fees < 5000 || !(h[need] > 0)) { await status(); console.error('\nfund both wallets first (see above)'); process.exit(1); }
  }
  // 1. authorities, both at once (each is an inscription plus a tap, about 20 minutes)
  const todo = [a, b].filter((x) => !x.wf.auth);
  if (todo.length) {
    log(`setting up ${todo.map((x) => x.name).join(' and ')}`);
    await Promise.all(todo.map((x) => cli('setup-authority', x.name, '--ticks', 'gib,tap', '--mainnet')));
  }
  const A = load('pilot-a'), B = load('pilot-b');
  const bot = (x, role) => liveSettle({
    w: x.w, priv: x.priv, chain, indexer: READER, auth: x.wf.auth, log: (s) => log(`[${role}] ${s}`),
    limits: limiter(LIMITS, { statePath: path.join(state, `${x.name}-limits.json`), stopFile: path.join(state, 'STOP') }),
    statePath: path.join(state, `${x.name}-locks.json`),
  });
  const maker = bot(A, 'maker'), taker = bot(B, 'taker');
  await maker.watchRefunds(); await taker.watchRefunds(); // a deal left over from an earlier run refunds when due

  // 2. the deal; the secret is saved before anything is locked
  let p = progress();
  if (!p.deal) {
    const secret = tap.newSecret(), tip = await chain.tip();
    p = { secret, deal: { id: 'pilot' + Date.now().toString(16), hash: await tap.hashOf(secret), t1: tip + tap.WINDOW.maker, t2: tip + tap.WINDOW.taker, takerAddr: B.w.address, offer: { ...DEAL, addr: A.w.address } } };
    save(p);
  }
  const d = p.deal;
  log(`deal ${d.id}: ${A.name} gives ${d.offer.give.amt} ${d.offer.give.tick}, ${B.name} gives ${d.offer.want.amt} ${d.offer.want.tick}; refund heights ${d.t1} / ${d.t2}`);
  const step = async (key, fn) => { if (!p[key]) { p[key] = await fn(); save(p); } return p[key]; };
  const check = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.problems.join('; ')}`); log(`✔ ${what}`); };

  const makerLock = await step('makerLock', () => maker.lock(d, 'maker'));
  log(`maker lock ${makerLock}`); await confirmed(makerLock);
  if (!p.takerLock) check(await taker.verify(d, 'maker', makerLock), 'taker verified the maker lock on the TAP reader');
  const takerLock = await step('takerLock', () => taker.lock(d, 'taker'));
  log(`taker lock ${takerLock}`); await confirmed(takerLock);
  if (!p.makerClaim) check(await maker.verify(d, 'taker', takerLock), 'maker verified the taker lock on the TAP reader');
  await step('makerClaim', async () => { await maker.claim(d, takerLock, p.secret); return true; });
  let pre = null;
  for (let i = 0; i < 240 && !pre && !p.takerClaim; i++) { pre = await tap.findPreimage(READER, takerLock, d.hash).catch(() => null); if (!pre) await sleep(60e3); }
  if (!p.takerClaim) { if (!pre) throw new Error('the secret did not show up within 4 hours'); log('✔ taker found the secret in the maker claim on Bitcoin'); }
  await step('takerClaim', async () => { await taker.claim(d, makerLock, pre); return true; });
  for (let i = 0; i < 240 && !(await tap.lockConsumed(READER, makerLock)); i++) await sleep(60e3);
  log('✔ both locks are consumed: the deal settled on Bitcoin');
  await status();
}

if (cmd === 'status') await status();
else if (cmd === 'run') await run();
else console.error('usage: node scripts/pilot.mjs status | run --mainnet');
