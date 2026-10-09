import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as tap from '../otc/tap.js';

const ADDR_M = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const ADDR_T = 'bc1pxwww0ct9ue7e8tdnlmug5m2tamfn7q06sahstg39ys4c9f3340qqxrdu9k';

test('hashlock hashes the hex preimage as raw bytes (ord-tap rule)', async () => {
  const s = 'ab'.repeat(32);
  assert.equal(await tap.hashOf(s), createHash('sha256').update(Buffer.from(s, 'hex')).digest('hex'));
  assert.match(tap.newSecret(), /^[0-9a-f]{64}$/);
  await assert.rejects(tap.hashOf('secret'));
});

test('amounts convert to atomic units with truncation', () => {
  assert.equal(tap.toAtomic('250', 18), 250n * 10n ** 18n);
  assert.equal(tap.toAtomic('1.5', 2), 150n);
  assert.equal(tap.toAtomic('1.239', 2), 123n);
});

test('both deal legs share the hash and point at each other', () => {
  const deal = { id: 'd1', hash: 'f'.repeat(64), t1: 1300, t2: 1200, takerAddr: ADDR_T,
    offer: { give: { tick: 'GIB', amt: '1000000' }, want: { tick: 'tap', amt: '250' }, addr: ADDR_M } };
  const { maker, taker } = tap.dealLegs(deal);
  assert.equal(maker.kind, 'otc'); assert.equal(maker.tick, 'gib');
  assert.equal(maker.claim, ADDR_T); assert.equal(maker.refund, ADDR_M); assert.equal(maker.refund_after, '1300');
  assert.equal(taker.claim, ADDR_M); assert.equal(taker.refund, ADDR_T); assert.equal(taker.refund_after, '1200');
  assert.equal(maker.condition.hash, taker.condition.hash);
  assert.equal(maker.data.cp, ADDR_T); assert.equal(taker.data.cp, ADDR_M);
});

test('refund windows keep the taker safe', () => {
  assert.deepEqual(tap.checkWindows(1300, 1200, 1000), []);
  assert.equal(tap.checkWindows(1250, 1200, 1000).length, 1); // gap < 72
  assert.equal(tap.checkWindows(1300, 1003, 1000).length, 1); // taker window too short
});

test('input validators', () => {
  assert.ok(tap.isAddr(ADDR_M)); assert.ok(!tap.isAddr('bc1pshort'));
  assert.ok(tap.isAmt('0.5')); assert.ok(!tap.isAmt('-1')); assert.ok(!tap.isAmt('1e5')); assert.ok(!tap.isAmt('0'));
  assert.ok(tap.isLockId('ab'.repeat(32) + 'i0:0')); assert.ok(!tap.isLockId('abc:0'));
});
