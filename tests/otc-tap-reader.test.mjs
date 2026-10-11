import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as tap from '../otc/tap.js';

// A fake public TAP reader: no /r/tap routes (404, like tap-reader-tw.tap-hosting.xyz), but deployments and
// token-auth redeem lists, oldest first, paged with offset/max.
async function fakeReader() {
  const redeems = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
    const page = (list) => list.slice(Number(u.searchParams.get('offset') || 0), Number(u.searchParams.get('offset') || 0) + Number(u.searchParams.get('max') || 100));
    let body = null;
    if (p.startsWith('/getDeployment/')) body = { result: { dec: 18 } };
    else if (p === '/getCurrentBlock') body = { result: 1000 };
    else if (p === '/getRedeemListLength') body = { result: redeems.length };
    else if (p === '/getRedeemList') body = { result: page(redeems) };
    else if (p.startsWith('/getAccountRedeemListLength/')) body = { result: redeems.filter((r) => r.addr === p.split('/').pop()).length };
    else if (p.startsWith('/getAccountRedeemList/')) body = { result: page(redeems.filter((r) => r.addr === p.split('/').pop())) };
    res.statusCode = body ? 200 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body || { message: `Route GET:${p} not found`, statusCode: 404 }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, redeems, close: () => srv.close() };
}

const maker = 'bc1p' + 'm'.repeat(58), taker = 'bc1p' + 't'.repeat(58), other = 'bc1p' + 'o'.repeat(58);
const ins = (n) => n.toString(16).padStart(64, '0') + 'i0';
async function setup() {
  const secret = tap.newSecret(), hash = await tap.hashOf(secret);
  const d = { id: 'feed01', hash, t1: 1288, t2: 1144, takerAddr: taker, offer: { give: { tick: 'gib', amt: '100' }, want: { tick: 'tap', amt: '2' }, addr: maker } };
  const legs = tap.dealLegs(d);
  const r = await fakeReader();
  for (let i = 0; i < 150; i++) r.redeems.push({ addr: i % 2 ? maker : other, ins: ins(1000 + i), blck: 900 + (i >> 4), rdm: { actions: [{ op: 'unstake' }] } });
  r.redeems.push({ addr: maker, ins: ins(7), blck: 990, rdm: { auth: ins(1), actions: [{ op: 'claim-rwd' }, legs.maker], data: {} } });
  return { r, d, legs, secret, hash, lockId: ins(7) + ':1' };
}

test('reader: a lock is found through the redeem that created it and checked like a getLock record', async () => {
  const { r, legs, lockId } = await setup();
  try {
    const ok = await tap.verifyLock(r.url, lockId, legs.maker, 1000);
    assert.equal(ok.ok, true, ok.problems.join('; '));
    const bad = await tap.verifyLock(r.url, lockId, { ...legs.maker, claim: other }, 1000);
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join(';'), /claim address/);
    const missing = await tap.verifyLock(r.url, ins(8) + ':0', legs.maker, 1000);
    assert.match(missing.problems[0], /not found/);
  } finally { r.close(); }
});

test('reader: a claim in anyone\'s redeem consumes the lock and reveals the secret', async () => {
  const { r, lockId, secret, hash } = await setup();
  try {
    assert.equal(await tap.lockConsumed(r.url, lockId), false);
    assert.equal(await tap.findPreimage(r.url, lockId, hash), null);
    r.redeems.push({ addr: taker, ins: ins(9), blck: 995, rdm: { actions: [tap.claimAction(lockId, secret)] } });
    assert.equal(await tap.lockConsumed(r.url, lockId), true);
    assert.equal(await tap.findPreimage(r.url, lockId, hash), secret);
    assert.equal(await tap.findPreimage(r.url, lockId, 'ab'.repeat(32)), null); // a preimage that does not match the hash is ignored
  } finally { r.close(); }
});
