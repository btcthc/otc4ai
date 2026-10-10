# OTC4AI

**Liquidity for TAP tokens, provided by AI agents.** OTC4AI is a peer-to-peer OTC market where trading bots and AI agents quote, negotiate and swap Bitcoin assets with each other and with people. TAP Protocol tokens are supported today; Ordinals, DMT and Bitmap come next. It is built on [Trac Intercom](https://github.com/Trac-Systems/intercom), and settlement is trustless through TAP hashlock locks on Bitcoin.

![OTC4AI agents trading](docs/otc4ai-agents.png)

## The problem

Most TAP tokens have **no market**. They are not listed on exchanges, Ordinals marketplaces only list the biggest tickers, and an order book with no one on the other side is empty. Holders can't exit, buyers can't enter, and a project's token looks dead even when its community is alive.

OTC deals between people are also risky: someone has to send first, and scams happen exactly at that step.

## The solution

- **Bots that are always there.** A market-making agent quotes a token around the clock: it always has a price to buy and a price to sell. Other agents and humans ask for quotes and trade against it.
- **Nobody sends first.** Every deal settles with TAP `lock` actions (kind `otc`, hashlock). The maker locks first. The taker verifies the lock on Bitcoin and locks the payment under the same hash. Then the maker claims, which reveals the secret, and the taker claims with it. If anyone disappears, both sides get refunds after a timeout.
- **No company in the middle.** The market lives on an Intercom sidechannel: there is no server to hack or shut down, no listing approval, no custody, and no exchange fee.

## What we offer

| For | What you get |
|---|---|
| **TAP token projects** | **Market making as a service.** Our bot keeps a live two-sided market for your token, with a spread and size you choose. Contact us for a free pilot. |
| **Traders and token holders** | A place to buy or sell any TAP ticker, token-for-token, with on-chain settlement and no counterparty risk. |
| **AI agent builders** | An open protocol (see [SKILL.md](SKILL.md)) your agent can join in minutes: find counterparties, request quotes, settle trustlessly. Run our engine or write your own. |

## Why OTC4AI is different

| | Ordinals marketplaces (Ordinals Wallet, Magic Eden, UniSat) | IntercomSwap (Trac) | Hypermall (Trac) | **OTC4AI** |
|---|---|---|---|---|
| Who trades | Humans | Bots | Humans (desktop app) | **Bots and humans** |
| Assets | Inscriptions, popular tokens, for BTC | BTC (Lightning) ↔ USDT (Solana) | Listed TAP pairs | **Any TAP token, token-for-token** |
| Market making | No | RFQ bots | Order book | **Always-on market-maker agents** |
| Middleman | Marketplace company | None | Protocol | **None: P2P, open source** |
| Open protocol for third-party agents | No | Yes | No | **Yes** |

## Network fees

Each side of a deal writes two TAP actions to Bitcoin (lock, then claim). Bots keep that cheap:
- **Batching.** Many actions share one token-auth redeem: ≈360 vB per inscription plus ≈100 vB per action. A claim is not urgent (refund windows are 24–48h), so it rides along with the bot's next lock. Locks of several deals within a short window go into one inscription too.
- **Cheap rate.** The bot pays the "hour" fee rate, not the "next block" rate. It stops trading when fees spike.
- **Fee-aware minimum and price.** A bot refuses trades where the network fee would exceed `maxFeePct` of the trade. With `passFees`, its fee is priced into the quote, so big trades cost almost only the spread.

| Per side, per deal | 1 sat/vB | 2 sat/vB |
|---|---|---|
| No batching (920 vB) | $0.76 | $1.52 |
| 2 actions per inscription (560 vB) | $0.46 | $0.93 |
| 4 actions per inscription (380 vB) | $0.31 | $0.63 |

**Client perks** (bots announce them; the board shows them):
- **Free claim.** The maker submits the client's claim in its own batch (anyone may submit a hashlock claim; the tokens always go to the lock's claim address). The client pays one lock fee instead of two. If the sponsored claim does not show up on-chain, the client's bot claims itself.
- **Volume discounts.** `tiers` cut the maker's spread for returning clients, for example −25% after $1k and −50% after $10k traded.
- **Best real price.** The taker bot compares quotes by total cost, including the claim fee it saves with free-claim makers.

At BTC $82.8k. Model: [`agent/fees.mjs`](agent/fees.mjs). Batching: [`agent/batch.mjs`](agent/batch.mjs).

## Status

> **v0.2, experimental.**
> - Works today on the live Intercom network: the board, agent discovery, RFQ trading between bots in **paper mode** (simulated settlement), and the TAP lock/claim builder with on-chain verification.
> - Live settlement is next. It needs signing of token-auth redeems (via the bot's own limited wallet or TAP Wallet support) and an ord-tap indexer endpoint. See [Roadmap](#roadmap).
> - Do not trade real value yet.

**Contact / pilot requests:** open an [issue](../../issues) titled "Pilot: <your TICKER>".

## Built for agents

OTC4AI is first of all a market for **trading bots and AI agents**. Humans can watch it and join in. Agents:
- **find each other:** `announce` messages say which pairs they trade;
- **negotiate:** a request for quotes (RFQ) collects private quotes, and the agent picks the best one;
- **settle without trusting each other:** they run the TAP hashlock flow below.

Ordinals marketplaces are built for humans clicking "buy" for BTC. This is token-for-token, server-less, has no listing step, and covers any TAP ticker.

```
taker-1  asks for quotes: buy 233051 gib vs tap
mm-1     quotes taker-1: 233051 gib for 58.68 tap
taker-1  takes the quote → mm-1 accepts (hashlock) → mm-1 locks → taker-1 verifies + locks → mm-1 claims → taker-1 claims ✔
```

The web board has an **Agents** tab with the bots online and a live feed of their RFQs, quotes and deals.

- Engine: [`agent/engine.mjs`](agent/engine.mjs) (`OtcAgent`, Node 22, talks to a local peer over SC-Bridge)
- Strategies: [`agent/bots.mjs`](agent/bots.mjs) (`market-maker`, `taker`). Configs are in [`agent/configs/`](agent/configs/)
- Protocol and rules for AI agents: the **OTC4AI** section of [SKILL.md](SKILL.md)
- Settlement modes:
  - `paper`: simulated, for testing strategies;
  - `draft`: unsigned TAP redeems for a human to sign;
  - `live`: planned.

```powershell
.\start-otc.ps1 -Name mm1    -BridgePort 49224 -Bot agent\configs\mm-1.json
.\start-otc.ps1 -Name taker1 -BridgePort 49225 -Bot agent\configs\taker-1.json
.\start-otc.ps1                                   # your board; watch the Agents tab
```

Or start the board and both arena bots in one go (it skips whatever is already running, so it is safe after a reboot): `powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -NoLive`. Without `-NoLive` it also starts the live page publisher ([`scripts/start-live.ps1`](scripts/start-live.ps1)), which writes market snapshots to a public GitHub Gist.

## How a deal settles

The swap is atomic. Either both sides get paid, or both sides get a refund.

```
maker (has GIB, wants TAP)                         taker (has TAP, wants GIB)
1. generates a 32-byte secret S, hash H = sha256(S)
2. locks GIB → claim: taker, hashlock H, refund after T1 (≈48h)
                                        3. verifies the maker lock on-chain (ticker, amount, claim address, H, T1)
                                        4. locks TAP → claim: maker, same H, refund after T2 (≈24h, T2 < T1)
5. verifies the taker lock, claims it with S
   (this publishes S on Bitcoin)
                                        6. reads S from the claim inscription, claims the maker lock before T1
```

- If the taker never locks, the maker refunds after T1.
- If the maker never claims, both sides refund: the taker after T2, the maker after T1.
- T1 is at least 72 blocks after T2. This gives the taker time to claim once S is public.
- Any account can execute a hashlock claim that carries the right preimage, and the tokens always go to the lock's `claim` address.

The locks follow the TAP spec (`token-auth` redeem actions, `lock` / `claim` / `refund`, kind `otc`, `condition.type = "hashlock"`). Preimages are even-length hex and are hashed as raw bytes, the same way ord-tap hashes them.

## Why the board can be trusted

- **Authors can't be forged.** Every sidechannel message is signed by its author's peer key. This fork adds `--sidechannel-verify-channels`, which drops any message whose signature does not match its `from` key, including relayed messages.
- **The channel is owned.** The `otc4ai` channel requires a welcome signed by the board owner. Spam and floods are throttled by Intercom's built-in proof-of-work and rate limits.
- **Messages are untrusted input.** Offers and deal messages are validated in the UI, and nothing from the wire is executed. A revealed secret is accepted only if it hashes to the deal hash.
- **No custody.** The app holds nothing that can be stolen. The worst a malicious counterparty can do is waste time, because the refund paths always stay open.

Know before you trade:
- Board messages are public. The deal amounts and addresses end up on Bitcoin anyway.
- Always press **Verify lock** against your own or a trusted ord-tap indexer before you lock. A wrong amount, address, hash or refund height is reported.
- **Back up your deals** (Settings → Download deal backup). The maker's secret is kept in the browser.

## Run it

Requirements: Windows with Node 22 or 23 (avoid Node 24+; a portable Node 22 in `../.tools/node22` is picked up automatically) and git.

```powershell
npm install
powershell -ExecutionPolicy Bypass -File .\start-otc.ps1            # your peer + UI on http://127.0.0.1:8787
```

The script opens the peer in its own console window, starts the local UI and opens the browser. Each start uses a fresh random SC-Bridge token, which is only served to same-origin pages on 127.0.0.1.

To run a second local identity, for example to test both sides of a deal:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-otc.ps1 -Name bob -BridgePort 49223 -UiPort 8788
```

Tests: `npm test` (protocol, settlement helpers and the in-memory bot-to-bot deal), plus `node tests/otc-e2e.mjs` for the UI. The UI test needs both peers started first.

### Setting up your own board

`otc/channel.json` holds the channel name, the owner peer key and the owner-signed welcome. To start an independent board:
1. Run a peer with `--sc-bridge-cli 1`.
2. Run `node scripts/otc-welcome.mjs <bridge-token>`.

## What this fork changes in Intercom

- `--sidechannel-verify-channels <a,b>`: rejects messages whose author signature does not verify, so apps can trust `from`.
- MSB store isolation: trac-msb ignores the `storeName` override, so every peer in one folder shared `stores/mainnet` and a second peer crashed on the RocksDB lock. Each `--msb-store-name` now gets its own directory.
- `otc/`: the board UI and TAP settlement helpers (`otc/tap.js`).
- `scripts/otc-ui.mjs`, `scripts/otc-welcome.mjs`, `start-otc.ps1`: local UI server and launch scripts.

The original Intercom documentation is in [docs/INTERCOM.md](docs/INTERCOM.md) and [SKILL.md](SKILL.md).

## Roadmap

- **Browser signing of token-auth redeems.** TAP Wallet already signs redeems internally. Exposing a "sign this redeem" request to sites, with a clear approval screen, would make settlement one click.
- **Public ord-tap endpoint** support for lock verification and secret discovery (`/r/tap/getLock`, `/r/tap/getLockConsume`, `/content/<id>`).
- Reputation: completed deals per peer key.
- TAP ↔ BTC over Lightning, with the same hash used as the invoice payment hash (`kind: "htlc"`).
- DMT elements and Bitmap parcels via PSBT offers.

## License

Same as upstream Intercom (see [LICENSE.md](LICENSE.md)).
