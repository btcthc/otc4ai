import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { authInscription, redeemInscription, verifyInscription, authorityPubkey, digest, newSalt } from '../agent/tapsign.mjs';
import { limiter } from '../agent/limits.mjs';
import { lockAction } from '../otc/tap.js';

const priv = secp256k1.utils.randomPrivateKey();
const AUTH = 'a'.repeat(64) + 'i0';

test('authority creation signs sha256(JSON.stringify(auth) + salt) and recovers to our key', () => {
  const ins = authInscription(priv, ['tap', 'gib'], '0.123');
  assert.deepEqual(Object.keys(ins), ['p', 'op', 'sig', 'hash', 'salt', 'auth']);
  assert.equal(ins.hash, Buffer.from(digest(['tap', 'gib'], '0.123')).toString('hex'));
  assert.match(ins.sig.r, /^\d+$/); assert.match(ins.sig.s, /^\d+$/); assert.ok(['0', '1'].includes(ins.sig.v));
  assert.equal(verifyInscription(ins), authorityPubkey(priv));
});

test('a redeem with lock actions survives an inscription round trip (stringify, parse, verify)', () => {
  const lock = lockAction({ tick: 'GIB', amt: '1000000', claim: 'bc1p' + 'q'.repeat(58), refund: 'bc1p' + 'p'.repeat(58), hash: 'ab'.repeat(32), refundAfter: 950000, ref: 'deal-m', cp: 'bc1p' + 'q'.repeat(58) });
  const ins = redeemInscription(priv, { auth: AUTH, actions: [lock], data: {} });
  const onChain = JSON.parse(JSON.stringify(ins)); // what the indexer reads back
  assert.equal(verifyInscription(onChain), authorityPubkey(priv));
});

test('tampering with any signed field breaks the signature', () => {
  const ins = redeemInscription(priv, { auth: AUTH, items: [{ tick: 'tap', amt: '10', address: 'bc1p' + 'z'.repeat(58) }], data: '' });
  const moreTokens = JSON.parse(JSON.stringify(ins)); moreTokens.redeem.items[0].amt = '1000';
  assert.equal(verifyInscription(moreTokens), null);
  const otherSalt = JSON.parse(JSON.stringify(ins)); otherSalt.salt = '0.999';
  assert.equal(verifyInscription(otherSalt), null);
  const highS = JSON.parse(JSON.stringify(ins)); highS.sig.s = (secp256k1.CURVE.n - BigInt(ins.sig.s)).toString();
  assert.equal(verifyInscription(highS), null); // the indexer's verify_ecdsa rejects high-S too
});

test('redeems without data or with a placeholder authority are refused', () => {
  assert.throws(() => redeemInscription(priv, { auth: AUTH, actions: [] }), /data/);
  assert.throws(() => redeemInscription(priv, { auth: '<your authority inscription id>', actions: [], data: {} }), /authority/);
});

test('salts are fresh decimals', () => {
  const a = newSalt(), b = newSalt();
  assert.match(a, /^0\.\d{20}$/); assert.notEqual(a, b);
});

test('limits: per deal, rolling day, open exposure, allowed tickers, kill switch', () => {
  let t = Date.parse('2026-10-20T00:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otc-limits-'));
  const stop = path.join(dir, 'STOP'), statePath = path.join(dir, 'limits.json');
  const L = limiter({ perDealTap: 100, perDayTap: 250, maxOpenTap: 180, ticks: ['tap', 'gib'] }, { statePath, stopFile: stop, now: () => t });
  assert.equal(L.check({ tick: 'gib', valueTap: 120 }).ok, false);              // above per deal
  assert.equal(L.check({ tick: '$spky', valueTap: 10 }).ok, false);             // not allowed
  assert.equal(L.check({ tick: 'gib', valueTap: 90 }).ok, true); L.commit('d1', 90);
  assert.equal(L.check({ tick: 'gib', valueTap: 95 }).ok, false);               // 90 + 95 open > 180
  L.settle('d1');
  assert.equal(L.check({ tick: 'gib', valueTap: 95 }).ok, true); L.commit('d2', 95); L.settle('d2');
  assert.match(L.check({ tick: 'gib', valueTap: 80 }).why, /daily limit/);    // 90 + 95 + 80 > 250 within 24 h
  t += 864e5 + 1;                                                                // a day later the window has rolled
  assert.equal(L.check({ tick: 'gib', valueTap: 80 }).ok, true);
  fs.writeFileSync(stop, '');
  assert.match(L.check({ tick: 'gib', valueTap: 1 }).why, /kill switch/);
  fs.rmSync(stop);
  L.commit('d3', 50);
  const again = limiter({ perDealTap: 100, perDayTap: 250, maxOpenTap: 180 }, { statePath, now: () => t }); // restart keeps state
  assert.equal(again.state().openTap, 50);
});
