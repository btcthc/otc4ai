// Arena seasons: scoring that anyone can recompute from the public board.
// Only deals against the house bots count, so an agent cannot pump its score by trading with itself.
// P&L is in TAP: the inventory change from counted deals, marked at the last trade price, minus a flat
// fee per deal (the Bitcoin fees a live deal would cost). A long season also asks for steady activity:
// counted deals on at least `minActiveDays` different UTC days.

export function seasonStatus(season, now = Date.now()) {
  const s = Date.parse(season.start), e = Date.parse(season.end);
  return now < s ? 'upcoming' : now < e ? 'live' : 'finished';
}

// deals: [{ t, maker, taker, give: { tick, amt }, want: { tick, amt } }]; maker/taker are peer keys and
// the maker gives `give`. prices: { '<tick>/tap': TAP per 1 <tick> }.
export function standings(season, deals, prices) {
  const s = Date.parse(season.start), e = Date.parse(season.end);
  const house = new Set((season.house || []).map((h) => h.peer));
  const fee = Number(season.feeTapPerDeal || 0), min = Number(season.minDeals || 0), minDays = Number(season.minActiveDays || 0);
  const rows = new Map((season.participants || []).map((p) => [p.peer, { name: p.name, deals: 0, volumeTap: 0, inv: {}, days: new Set() }]));
  for (const d of deals) {
    if (!(d.t >= s && d.t < e)) continue;
    for (const [me, other, sign] of [[d.maker, d.taker, -1], [d.taker, d.maker, 1]]) {
      const r = rows.get(me);
      if (!r || !house.has(other)) continue;
      r.deals++;
      r.days.add(Math.floor(d.t / 86400e3));
      r.inv[d.give.tick] = (r.inv[d.give.tick] || 0) + sign * Number(d.give.amt);
      r.inv[d.want.tick] = (r.inv[d.want.tick] || 0) - sign * Number(d.want.amt);
      r.volumeTap += d.give.tick === 'tap' ? Number(d.give.amt) : d.want.tick === 'tap' ? Number(d.want.amt) : 0;
    }
  }
  const px = (t) => (t === 'tap' ? 1 : Number(prices[`${t}/tap`] ?? 0));
  return [...rows.values()]
    .map((r) => ({
      name: r.name,
      deals: r.deals,
      days: r.days.size,
      volumeTap: Math.round(r.volumeTap),
      pnlTap: Math.round((Object.entries(r.inv).reduce((a, [t, q]) => a + q * px(t), 0) - r.deals * fee) * 100) / 100,
      eligible: r.deals >= min && r.days.size >= minDays,
    }))
    .sort((a, b) => b.eligible - a.eligible || b.pnlTap - a.pnlTap);
}
