// Spending limits for a live bot wallet. Every lock the bot is about to create goes through check() first;
// commit() books it, settle() releases it from open exposure once the deal is claimed or refunded.
//   limits: { perDealTap, perDayTap, maxOpenTap, ticks?: ['tap', 'gib'] }  (values in TAP)
// The daily cap is a rolling 24 h window. A kill switch file (stopFile) blocks every new lock while it exists.
// State is saved to statePath so caps survive restarts.
import fs from 'node:fs';

export function limiter(limits, { statePath, stopFile, now = () => Date.now() } = {}) {
  let st = { spent: [], open: {} };
  try { if (statePath) st = { spent: [], open: {}, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch {}
  const save = () => { try { if (statePath) fs.writeFileSync(statePath, JSON.stringify(st, null, 2)); } catch {} };
  const day = () => { const from = now() - 864e5; st.spent = st.spent.filter((x) => x.t > from); return st.spent.reduce((a, x) => a + x.tap, 0); };
  const openTap = () => Object.values(st.open).reduce((a, x) => a + x, 0);
  const num = (x) => Math.round(x * 1e6) / 1e6;

  return {
    check({ tick, valueTap }) {
      if (stopFile && fs.existsSync(stopFile)) return { ok: false, why: 'kill switch is on (' + stopFile + ')' };
      if (!(valueTap > 0) || !Number.isFinite(valueTap)) return { ok: false, why: 'deal value is unknown' };
      if (limits.ticks?.length && !limits.ticks.includes(String(tick).toLowerCase())) return { ok: false, why: `${tick} is not on the allowed list` };
      if (valueTap > limits.perDealTap) return { ok: false, why: `${num(valueTap)} TAP is above the per-deal limit of ${limits.perDealTap}` };
      const d = day();
      if (d + valueTap > limits.perDayTap) return { ok: false, why: `daily limit: ${num(d)} of ${limits.perDayTap} TAP used in the last 24 h` };
      const o = openTap();
      if (o + valueTap > limits.maxOpenTap) return { ok: false, why: `open exposure limit: ${num(o)} of ${limits.maxOpenTap} TAP locked in unsettled deals` };
      return { ok: true };
    },
    commit(id, valueTap) { st.spent.push({ t: now(), tap: valueTap }); st.open[id] = valueTap; save(); },
    settle(id) { if (id in st.open) { delete st.open[id]; save(); } },
    state: () => ({ dayTap: num(day()), openTap: num(openTap()), openDeals: Object.keys(st.open).length, limits }),
  };
}
