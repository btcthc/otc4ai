// Publishes a public snapshot of the OTC4AI market for the live page (docs/index.html).
// It listens on your local peer like the web board does, keeps the last hour of activity, and every
// minute writes snapshot.json locally and (optionally) to a public GitHub Gist the page reads.
// No addresses, keys or tokens go into the snapshot: only bot names, offers, events and arena stats.
//
// Usage: node scripts/otc-live.mjs [--gist <id>] [--every 60] [--ui http://127.0.0.1:8787]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const UI = arg('ui', 'http://127.0.0.1:8787'), GIST = arg('gist', ''), EVERY = Number(arg('every', 60));
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'docs/live/snapshot.json');
const GH = process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';
const log = (s) => console.log(new Date().toISOString().slice(11, 19), s);

const agents = new Map();      // peer -> { name, pairs, perks, stats, minUsd, feeUsd, satPerVb, modes, seen }
const offers = new Map();      // oid -> { offer, from, seen }
const quotes = new Map();      // oid -> { offer, from } (private quotes, needed to price a take)
const deals = new Map();       // did -> { pair, base, quote, price, maker, taker, state, t }
const events = [];             // newest first, capped
const name = (peer) => agents.get(peer)?.name || 'agent-' + String(peer).slice(0, 4);
const pairOf = (o) => { const b = [o.give, o.want].find((x) => x.tick !== 'tap') || o.give, q = [o.give, o.want].find((x) => x !== b); return { b, q }; };
const push = (e) => { events.unshift({ t: Date.now(), ...e }); events.length = Math.min(events.length, 80); };

function onMsg(from, m) {
  if (!m || m.app !== 'otc4ai' || m.v !== 1) return;
  if (m.t === 'announce' && m.agent?.name) {
    const a = m.agent;
    agents.set(from, { name: String(a.name).slice(0, 32), kind: a.kind, pairs: a.pairs, modes: a.modes, perks: a.perks, stats: a.stats, minUsd: a.minUsd, feeUsd: a.feeUsd, satPerVb: a.satPerVb, seen: Date.now() });
  } else if (m.t === 'offer' && m.offer?.oid) offers.set(m.offer.oid, { offer: m.offer, from, seen: Date.now() });
  else if (m.t === 'cancel') offers.delete(m.oid);
  else if (m.t === 'rfq') push({ k: 'rfq', who: name(from), text: `${m.side} ${m.amt} ${m.tick} for ${m.against}` });
  else if (m.t === 'quote' && m.offer?.oid) {
    quotes.set(m.offer.oid, { offer: m.offer, from });
    push({ k: 'quote', who: name(from), text: `${m.offer.give.amt} ${m.offer.give.tick} for ${m.offer.want.amt} ${m.offer.want.tick}` });
  } else if (m.t === 'take' && m.did) {
    const e = quotes.get(m.oid) || offers.get(m.oid);
    if (!e) return;
    const { b, q } = pairOf(e.offer);
    deals.set(m.did, { pair: `${b.tick}/${q.tick}`, base: b.amt, quote: q.amt, price: Number(q.amt) / Number(b.amt), maker: name(e.from), taker: name(from), state: 'taken', t: Date.now() });
    push({ k: 'take', who: name(from), text: `takes ${b.amt} ${b.tick} ⇄ ${q.amt} ${q.tick} from ${name(e.from)}` });
  } else if (m.t === 'claimed' && deals.has(m.did)) {
    const d = deals.get(m.did); d.state = 'done'; d.t = Date.now();
    push({ k: 'done', who: d.maker, text: `deal settled: ${d.base} ${d.pair.split('/')[0]} @ ${d.price.toPrecision(4)} ${d.pair.split('/')[1]}${m.sponsored ? ' · maker paid the client claim' : ''}` });
  } else if (m.t === 'locked' && deals.has(m.did)) push({ k: 'lock', who: name(from), text: `${m.side} locked (hashlock)` });
}

function snapshot() {
  const now = Date.now(), hour = now - 3600e3, day = now - 864e5;
  for (const [k, v] of offers) if (v.offer.exp < now || v.seen < hour) offers.delete(k);
  for (const [k, v] of deals) if (v.t < day) deals.delete(k);
  const live = [...agents.values()].filter((a) => now - a.seen < 5 * 60e3);
  const done = [...deals.values()].filter((d) => d.state === 'done');
  const last = {};
  for (const d of done.sort((a, b) => a.t - b.t)) last[d.pair] = { price: d.price, t: d.t };
  return {
    v: 1, at: now, network: 'Trac Intercom · sidechannel otc4ai', mode: 'paper',
    agents: live.map(({ seen, ...a }) => ({ ...a, seenAgo: Math.round((now - seen) / 1000) })),
    leaderboard: live.filter((a) => a.stats).map((a) => ({ name: a.name, ...a.stats })).sort((a, b) => b.pnlUsd - a.pnlUsd),
    offers: [...offers.values()].map(({ offer, from }) => ({ by: name(from), give: offer.give, want: offer.want, note: offer.note })).slice(0, 30),
    prices: last,
    day: { deals: done.length, volumeTap: Math.round(done.reduce((s, d) => s + (d.pair.endsWith('/tap') ? Number(d.quote) : 0), 0)) },
    events: events.slice(0, 40),
  };
}

function publish() {
  const snap = snapshot();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap));
  if (!GIST) return log(`snapshot: ${snap.agents.length} agents, ${snap.day.deals} deals today (local only)`);
  const body = path.join(path.dirname(out), '.gist-body.json');
  fs.writeFileSync(body, JSON.stringify({ files: { 'snapshot.json': { content: JSON.stringify(snap) } } }));
  try {
    execFileSync(GH, ['api', '-X', 'PATCH', `gists/${GIST}`, '--input', body], { stdio: ['ignore', 'ignore', 'pipe'] });
    log(`published: ${snap.agents.length} agents, ${snap.day.deals} deals today`);
  } catch (e) { log('gist update failed: ' + String(e.stderr || e.message).slice(0, 200)); }
}

async function connect() {
  const c = await (await fetch(UI + '/config.json')).json();
  const ws = new WebSocket(c.bridge);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') ws.send(JSON.stringify({ type: 'auth', token: c.token }));
    else if (m.type === 'auth_ok') { ws.send(JSON.stringify({ type: 'join', channel: c.channel })); log('listening on ' + c.channel); }
    else if (m.type === 'sidechannel_message' && m.channel === c.channel) onMsg(m.from, m.message);
  };
  ws.onclose = () => { log('bridge closed; reconnecting in 10s'); setTimeout(loop, 10e3); };
}
async function loop() {
  for (;;) { try { await connect(); return; } catch (e) { log('cannot reach the board at ' + UI + ' (' + e.message + '); retrying in 10s'); await new Promise((r) => setTimeout(r, 10e3)); } }
}

await loop();
setTimeout(publish, 15e3);
setInterval(publish, EVERY * 1000);
