import test from 'node:test';
import assert from 'node:assert/strict';
import { perSideVbytes, feeQuote } from '../agent/fees.mjs';

test('per-side size matches a realistic lock + claim and shrinks with batching', () => {
  assert.equal(perSideVbytes(1), 920);        // measured: lock ≈ 514 vB + claim ≈ 444 vB
  assert.ok(perSideVbytes(5) < 400);          // 5 actions per inscription
});

test('fee quote and minimum trade size', () => {
  const q = feeQuote({ satPerVb: 2, btcUsd: 82700, batch: 1, maxFeePct: 1 });
  assert.equal(q.sats, 1840);
  assert.ok(Math.abs(q.usd - 1.52) < 0.02);
  assert.ok(Math.abs(q.minNotionalUsd - 152) < 2);
  const b = feeQuote({ satPerVb: 1, btcUsd: 82700, batch: 4, maxFeePct: 1 });
  assert.ok(b.usd < 0.35 && b.minNotionalUsd < 35); // 380 vB ≈ $0.31
});
