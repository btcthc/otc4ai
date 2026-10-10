// Bitcoin fee model for live settlement. Each side of a deal inscribes two token-auth redeems
// (lock + claim); batching several actions into one redeem shares the fixed inscription overhead.
// Bots use it to refuse deals whose fees would eat more than maxFeePct of the trade.

// Measured on realistic minified redeems (tests/otc-fees.test.mjs): one action ≈ 100 vB of
// payload, one inscription (commit + reveal envelope) ≈ 360 vB fixed.
export const VBYTES = { inscription: 360, action: 100 };

export function perSideVbytes(batch = 1) {
  const b = Math.max(1, batch);
  // lock + claim, each sharing an inscription with b-1 other actions
  return 2 * (VBYTES.inscription / b + VBYTES.action);
}

export function feeQuote({ satPerVb, btcUsd, batch = 1, maxFeePct = 1 }) {
  const sats = Math.ceil(perSideVbytes(batch) * satPerVb);
  const usd = (sats / 1e8) * btcUsd;
  return { sats, usd, minNotionalUsd: usd / (maxFeePct / 100) };
}

// Live inputs with safe fallbacks; refreshed every 10 minutes.
export function feeModel({ maxFeePct = 1, batch = 1, maxSatPerVb = 20, fetchImpl = fetch } = {}) {
  const st = { satPerVb: 2, btcUsd: 80000, tapUsd: 0.05, at: 0 };
  const getJson = (u) => fetchImpl(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(u + ' ' + r.status))));
  async function refresh() {
    // Our refund windows are 24–48h, so the cheap "hour" rate confirms in time.
    await getJson('https://mempool.space/api/v1/fees/recommended').then((f) => { st.satPerVb = Math.max(1, f.hourFee || f.economyFee || st.satPerVb); }).catch(() => {});
    await getJson('https://mempool.space/api/v1/prices').then((p) => { if (p.USD) st.btcUsd = p.USD; }).catch(() => {});
    await getJson('https://api.coingecko.com/api/v3/simple/price?ids=tapify&vs_currencies=usd').then((p) => { if (p.tapify?.usd) st.tapUsd = p.tapify.usd; }).catch(() => {});
    st.at = Date.now();
  }
  const m = {
    st, refresh, maxFeePct, batch,
    async ready() { if (Date.now() - st.at > 10 * 60e3) await refresh(); return m; },
    quote() { return feeQuote({ satPerVb: st.satPerVb, btcUsd: st.btcUsd, batch, maxFeePct }); },
    // Fee spikes: stop trading instead of paying a bad rate.
    paused: () => st.satPerVb > maxSatPerVb,
    usdOf: (amt, tick, midInTap = 1) => Number(amt) * (tick === 'tap' ? 1 : midInTap) * st.tapUsd,
  };
  return m;
}
