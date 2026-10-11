# Live mode (v0.3, in testing)

In live mode a bot trades real TAP tokens. It holds its own wallet, signs its own token-auth redeems and inscribes them itself, inside spending limits you set. Paper mode stays the default.

> Status: passed a full end-to-end run on a local regtest chain (Bitcoin Core 31.1 + ord-tap 1.0.5), see [below](#end-to-end-check-on-regtest). The next step is a small mainnet pilot. Do not put more on a bot wallet than you are ready to lose while this is experimental.

## How it works

- **One key per bot** (`agent/wallet-cli.mjs`). Its taproot address holds the bot's tokens and pays its Bitcoin fees. The same key is the bot's TAP authority. The key file stays in `agent/state/` (gitignored), and no command ever prints it.
- **Authority, once.** `setup-authority` inscribes a `token-auth` creation signed by the key, then taps it (sends it back to the bot address), as the TAP spec requires.
- **Every batch is one redeem.** The batcher collects locks and claims. The bot signs `sha256(JSON.stringify(redeem) + salt)` (`agent/tapsign.mjs`) and inscribes it as commit + reveal (`agent/inscribe.mjs`). The signature format mirrors ord-tap's check: recovery from `hash`, low-S, and `r`/`s` as decimal strings.
- **Counterparty locks** show up on the indexer only after they confirm. `verify` waits up to 3 hours for the lock, then checks ticker, amount, claim address, hashlock and refund height.
- **Refunds.** The bot keeps its open locks on disk. Every 5 minutes it refunds any lock whose counterparty disappeared once `refund_after` is reached.
- **Limits** (`agent/limits.mjs`), checked before a lock is signed:
  - `perDealTap`: the largest deal, valued in TAP;
  - `perDayTap`: the rolling 24 h total;
  - `maxOpenTap`: TAP locked in deals that are not settled yet;
  - `ticks` (optional): the allowed tickers.

  Deals that cannot be valued in TAP are refused.
- **Kill switch.** `node agent/wallet-cli.mjs stop` blocks every new lock in every live bot, while claims and refunds of open deals still go through. Undo it with `resume`.
- **Coin safety.** Outputs of 10,000 sats or less are never spent as fees, because inscriptions and TAP transferables sit on small outputs. Fund the bot with one larger output.

## Setup

```powershell
node agent/wallet-cli.mjs new mybot --network regtest      # or signet / testnet / mainnet
node agent/wallet-cli.mjs address mybot                     # send a little BTC here (and the tokens it trades)
node agent/wallet-cli.mjs setup-authority mybot --ticks tap,gib
node agent/wallet-cli.mjs status mybot --indexer <ord-tap url> --ticks tap,gib
node agent/wallet-cli.mjs send-token mybot tap 10 <address>   # TAP out of the bot: token-transfer, then send
node agent/wallet-cli.mjs withdraw mybot <address>            # BTC out (outputs of 10,000 sats or less stay)
```

Bot config (start from `agent/configs/mm-1.json`):

```json
{
  "mode": "live",
  "wallet": "mybot",
  "indexer": "http://127.0.0.1:8080",
  "limits": { "perDealTap": 200, "perDayTap": 1000, "maxOpenTap": 400, "ticks": ["tap", "gib"] }
}
```

On mainnet the config also needs `"allowMainnet": true`, and `setup-authority` needs `--mainnet`.

Chain access:
- regtest: Bitcoin Core RPC, set by `OTC4AI_BITCOIND=http://user:pass@127.0.0.1:18443`;
- other networks: mempool.space by default, or another Esplora API set by `OTC4AI_ESPLORA`.

Indexer (`indexer` in the config):
- an **ord-tap** server: locks are read with `/r/tap/getLock` and `/r/tap/getLockConsume`;
- or a **public TAP reader** such as `https://tap-reader-tw.tap-hosting.xyz`, which has no lock routes. There a lock is read from the token-auth redeem that created it: the lock owner's redeem list holds the inscription, and a redeem is listed only if all its actions passed. Claims, refunds and revealed secrets are found among the newest redeems. You trust whoever runs the reader, so check big deals against your own ord-tap.

Mainnet pilot: [`scripts/pilot.mjs`](../scripts/pilot.mjs) runs one small deal between two bot wallets (`pilot-a` gives GIB, `pilot-b` gives TAP) through the public reader. `status` shows what each wallet still needs; `run --mainnet` sets up both authorities and settles the deal. It resumes from `agent/state/pilot.json` after an interruption.

## End-to-end check on regtest

[`scripts/regtest-e2e.mjs`](../scripts/regtest-e2e.mjs) runs the live code against Bitcoin Core in regtest and a real ord-tap indexer, so ord-tap itself judges every inscription:

1. creates two fresh bot wallets with `wallet-cli new`, in a temporary folder (never `agent/state`), and funds them from the regtest miner;
2. deploys and mints the test tokens `tap` and `gib` to them;
3. sets up both token-auth authorities with `wallet-cli setup-authority` (inscribe, then tap);
4. runs a full deal: maker lock → taker verifies and locks → maker verifies and claims → the taker finds the secret in the claim on Bitcoin and claims;
5. abandons a second deal: after the refund height the refund watcher returns the maker's tokens;
6. checks that a lock above the per-deal limit is refused before anything is signed.

Every balance is read back from ord-tap. Result on 11 October 2026: all checks passed. Each single-action inscription cost 420–515 sats at 1 sat/vB, as the fee model expects.

To run it:

```powershell
bitcoind -regtest -txindex=1 -listen=0 -fallbackfee=0.0002 -datadir=<dir>
ord --regtest --bitcoin-data-dir <dir> --index <dir>\ord-tap.redb server --address 127.0.0.1 --http --http-port 3333
$env:BITCOIN_COOKIE = '<dir>\regtest\.cookie'; $env:ORD_TAP = 'http://127.0.0.1:3333'
node scripts/regtest-e2e.mjs
```

ord-tap needs its Node 20 V8 artifact to build (see its README). That artifact is only used for DMT mints, which this check does not touch.

## Tests

`npm test` covers:
- signatures: recovery, tampering and high-S rejection, against the same rules ord-tap applies;
- inscriptions: commit/reveal are built and the TAP JSON is parsed back from the witness; small outputs are never spent;
- the tap transaction;
- limits;
- live settlement against a fake chain and a fake indexer: a lock over the limit is refused, signed locks are inscribed, the bot waits for a counterparty lock, and an expired lock is refunded.
