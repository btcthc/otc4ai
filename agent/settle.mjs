// Settlement adapters for the agent engine.
// paper: simulated locks, no chain, for strategy tests and demos.
// draft: real TAP drafts; a human signs + inscribes each one and drops the result into the outbox.
import fs from 'node:fs';
import path from 'node:path';
import * as tap from '../otc/tap.js';

export function paperSettle() {
  return {
    isLockId: (id) => /^paper:[0-9a-f]{16}:(maker|taker)$/.test(String(id)),
    lock: async (d, side) => `paper:${d.id}:${side}`,
    verify: async (d, side, id) => (id === `paper:${d.id}:${side}` ? { ok: true, problems: [] } : { ok: false, problems: ['wrong paper lock id'] }),
    claim: async () => true,
  };
}

// Human-in-the-loop: writes <did>-<step>.json (unsigned redeem) and waits for <did>-<step>.done
// containing the lock id (for locks) or anything (for claims).
export function draftSettle({ outbox, auth, indexer, log = () => {} }) {
  fs.mkdirSync(outbox, { recursive: true });
  const waitFor = async (file, ms = 6 * 3600e3) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('timed out waiting for ' + path.basename(file));
  };
  const write = (name, actions, help) => {
    const file = path.join(outbox, name + '.json');
    fs.writeFileSync(file, JSON.stringify({ help, redeem: tap.redeemDraft(auth, actions) }, null, 2));
    log(`draft ready: ${file} — sign + inscribe it, then write the result into ${name}.done`);
    return path.join(outbox, name + '.done');
  };
  return {
    isLockId: tap.isLockId,
    async lock(d, side) {
      const leg = tap.dealLegs(d)[side];
      const id = await waitFor(write(`${d.id}-${side}-lock`, [leg], 'Sign with your authority key, inscribe, put "<inscriptionId>:0" into the .done file'));
      if (!tap.isLockId(id)) throw new Error('bad lock id in .done file');
      return id;
    },
    verify: (d, side, id) => tap.verifyLock(indexer, id, tap.dealLegs(d)[side]),
    async claim(d, lockId, preimage) {
      await waitFor(write(`${d.id}-claim`, [tap.claimAction(lockId, preimage)], 'Sign, inscribe, then create the .done file'));
      return true;
    },
  };
}
