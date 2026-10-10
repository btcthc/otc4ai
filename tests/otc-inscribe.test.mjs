import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex, utf8 } from '@scure/base';
import { wallet, buildInscription, buildTap, rawHex, POSTAGE, DUST_GUARD } from '../agent/inscribe.mjs';

const priv = hex.decode('0a'.repeat(32));
const txid = (n) => n.toString(16).padStart(64, '0');

test('bot addresses use the right prefix per network', () => {
  assert.match(wallet(priv, 'mainnet').address, /^bc1p/);
  assert.match(wallet(priv, 'signet').address, /^tb1p/);
  assert.match(wallet(priv, 'regtest').address, /^bcrt1p/);
});

test('commit + reveal: the reveal carries the TAP JSON as text/plain and lands on the bot address', () => {
  const w = wallet(priv, 'regtest');
  const json = { p: 'tap', op: 'token-auth', cancel: 'b'.repeat(64) + 'i0' };
  const { commit, reveal, inscriptionId, feeSats } = buildInscription(w, json, [{ txid: txid(1), vout: 0, value: 50_000 }], 2);
  // the commit pays the reveal address exactly what the reveal needs, change returns to the bot
  assert.equal(commit.outputsLength, 2);
  assert.equal(btc.Address(w.network).encode(btc.OutScript.decode(commit.getOutput(1).script)), w.address);
  // the reveal spends commit:0 and sends POSTAGE to the bot
  const r = btc.Transaction.fromRaw(hex.decode(rawHex(reveal)), { allowUnknownOutputs: true });
  assert.equal(hex.encode(r.getInput(0).txid), commit.id);
  assert.equal(r.getOutput(0).amount, POSTAGE);
  assert.equal(btc.Address(w.network).encode(btc.OutScript.decode(r.getOutput(0).script)), w.address);
  const [ins] = ordinals.parseWitness(r.inputs[0].finalScriptWitness);
  assert.equal(ins.tags.contentType, 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(utf8.encode(ins.body)), json);
  assert.equal(inscriptionId, reveal.id + 'i0');
  // fees: inputs = outputs + fee
  const out = (tx) => Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i).amount).reduce((a, b) => a + b, 0n);
  assert.equal(50_000n - out(commit) + (out(commit) - (commit.getOutput(1).amount) - POSTAGE), BigInt(feeSats));
  assert.ok(feeSats > 0 && feeSats < 5_000);
});

test('small UTXOs (inscriptions, transferables) are never spent as fee inputs', () => {
  const w = wallet(priv, 'regtest');
  const utxos = [{ txid: txid(2), vout: 0, value: 546 }, { txid: txid(3), vout: 1, value: Number(DUST_GUARD) }, { txid: txid(4), vout: 0, value: 30_000 }];
  const { commit } = buildInscription(w, { p: 'tap' }, utxos, 1);
  assert.equal(commit.inputsLength, 1);
  assert.equal(hex.encode(commit.getInput(0).txid), txid(4));
  assert.throws(() => buildInscription(w, { p: 'tap' }, utxos.slice(0, 2), 1), /not enough BTC/);
});

test('tap: the inscription input comes first and returns to the bot address on output 0', () => {
  const w = wallet(priv, 'regtest');
  const inscribed = { txid: txid(5), vout: 0, value: 546 };
  const tx = buildTap(w, inscribed, [inscribed, { txid: txid(6), vout: 2, value: 20_000 }], 2);
  assert.equal(hex.encode(tx.getInput(0).txid), txid(5));
  assert.equal(tx.getOutput(0).amount, 546n);
  assert.equal(btc.Address(w.network).encode(btc.OutScript.decode(tx.getOutput(0).script)), w.address);
  assert.ok(tx.getOutput(1).amount < 20_000n);
});
