// OTC4AI agent engine: speaks the board protocol over an Intercom SC-Bridge and runs deals
// end to end without a human. Same messages as the web board, plus RFQ/quote for bots:
//   announce  {agent}                                  who I am, which pairs I trade (re-sent every 45s)
//   offer     {offer}  / cancel {oid}                  standing public offers (shown on the board)
//   rfq       {rfq, give?|want?, amt, addr, mode, exp} "who sells/buys X of TICK?" (amt in base units)
//   quote     {to, rfq, offer}                          private offer answering an rfq
//   take / accept / reject / locked / claimed           the deal flow (see otc/app.js and README)
// Settlement goes through an adapter: "paper" (simulated, no chain) or "draft" (writes the TAP
// redeem drafts for a human to sign and inscribe). The engine never holds private keys.
import { EventEmitter } from 'node:events';
import * as tap from '../otc/tap.js';

const APP = 'otc4ai';
const rid = () => crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
const pairKey = (a, b) => `${a.toLowerCase()}/${b.toLowerCase()}`;

export function validOffer(o) {
  return !!o && typeof o.oid === 'string' && o.oid.length <= 64 && o.give && o.want && tap.isTick(o.give.tick) && tap.isAmt(o.give.amt)
    && tap.isTick(o.want.tick) && tap.isAmt(o.want.amt) && tap.isAddr(o.addr) && Number(o.exp) > Date.now();
}

export class OtcAgent extends EventEmitter {
  constructor({ bridge, token, channel, name, addr, mode = 'paper', settle, policy, tipHeight = tap.tipHeight }) {
    super();
    Object.assign(this, { bridge, token, channel, name, addr, mode, settle, policy });
    this.me = null; this.ready = false;
    this.offers = new Map();   // public offers on the board: oid -> {offer, from}
    this.mine = new Map();     // my standing offers + quotes: oid -> offer
    this.deals = new Map();    // did -> deal
    this.agents = new Map();   // peer -> {agent, seen}
    this.rfqs = new Map();     // my open rfqs: rfq -> {quotes: []}
    this.chain = Promise.resolve();
    let tip = null;            // cache the block height for a minute
    this.tipHeight = async () => (tip && Date.now() - tip.at < 60e3 ? tip.h : (tip = { h: await tipHeight(), at: Date.now() }).h);
  }

  // ---- transport ----
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.bridge); this.ws = ws;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'hello') { this.me = m.peer; ws.send(JSON.stringify({ type: 'auth', token: this.token })); }
        else if (m.type === 'auth_ok') { this.ready = true; ws.send(JSON.stringify({ type: 'join', channel: this.channel })); this.announce(); this.timer = setInterval(() => this.announce(), 45e3); resolve(this); }
        else if (m.type === 'sidechannel_message' && m.channel === this.channel) this.onMsg(m.from, m.message);
        else if (m.type === 'error') this.emit('log', 'bridge error ' + JSON.stringify(m));
      };
      ws.onerror = () => reject(new Error('cannot reach SC-Bridge at ' + this.bridge));
      ws.onclose = () => { const was = this.ready; this.ready = false; clearInterval(this.timer); if (was) { this.emit('log', 'bridge closed'); this.emit('closed'); } };
    });
  }
  send(msg) { if (this.ready) this.ws.send(JSON.stringify({ type: 'send', channel: this.channel, message: { app: APP, v: 1, ...msg } })); }
  close() { clearInterval(this.timer); this.ws?.close(); }

  announce() {
    const now = Date.now();
    this.send({ t: 'announce', agent: { name: this.name, kind: 'bot', pairs: this.policy.pairs(), modes: [this.mode], sw: 'otc4ai-agent/0.3', ...(this.policy.info?.() || {}) } });
    for (const [oid, o] of this.mine) {
      if (o.exp < now) this.mine.delete(oid);
      else if (!o.private) this.send({ t: 'offer', offer: strip(o) });
    }
    for (const [oid, e] of this.offers) if (e.offer.exp < now) this.offers.delete(oid);
    for (const d of this.deals.values()) if (!d.end && now - d.touched > 30 * 60e3) this.finish(d, 'expired');
  }

  // ---- public API for bots ----
  postOffer(give, want, { ttl = 3 * 864e5, note = '' } = {}) {
    const o = { oid: rid(), give, want, addr: this.addr, exp: Date.now() + ttl, note, mode: this.mode };
    if (!validOffer(o)) throw new Error('invalid offer');
    this.mine.set(o.oid, o); this.send({ t: 'offer', offer: strip(o) }); return o;
  }
  cancelOffer(oid) { this.mine.delete(oid); this.send({ t: 'cancel', oid }); }

  // Ask the network for quotes and collect them for `wait` ms. side: 'buy' = I want `tick`, 'sell' = I give `tick`.
  async requestQuotes({ side, tick, amt, against, wait = 6000 }) {
    const id = rid();
    const r = { quotes: [] }; this.rfqs.set(id, r);
    this.send({ t: 'rfq', rfq: id, side, tick, amt: String(amt), against, addr: this.addr, mode: this.mode, exp: Date.now() + wait + 60e3 });
    await new Promise((res) => setTimeout(res, wait));
    this.rfqs.delete(id);
    return r.quotes;
  }
  take(entry) {
    const did = rid(), offer = entry.offer;
    const d = { id: did, role: 'taker', state: 'requested', offer, peer: entry.from, takerAddr: this.addr, mode: offer.mode || 'paper', created: Date.now(), touched: Date.now() };
    this.deals.set(did, d);
    this.send({ t: 'take', oid: offer.oid, did, to: entry.from, addr: this.addr, mode: d.mode });
    this.emit('deal', d); return d;
  }

  // ---- protocol ----
  onMsg(from, m) {
    if (!m || m.app !== APP || m.v !== 1 || !from || from === this.me) return;
    this.emit('wire', from, m);
    if (m.t === 'announce' && m.agent && typeof m.agent.name === 'string') this.agents.set(from, { agent: m.agent, seen: Date.now() });
    else if (m.t === 'offer' && validOffer(m.offer)) this.offers.set(m.offer.oid, { offer: m.offer, from });
    else if (m.t === 'cancel') { const e = this.offers.get(m.oid); if (e?.from === from) this.offers.delete(m.oid); }
    else if (m.t === 'rfq') this.onRfq(from, m).catch((e) => this.emit('log', 'rfq error ' + e.message));
    else if (m.to === this.me && m.t === 'quote') { const r = this.rfqs.get(m.rfq); if (r && validOffer(m.offer)) r.quotes.push({ offer: m.offer, from }); }
    // Messages of one deal run one at a time so a fast counterparty cannot overtake our own async
    // steps; different deals run side by side (a lock waiting for a batch must not stall the others).
    else if (m.to === this.me) {
      const d = this.deals.get(m.did), run = () => this.onDirect(from, m).catch((e) => this.emit('log', 'deal error ' + e.message));
      if (d && m.t !== 'take') d.chain = (d.chain || Promise.resolve()).then(run);
      else this.chain = this.chain.then(run);
    }
  }

  async onRfq(from, m) {
    if (typeof m.rfq !== 'string' || !tap.isTick(m.tick) || !tap.isTick(m.against) || !tap.isAmt(m.amt) || !tap.isAddr(m.addr)) return;
    if ((m.mode || 'paper') !== this.mode) return;
    const q = this.policy.quote?.({ side: m.side, tick: m.tick.toLowerCase(), against: m.against.toLowerCase(), amt: Number(m.amt), from });
    if (!q) return;
    const offer = { oid: rid(), give: q.give, want: q.want, addr: this.addr, exp: Date.now() + 120e3, note: 'quote', mode: this.mode, private: true };
    if (!validOffer(offer)) return;
    this.mine.set(offer.oid, offer);
    this.send({ t: 'quote', to: from, rfq: m.rfq, offer: strip(offer) });
  }

  async onDirect(from, m) {
    if (m.t === 'take') {
      const offer = this.mine.get(m.oid);
      if (!offer || this.deals.has(m.did) || !tap.isAddr(m.addr) || typeof m.did !== 'string') return;
      const d = { id: m.did, role: 'maker', state: 'taken', offer, peer: from, takerAddr: m.addr, mode: offer.mode, created: Date.now(), touched: Date.now() };
      this.deals.set(d.id, d); this.emit('deal', d);
      if (!(await this.policy.approve?.(d) ?? true)) { this.send({ t: 'reject', did: d.id, to: from, reason: 'policy' }); return this.finish(d, 'rejected'); }
      this.mine.delete(offer.oid); if (!offer.private) this.send({ t: 'cancel', oid: offer.oid }); // one taker per offer
      const tip = await this.tipHeight();
      d.secret = tap.newSecret(); d.hash = await tap.hashOf(d.secret);
      d.t2 = tip + tap.WINDOW.taker; d.t1 = tip + tap.WINDOW.maker; this.step(d, 'accepted');
      this.send({ t: 'accept', did: d.id, to: from, hash: d.hash, t1: d.t1, t2: d.t2 });
      // the lock may wait for a batch: continue on this deal's own chain, free the shared one
      d.chain = (async () => {
        d.makerLock = await this.settle.lock(d, 'maker'); this.step(d, 'makerLocked');
        this.send({ t: 'locked', did: d.id, to: from, side: 'maker', lock: d.makerLock });
      })().catch((e) => this.finish(d, 'failed', 'maker lock: ' + e.message));
      return;
    }
    const d = this.deals.get(m.did);
    if (!d || d.peer !== from || d.end) return;
    d.touched = Date.now();
    if (m.t === 'reject') return this.finish(d, 'rejected');
    if (d.role === 'taker') {
      if (m.t === 'accept' && d.state === 'requested') {
        if (!/^[0-9a-f]{64}$/.test(m.hash) || !Number.isInteger(m.t1) || !Number.isInteger(m.t2)) return this.finish(d, 'failed');
        const errs = tap.checkWindows(m.t1, m.t2, await this.tipHeight());
        if (errs.length) return this.finish(d, 'failed', errs.join('; '));
        Object.assign(d, { hash: m.hash, t1: m.t1, t2: m.t2 }); this.step(d, 'accepted');
      } else if (m.t === 'locked' && m.side === 'maker' && d.state === 'accepted' && this.settle.isLockId(m.lock)) {
        d.makerLock = m.lock;
        const v = await this.settle.verify(d, 'maker', m.lock);
        if (!v.ok) return this.finish(d, 'failed', 'maker lock: ' + v.problems.join('; '));
        this.step(d, 'makerLocked');
        d.takerLock = await this.settle.lock(d, 'taker'); this.step(d, 'takerLocked');
        this.send({ t: 'locked', did: d.id, to: from, side: 'taker', lock: d.takerLock });
      } else if (m.t === 'claimed' && d.state === 'takerLocked' && typeof m.preimage === 'string') {
        if ((await tap.hashOf(m.preimage.toLowerCase()).catch(() => '')) !== d.hash) return; // ignore bad secrets
        d.preimage = m.preimage.toLowerCase();
        await this.settle.claim(d, d.makerLock, d.preimage);
        this.finish(d, 'done');
      }
    } else if (m.t === 'locked' && m.side === 'taker' && d.state === 'makerLocked' && this.settle.isLockId(m.lock)) {
      d.takerLock = m.lock;
      const v = await this.settle.verify(d, 'taker', m.lock);
      if (!v.ok) return this.emit('log', `deal ${d.id}: taker lock rejected (${v.problems.join('; ')}); will refund after ${d.t1}`);
      await this.settle.claim(d, d.takerLock, d.secret);
      this.send({ t: 'claimed', did: d.id, to: from, side: 'maker', lock: d.takerLock, preimage: d.secret });
      this.finish(d, 'done');
    }
  }

  step(d, state) { d.state = state; d.touched = Date.now(); this.emit('deal', d); }
  finish(d, end, note) { d.end = end; d.state = end; if (note) d.note = note; this.emit('deal', d); if (end === 'done') this.policy.settled?.(d); }
}

const strip = ({ private: _p, ...o }) => o;
export { pairKey };
