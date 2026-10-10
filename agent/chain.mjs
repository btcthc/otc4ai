// Chain access for the live bot wallet: UTXOs, fee rate, broadcast, tip height.
//   esplora(base): mempool.space / Esplora REST, e.g. https://mempool.space/api (mainnet),
//                  https://mempool.space/signet/api (signet)
//   bitcoind(url, { user, pass }): Bitcoin Core JSON-RPC, for regtest (UTXOs through scantxoutset, no wallet needed)
// Every adapter returns UTXOs as { txid, vout, value } with value in sats (number).

export function esplora(base, { minFeeRate = 1 } = {}) {
  const b = String(base).replace(/\/+$/, '');
  const get = async (p, as = 'json') => { const r = await fetch(b + p); if (!r.ok) throw new Error(`${b}${p} → ${r.status}`); return as === 'json' ? r.json() : r.text(); };
  return {
    async utxos(address) { return (await get(`/address/${address}/utxo`)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed })); },
    async feeRate() { try { return Math.max(minFeeRate, (await get('/v1/fees/recommended')).halfHourFee); } catch { return minFeeRate; } },
    async broadcast(hex) {
      const r = await fetch(b + '/tx', { method: 'POST', body: hex });
      const t = await r.text();
      if (!r.ok) throw new Error('broadcast failed: ' + t.slice(0, 300));
      return t.trim();
    },
    async tip() { return Number(await get('/blocks/tip/height', 'text')); },
    async confirmed(txid) { try { return !!(await get(`/tx/${txid}/status`)).confirmed; } catch { return false; } },
  };
}

export function bitcoind(url, { user = '', pass = '', minFeeRate = 1 } = {}) {
  let id = 0;
  const rpc = async (method, params = []) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }, body: JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params }) });
    const j = await r.json().catch(() => ({ error: { message: 'HTTP ' + r.status } }));
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  return {
    rpc,
    async utxos(address) {
      const res = await rpc('scantxoutset', ['start', [`addr(${address})`]]);
      return (res.unspents || []).map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8), confirmed: true }));
    },
    async feeRate() { try { const e = await rpc('estimatesmartfee', [2]); return Math.max(minFeeRate, Math.ceil((e.feerate || 0) * 1e5)); } catch { return minFeeRate; } },
    broadcast: (hex) => rpc('sendrawtransaction', [hex]),
    tip: () => rpc('getblockcount'),
    async confirmed(txid) { try { return (await rpc('getrawtransaction', [txid, true])).confirmations > 0; } catch { return false; } },
  };
}
