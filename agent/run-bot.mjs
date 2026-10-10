// Runs one trading bot against a local Intercom peer.
// Usage: node agent/run-bot.mjs <config.json> <bridge-token> [bridge-port]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OtcAgent } from './engine.mjs';
import { hex } from '@scure/base';
import { paperSettle, draftSettle, liveSettle } from './settle.mjs';
import { STRATEGIES } from './bots.mjs';
import { feeModel } from './fees.mjs';
import { wallet } from './inscribe.mjs';
import { limiter } from './limits.mjs';
import { chainFor } from './chains.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [cfgPath, token, port = '49232'] = process.argv.slice(2);
if (!cfgPath || !token) { console.error('usage: node agent/run-bot.mjs <config.json> <bridge-token> [bridge-port]'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const channel = JSON.parse(fs.readFileSync(path.join(root, 'otc/channel.json'), 'utf8')).channel;
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} [${cfg.name}] ${s}`);

const mode = cfg.mode || 'paper';
const strat = STRATEGIES[cfg.strategy];
if (!strat) { console.error('unknown strategy ' + cfg.strategy); process.exit(1); }
const fees = feeModel(cfg.fees);
// cfg.batch: { lockWindowSec, claimMaxWaitSec, maxActions } — several actions per inscription
const batch = cfg.batch && { lockWindowMs: (cfg.batch.lockWindowSec ?? 60) * 1000, claimMaxWaitMs: (cfg.batch.claimMaxWaitSec ?? 1800) * 1000, maxActions: cfg.batch.maxActions ?? 20 };
const onInscribe = ({ n, kinds }) => { fees.charge({ n }); if (n > 1) log(`batched ${n} actions into one inscription (${kinds.join(', ')})`); };
const stateDir = path.join(root, 'agent/state');
let settle;
if (mode === 'live') {
  // cfg.wallet: name of a bot wallet made with agent/wallet-cli.mjs; cfg.limits: { perDealTap, perDayTap, maxOpenTap, ticks }
  const die = (s) => { console.error(s); process.exit(1); };
  let wf; try { wf = JSON.parse(fs.readFileSync(path.join(stateDir, `${cfg.wallet}.wallet.json`), 'utf8')); } catch { die(`live mode: bot wallet "${cfg.wallet}" not found (node agent/wallet-cli.mjs new <name> --network signet)`); }
  if (wf.network === 'mainnet' && cfg.allowMainnet !== true) die('live mode on mainnet needs "allowMainnet": true in the config');
  if (!cfg.limits || !(cfg.limits.perDealTap > 0) || !(cfg.limits.perDayTap > 0) || !(cfg.limits.maxOpenTap > 0)) die('live mode needs "limits": { "perDealTap", "perDayTap", "maxOpenTap" }');
  if (!cfg.indexer) die('live mode needs "indexer" (an ord-tap server for the wallet network)');
  const priv = hex.decode(wf.priv), w = wallet(priv, wf.network);
  cfg.addr = w.address; // tokens are claimed to and refunded to the bot wallet
  settle = liveSettle({
    w, priv, chain: chainFor(wf.network), indexer: cfg.indexer, auth: wf.auth, batch, onInscribe, log,
    limits: limiter(cfg.limits, { statePath: path.join(stateDir, `${cfg.name}-limits.json`), stopFile: path.join(stateDir, 'STOP') }),
    statePath: path.join(stateDir, `${cfg.name}-locks.json`),
  });
  setInterval(() => settle.watchRefunds().catch((e) => log('refund watch: ' + e.message)), 5 * 60e3);
  log(`live on ${wf.network}: wallet ${w.address}, authority ${wf.auth}, limits ${JSON.stringify(cfg.limits)}`);
} else settle = mode === 'draft'
  ? draftSettle({ outbox: path.join(root, 'agent/outbox', cfg.name), auth: cfg.auth, indexer: cfg.indexer, batch, onInscribe, log })
  : paperSettle({ batch, onInscribe });

const agent = new OtcAgent({ bridge: `ws://127.0.0.1:${port}`, token, channel, name: cfg.name, addr: cfg.addr, mode, settle, policy: { pairs: () => [] } });
fs.mkdirSync(path.join(root, 'agent/state'), { recursive: true });
const bot = strat({ ...cfg, feeModel: fees, statePath: path.join(root, 'agent/state', cfg.name + '.json') }, agent, log);
agent.policy = bot.policy;

const stats = { deals: 0, done: 0, failed: 0 };
agent.on('log', log);
agent.on('deal', (d) => {
  if (d.state === 'taken' || d.state === 'requested') stats.deals++;
  if (d.state === 'done') stats.done++;
  if (['failed', 'rejected', 'expired'].includes(d.state)) stats.failed++;
  log(`deal ${d.id} ${d.role} ${d.offer.give.amt} ${d.offer.give.tick} ⇄ ${d.offer.want.amt} ${d.offer.want.tick}: ${d.state}${d.note ? ' — ' + d.note : ''}`);
});
setInterval(() => log(`stats ${JSON.stringify(stats)} · agents seen ${agent.agents.size} · board offers ${agent.offers.size}`), 120e3);

// The peer may still be booting (or restarting): keep retrying instead of exiting.
let started = false;
async function connectLoop() {
  for (;;) {
    try { await agent.connect(); break; } catch (e) { log(e.message + ' — retrying in 5s'); await new Promise((r) => setTimeout(r, 5000)); }
  }
  log(`online as ${agent.me.slice(0, 12)}… mode=${mode} strategy=${cfg.strategy}`);
  if (!started) { started = true; bot.start(); }
}
agent.on('closed', () => setTimeout(connectLoop, 5000));
await connectLoop();
process.on('SIGINT', () => { agent.close(); process.exit(0); });
