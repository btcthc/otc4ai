import { feeModel } from './fees.mjs';

// Example strategies. A policy tells the engine what to quote and whether to accept a deal;
// the bot loop decides what to post or take. Inventory is tracked locally (paper mode = simulated).

export const fmt = (x) => {
  const s = Number(x).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return s === '0' ? null : s;
};

// Market maker: quotes around a mid price with a spread, keeps a bid and an ask on the board.
export function marketMaker(cfg, agent, log) {
  const inv = { ...cfg.inventory }, fees = cfg.feeModel || feeModel(cfg.fees);
  const P = new Map(cfg.pairs.map((p) => [`${p.base}/${p.quote}`, { ...p }]));
  const posted = new Map();
  const has = (tick, amt) => (inv[tick] ?? 0) >= amt;
  const legs = (p, side, amt) => {
    // side is the requester's view: 'buy' = they buy base from me.
    // passFees: my network fee is added to the price, so it is a bigger share of small trades
    // and almost nothing on big ones.
    const edge = p.spread / 2 + (cfg.passFees ? fees.quote().usd / Math.max(1e-9, usd(p, amt)) : 0);
    const px = side === 'buy' ? p.mid * (1 + edge) : p.mid * (1 - edge);
    const quoteAmt = amt * px;
    return side === 'buy'
      ? { give: { tick: p.base, amt: fmt(amt) }, want: { tick: p.quote, amt: fmt(quoteAmt) }, gives: [p.base, amt] }
      : { give: { tick: p.quote, amt: fmt(quoteAmt) }, want: { tick: p.base, amt: fmt(amt) }, gives: [p.quote, quoteAmt] };
  };
  // Trade size in USD (pairs are quoted in TAP).
  const usd = (p, baseAmt) => fees.usdOf(baseAmt * p.mid, p.quote);
  const bigEnough = (p, baseAmt) => usd(p, baseAmt) >= fees.quote().minNotionalUsd;
  const policy = {
    pairs: () => [...P.keys()],
    info: () => { const q = fees.quote(); return { minUsd: Math.ceil(q.minNotionalUsd), feeUsd: +q.usd.toFixed(2), satPerVb: fees.st.satPerVb }; },
    quote({ side, tick, against, amt }) {
      const p = P.get(`${tick}/${against}`);
      if (!p || !['buy', 'sell'].includes(side)) return null;
      if (amt > p.maxBase || fees.paused() || !bigEnough(p, amt)) { log(`no quote for ${amt} ${tick}: ${amt > p.maxBase ? 'above max size' : fees.paused() ? 'network fee too high' : 'below the fee-efficient minimum'}`); return null; }
      const l = legs(p, side, amt);
      if (!l.give.amt || !l.want.amt || !has(...l.gives)) return null;
      return { give: l.give, want: l.want };
    },
    approve: (d) => has(d.offer.give.tick, Number(d.offer.give.amt)),
    settled(d) {
      const [out, inn] = d.role === 'maker' ? [d.offer.give, d.offer.want] : [d.offer.want, d.offer.give];
      inv[out.tick] = (inv[out.tick] ?? 0) - Number(out.amt);
      inv[inn.tick] = (inv[inn.tick] ?? 0) + Number(inn.amt);
      // fees are booked per inscription (fees.charge), so batching shows up in the paper P&L
      const st = fees.st, avg = st.inscriptions ? st.actions / st.inscriptions : 1;
      log(`inventory ${JSON.stringify(roundInv(inv))} · network fees so far $${st.spentUsd.toFixed(2)} (${st.inscriptions} inscriptions, ${avg.toFixed(1)} actions each)`);
    },
  };
  // Keep one bid and one ask per pair on the public board; drift the mid a little.
  const refresh = async () => {
    await fees.ready();
    for (const p of P.values()) {
      // never post an offer smaller than the fee-efficient minimum
      const minBase = fees.quote().minNotionalUsd / Math.max(1e-12, fees.usdOf(p.mid, p.quote));
      if (p.size < minBase) p.size = Math.ceil(minBase * 1.1);
      p.mid *= 1 + (Math.random() - 0.5) * (cfg.drift ?? 0.004);
      for (const side of ['buy', 'sell']) {
        const old = posted.get(p.base + side);
        if (old) agent.cancelOffer(old.oid);
        const l = legs(p, side, p.size);
        if (l.give.amt && l.want.amt && has(...l.gives)) posted.set(p.base + side, agent.postOffer(l.give, l.want, { ttl: 10 * 60e3, note: `${cfg.name} ${side === 'buy' ? 'ask' : 'bid'}` }));
      }
    }
  };
  return { policy, start: () => { refresh(); return setInterval(refresh, (cfg.refreshSec ?? 90) * 1000); }, inv, fees, feesUsd: () => fees.st.spentUsd };
}

// Taker: every N seconds asks for quotes on a random size and takes the best one if it is within its limit.
export function taker(cfg, agent, log) {
  const inv = { ...cfg.inventory }, fees = cfg.feeModel || feeModel(cfg.fees);
  const policy = {
    pairs: () => cfg.pairs.map((p) => `${p.base}/${p.quote}`),
    info: () => { const q = fees.quote(); return { minUsd: Math.ceil(q.minNotionalUsd), feeUsd: +q.usd.toFixed(2), satPerVb: fees.st.satPerVb }; },
    approve: () => false, // posts no offers of its own
    settled(d) {
      inv[d.offer.want.tick] = (inv[d.offer.want.tick] ?? 0) - Number(d.offer.want.amt);
      inv[d.offer.give.tick] = (inv[d.offer.give.tick] ?? 0) + Number(d.offer.give.amt);
      log(`inventory ${JSON.stringify(roundInv(inv))}`);
    },
  };
  const round = async () => {
    const p = cfg.pairs[Math.floor(Math.random() * cfg.pairs.length)];
    const side = Math.random() < 0.5 ? 'buy' : 'sell';
    await fees.ready();
    if (fees.paused()) return log(`network fee ${fees.st.satPerVb} sat/vB is above the limit; waiting`);
    // size at least the fee-efficient minimum (priced with this bot's own price limit)
    const minBase = 1.2 * fees.quote().minNotionalUsd / Math.max(1e-12, fees.usdOf(p.maxPrice, p.quote));
    const lo = Math.max(p.minBase, minBase), hi = Math.max(p.maxBase, lo);
    const amt = Math.round(lo + Math.random() * (hi - lo));
    const quotes = await agent.requestQuotes({ side, tick: p.base, against: p.quote, amt });
    const priced = quotes.map((q) => ({ q, px: side === 'buy' ? Number(q.offer.want.amt) / Number(q.offer.give.amt) : Number(q.offer.give.amt) / Number(q.offer.want.amt) }));
    const ok = priced.filter(({ px }) => (side === 'buy' ? px <= p.maxPrice : px >= p.minPrice));
    log(`rfq ${side} ${amt} ${p.base}: ${quotes.length} quote(s)${ok.length ? '' : ', none within limit'}`);
    if (!ok.length) return;
    ok.sort((a, b) => (side === 'buy' ? a.px - b.px : b.px - a.px));
    const best = ok[0];
    log(`taking ${best.q.offer.give.amt} ${best.q.offer.give.tick} for ${best.q.offer.want.amt} ${best.q.offer.want.tick} @ ${best.px.toPrecision(5)}`);
    agent.take(best.q);
  };
  return { policy, start: () => { setTimeout(round, 8000); return setInterval(() => round().catch((e) => log('round error ' + e.message)), (cfg.everySec ?? 40) * 1000); }, inv };
}

const roundInv = (inv) => Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4]));
export const STRATEGIES = { 'market-maker': marketMaker, taker };
