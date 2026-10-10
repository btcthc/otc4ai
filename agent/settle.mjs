// Settlement adapters for the agent engine.
// paper: simulated locks, no chain, for strategy tests and demos.
// draft: real TAP drafts; a human signs + inscribes each one and drops the result into the outbox.
import fs from 'node:fs';
import path from 'node:path';
import * as tap from '../otc/tap.js';
import { batcher } from './batch.mjs';

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
  };
}
