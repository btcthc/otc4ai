import test from 'node:test';
import assert from 'node:assert/strict';
import { batcher } from '../agent/batch.mjs';
import { feeModel, inscriptionVbytes } from '../agent/fees.mjs';

test('claims wait and ride along with the next lock', async () => {
  const flushed = [];
  const b = batcher({ flush: async (a) => { flushed.push(a); return 'ab'.repeat(32) + 'i' + flushed.length; }, lockWindowMs: 30, claimMaxWaitMs: 5000 });
  const c1 = b.add({ op: 'claim', n: 1 }, 'claim');
  const c2 = b.add({ op: 'claim', n: 2 }, 'claim');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(flushed.length, 0);                 // claims alone do not flush yet
  const l = b.add({ op: 'lock' }, 'lock');
  const [r1, r2, rl] = await Promise.all([c1, c2, l]);
  assert.equal(flushed.length, 1);                 // one inscription for all three
  assert.equal(flushed[0].length, 3);
  assert.equal(rl.id, rl.ins + ':2');              // lock id points at its action index
  assert.equal(r1.ins, r2.ins);
  assert.equal(b.avgBatch(), 3);
});

test('maxActions flushes immediately and errors reach every caller', async () => {
  let calls = 0;
  const b = batcher({ flush: async () => { calls++; throw new Error('inscribe failed'); }, lockWindowMs: 10000, maxActions: 2 });
  const res = await Promise.allSettled([b.add({}, 'lock'), b.add({}, 'lock')]);
  assert.equal(calls, 1);
  assert.ok(res.every((r) => r.status === 'rejected' && /inscribe failed/.test(r.reason.message)));
});

test('fee booking: batching three actions costs much less than three inscriptions', () => {
  const f = feeModel({ fetchImpl: async () => ({ ok: false }) });
  Object.assign(f.st, { satPerVb: 2, btcUsd: 80000 });
  f.charge({ n: 3 });
  const batched = f.st.spentUsd;
  f.st.spentUsd = 0; f.charge({ n: 1 }); f.charge({ n: 1 }); f.charge({ n: 1 });
  assert.equal(inscriptionVbytes(3), 660);
  assert.ok(batched < 0.6 * f.st.spentUsd);        // 660 vB vs 1380 vB
});
