// Bot wallet inscriptions for live mode (v0.3). The bot owns one taproot key: its address holds the tokens,
// pays the fees, and the same key signs token-auth redeems (agent/tapsign.mjs).
//   commit: pays POSTAGE + reveal fee to the one-off reveal address of the inscription
//   reveal: spends it through the inscription leaf; the inscription lands on the bot's own address
//   tap:    sends an inscription back to the bot's address (needed once, for the authority creation)
// Building is pure; UTXOs, fee rate and broadcast come from a chain adapter (agent/chain.mjs).
// Safety: UTXOs at or below DUST_GUARD sats are never spent as fee inputs, because inscriptions and TAP
// transferables sit on small outputs. Fund the bot with one larger UTXO.
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { utf8, hex } from '@scure/base';

export const NETWORKS = {
  mainnet: btc.NETWORK,
  testnet: btc.TEST_NETWORK,
  signet: btc.TEST_NETWORK,
  regtest: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
};
export const POSTAGE = 546n;
export const DUST_GUARD = 10_000n;
const SCRIPTS = [ordinals.OutOrdinalReveal];
const fee = (vsize, rate) => BigInt(Math.ceil(vsize * rate));

export function wallet(priv, net) {
  const network = NETWORKS[net];
  if (!network) throw new Error('unknown network ' + net);
  const pub = btc.utils.pubSchnorr(priv);
  const pay = btc.p2tr(pub, undefined, network);
  return { net, network, pub, priv, address: pay.address, script: pay.script, pay };
}

export function revealOutput(w, json) {
  const insc = { tags: { contentType: 'text/plain;charset=utf-8' }, body: utf8.decode(JSON.stringify(json)) };
  return btc.p2tr(undefined, ordinals.p2tr_ord_reveal(w.pub, [insc]), w.network, false, SCRIPTS);
}

function revealTx(w, rev, commit, amountOut, to) {
  const tx = new btc.Transaction({ customScripts: SCRIPTS });
  tx.addInput({ ...rev, txid: commit.txid, index: commit.vout, witnessUtxo: { script: rev.script, amount: commit.value } });
  tx.addOutputAddress(to, amountOut, w.network);
  tx.sign(w.priv);
  tx.finalize();
  return tx;
}

// Plans and signs both transactions. utxos: [{ txid, vout, value }] of the bot address (value in sats).
export function buildInscription(w, json, utxos, feeRate, { to = w.address } = {}) {
  const rev = revealOutput(w, json);
  const dummy = { txid: '00'.repeat(32), vout: 0, value: 100_000n };
  const revealFee = fee(revealTx(w, rev, dummy, 100_000n - 1_000n, to).vsize, feeRate);
  const need = POSTAGE + revealFee;

  const spendable = utxos.map((u) => ({ ...u, value: BigInt(u.value) })).filter((u) => u.value > DUST_GUARD).sort((a, b) => (b.value > a.value ? 1 : -1));
  const make = (inputs, change) => {
    const tx = new btc.Transaction();
    for (const u of inputs) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: w.script, amount: u.value }, tapInternalKey: w.pub });
    tx.addOutputAddress(rev.address, need, w.network);
    if (change > 0n) tx.addOutputAddress(w.address, change, w.network);
    tx.sign(w.priv); tx.finalize();
    return tx;
  };
  const inputs = [];
  let total = 0n;
  for (const u of spendable) {
    inputs.push(u); total += u.value;
    const withChange = fee(make(inputs, 1n).vsize, feeRate);
    if (total >= need + withChange + 546n) {
      const commit = make(inputs, total - need - withChange);
      const reveal = revealTx(w, rev, { txid: commit.id, vout: 0, value: need }, POSTAGE, to);
      return { commit, reveal, inscriptionId: reveal.id + 'i0', feeSats: Number(withChange + revealFee), revealAddress: rev.address };
    }
    const noChange = fee(make(inputs, 0n).vsize, feeRate);
    if (total >= need + noChange) { // the leftover is too small for a change output; it goes to the miner
      const commit = make(inputs, 0n);
      const reveal = revealTx(w, rev, { txid: commit.id, vout: 0, value: need }, POSTAGE, to);
      return { commit, reveal, inscriptionId: reveal.id + 'i0', feeSats: Number(total - POSTAGE), revealAddress: rev.address };
    }
  }
  throw new Error(`not enough BTC on ${w.address}: need about ${need + fee(160, feeRate)} sats in UTXOs above ${DUST_GUARD} sats`);
}

// Sends an inscription (the postage output it sits on) back to the bot address ("tap"), or to `to`, paying the
// fee from a clean UTXO. The inscription is on the first sat of input 0, so it lands on the first sat of output 0.
export function buildTap(w, inscribed /* { txid, vout, value } */, utxos, feeRate, to = w.address) {
  const ins = { ...inscribed, value: BigInt(inscribed.value) };
  const funding = utxos.map((u) => ({ ...u, value: BigInt(u.value) })).filter((u) => u.value > DUST_GUARD && !(u.txid === ins.txid && u.vout === ins.vout)).sort((a, b) => (b.value > a.value ? 1 : -1))[0];
  if (!funding) throw new Error(`no UTXO above ${DUST_GUARD} sats on ${w.address} to pay the tap fee`);
  const make = (change) => {
    const tx = new btc.Transaction();
    for (const u of [ins, funding]) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: w.script, amount: u.value }, tapInternalKey: w.pub });
    tx.addOutputAddress(to, ins.value, w.network);
    if (change > 0n) tx.addOutputAddress(w.address, change, w.network);
    tx.sign(w.priv); tx.finalize();
    return tx;
  };
  const f = fee(make(1n).vsize, feeRate);
  if (funding.value < f + 546n) throw new Error('the funding UTXO is too small for the tap fee');
  return make(funding.value - f);
}

// Sends all BTC above DUST_GUARD to `to` in one output. Small outputs stay, because they may carry inscriptions.
export function buildSweep(w, utxos, feeRate, to) {
  const inputs = utxos.map((u) => ({ ...u, value: BigInt(u.value) })).filter((u) => u.value > DUST_GUARD);
  if (!inputs.length) throw new Error(`no UTXO above ${DUST_GUARD} sats on ${w.address}`);
  const total = inputs.reduce((a, u) => a + u.value, 0n);
  const make = (amount) => {
    const tx = new btc.Transaction();
    for (const u of inputs) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: w.script, amount: u.value }, tapInternalKey: w.pub });
    tx.addOutputAddress(to, amount, w.network);
    tx.sign(w.priv); tx.finalize();
    return tx;
  };
  const f = fee(make(total - 1000n).vsize, feeRate);
  if (total - f < 546n) throw new Error('the outputs are too small to pay the fee');
  return make(total - f);
}

export const rawHex = (tx) => hex.encode(tx.extract());
