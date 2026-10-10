// TAP settlement helpers for OTC4AI.
// Builds token-auth `lock` / `claim` actions (TAP spec, kind "otc", hashlock condition)
// and verifies them against an ord-tap indexer. Never touches private keys.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

export const DOM = 'otc4ai';
// Maker (secret holder) locks first with the longer window; taker locks second with the shorter one.
// Maker must claim the taker lock before T2 (revealing the secret), leaving the taker >= GAP blocks to claim.
export const WINDOW = { maker: 288, taker: 144, minGap: 72 }; // blocks (~48h / ~24h / ~12h)

export async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export function newSecret() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

// ord-tap hashes an even-length hex preimage as raw bytes (Lightning compatible).
export async function hashOf(secretHex) {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('secret must be 32-byte hex');
  return sha256Hex(unhex(secretHex));
}

export const isAddr = (a) => /^(bc1p[02-9ac-hj-np-z]{58}|bc1q[02-9ac-hj-np-z]{38,58}|tb1[02-9ac-hj-np-z]{39,59}|bcrt1[02-9ac-hj-np-z]{39,59})$/.test(String(a || '').trim());
export const isTick = (t) => typeof t === 'string' && t.length > 0 && t.length <= 32 && !/[\s"\\]/.test(t);
export const isAmt = (a) => /^(0|[1-9]\d*)(\.\d+)?$/.test(String(a || '')) && Number(a) > 0;
export const isLockId = (id) => /^[0-9a-f]{64}i\d+:\d+$/.test(String(id || '').trim());

export async function tipHeight() {
  const r = await fetch('https://mempool.space/api/blocks/tip/height');
  if (!r.ok) throw new Error('mempool.space ' + r.status);
  return Number(await r.text());
}

export function lockAction({ tick, amt, claim, refund, hash, refundAfter, ref, cp }) {
  return {
    op: 'lock',
    kind: 'otc',
    tick: String(tick).toLowerCase(),
    amt: String(amt),
    claim,
    refund,
    condition: { type: 'hashlock', hash },
    refund_after: String(refundAfter),
    data: { dom: DOM, ref, cp },
  };
}

export const claimAction = (lock, preimage) => ({ op: 'claim', lock, preimage });
export const refundAction = (lock) => ({ op: 'refund', lock });

// Unsigned token-auth redeem: the authority owner signs sha256(JSON.stringify(redeem) + salt)
// in their own wallet, then the signed JSON is inscribed by any address (redeems need no tapping).
export function redeemDraft(auth, actions) {
  return { auth: auth || '<your authority inscription id>', actions, data: {} };
}

// The two legs of one deal, derived the same way on both sides so each can check the other.
export function dealLegs(deal) {
  const { offer, takerAddr, hash, t1, t2, id } = deal;
  return {
    maker: lockAction({ tick: offer.give.tick, amt: offer.give.amt, claim: takerAddr, refund: offer.addr, hash, refundAfter: t1, ref: id + '-m', cp: takerAddr }),
    taker: lockAction({ tick: offer.want.tick, amt: offer.want.amt, claim: offer.addr, refund: takerAddr, hash, refundAfter: t2, ref: id + '-t', cp: offer.addr }),
  };
}

export function checkWindows(t1, t2, tip) {
  const errs = [];
  if (!(t2 > tip + 6)) errs.push('taker refund height is too close to the current block');
  if (!(t1 - t2 >= WINDOW.minGap)) errs.push(`maker refund must be at least ${WINDOW.minGap} blocks after taker refund`);
  return errs;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

// Compare an on-chain lock record with the expected leg. Returns { ok, problems, record }.
export async function verifyLock(indexer, lockId, expected, tip) {
  const base = String(indexer || '').replace(/\/+$/, '');
  if (!base) return { ok: false, problems: ['no indexer configured — verify manually'], record: null };
  const { result: rec } = await getJson(`${base}/r/tap/getLock/${encodeURIComponent(lockId)}`);
  if (!rec) return { ok: false, problems: ['lock not found (not confirmed yet?)'], record: null };
  const p = [];
  const eq = (a, b, what) => { if (String(a).toLowerCase() !== String(b).toLowerCase()) p.push(`${what}: ${a} ≠ ${b}`); };
  eq(rec.kind, 'otc', 'kind');
  eq(rec.tick, expected.tick, 'ticker');
  eq(rec.claim, expected.claim, 'claim address');
  eq(rec.refund_after, expected.refund_after, 'refund height');
  eq(rec.condition?.hash, expected.condition.hash, 'hashlock');
  const dep = await getJson(`${base}/r/tap/getDeployment/${encodeURIComponent(expected.tick)}`).then((j) => j.result).catch(() => null);
  if (!dep) p.push('ticker deployment not found');
  else if (BigInt(rec.amt) < toAtomic(expected.amt, dep.dec)) p.push(`amount too small: ${rec.amt} < ${toAtomic(expected.amt, dep.dec)} (atomic, ${dep.dec} decimals)`);
  if (rec.remaining !== undefined && rec.remaining !== rec.amt) p.push('lock already partly consumed');
  const consumed = await getJson(`${base}/r/tap/getLockConsume/${encodeURIComponent(lockId)}`).then((j) => j.result).catch(() => null);
  if (consumed) p.push('lock already consumed');
  if (tip && Number(rec.refund_after) <= tip) p.push('refund window already open');
  return { ok: p.length === 0, problems: p, record: rec };
}

// Human decimal → atomic units, truncating extra fractional digits like the TAP indexer does.
export function toAtomic(amt, dec) {
  const [i, f = ''] = String(amt).split('.');
  return BigInt(i + f.slice(0, dec).padEnd(dec, '0'));
}

// True once a claim or refund for the lock is indexed.
export async function lockConsumed(indexer, lockId) {
  const base = String(indexer || '').replace(/\/+$/, '');
  if (!base) return false;
  const j = await getJson(`${base}/r/tap/getLockConsume/${encodeURIComponent(lockId)}`).catch(() => null);
  return !!j?.result;
}

// After the maker claims the taker lock, the secret is public in the claim inscription.
export async function findPreimage(indexer, lockId, hash) {
  const base = String(indexer || '').replace(/\/+$/, '');
  if (!base) return null;
  const { result: c } = await getJson(`${base}/r/tap/getLockConsume/${encodeURIComponent(lockId)}`);
  if (!c?.ins) return null;
  const body = await getJson(`${base}/content/${c.ins}`).catch(() => null);
  const actions = body?.redeem?.actions || [];
  for (const a of actions) {
    if (a.op === 'claim' && a.lock === lockId && typeof a.preimage === 'string' && (await hashOf(a.preimage.toLowerCase()).catch(() => '')) === hash) return a.preimage.toLowerCase();
  }
  return null;
}
