// Settlement adapters for the agent engine.
// paper: simulated locks, no chain, for strategy tests and demos.
// draft: real TAP drafts; a human signs + inscribes each one and drops the result into the outbox.
// live:  the bot signs with its own authority key and inscribes from its own wallet, within spending limits.
import fs from 'node:fs';
import path from 'node:path';
import { hex } from '@scure/base';
import * as tap from '../otc/tap.js';
import { batcher } from './batch.mjs';
import { redeemInscription } from './tapsign.mjs';
import { buildInscription, rawHex } from './inscribe.mjs';

// Without batching every action is its own inscription.
const SINGLE = { lockWindowMs: 0, claimMaxWaitMs: 0, maxActions: 1 };

// batch: batcher options (see batch.mjs) or null; onInscribe({ ins, n }) reports each simulated
// inscription so the bot can book what it would have paid on-chain.
export function paperSettle({ batch = null, onInscribe = () => {} } = {}) {
  let n = 0;
  const b = batcher({ ...(batch || SINGLE), flush: async () => `paperins${(++n).toString(16)}`, onFlush: onInscribe });
  return {
    batcher: b,
    isLockId: (id) => /^paper:[0-9a-f]{16}:(maker|taker)$/.test(String(id)),
    lock: async (d, side) => { await b.add(tap.dealLegs(d)[side], 'lock'); return `paper:${d.id}:${side}`; },
    verify: async (d, side, id) => (id === `paper:${d.id}:${side}` ? { ok: true, problems: [] } : { ok: false, problems: ['wrong paper lock id'] }),
    claim: async (d, lockId, preimage) => { await b.add(tap.claimAction(lockId, preimage), 'claim'); return true; },
    awaitClaim: async () => true, // paper: the maker's sponsored claim is simulated
  };
}

// Human-in-the-loop: writes batch-<n>.json (one unsigned redeem with every queued action) and waits
// for batch-<n>.done containing the inscription id. Lock ids are "<inscriptionId>:<actionIndex>".
export function draftSettle({ outbox, auth, indexer, batch = null, onInscribe = () => {}, log = () => {} }) {
  fs.mkdirSync(outbox, { recursive: true });
  const waitFor = async (file, ms = 6 * 3600e3) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('timed out waiting for ' + path.basename(file));
  };
  let n = fs.readdirSync(outbox).filter((f) => /^batch-\d+\.json$/.test(f)).length;
  const flush = async (actions) => {
    const name = `batch-${++n}`, file = path.join(outbox, name + '.json');
    fs.writeFileSync(file, JSON.stringify({ help: 'Sign with your authority key, inscribe, put the inscription id into ' + name + '.done', redeem: tap.redeemDraft(auth, actions) }, null, 2));
    log(`draft ready: ${file} (${actions.length} action${actions.length > 1 ? 's' : ''}) — sign + inscribe it, then write the inscription id into ${name}.done`);
    const ins = await waitFor(path.join(outbox, name + '.done'));
    if (!/^[0-9a-f]{64}i\d+$/.test(ins)) throw new Error('bad inscription id in ' + name + '.done');
    return ins;
  };
  const b = batcher({ ...(batch || SINGLE), flush, onFlush: onInscribe });
  return {
    batcher: b,
    isLockId: tap.isLockId,
    lock: async (d, side) => (await b.add(tap.dealLegs(d)[side], 'lock')).id,
    verify: (d, side, id) => tap.verifyLock(indexer, id, tap.dealLegs(d)[side]),
    claim: async (d, lockId, preimage) => { await b.add(tap.claimAction(lockId, preimage), 'claim'); return true; },
    // Wait for a claim submitted by the counterparty; false means "claim it yourself".
    async awaitClaim(d, lockId, ms = 3 * 3600e3) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await tap.lockConsumed(indexer, lockId)) return true;
        await new Promise((r) => setTimeout(r, 60e3));
      }
      return false;
    },
  };
}

// Live: every redeem is signed with the bot's authority key and inscribed from the bot wallet.
//   w, priv: the bot wallet (agent/inscribe.mjs wallet()) and its key; chain: agent/chain.mjs adapter
//   auth: the bot's authority inscription id; limits: agent/limits.mjs limiter
//   statePath: where the bot's own open locks are kept, so refunds survive restarts
// A counterparty lock exists on the indexer only after it confirms, so verify() waits for it.
// watchRefunds() returns funds from locks whose counterparty disappeared, once refund_after is reached.
export function liveSettle({ w, priv, chain, indexer, auth, limits, statePath, batch = null, onInscribe = () => {}, log = () => {}, verifyWaitMs = 3 * 3600e3, pollMs = 60e3 }) {
  if (!auth || !/^[0-9a-f]{64}i\d+$/.test(auth)) throw new Error('live mode needs the authority inscription id (node agent/wallet-cli.mjs setup-authority <wallet>)');
  let own = {};
  try { if (statePath) own = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const saveOwn = () => { try { if (statePath) fs.writeFileSync(statePath, JSON.stringify(own, null, 2)); } catch {} };
  const spent = new Set(); // outpoints our own unconfirmed transactions already use
  const flush = async (actions) => {
    const ins = redeemInscription(priv, { auth, actions, data: {} });
    const utxos = (await chain.utxos(w.address)).filter((u) => !spent.has(`${u.txid}:${u.vout}`));
    const { commit, reveal, inscriptionId, feeSats } = buildInscription(w, ins, utxos, await chain.feeRate());
    for (let i = 0; i < commit.inputsLength; i++) { const inp = commit.getInput(i); spent.add(`${hex.encode(inp.txid)}:${inp.index}`); }
    await chain.broadcast(rawHex(commit));
    await chain.broadcast(rawHex(reveal));
    log(`inscribed ${inscriptionId}: ${actions.length} action${actions.length > 1 ? 's' : ''}, ${feeSats} sats in fees`);
    return inscriptionId;
  };
  const b = batcher({ ...(batch || SINGLE), flush, onFlush: onInscribe });
  const valueTap = (d) => { const l = tap.dealLegs(d), t = [l.maker, l.taker].find((x) => x.tick === 'tap'); return t ? Number(t.amt) : NaN; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    batcher: b,
    limits,
    isLockId: tap.isLockId,
    async lock(d, side) {
      const leg = tap.dealLegs(d)[side], v = valueTap(d), ok = limits.check({ tick: leg.tick, valueTap: v });
      if (!ok.ok) throw new Error('limit: ' + ok.why);
      limits.commit(d.id, v);
      const id = (await b.add(leg, 'lock')).id;
      own[id] = { deal: d.id, refundAfter: Number(leg.refund_after), at: Date.now() }; saveOwn();
      return id;
    },
    async verify(d, side, id) {
      const t0 = Date.now();
      for (;;) {
        const r = await tap.verifyLock(indexer, id, tap.dealLegs(d)[side], await chain.tip().catch(() => 0)).catch((e) => ({ ok: false, problems: [e.message], record: null }));
        if (r.ok || r.record || Date.now() - t0 > verifyWaitMs) return r; // a found lock is judged at once; a missing one is awaited
        await sleep(pollMs);
      }
    },
    async claim(d, lockId, preimage) { await b.add(tap.claimAction(lockId, preimage), 'claim'); limits.settle(d.id); return true; },
    async awaitClaim(d, lockId, ms = 3 * 3600e3) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await tap.lockConsumed(indexer, lockId)) { limits.settle(d.id); return true; }
        await sleep(pollMs);
      }
      return false;
    },
    // Called on a timer: consumed locks are forgotten, expired ones are refunded.
    async watchRefunds() {
      const tip = await chain.tip().catch(() => 0);
      for (const [id, l] of Object.entries(own)) {
        if (await tap.lockConsumed(indexer, id)) { delete own[id]; limits.settle(l.deal); continue; }
        if (tip && tip >= l.refundAfter && !l.refunding) {
          l.refunding = true; saveOwn();
          log(`refunding ${id}: the counterparty did not finish, refund height ${l.refundAfter} reached`);
          b.add(tap.refundAction(id), 'claim').catch((e) => { l.refunding = false; saveOwn(); log('refund failed: ' + e.message); });
        }
      }
      saveOwn();
    },
    openLocks: () => ({ ...own }),
  };
}
