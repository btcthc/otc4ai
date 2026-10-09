import test from 'node:test';
import assert from 'node:assert/strict';
import { OtcAgent } from '../agent/engine.mjs';
import { paperSettle } from '../agent/settle.mjs';
import { marketMaker, taker } from '../agent/bots.mjs';

const ADDR_M = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const ADDR_T = 'bc1pxwww0ct9ue7e8tdnlmug5m2tamfn7q06sahstg39ys4c9f3340qqxrdu9k';

// In-memory sidechannel: every message is delivered to every other agent, like a broadcast topic.
function bus(agents) {
  for (const a of agents) {
    a.ready = true;
    a.ws = { send: (raw) => { const { message } = JSON.parse(raw); setImmediate(() => agents.filter((b) => b !== a).forEach((b) => b.onMsg(a.me, message))); } };
  }
}
const mk = (name, me, addr) => new OtcAgent({ bridge: 'x', token: 'x', channel: 'otc4ai', name, addr, settle: paperSettle(), policy: { pairs: () => [] }, tipHeight: async () => 900000 });

test('bot-to-bot RFQ deal settles end to end in paper mode', async () => {
  const M = mk('mm', 'aa'.repeat(32), ADDR_M), T = mk('tk', 'bb'.repeat(32), ADDR_T);
  M.me = 'aa'.repeat(32); T.me = 'bb'.repeat(32);
  const log = () => {};
  const mm = marketMaker({ name: 'mm', pairs: [{ base: 'gib', quote: 'tap', mid: 0.00025, spread: 0.02, size: 1e6, maxBase: 5e6 }], inventory: { gib: 1e7, tap: 1000 } }, M, log);
  const tk = taker({ pairs: [] , inventory: { gib: 0, tap: 1000 } }, T, log);
  M.policy = mm.policy; T.policy = tk.policy;
  bus([M, T]);

  const quotes = await T.requestQuotes({ side: 'buy', tick: 'gib', against: 'tap', amt: 1000000, wait: 50 });
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].offer.give.tick, 'gib');
  assert.equal(quotes[0].offer.want.amt, '252.5'); // 1e6 * 0.00025 * 1.01

  const done = new Promise((res) => T.on('deal', (d) => d.end && res(d)));
  T.take(quotes[0]);
  const d = await done;
  assert.equal(d.end, 'done');
  assert.equal(d.makerLock, `paper:${d.id}:maker`);
  assert.equal(d.takerLock, `paper:${d.id}:taker`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(M.deals.get(d.id).end, 'done');
  assert.equal(mm.inv.gib, 9e6);
  assert.equal(mm.inv.tap, 1252.5);
  assert.equal(tk.inv.gib, 1e6);
});

test('taker refuses a deal whose refund windows are unsafe', async () => {
  const M = mk('mm', '', ADDR_M), T = mk('tk', '', ADDR_T);
  M.me = 'cc'.repeat(32); T.me = 'dd'.repeat(32);
  T.policy = { pairs: () => [] };
  M.policy = { pairs: () => [], approve: () => true };
  bus([M, T]);
  const offer = M.postOffer({ tick: 'gib', amt: '10' }, { tick: 'tap', amt: '1' });
  M.tipHeight = async () => 900000;
  T.tipHeight = async () => 900200; // taker sees a much later block: maker's windows are already too short
  const done = new Promise((res) => T.on('deal', (d) => d.end && res(d)));
  T.take({ offer, from: M.me });
  const d = await done;
  assert.equal(d.end, 'failed');
});

test('a forged secret does not complete the deal', async () => {
  const T = mk('tk', '', ADDR_T); T.me = 'ee'.repeat(32);
  T.policy = { pairs: () => [] }; T.ready = true; T.ws = { send() {} };
  const d = { id: '0123456789abcdef', role: 'taker', state: 'takerLocked', peer: 'ff'.repeat(32), hash: 'a'.repeat(64), offer: {}, touched: Date.now() };
  T.deals.set(d.id, d);
  T.onMsg(d.peer, { app: 'otc4ai', v: 1, t: 'claimed', to: T.me, did: d.id, preimage: 'b'.repeat(64) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.state, 'takerLocked');
});
