// TNK settlement on the Trac MSB for OTC4AI: HTLC lock / claim / refund (MSB branch feature-implement-htlc).
// The MSB hashlock is SHA-256 of a 32-byte preimage, the same rule as the TAP `lock` (see tap.js hashOf),
// so one secret settles a TNK⇄TAP deal atomically. Provisional: the MSB HTLC RPC is not released yet;
// field names follow proto/applyOperations/messages/htlc_lock_operation.proto and proto/state/escrow_entry.proto.
// Never touches private keys: lock drafts are signed by the owner's MSB wallet.

import { hashOf, lockAction, sha256Hex, toAtomic } from './tap.js';

export const TNK = { tick: 'tnk', dec: 18 };
export const isTracAddr = (a) => /^trac1[02-9ac-hj-np-z]{58}$/.test(String(a || '').trim());
export const chainOf = (tick) => (String(tick).toLowerCase() === TNK.tick ? 'msb' : 'tap');

const H = 3600e3;
// Bitcoin heights are converted to wall-clock time pessimistically: fast blocks for the leg that must
// stay open longer, slow blocks for the leg that must close first.
export const BLOCK_MS = { fast: 8 * 60e3, slow: 12 * 60e3 };
// Time the taker needs to claim the first leg after the secret is out: a Bitcoin claim must confirm,
// an MSB claim settles in seconds.
export const GAP_MS = { tap: 12 * H, msb: 6 * H };
// "usually 24hrs refund window" (Benny, Trac Discord, 2026-10-10).
export const MSB_REFUND_MS = 24 * H;
const MIN_SECOND_MS = 6 * H; // the maker needs time to claim the second leg

// Wall-clock deadline of a leg: { chain: 'tap', refundAfter } (block height) or { chain: 'msb', refundAt } (ms).
export function legDeadline(leg, { tip, now }, bound) {
  return leg.chain === 'msb' ? Number(leg.refundAt) : now + (Number(leg.refundAfter) - tip) * BLOCK_MS[bound];
}

// The first leg (locked by the maker, who holds the secret) must outlive the second by the taker's claim gap.
export function checkCrossWindows(first, second, at) {
  const errs = [];
  if (!(legDeadline(second, at, 'fast') >= at.now + MIN_SECOND_MS)) errs.push('second leg refund is too close');
  const gap = legDeadline(first, at, 'fast') - legDeadline(second, at, 'slow');
  if (!(gap >= GAP_MS[first.chain])) errs.push(`first leg must stay open ${GAP_MS[first.chain] / H}h after the second closes (now ${Math.floor(gap / H)}h)`);
  return errs;
}

// Refund windows for a deal whose first leg is on `firstChain`. The MSB leg always gets the usual 24h.
export function planCross(firstChain, { tip, now }) {
  const slack = 2 * H; // the taker locks after the first leg is confirmed
  if (firstChain === 'tap') {
    const second = { chain: 'msb', refundAt: now + slack + MSB_REFUND_MS };
    return { first: { chain: 'tap', refundAfter: tip + Math.ceil((slack + MSB_REFUND_MS + GAP_MS.tap) / BLOCK_MS.fast) }, second };
  }
  const first = { chain: 'msb', refundAt: now + MSB_REFUND_MS };
  return { first, second: { chain: 'tap', refundAfter: tip + Math.floor((MSB_REFUND_MS - GAP_MS.msb - slack) / BLOCK_MS.slow) } };
}

// MSB refund times are epochs; their length comes from the network's consensus config.
export function refundEpoch(refundAt, { now, epochNow, epochMs }) {
  if (!(epochMs > 0)) throw new Error('MSB epoch length unknown: set epochMs');
  return BigInt(epochNow) + BigInt(Math.ceil((refundAt - now) / epochMs));
}

// Commits a lock to one OTC4AI deal leg, so both sides can recognise it on the MSB.
export const policyHash = (ref) => sha256Hex(new TextEncoder().encode(`otc4ai:${ref}`));

// Unsigned HtlcLockOperation fields. `fa`/`fr`: optional surcharge paid on claim (e.g. a maker-paid fee).
export async function msbLockDraft({ amt, claim, refund, hash, refundAt, ref, fee, feeTo }) {
  if (!isTracAddr(claim) || !isTracAddr(refund)) throw new Error('claim and refund must be trac1 addresses');
  const fa = fee ? toAtomic(fee, TNK.dec) : 0n;
  if (fa > 0n && !isTracAddr(feeTo)) throw new Error('fee recipient must be a trac1 address');
  return {
    op: 'htlc_lock', ca: claim, ra: refund, am: String(toAtomic(amt, TNK.dec)), fa: String(fa), ...(fa > 0n ? { fr: feeTo } : {}),
    hl: hash, refundAt, ph: await policyHash(ref),
  };
}

// The two legs of a cross-chain deal. Each side has an address per chain: { tap: 'bc1p…', msb: 'trac1…' }.
export async function crossLegs({ id, hash, offer, maker, taker, tip, now }) {
  const c1 = chainOf(offer.give.tick), c2 = chainOf(offer.want.tick);
  if (c1 === c2) throw new Error('not a cross-chain deal');
  const w = planCross(c1, { tip, now });
  const leg = (chain, give, to, from, win, ref) => chain === 'msb'
    ? msbLockDraft({ amt: give.amt, claim: to.msb, refund: from.msb, hash, refundAt: win.refundAt, ref })
    : lockAction({ tick: give.tick, amt: give.amt, claim: to.tap, refund: from.tap, hash, refundAfter: win.refundAfter, ref, cp: to.tap });
  return {
    windows: w,
    maker: { chain: c1, lock: await leg(c1, offer.give, taker, maker, w.first, id + '-m') },
    taker: { chain: c2, lock: await leg(c2, offer.want, maker, taker, w.second, id + '-t') },
  };
}

const lc = (x) => String(x ?? '').toLowerCase();
const PENDING = new Set(['0', 'pending']), CLAIMED = new Set(['1', 'claimed']);

// Compare an MSB escrow entry with the expected draft. `minEpoch`: the latest refund epoch the plan allows.
export function verifyMsbLock(entry, expected, { minEpoch } = {}) {
  if (!entry) return { ok: false, problems: ['lock not found on the MSB'] };
  const p = [];
  const eq = (a, b, what) => { if (lc(a) !== lc(b)) p.push(`${what}: ${a} ≠ ${b}`); };
  if (!PENDING.has(lc(entry.status))) p.push(`status is ${entry.status}, not PENDING`);
  eq(entry.claimRecipientAddress, expected.ca, 'claim address');
  eq(entry.hashLock, expected.hl, 'hashlock');
  eq(entry.policyHash, expected.ph, 'deal commitment');
  if (BigInt(entry.amount ?? 0) < BigInt(expected.am)) p.push(`amount too small: ${entry.amount} < ${expected.am}`);
  if (minEpoch !== undefined && BigInt(entry.refundEpoch ?? 0) < BigInt(minEpoch)) p.push(`refund epoch ${entry.refundEpoch} is earlier than ${minEpoch}`);
  return { ok: p.length === 0, problems: p };
}

// Once the maker claims an MSB lock, its escrow entry carries the preimage.
export async function msbPreimage(entry, hash) {
  if (!entry || !CLAIMED.has(lc(entry.status)) || typeof entry.preimage !== 'string') return null;
  const s = entry.preimage.toLowerCase();
  return (await hashOf(s).catch(() => '')) === lc(hash) ? s : null;
}

// Thin RPC client for an MSB node (routes from rpc/routes/v1.js on the HTLC branch).
export function msbClient(base, fetchFn = fetch) {
  const root = String(base || '').replace(/\/+$/, '') + '/v1';
  const call = async (method, path, body) => {
    const r = await fetchFn(root + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error(`MSB ${method} ${path} → ${r.status}`);
    return r.json();
  };
  return {
    escrow: async (id) => (await call('GET', `/htlc/${encodeURIComponent(id)}`)).htlc ?? null,
    lock: (signedTx) => call('POST', '/htlc', signedTx),
    claim: (id, signedTx) => call('POST', `/htlc/${encodeURIComponent(id)}/claim`, signedTx),
    refund: (id, signedTx) => call('POST', `/htlc/${encodeURIComponent(id)}/refund`, signedTx),
  };
}
