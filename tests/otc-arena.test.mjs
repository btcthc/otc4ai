import test from 'node:test';
import assert from 'node:assert/strict';
import { standings, seasonStatus } from '../agent/arena.mjs';

const season = {
  start: '2026-10-19T00:00:00Z', end: '2026-10-26T00:00:00Z', minDeals: 2, feeTapPerDeal: 1,
  house: [{ name: 'mm-1', peer: 'H1' }, { name: 'taker-1', peer: 'H2' }],
  participants: [{ name: 'alice', peer: 'A' }, { name: 'bob', peer: 'B' }],
};
const t = Date.parse('2026-10-20T12:00:00Z');
const gib = (amt) => ({ tick: 'gib', amt: String(amt) }), tap = (amt) => ({ tick: 'tap', amt: String(amt) });

test('season status follows the dates', () => {
  assert.equal(seasonStatus(season, Date.parse('2026-10-18T23:59:59Z')), 'upcoming');
  assert.equal(seasonStatus(season, t), 'live');
  assert.equal(seasonStatus(season, Date.parse('2026-10-26T00:00:00Z')), 'finished');
});

test('a maker selling to the house taker above the mark earns the spread minus fees', () => {
  // alice (maker) gives 1,000,000 gib for 260 tap twice; mark 0.00025 tap/gib
  const deals = [1, 2].map((i) => ({ t: t + i, maker: 'A', taker: 'H2', give: gib(1e6), want: tap(260) }));
  const [a] = standings(season, deals, { 'gib/tap': 0.00025 });
  assert.equal(a.name, 'alice');
  assert.equal(a.deals, 2);
  assert.equal(a.volumeTap, 520);
  assert.equal(a.pnlTap, 2 * (260 - 250) - 2 * 1); // +20 spread, -2 fees
  assert.equal(a.eligible, true);
});

test('a taker buying from the house maker pays the spread', () => {
  // bob takes mm-1's ask: mm-1 gives 1,000,000 gib, wants 252 tap
  const deals = [{ t, maker: 'H1', taker: 'B', give: gib(1e6), want: tap(252) }];
  const rows = standings(season, deals, { 'gib/tap': 0.00025 });
  const b = rows.find((r) => r.name === 'bob');
  assert.equal(b.pnlTap, 250 - 252 - 1);
  assert.equal(b.eligible, false); // below minDeals
});

test('self-trades, unregistered agents and deals outside the season do not count', () => {
  const deals = [
    { t, maker: 'A', taker: 'B', give: gib(1e6), want: tap(999) },               // participant vs participant
    { t, maker: 'A', taker: 'X', give: gib(1e6), want: tap(999) },               // vs unknown agent
    { t: Date.parse('2026-10-27T00:00:00Z'), maker: 'A', taker: 'H2', give: gib(1e6), want: tap(999) }, // after the end
  ];
  for (const r of standings(season, deals, { 'gib/tap': 0.00025 })) { assert.equal(r.deals, 0); assert.equal(r.pnlTap, 0); }
});

test('eligible agents rank above ineligible ones, then by P&L', () => {
  const deals = [
    ...[1, 2].map((i) => ({ t: t + i, maker: 'A', taker: 'H2', give: gib(1e6), want: tap(251) })), // alice: 2 deals, small edge
    { t, maker: 'B', taker: 'H2', give: gib(1e6), want: tap(300) },                                 // bob: 1 big deal, ineligible
  ];
  assert.deepEqual(standings(season, deals, { 'gib/tap': 0.00025 }).map((r) => r.name), ['alice', 'bob']);
});
