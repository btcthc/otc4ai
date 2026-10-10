// End-to-end check of live mode (v0.3) on a local Bitcoin regtest chain, judged by a real ord-tap indexer.
//
// Needs bitcoind -regtest -txindex=1 (RPC on 127.0.0.1:18443) and ord-tap --regtest server --http.
//   BITCOIN_COOKIE=<datadir>/regtest/.cookie  (or OTC4AI_BITCOIND=http://user:pass@127.0.0.1:18443)
//   ORD_TAP=http://127.0.0.1:3333
//   node scripts/regtest-e2e.mjs
//
// What it checks, with the same code the live bots run:
//   1. two fresh bot wallets (wallet-cli new), funded by the regtest miner;
//   2. test tokens tap and gib deployed and minted to them;
//   3. both token-auth authorities set up with wallet-cli setup-authority (inscribe + tap);
//   4. a full deal: maker lock → taker verify + lock → maker verify + claim → taker finds the secret and claims;
//   5. an abandoned deal: the maker locks, nobody answers, the refund watcher returns the tokens;
//   6. a lock above the per-deal limit is refused before anything is signed.
// Every balance is read back from ord-tap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hex } from '@scure/base';
import * as tap from '../otc/tap.js';
import { wallet, buildInscription, rawHex } from '../agent/inscribe.mjs';
import { liveSettle } from '../agent/settle.mjs';
import { limiter } from '../agent/limits.mjs';
import { chainFor } from '../agent/chains.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ORD = (process.env.ORD_TAP || 'http://127.0.0.1:3333').replace(/\/+$/, '');
if (!process.env.OTC4AI_BITCOIND) {
  const cookie = process.env.BITCOIN_COOKIE;
  if (!cookie) { console.error('set BITCOIN_COOKIE=<datadir>/regtest/.cookie or OTC4AI_BITCOIND=http://user:pass@127.0.0.1:18443'); process.exit(1); }
  const [u, p] = fs.readFileSync(cookie, 'utf8').trim().split(':');
  process.env.OTC4AI_BITCOIND = `http://${encodeURIComponent(u)}:${encodeURIComponent(p)}@127.0.0.1:18443`;
}
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'otc4ai-e2e-'));
const env = { ...process.env, OTC4AI_STATE: state, OTC4AI_POLL_MS: '1000' };
const chain = chainFor('regtest');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
let failures = 0;
const check = (ok, what) => { if (ok) log('✔ ' + what); else { failures++; log('✘ ' + what); } };

// --- bitcoind --------------------------------------------------------------------------------
const u = new URL(process.env.OTC4AI_BITCOIND);
const rpcAt = (pathname) => async (method, params = []) => {
  const r = await fetch(`${u.protocol}//${u.host}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const node = rpcAt('/'), miner = rpcAt('/wallet/miner');
if (!(await node('listwallets')).includes('miner')) {
  try { await node('loadwallet', ['miner']); } catch { await node('createwallet', ['miner']); }
}
const minerAddr = await miner('getnewaddress');
const mine = async (n = 1) => { await node('generatetoaddress', [n, minerAddr]); };
if ((await node('getblockcount')) < 110) await mine(110);

// --- ord-tap ---------------------------------------------------------------------------------
const ord = async (p) => { const r = await fetch(ORD + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); };
async function synced() { // ord-tap has indexed the current tip
  const want = await node('getblockcount');
  for (let i = 0; i < 120; i++) { const h = Number((await ord('/r/tap/getCurrentBlock').catch(() => ({}))).result); if (h >= want) return; await sleep(500); }
  throw new Error('ord-tap did not catch up with the chain');
}
const balance = async (addr, tick) => BigInt((await ord(`/r/tap/getBalance/${addr}/${encodeURIComponent(tick)}`)).result ?? 0);
const E18 = 10n ** 18n;

// --- wallets ---------------------------------------------------------------------------------
function cli(...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'agent/wallet-cli.mjs'), ...args], { env });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`wallet-cli ${args.join(' ')}: ${out.trim()}`))));
  });
}
const loadWallet = (name) => { const wf = JSON.parse(fs.readFileSync(path.join(state, `${name}.wallet.json`), 'utf8')); const priv = hex.decode(wf.priv); return { wf, priv, w: wallet(priv, 'regtest') }; };

log(`state folder ${state}`);
await cli('new', 'mm', '--network', 'regtest');
await cli('new', 'tk', '--network', 'regtest');
let mm = loadWallet('mm'), tk = loadWallet('tk');
log(`maker ${mm.w.address}\n          taker ${tk.w.address}`);
for (let i = 0; i < 4; i++) await miner('sendmany', ['', { [mm.w.address]: 0.05, [tk.w.address]: 0.05 }]);
await mine();

// One inscription from a bot wallet, mined at once (the bitcoind adapter sees confirmed outputs only).
async function inscribe(b, json) {
  const { commit, reveal, inscriptionId } = buildInscription(b.w, json, await chain.utxos(b.w.address), await chain.feeRate());
  await chain.broadcast(rawHex(commit)); await chain.broadcast(rawHex(reveal));
  await mine();
  return inscriptionId;
}
await inscribe(mm, { p: 'tap', op: 'token-deploy', tick: 'tap', max: '21000000', lim: '100000' });
await inscribe(mm, { p: 'tap', op: 'token-deploy', tick: 'gib', max: '1000000000000', lim: '100000000' });
await inscribe(mm, { p: 'tap', op: 'token-mint', tick: 'gib', amt: '10000000' });
await inscribe(tk, { p: 'tap', op: 'token-mint', tick: 'tap', amt: '1000' });
await synced();
check(await balance(mm.w.address, 'gib') === 10_000_000n * E18, 'maker holds 10,000,000 gib');
check(await balance(tk.w.address, 'tap') === 1_000n * E18, 'taker holds 1,000 tap');

// --- authorities: wallet-cli setup-authority waits for confirmations, so a block is mined every 2 s
const auto = setInterval(() => mine().catch(() => {}), 2000);
try {
  // one after the other: bitcoind runs one scantxoutset at a time
  for (const name of ['mm', 'tk']) log((await cli('setup-authority', name, '--ticks', 'tap,gib')).trim().split('\n').pop());
} finally { clearInterval(auto); }
await mine(); await synced();
mm = loadWallet('mm'); tk = loadWallet('tk');
check(/^[0-9a-f]{64}i0$/.test(mm.wf.auth || '') && /^[0-9a-f]{64}i0$/.test(tk.wf.auth || ''), 'both authorities saved in the wallet files');

// --- bots ------------------------------------------------------------------------------------
const lim = { perDealTap: 100, perDayTap: 1000, maxOpenTap: 500, ticks: ['tap', 'gib'] };
const bot = (b, name) => liveSettle({
  w: b.w, priv: b.priv, chain, indexer: ORD, auth: b.wf.auth, pollMs: 1000, verifyWaitMs: 60e3, log: (s) => log(`[${name}] ${s}`),
  limits: limiter(lim, { statePath: path.join(state, `${name}-limits.json`), stopFile: path.join(state, 'STOP') }),
  statePath: path.join(state, `${name}-locks.json`),
});
const maker = bot(mm, 'maker'), taker = bot(tk, 'taker');

// Deal 1: the full happy path. Both sides derive the legs from the same deal, as the engine does.
const secret = tap.newSecret(), hash = await tap.hashOf(secret);
let tip = await chain.tip();
const d1 = { id: 'e2e' + Date.now().toString(16), hash, t1: tip + tap.WINDOW.maker, t2: tip + tap.WINDOW.taker, takerAddr: tk.w.address,
  offer: { give: { tick: 'gib', amt: '100000' }, want: { tick: 'tap', amt: '25' }, addr: mm.w.address } };
log(`deal 1: maker gives 100000 gib, taker gives 25 tap; refund heights ${d1.t1} / ${d1.t2}`);

const makerLock = await maker.lock(d1, 'maker');
await mine(); await synced();
const v1 = await taker.verify(d1, 'maker', makerLock);
check(v1.ok, `taker verified the maker lock ${makerLock}${v1.ok ? '' : ': ' + v1.problems.join('; ')}`);

const takerLock = await taker.lock(d1, 'taker');
await mine(); await synced();
const v2 = await maker.verify(d1, 'taker', takerLock);
check(v2.ok, `maker verified the taker lock ${takerLock}${v2.ok ? '' : ': ' + v2.problems.join('; ')}`);

await maker.claim(d1, takerLock, secret);
await mine(); await synced();
const found = await tap.findPreimage(ORD, takerLock, hash);
check(found === secret, 'taker found the secret in the maker claim on Bitcoin');

await taker.claim(d1, makerLock, found);
await mine(); await synced();
check(await tap.lockConsumed(ORD, makerLock) && await tap.lockConsumed(ORD, takerLock), 'both locks are consumed');
check(await balance(mm.w.address, 'tap') === 25n * E18, 'maker received 25 tap');
check(await balance(tk.w.address, 'gib') === 100_000n * E18, 'taker received 100000 gib');
check(await balance(tk.w.address, 'tap') === 975n * E18, 'taker has 975 tap left');
check(await balance(mm.w.address, 'gib') === 9_900_000n * E18, 'maker has 9,900,000 gib left');

// Deal 2: the taker never answers. After the refund height the watcher refunds the maker lock.
tip = await chain.tip();
const d2 = { id: 'e2e' + Date.now().toString(16) + 'r', hash: await tap.hashOf(tap.newSecret()), t1: tip + 12, t2: tip + 6, takerAddr: tk.w.address,
  offer: { give: { tick: 'gib', amt: '50000' }, want: { tick: 'tap', amt: '10' }, addr: mm.w.address } };
const lock2 = await maker.lock(d2, 'maker');
await mine(); await synced();
check(await balance(mm.w.address, 'gib') === 9_900_000n * E18 && (await ord(`/r/tap/getLock/${lock2}`)).result, `deal 2: maker lock ${lock2} is on the indexer`);
await maker.watchRefunds();
check(!maker.openLocks()[lock2]?.refunding, 'no refund before the refund height');
while ((await chain.tip()) < d2.t1) await mine();
await maker.watchRefunds();
for (let i = 0; i < 40 && maker.batcher.pending(); i++) await sleep(250);
await sleep(1000);
await mine(); await synced();
check(await tap.lockConsumed(ORD, lock2), 'deal 2: the abandoned lock was refunded');
await maker.watchRefunds();
check(!(lock2 in maker.openLocks()), 'the refunded lock is no longer tracked');

// Limits: 500 tap is above the 100 tap per-deal limit, so nothing is signed or sent.
const before = (await chain.utxos(tk.w.address)).length;
const big = { ...d1, id: d1.id + 'x', offer: { ...d1.offer, want: { tick: 'tap', amt: '500' } } };
const refused = await taker.lock(big, 'taker').then(() => null, (e) => e.message);
check(/per-deal limit/.test(refused || '') && (await chain.utxos(tk.w.address)).length === before, `a 500 tap lock is refused: ${refused}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll live-mode checks passed on regtest with ord-tap.');
process.exit(failures ? 1 : 0);
