import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex, utf8 } from '@scure/base';
import { liveSettle } from '../agent/settle.mjs';
import { wallet } from '../agent/inscribe.mjs';
import { limiter } from '../agent/limits.mjs';
import { verifyInscription, authorityPubkey } from '../agent/tapsign.mjs';

const priv = hex.decode('0b'.repeat(32));
const w = wallet(priv, 'regtest');
const AUTH = 'c'.repeat(64) + 'i0';
const other = 'bcrt1p' + 'q'.repeat(58);

// Fake chain with a UTXO set like Esplora reports it: spent outputs disappear, new outputs to the bot
// (change, postage) appear at once, unconfirmed.
function fakeChain() {
  const sent = [];
  let set = [{ txid: 'f'.repeat(64), vout: 1, value: 200_000 }];
  const mine = hex.encode(w.script);
  return { sent, tipHeight: 1000, utxos: async () => set.slice(), feeRate: async () => 2,
    async broadcast(h) {
      const tx = btc.Transaction.fromRaw(hex.decode(h), { allowUnknownOutputs: true });
      for (let i = 0; i < tx.inputsLength; i++) { const inp = tx.getInput(i); set = set.filter((u) => !(u.txid === hex.encode(inp.txid) && u.vout === inp.index)); }
      for (let i = 0; i < tx.outputsLength; i++) { const o = tx.getOutput(i); if (hex.encode(o.script) === mine) set.push({ txid: tx.id, vout: i, value: Number(o.amount) }); }
      sent.push(h); return tx.id;
    },
    async tip() { return this.tipHeight; }, confirmed: async () => true };
}
// Fake ord-tap: locks appear after `appearAfter` lookups.
async function fakeIndexer(records) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    let body = { result: null };
    if (u.startsWith('/r/tap/getDeployment/')) body = { result: { dec: 18 } };
    else if (u.startsWith('/r/tap/getLock/')) { const id = u.split('/').pop(), r = records[id]; if (r && --r.appearAfter < 0) body = { result: r.rec }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
const redeemOf = (rawTx) => {
  const tx = btc.Transaction.fromRaw(hex.decode(rawTx), { allowUnknownOutputs: true });
  const [ins] = ordinals.parseWitness(tx.inputs[0].finalScriptWitness);
  return JSON.parse(utf8.encode(ins.body));
};
const deal = (tapAmt) => ({ id: 'abcdef0123456789', hash: 'ab'.repeat(32), t1: 1288, t2: 1144, takerAddr: other,
  offer: { give: { tick: 'gib', amt: '1000000' }, want: { tick: 'tap', amt: String(tapAmt) }, addr: w.address } });

function setup(indexer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otc-live-'));
  const chain = fakeChain();
  const s = liveSettle({ w, priv, chain, indexer, auth: AUTH, pollMs: 20, verifyWaitMs: 2000,
    limits: limiter({ perDealTap: 500, perDayTap: 2000, maxOpenTap: 1000 }, { statePath: path.join(dir, 'limits.json') }),
    statePath: path.join(dir, 'locks.json') });
  return { s, chain };
}

test('live: a lock above the per-deal limit is refused before anything is signed', async () => {
  const { s, chain } = setup('http://127.0.0.1:9');
  await assert.rejects(s.lock(deal(900), 'maker'), /limit: .*per-deal/);
  assert.equal(chain.sent.length, 0);
});

test('live: a maker lock is signed by the bot authority and inscribed as commit + reveal', async () => {
  const { s, chain } = setup('http://127.0.0.1:9');
  const id = await s.lock(deal(250), 'maker');
  assert.equal(chain.sent.length, 2);
  const ins = redeemOf(chain.sent[1]);
  assert.equal(verifyInscription(ins), authorityPubkey(priv));
  assert.equal(ins.redeem.auth, AUTH);
  const [a] = ins.redeem.actions;
  assert.deepEqual([a.op, a.kind, a.tick, a.amt, a.claim, a.refund, a.refund_after], ['lock', 'otc', 'gib', '1000000', other, w.address, '1288']);
  assert.match(id, /^[0-9a-f]{64}i0:0$/);
  assert.equal(s.limits.state().openTap, 250);
});

test('live: verify waits until the counterparty lock is indexed, then checks it', async () => {
  const lockId = 'd'.repeat(64) + 'i0:0';
  const rec = { kind: 'otc', tick: 'tap', claim: w.address, refund_after: '1144', condition: { hash: 'ab'.repeat(32) }, amt: '250000000000000000000' };
  const idx = await fakeIndexer({ [lockId]: { appearAfter: 3, rec } });
  try {
    const { s } = setup(idx.url);
    const r = await s.verify(deal(250), 'taker', lockId);
    assert.equal(r.ok, true, r.problems.join('; '));
  } finally { idx.close(); }
});

test('live: an expired own lock is refunded by the watcher', async () => {
  const idx = await fakeIndexer({});
  try {
    const { s, chain } = setup(idx.url);
    const id = await s.lock(deal(100), 'maker');
    await s.watchRefunds();                       // tip 1000 < refund_after 1288: nothing yet
    assert.equal(chain.sent.length, 2);
    chain.tipHeight = 1288;
    await s.watchRefunds();
    await new Promise((r) => setTimeout(r, 50));  // the refund batch flushes asynchronously
    assert.equal(chain.sent.length, 4);
    assert.deepEqual(redeemOf(chain.sent[3]).redeem.actions, [{ op: 'refund', lock: id }]);
  } finally { idx.close(); }
});
