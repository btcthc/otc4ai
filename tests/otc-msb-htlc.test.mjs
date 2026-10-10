import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chainOf, checkCrossWindows, crossLegs, msbClient, msbLockDraft, msbPreimage, planCross, policyHash, refundEpoch, verifyMsbLock, BLOCK_MS,
} from '../otc/msb-htlc.js';
import { hashOf } from '../otc/tap.js';

const H = 3600e3, now = Date.parse('2026-11-02T12:00:00Z'), tip = 920000, at = { tip, now };
const T1 = 'trac1' + 'q'.repeat(58), T2 = 'trac1' + 'p'.repeat(58);
const B1 = 'bc1p' + 'q'.repeat(58), B2 = 'bc1p' + 'p'.repeat(58);
const secret = 'ab'.repeat(32);

test('MSB uses the same hashlock as TAP: sha256 of the raw 32-byte secret', async () => {
  assert.equal(await hashOf(secret), createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex'));
});

test('tnk settles on the MSB, everything else on TAP', () => {
  assert.equal(chainOf('TNK'), 'msb');
  assert.equal(chainOf('gib'), 'tap');
});

test('planned windows pass the check in both directions', () => {
  for (const c of ['tap', 'msb']) {
    const { first, second } = planCross(c, at);
    assert.deepEqual(checkCrossWindows(first, second, at), [], c);
  }
});

test('a TAP first leg must outlive the 24h MSB leg plus 12h even with fast blocks', () => {
  const { first, second } = planCross('tap', at);
  assert.ok((first.refundAfter - tip) * BLOCK_MS.fast >= second.refundAt - now + 12 * H);
  const short = { chain: 'tap', refundAfter: tip + 144 }; // the TAP-only taker window (~24h) is not enough here
  assert.match(checkCrossWindows(short, second, at).join(), /must stay open 12h/);
});

test('a TAP second leg is checked with slow blocks against the MSB first leg', () => {
  const first = { chain: 'msb', refundAt: now + 24 * H };
  assert.deepEqual(checkCrossWindows(first, { chain: 'tap', refundAfter: tip + 80 }, at), []);
  assert.match(checkCrossWindows(first, { chain: 'tap', refundAfter: tip + 100 }, at).join(), /must stay open 6h/); // 20h at 12 min/block
  assert.match(checkCrossWindows(first, { chain: 'tap', refundAfter: tip + 20 }, at).join(), /too close/);
});

test('refund epoch needs the epoch length', () => {
  assert.equal(refundEpoch(now + 24 * H, { now, epochNow: 100, epochMs: H }), 124n);
  assert.throws(() => refundEpoch(now + H, { now, epochNow: 1 }), /epoch length/);
});

test('lock draft: atomic amount, optional surcharge, deal commitment', async () => {
  const d = await msbLockDraft({ amt: '1.5', claim: T1, refund: T2, hash: 'h', refundAt: now + H, ref: 'd1-m' });
  assert.equal(d.am, '1500000000000000000');
  assert.equal(d.fa, '0');
  assert.equal('fr' in d, false);
  assert.equal(d.ph, await policyHash('d1-m'));
  const f = await msbLockDraft({ amt: '1', claim: T1, refund: T2, hash: 'h', refundAt: now, ref: 'x', fee: '0.01', feeTo: T1 });
  assert.equal(f.fa, '10000000000000000');
  assert.equal(f.fr, T1);
  await assert.rejects(msbLockDraft({ amt: '1', claim: B1, refund: T2, hash: 'h', refundAt: now, ref: 'x' }), /trac1/);
});

test('cross legs: maker gives TNK on the MSB, taker gives TAP on Bitcoin, addresses cross over', async () => {
  const hash = await hashOf(secret);
  const offer = { give: { tick: 'tnk', amt: '10' }, want: { tick: 'tap', amt: '2000' } };
  const L = await crossLegs({ id: 'd7', hash, offer, maker: { tap: B1, msb: T1 }, taker: { tap: B2, msb: T2 }, tip, now });
  assert.equal(L.maker.chain, 'msb');
  assert.equal(L.maker.lock.ca, T2); // taker receives TNK
  assert.equal(L.maker.lock.ra, T1);
  assert.equal(L.taker.chain, 'tap');
  assert.equal(L.taker.lock.claim, B1); // maker receives TAP
  assert.equal(L.taker.lock.refund, B2);
  assert.equal(L.taker.lock.condition.hash, hash);
  assert.deepEqual(checkCrossWindows(L.windows.first, L.windows.second, at), []);
  await assert.rejects(crossLegs({ id: 'x', hash, offer: { give: { tick: 'gib', amt: '1' }, want: { tick: 'tap', amt: '1' } }, maker: {}, taker: {}, tip, now }), /not a cross-chain/);
});

test('verify an escrow entry against the expected draft', async () => {
  const exp = await msbLockDraft({ amt: '10', claim: T2, refund: T1, hash: 'aa', refundAt: now, ref: 'd7-m' });
  const entry = { status: 'PENDING', amount: exp.am, claimRecipientAddress: T2, hashLock: 'AA', policyHash: exp.ph, refundEpoch: '130' };
  assert.deepEqual(verifyMsbLock(entry, exp, { minEpoch: 124 }), { ok: true, problems: [] });
  const bad = verifyMsbLock({ ...entry, status: 1, amount: '1', refundEpoch: '120' }, exp, { minEpoch: 124 });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 3);
  assert.equal(verifyMsbLock(null, exp).ok, false);
});

test('preimage is read only from a claimed entry and only if it matches', async () => {
  const hash = await hashOf(secret);
  assert.equal(await msbPreimage({ status: 'CLAIMED', preimage: secret.toUpperCase() }, hash), secret);
  assert.equal(await msbPreimage({ status: 'PENDING', preimage: secret }, hash), null);
  assert.equal(await msbPreimage({ status: 'CLAIMED', preimage: 'cd'.repeat(32) }, hash), null);
});

test('client calls the v1 HTLC routes', async () => {
  const calls = [];
  const fake = async (url, o) => { calls.push([o.method, url]); return { ok: true, json: async () => ({ htlc: { status: 'PENDING' } }) }; };
  const c = msbClient('http://node:5000/', fake);
  assert.deepEqual(await c.escrow('ab'), { status: 'PENDING' });
  await c.claim('ab', { tx: 1 });
  assert.deepEqual(calls, [['GET', 'http://node:5000/v1/htlc/ab'], ['POST', 'http://node:5000/v1/htlc/ab/claim']]);
});
