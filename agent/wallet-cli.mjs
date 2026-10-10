// Bot wallet for live mode (v0.3). The wallet owns the bot's tokens, pays its Bitcoin fees and signs its
// token-auth redeems. Start on signet or regtest; mainnet needs --mainnet on every command that spends.
//
//   node agent/wallet-cli.mjs new <name> --network signet|testnet|regtest|mainnet
//   node agent/wallet-cli.mjs address <name>
//   node agent/wallet-cli.mjs status <name> [--indexer <ord-tap url>] [--ticks tap,gib]
//   node agent/wallet-cli.mjs setup-authority <name> [--ticks tap,gib] [--mainnet]
//   node agent/wallet-cli.mjs stop | resume        (kill switch for every live bot)
//
// The private key is kept in agent/state/<name>.wallet.json (gitignored) and is never printed.
// Back the file up offline. Anyone with it controls the bot's coins, so keep only trading amounts there.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hex } from '@scure/base';
import { wallet, buildInscription, buildTap, rawHex, POSTAGE } from './inscribe.mjs';
import { authInscription, authorityPubkey } from './tapsign.mjs';
import { chainFor } from './chains.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = process.env.OTC4AI_STATE || path.join(root, 'agent/state'); // OTC4AI_STATE: another folder, e.g. for tests
const [cmd, name] = process.argv.slice(2);
const flag = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);
const file = (n) => path.join(state, `${n}.wallet.json`);
const die = (s) => { console.error(s); process.exit(1); };
const load = (n) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { die(`no wallet "${n}" (create it: node agent/wallet-cli.mjs new ${n} --network signet)`); } };
const save = (n, wf) => fs.writeFileSync(file(n), JSON.stringify(wf, null, 2), { mode: 0o600 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitConfirmed(chain, txid, what) {
  process.stdout.write(`waiting for ${what} to confirm (${txid.slice(0, 12)}…)`);
  for (;;) { if (await chain.confirmed(txid)) { console.log(' confirmed'); return; } process.stdout.write('.'); await sleep(Number(process.env.OTC4AI_POLL_MS) || 30e3); }
}

if (cmd === 'stop' || cmd === 'resume') {
  const stop = path.join(state, 'STOP');
  fs.mkdirSync(state, { recursive: true });
  if (cmd === 'stop') { fs.writeFileSync(stop, new Date().toISOString()); console.log('Kill switch ON: live bots create no new locks. Open deals still claim and refund.'); }
  else { fs.rmSync(stop, { force: true }); console.log('Kill switch OFF.'); }
  process.exit(0);
}
if (!name || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) die('usage: node agent/wallet-cli.mjs <new|address|status|setup-authority> <name> ... (see the header of this file)');

if (cmd === 'new') {
  const network = flag('network');
  if (!['signet', 'testnet', 'regtest', 'mainnet'].includes(network)) die('choose --network signet|testnet|regtest|mainnet');
  if (fs.existsSync(file(name))) die(`wallet "${name}" already exists; refusing to overwrite it`);
  fs.mkdirSync(state, { recursive: true });
  const priv = randomBytes(32);
  const w = wallet(priv, network);
  save(name, { network, priv: hex.encode(priv), address: w.address, auth: null, created: new Date().toISOString() });
  console.log(`New ${network} bot wallet "${name}"\n  address:   ${w.address}\n  key file:  ${file(name)} (back it up offline, never share it)\nNext: send a little BTC to the address, then run setup-authority.`);
} else {
  const wf = load(name), priv = hex.decode(wf.priv), w = wallet(priv, wf.network), chain = chainFor(wf.network);
  if (cmd === 'address') {
    console.log(`${w.address}\nauthority public key: ${authorityPubkey(priv)}\nauthority: ${wf.auth || 'not set up yet'}`);
  } else if (cmd === 'status') {
    const utxos = await chain.utxos(w.address);
    const sats = utxos.reduce((a, u) => a + u.value, 0), small = utxos.filter((u) => u.value <= 10_000);
    console.log(`${wf.network} ${w.address}\nBTC: ${sats} sats in ${utxos.length} outputs (${small.length} small ones kept for inscriptions)\nauthority: ${wf.auth || 'not set up yet'}`);
    const indexer = flag('indexer'), ticks = flag('ticks', 'tap').split(',');
    if (indexer) for (const t of ticks) {
      const j = await fetch(`${indexer.replace(/\/+$/, '')}/r/tap/getBalance/${w.address}/${encodeURIComponent(t)}`).then((r) => r.json()).catch(() => ({}));
      console.log(`${t}: ${j.result ?? 0} (atomic units)`);
    }
  } else if (cmd === 'setup-authority') {
    if (wf.network === 'mainnet' && !has('mainnet')) die('this spends real BTC: add --mainnet to confirm');
    if (wf.auth) die(`authority already set up: ${wf.auth}`);
    const ticks = flag('ticks', '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const ins = authInscription(priv, ticks);
    const rate = await chain.feeRate();
    const { commit, reveal, inscriptionId, feeSats } = buildInscription(w, ins, await chain.utxos(w.address), rate);
    console.log(`authority for ${ticks.length ? ticks.join(', ') : 'any token'}: inscribing ${inscriptionId} at ${rate} sat/vB (${feeSats} sats)`);
    await chain.broadcast(rawHex(commit)); await chain.broadcast(rawHex(reveal));
    await waitConfirmed(chain, reveal.id, 'the authority inscription');
    // tap: send the inscription back to the bot address, as the spec requires for an authority
    const tapTx = buildTap(w, { txid: reveal.id, vout: 0, value: Number(POSTAGE) }, await chain.utxos(w.address), await chain.feeRate());
    await chain.broadcast(rawHex(tapTx));
    await waitConfirmed(chain, tapTx.id, 'the tap');
    save(name, { ...wf, auth: inscriptionId, authTicks: ticks });
    console.log(`authority ready: ${inscriptionId}\nIt is saved in the wallet file; live bots that use this wallet pick it up.`);
  } else die('unknown command ' + cmd);
}
