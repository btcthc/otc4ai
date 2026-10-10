// TAP token-auth signatures for a bot that holds its own authority key (live mode, v0.3).
// Spec: token-auth "Create an Authority" and "Redeem Items". The indexer (ord-tap) recovers the public key
// from `hash` with recovery id `v`, then verifies (r, s) against sha256(JSON.stringify(payload) + salt).
// So `hash` is exactly that digest, r and s are decimal strings, and the signature must be low-S.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';

const hex = (u8) => Buffer.from(u8).toString('hex');

// A decimal salt like the reference wallets use ("0.2599…"), drawn from a CSPRNG.
export const newSalt = () => '0.' + BigInt('0x' + randomBytes(8).toString('hex')).toString().padStart(20, '0');

export const digest = (payload, salt) => sha256(new TextEncoder().encode(JSON.stringify(payload) + salt));

function sign(priv, payload, salt) {
  const h = digest(payload, salt);
  const s = secp256k1.sign(h, priv); // RFC 6979 nonce, low-S
  return { sig: { v: String(s.recovery), r: s.r.toString(), s: s.s.toString() }, hash: hex(h), salt };
}

// Authority creation. After it is inscribed it must be tapped: sent back to the authority account.
// tickers = [] lets the authority move any token the account holds.
export function authInscription(priv, tickers = [], salt = newSalt()) {
  const { sig, hash } = sign(priv, tickers, salt);
  return { p: 'tap', op: 'token-auth', sig, hash, salt, auth: tickers };
}

// Signed redeem (items and/or actions). Anyone can inscribe it; no tapping needed.
export function redeemInscription(priv, redeem, salt = newSalt()) {
  if (!redeem || !('data' in redeem)) throw new Error('redeem.data must be present');
  if (!redeem.auth || /^</.test(redeem.auth)) throw new Error('redeem.auth must be the authority inscription id');
  const { sig, hash } = sign(priv, redeem, salt);
  return { p: 'tap', op: 'token-auth', sig, hash, salt, redeem };
}

// Mirror of the indexer check, for tests and for checking a counterparty's redeem before relying on it.
// Returns the uncompressed authority public key (hex) or null.
export function verifyInscription(obj) {
  try {
    const payload = obj.redeem ?? obj.auth, h = digest(payload, obj.salt);
    if (hex(h) !== String(obj.hash).replace(/^0x/, '').toLowerCase()) return null;
    let v = Number(obj.sig.v); if (v >= 27) v -= 27;
    const sig = new secp256k1.Signature(BigInt(obj.sig.r), BigInt(obj.sig.s)).addRecoveryBit(v);
    if (sig.hasHighS()) return null;
    const pub = sig.recoverPublicKey(h);
    return secp256k1.verify(sig, h, pub.toRawBytes(true)) ? pub.toHex(false) : null;
  } catch { return null; }
}

export const authorityPubkey = (priv) => hex(secp256k1.getPublicKey(priv, false)); // uncompressed, as ord-tap reports it
