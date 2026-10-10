// Batching: many TAP actions in one token-auth redeem share the fixed inscription overhead
// (≈360 vB once, plus ≈100 vB per action; see fees.mjs).
//
// Locks are urgent (the counterparty is waiting for them): they flush after a short window, and
// everything queued by then rides along. Claims are not urgent (refund windows are 24–48h): they
// wait for the next lock flush, or flush on their own after claimMaxWaitMs.
// A lock id is "<inscriptionId>:<actionIndex>", so one inscription can carry locks of several deals.

export function batcher({ flush, lockWindowMs = 60e3, claimMaxWaitMs = 30 * 60e3, maxActions = 20, onFlush = () => {} }) {
  let queue = [], timer = null, timerAt = Infinity, busy = Promise.resolve();
  const stats = { inscriptions: 0, actions: 0 };

  const arm = (ms) => {
    const at = Date.now() + ms;
    if (at >= timerAt) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(run, Math.max(0, ms));
  };
  function run() {
    clearTimeout(timer); timer = null; timerAt = Infinity;
    const batch = queue.splice(0, maxActions);
    if (queue.length) arm(0);
    if (!batch.length) return busy;
    busy = busy.then(async () => {
      try {
        const ins = await flush(batch.map((q) => q.action));
        stats.inscriptions++; stats.actions += batch.length;
        onFlush({ ins, n: batch.length, kinds: batch.map((q) => q.kind) });
        batch.forEach((q, index) => q.resolve({ ins, index, id: `${ins}:${index}` }));
      } catch (e) {
        batch.forEach((q) => q.reject(e));
      }
    });
    return busy;
  }

  return {
    stats,
    avgBatch: () => (stats.inscriptions ? stats.actions / stats.inscriptions : 1),
    pending: () => queue.length,
    // kind: 'lock' (urgent) or 'claim'/'refund' (can wait)
    add(action, kind = 'lock') {
      return new Promise((resolve, reject) => {
        queue.push({ action, kind, resolve, reject });
        if (queue.length >= maxActions) arm(0);
        else arm(kind === 'lock' ? lockWindowMs : claimMaxWaitMs);
      });
    },
    flushNow: run,
  };
}
