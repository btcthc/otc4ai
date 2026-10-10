// Default chain adapter per network. Override with OTC4AI_ESPLORA (an Esplora REST base URL) or, for
// regtest, OTC4AI_BITCOIND (http://user:pass@127.0.0.1:18443).
import { esplora, bitcoind } from './chain.mjs';

const ESPLORA = {
  mainnet: 'https://mempool.space/api',
  signet: 'https://mempool.space/signet/api',
  testnet: 'https://mempool.space/testnet4/api',
};

export function chainFor(network, override = process.env.OTC4AI_ESPLORA) {
  if (network === 'regtest') {
    const u = new URL(process.env.OTC4AI_BITCOIND || 'http://127.0.0.1:18443');
    return bitcoind(`${u.protocol}//${u.host}${u.pathname}`, { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) });
  }
  const base = override || ESPLORA[network];
  if (!base) throw new Error('no chain adapter for ' + network);
  return esplora(base);
}
