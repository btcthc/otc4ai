import * as tap from './tap.js';

// ---------- i18n ----------
const RU = {
  connecting: 'Подключение к узлу…', online: 'В сети', offline: 'Нет связи с узлом', peers: 'пиров',
  board: 'Доска', myDeals: 'Мои сделки', settings: 'Настройки', newOffer: 'Новое объявление',
  give: 'Отдаю', want: 'Хочу получить', ticker: 'Тикер', amount: 'Сумма', note: 'Комментарий', post: 'Опубликовать',
  noOffers: 'Пока нет объявлений. Будьте первым!', take: 'Взять', cancel: 'Снять', mine: 'моё', price: 'Цена',
  needAddr: 'Сначала укажите свой Taproot-адрес (bc1p…) в настройках.', yourAddr: 'Ваш BTC Taproot-адрес (получение токенов)',
  authId: 'ID вашего token-auth authority (для подписи)', indexer: 'URL индексатора ord-tap (необязательно)', save: 'Сохранить', saved: 'Сохранено',
  backup: 'Скачать резервную копию сделок', noDeals: 'Сделок пока нет.',
  agents: 'Агенты', agentsOnline: 'Боты в сети', feed: 'Живая лента', noAgents: 'Пока ни одного бота. Запустите своего: start-otc.ps1 -Bot', botDemo: 'бот · демо', pairs: 'Пары', lastSeen: 'был',
  accept: 'Принять', reject: 'Отклонить', step: 'Шаг', status: 'Статус', copy: 'Копировать', copied: 'Скопировано',
  lockIdPh: 'ID замка: <inscription>i0:0', submitLock: 'Я записал замок', verify: 'Проверить замок', claimDone: 'Я забрал токены',
  refundTitle: 'Возврат', refundText: 'Окно возврата открыто. Запишите это действие, чтобы вернуть свои токены.',
  ruleNever: 'Правило доски: никогда не отправляйте токены напрямую. Только через замок (lock), который проверяет блокчейн.',
};
const EN = Object.fromEntries(Object.keys(RU).map((k) => [k, k]));
Object.assign(EN, {
  connecting: 'Connecting to peer…', online: 'Online', offline: 'Peer not reachable', peers: 'peers',
  board: 'Board', myDeals: 'My deals', settings: 'Settings', newOffer: 'New offer',
  give: 'I give', want: 'I want', ticker: 'Ticker', amount: 'Amount', note: 'Note', post: 'Post offer',
  noOffers: 'No offers yet. Be the first!', take: 'Take', cancel: 'Cancel', mine: 'mine', price: 'Price',
  needAddr: 'Set your Taproot address (bc1p…) in Settings first.', yourAddr: 'Your BTC Taproot address (receives tokens)',
  authId: 'Your token-auth authority id (for signing)', indexer: 'ord-tap indexer URL (optional)', save: 'Save', saved: 'Saved',
  backup: 'Download deal backup', noDeals: 'No deals yet.',
  agents: 'Agents', agentsOnline: 'Bots online', feed: 'Live feed', noAgents: 'No bots yet. Start your own: start-otc.ps1 -Bot', botDemo: 'bot · paper', pairs: 'Pairs', lastSeen: 'seen',
  accept: 'Accept', reject: 'Reject', step: 'Step', status: 'Status', copy: 'Copy', copied: 'Copied',
  lockIdPh: 'Lock id: <inscription>i0:0', submitLock: 'I inscribed the lock', verify: 'Verify lock', claimDone: 'I claimed the tokens',
  refundTitle: 'Refund', refundText: 'The refund window is open. Inscribe this action to get your tokens back.',
  ruleNever: 'Board rule: never send tokens directly. Only through a lock that the chain enforces.',
});
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('otc.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('otc.' + k, JSON.stringify(v)); } catch {} },
};
let lang = store.get('lang', navigator.language.startsWith('ru') ? 'ru' : 'en');
const t = (k) => (lang === 'ru' ? RU : EN)[k] ?? k;

// ---------- state ----------
const S = {
  me: null, ws: null, ready: false, cfg: null, conns: 0,
  offers: new Map(),                    // oid -> {offer, from, seen}
  deals: store.get('deals', {}),        // did -> deal (maker keeps the secret here)
  settings: store.get('settings', { addr: '', auth: '', indexer: '' }),
  myOffers: store.get('myOffers', {}),  // oid -> offer (re-announced while open)
  tab: ['board', 'deals', 'agents', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'board', tip: null,
  agents: new Map(),                    // peer -> {agent, seen}
  feed: [],                             // recent protocol events from everyone on the channel
};
const APP = 'otc4ai';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const short = (k) => (k ? k.slice(0, 6) + '…' + k.slice(-4) : '?');
const saveDeals = () => store.set('deals', S.deals);

// ---------- bridge ----------
async function connect() {
  S.cfg = await fetch('/config.json').then((r) => r.json());
  const ws = new WebSocket(S.cfg.bridge);
  S.ws = ws;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') { S.me = m.peer; ws.send(JSON.stringify({ type: 'auth', token: S.cfg.token })); }
    else if (m.type === 'auth_ok') { S.ready = true; ws.send(JSON.stringify({ type: 'join', channel: S.cfg.channel })); announce(); render(); }
    else if (m.type === 'stats') { S.conns = m.connectionCount ?? 0; renderStatus(); }
    else if (m.type === 'sidechannel_message' && m.channel === S.cfg.channel) onMsg(m.from, m.message);
  };
  ws.onclose = () => { S.ready = false; renderStatus(); setTimeout(connect, 3000); };
}
function send(msg) {
  if (!S.ready) return false;
  S.ws.send(JSON.stringify({ type: 'send', channel: S.cfg.channel, message: { app: APP, v: 1, ...msg } }));
  return true;
}

// ---------- protocol ----------
// Every message is signed by its author's peer key; the patched sidechannel drops forgeries,
// so `from` can be trusted. Payload fields are still untrusted input and are validated here.
function validOffer(o) {
  return o && typeof o.oid === 'string' && o.give && o.want && tap.isTick(o.give.tick) && tap.isAmt(o.give.amt)
    && tap.isTick(o.want.tick) && tap.isAmt(o.want.amt) && tap.isAddr(o.addr) && Number(o.exp) > Date.now();
}
function onMsg(from, m) {
  if (!m || m.app !== APP || m.v !== 1 || !from) return;
  if (m.t === 'announce' && m.agent && typeof m.agent.name === 'string') { S.agents.set(from, { agent: m.agent, seen: Date.now() }); scheduleRender(); return; }
  if (['rfq', 'quote', 'take', 'accept', 'locked', 'claimed', 'reject'].includes(m.t)) { S.feed.unshift({ ts: Date.now(), from, m }); S.feed.length = Math.min(S.feed.length, 60); if (S.tab === 'agents') scheduleRender(); }
  if (m.t === 'offer' && validOffer(m.offer)) {
    S.offers.set(m.offer.oid, { offer: m.offer, from, seen: Date.now() }); scheduleRender();
  } else if (m.t === 'cancel') {
    const e = S.offers.get(m.oid); if (e && e.from === from) { S.offers.delete(m.oid); scheduleRender(); }
  } else if (m.to === S.me) onDirect(from, m);
}
function onDirect(from, m) {
  const d = S.deals[m.did];
  if (m.t === 'take') {
    const offer = S.myOffers[m.oid];
    if (!offer || S.deals[m.did] || !tap.isAddr(m.addr)) return;
    S.deals[m.did] = { id: m.did, role: 'maker', state: 'taken', offer, peer: from, takerAddr: m.addr, created: Date.now(), log: [] };
  } else if (!d || d.peer !== from) return;
  else if (m.t === 'accept' && d.role === 'taker' && d.state === 'requested') {
    if (!/^[0-9a-f]{64}$/.test(m.hash) || !(m.t1 > 0) || !(m.t2 > 0)) return;
    Object.assign(d, { hash: m.hash, t1: m.t1, t2: m.t2, state: 'accepted' });
    const errs = S.tip ? tap.checkWindows(d.t1, d.t2, S.tip) : [];
    if (errs.length) { d.state = 'failed'; d.note = errs.join('; '); }
  } else if (m.t === 'reject') { d.state = 'rejected'; d.note = String(m.reason || '').slice(0, 200); }
  else if (m.t === 'locked' && tap.isLockId(m.lock)) {
    if (d.role === 'taker' && m.side === 'maker') { d.makerLock = m.lock; if (d.state === 'accepted') d.state = 'makerLocked'; }
    if (d.role === 'maker' && m.side === 'taker') { d.takerLock = m.lock; if (d.state === 'makerLocked') d.state = 'takerLocked'; }
  } else if (m.t === 'claimed' && d.role === 'taker' && typeof m.preimage === 'string') {
    // Trust but verify: only accept a preimage that hashes to the deal hash.
    tap.hashOf(m.preimage.toLowerCase()).then((h) => { if (h === d.hash) { d.preimage = m.preimage.toLowerCase(); d.state = 'canClaim'; saveDeals(); render(); } }).catch(() => {});
  } else return;
  saveDeals(); render();
}
function announce() {
  const now = Date.now();
  for (const [oid, o] of Object.entries(S.myOffers)) {
    if (o.exp < now) { delete S.myOffers[oid]; continue; }
    send({ t: 'offer', offer: o });
    S.offers.set(oid, { offer: o, from: S.me, seen: now });
  }
  store.set('myOffers', S.myOffers);
  for (const [oid, e] of S.offers) if (e.offer.exp < now || now - e.seen > 5 * 60e3) S.offers.delete(oid);
  if (S.ready) S.ws.send(JSON.stringify({ type: 'stats' }));
}

// ---------- actions ----------
function postOffer(f) {
  const addr = S.settings.addr;
  if (!tap.isAddr(addr)) return alert(t('needAddr'));
  const o = { oid: rid(), give: { tick: f.gt.value.trim(), amt: f.ga.value.trim() }, want: { tick: f.wt.value.trim(), amt: f.wa.value.trim() }, addr, exp: Date.now() + 3 * 864e5, note: f.note.value.trim().slice(0, 140) };
  if (!validOffer(o)) return alert('Check ticker / amount');
  S.myOffers[o.oid] = o; announce(); f.reset(); render();
}
function cancelOffer(oid) { delete S.myOffers[oid]; S.offers.delete(oid); store.set('myOffers', S.myOffers); send({ t: 'cancel', oid }); render(); }
function takeOffer(oid) {
  const e = S.offers.get(oid); if (!e) return;
  if (!tap.isAddr(S.settings.addr)) return alert(t('needAddr'));
  const did = rid();
  S.deals[did] = { id: did, role: 'taker', state: 'requested', offer: e.offer, peer: e.from, takerAddr: S.settings.addr, created: Date.now() };
  saveDeals(); send({ t: 'take', oid, did, to: e.from, addr: S.settings.addr }); S.tab = 'deals'; render();
}
async function acceptDeal(did) {
  const d = S.deals[did];
  const tip = await tap.tipHeight();
  d.secret = tap.newSecret(); d.hash = await tap.hashOf(d.secret);
  d.t2 = tip + tap.WINDOW.taker; d.t1 = tip + tap.WINDOW.maker; d.state = 'accepted';
  saveDeals(); send({ t: 'accept', did, to: d.peer, hash: d.hash, t1: d.t1, t2: d.t2 }); render();
}
function rejectDeal(did) { const d = S.deals[did]; d.state = 'rejected'; saveDeals(); send({ t: 'reject', did, to: d.peer, reason: 'maker rejected' }); render(); }
function submitLock(did, side, input) {
  const id = input.value.trim(); if (!tap.isLockId(id)) return alert('Lock id format: <inscriptionId>:<actionIndex>, e.g. abc…i0:0');
  const d = S.deals[did];
  if (side === 'maker') { d.makerLock = id; d.state = d.takerLock ? 'takerLocked' : 'makerLocked'; }
  else { d.takerLock = id; d.state = 'takerLockedWait'; }
  saveDeals(); send({ t: 'locked', did, to: d.peer, side, lock: id }); render();
}
async function verifyLeg(did, side, out) {
  const d = S.deals[did], legs = tap.dealLegs(d), lockId = side === 'maker' ? d.makerLock : d.takerLock;
  out.textContent = '…';
  try {
    const r = await tap.verifyLock(S.settings.indexer, lockId, legs[side], S.tip);
    out.className = r.ok ? 'ok' : 'bad';
    out.textContent = r.ok ? '✔ lock matches the deal' : '✖ ' + r.problems.join(' · ');
    d['verified_' + side] = r.ok; saveDeals();
  } catch (e) { out.className = 'bad'; out.textContent = '✖ ' + e.message; }
}
function claimDone(did) {
  const d = S.deals[did];
  if (d.role === 'maker') send({ t: 'claimed', did, to: d.peer, side: 'maker', lock: d.takerLock, preimage: d.secret });
  d.state = 'done'; saveDeals(); render();
}
async function pollPreimage(d) {
  if (d.role !== 'taker' || d.state !== 'takerLockedWait' || !S.settings.indexer) return;
  const p = await tap.findPreimage(S.settings.indexer, d.takerLock, d.hash).catch(() => null);
  if (p) { d.preimage = p; d.state = 'canClaim'; saveDeals(); render(); }
}

// ---------- render ----------
let rq = 0;
const scheduleRender = () => { if (!rq) rq = requestAnimationFrame(() => { rq = 0; render(); }); };
function renderStatus() {
  const el = $('#status');
  el.className = 'status ' + (S.ready ? 'on' : 'off');
  el.textContent = S.ready ? `${t('online')} · ${S.conns} ${t('peers')} · ${short(S.me)}` : S.cfg ? t('offline') : t('connecting');
}
function render() {
  document.documentElement.lang = lang;
  $('#lang').textContent = lang === 'ru' ? 'EN' : 'RU';
  document.querySelectorAll('[data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === S.tab); b.textContent = t(b.dataset.label); });
  const open = Object.values(S.deals).filter((d) => !['done', 'rejected', 'failed'].includes(d.state)).length;
  $('[data-tab="deals"]').textContent = t('myDeals') + (open ? ` (${open})` : '');
  renderStatus();
  $('#rule').textContent = t('ruleNever');
  const main = $('#main');
  // Keep what the user is typing across re-renders.
  const keep = {}, focus = document.activeElement?.closest('#main') ? document.activeElement.id || document.activeElement.name : null;
  main.querySelectorAll('input').forEach((i) => { keep[i.id || i.name] = i.value; });
  if (S.tab === 'board') main.innerHTML = boardHtml();
  else if (S.tab === 'deals') main.innerHTML = dealsHtml();
  else if (S.tab === 'agents') main.innerHTML = agentsHtml();
  else main.innerHTML = settingsHtml();
  main.querySelectorAll('input').forEach((i) => { const k = i.id || i.name; if (keep[k] !== undefined) i.value = keep[k]; if (k === focus) i.focus(); });
}
function boardHtml() {
  const rows = [...S.offers.values()].sort((a, b) => b.offer.exp - a.offer.exp).map(({ offer: o, from }) => {
    const mine = from === S.me, paper = o.mode === 'paper';
    // Quote prices in the counter asset per one unit of the other (TAP is the usual quote asset).
    const inv = o.give.tick.toLowerCase() === 'tap', base = inv ? o.want : o.give, quote = inv ? o.give : o.want;
    const px = Number(quote.amt) / Number(base.amt);
    return `<tr><td><b>${esc(o.give.amt)}</b> ${esc(o.give.tick)}</td><td><b>${esc(o.want.amt)}</b> ${esc(o.want.tick)}</td>
      <td class="mono">${px.toPrecision(4)} ${esc(quote.tick)}/${esc(base.tick)}</td><td class="mute">${esc(o.note)}</td>
      <td class="mono mute">${mine ? t('mine') : short(from)}</td>
      <td>${mine ? `<button class="ghost" data-act="cancel" data-id="${o.oid}">${t('cancel')}</button>` : paper ? `<span class="pill">${t('botDemo')}</span>` : `<button data-act="take" data-id="${o.oid}">${t('take')}</button>`}</td></tr>`;
  }).join('');
  return `<div class="grid"><section class="card"><h2>${t('board')}</h2>
    ${rows ? `<div class="tw"><table><thead><tr><th>${t('give')}</th><th>${t('want')}</th><th>${t('price')}</th><th>${t('note')}</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="mute">${t('noOffers')}</p>`}
  </section><section class="card"><h2>${t('newOffer')}</h2><form id="offer">
    <label>${t('give')}</label><div class="row"><input name="gt" placeholder="${t('ticker')}" required><input name="ga" placeholder="${t('amount')}" inputmode="decimal" required></div>
    <label>${t('want')}</label><div class="row"><input name="wt" placeholder="${t('ticker')}" required><input name="wa" placeholder="${t('amount')}" inputmode="decimal" required></div>
    <label>${t('note')}</label><input name="note" maxlength="140">
    <button type="submit">${t('post')}</button></form></section></div>`;
}
const code = (obj) => { const s = JSON.stringify(obj, null, 2); return `<div class="code"><button class="ghost copy" data-copy="${esc(s)}">${t('copy')}</button><pre>${esc(s)}</pre></div>`; };
function dealsHtml() {
  const list = Object.values(S.deals).sort((a, b) => b.created - a.created);
  if (!list.length) return `<section class="card"><p class="mute">${t('noDeals')}</p></section>`;
  return list.map(dealHtml).join('');
}
function dealHtml(d) {
  const o = d.offer, legs = d.hash ? tap.dealLegs(d) : null, auth = S.settings.auth;
  const head = `<h2>${esc(o.give.amt)} ${esc(o.give.tick)} ⇄ ${esc(o.want.amt)} ${esc(o.want.tick)} <span class="pill">${d.role}</span> <span class="pill s-${d.state}">${d.state}</span></h2>
    <p class="mute mono">deal ${d.id} · ${d.role === 'maker' ? 'taker' : 'maker'} ${short(d.peer)}${d.t1 ? ` · refunds at blocks ${d.t1} (maker) / ${d.t2} (taker)` : ''}${S.tip ? ` · now ${S.tip}` : ''}</p>${d.note ? `<p class="bad">${esc(d.note)}</p>` : ''}`;
  let body = '';
  const lockInput = (side) => `<div class="row"><input id="lk-${d.id}" placeholder="${t('lockIdPh')}"><button data-act="lock" data-id="${d.id}" data-side="${side}">${t('submitLock')}</button></div>`;
  const verifyBtn = (side) => `<button class="ghost" data-act="verify" data-id="${d.id}" data-side="${side}">${t('verify')}</button> <span id="vf-${d.id}-${side}" class="${d['verified_' + side] ? 'ok' : ''}">${d['verified_' + side] ? '✔ verified' : ''}</span>`;
  if (d.role === 'maker') {
    if (d.state === 'taken') body = `<p>Taker wants this deal and will receive at <span class="mono">${esc(d.takerAddr)}</span>.</p><button data-act="accept" data-id="${d.id}">${t('accept')}</button> <button class="ghost" data-act="reject" data-id="${d.id}">${t('reject')}</button>`;
    else if (d.state === 'accepted') body = `<p><b>${t('step')} 1.</b> Lock your ${esc(o.give.amt)} ${esc(o.give.tick)} for the taker. Sign this redeem with your authority key and inscribe it, then paste the lock id (inscription id + <span class="mono">:0</span>).</p>${code(tap.redeemDraft(auth, [legs.maker]))}${lockInput('maker')}`;
    else if (d.state === 'makerLocked') body = `<p>Your lock: <span class="mono">${esc(d.makerLock)}</span>. Waiting for the taker to lock ${esc(o.want.amt)} ${esc(o.want.tick)}…</p>`;
    else if (d.state === 'takerLocked') body = `<p><b>${t('step')} 2.</b> The taker locked: <span class="mono">${esc(d.takerLock)}</span>. Verify it, then claim it before block ${d.t2}. Claiming reveals the secret so the taker can claim yours.</p>${verifyBtn('taker')}
      ${d.verified_taker ? code(tap.redeemDraft(auth, [tap.claimAction(d.takerLock, d.secret)])) + `<button data-act="claimed" data-id="${d.id}">${t('claimDone')}</button>` : '<p class="mute">Claim draft appears after a successful verification.</p>'}`;
  } else {
    if (d.state === 'requested') body = `<p class="mute">Waiting for the maker to accept…</p>`;
    else if (d.state === 'accepted') body = `<p class="mute">Accepted. Waiting for the maker to lock ${esc(o.give.amt)} ${esc(o.give.tick)} first…</p>`;
    else if (d.state === 'makerLocked') body = `<p><b>${t('step')} 1.</b> Maker locked: <span class="mono">${esc(d.makerLock)}</span>. Verify it before you lock anything.</p>${verifyBtn('maker')}
      ${d.verified_maker ? `<p><b>${t('step')} 2.</b> Lock your ${esc(o.want.amt)} ${esc(o.want.tick)} for the maker, inscribe, paste the lock id.</p>${code(tap.redeemDraft(auth, [legs.taker]))}${lockInput('taker')}` : ''}`;
    else if (d.state === 'takerLockedWait') body = `<p>Your lock: <span class="mono">${esc(d.takerLock)}</span>. Waiting for the maker to claim it (that reveals the secret)…</p><p class="mute">If nothing happens before block ${d.t2}, refund below.</p>`;
    else if (d.state === 'canClaim') body = `<p><b>${t('step')} 3.</b> Secret revealed. Claim the maker's lock before block ${d.t1}:</p>${code(tap.redeemDraft(auth, [tap.claimAction(d.makerLock, d.preimage)]))}<button data-act="claimed" data-id="${d.id}">${t('claimDone')}</button>`;
  }
  const myLock = d.role === 'maker' ? d.makerLock : d.takerLock, myRefund = d.role === 'maker' ? d.t1 : d.t2;
  if (myLock && S.tip && S.tip >= myRefund && d.state !== 'done') body += `<h3>${t('refundTitle')}</h3><p>${t('refundText')}</p>${code(tap.redeemDraft(auth, [tap.refundAction(myLock)]))}`;
  return `<section class="card deal">${head}${body}</section>`;
}
const who = (k) => (k === S.me ? 'you' : S.agents.get(k)?.agent.name || short(k));
function feedLine({ ts, from, m }) {
  const time = new Date(ts).toTimeString().slice(0, 8), o = m.offer;
  const txt = m.t === 'rfq' ? `asks for quotes: ${m.side} ${esc(m.amt)} ${esc(m.tick)} vs ${esc(m.against)}`
    : m.t === 'quote' ? `quotes ${who(m.to)}: ${esc(o?.give.amt)} ${esc(o?.give.tick)} for ${esc(o?.want.amt)} ${esc(o?.want.tick)}`
    : m.t === 'take' ? `takes an offer from ${who(m.to)}`
    : m.t === 'accept' ? `accepts deal ${esc(m.did)} · hashlock ${esc(String(m.hash).slice(0, 10))}…`
    : m.t === 'locked' ? `locked (${esc(m.side)}) ${esc(String(m.lock).slice(0, 40))}`
    : m.t === 'claimed' ? `claimed — deal ${esc(m.did)} complete ✔`
    : `rejected deal ${esc(m.did)}`;
  return `<tr><td class="mono mute">${time}</td><td><b>${esc(who(from))}</b></td><td>${txt}</td></tr>`;
}
function agentsHtml() {
  const now = Date.now();
  const list = [...S.agents.entries()].filter(([, a]) => now - a.seen < 3 * 60e3).map(([k, { agent: a, seen }]) =>
    `<tr><td><b>${esc(a.name)}</b> <span class="pill">${esc((a.modes || []).join(','))}</span></td><td class="mono">${esc((a.pairs || []).join(' · '))}</td><td class="mono mute">${short(k)}</td><td class="mute">${Math.round((now - seen) / 1000)}s</td></tr>`).join('');
  return `<div class="grid"><section class="card"><h2>${t('feed')}</h2>${S.feed.length ? `<div class="tw"><table><tbody>${S.feed.map(feedLine).join('')}</tbody></table></div>` : '<p class="mute">…</p>'}</section>
    <section class="card"><h2>${t('agentsOnline')}</h2>${list ? `<div class="tw"><table><thead><tr><th></th><th>${t('pairs')}</th><th></th><th>${t('lastSeen')}</th></tr></thead><tbody>${list}</tbody></table></div>` : `<p class="mute">${t('noAgents')}</p>`}</section></div>`;
}
function settingsHtml() {
  const s = S.settings;
  return `<section class="card narrow"><h2>${t('settings')}</h2><form id="settings">
    <label>${t('yourAddr')}</label><input name="addr" value="${esc(s.addr)}" placeholder="bc1p…">
    <label>${t('authId')}</label><input name="auth" value="${esc(s.auth)}" placeholder="…i0">
    <label>${t('indexer')}</label><input name="indexer" value="${esc(s.indexer)}" placeholder="http://127.0.0.1:3333">
    <button type="submit">${t('save')}</button> <span id="saved" class="ok"></span></form>
    <p><button class="ghost" data-act="backup">${t('backup')}</button></p>
    <p class="mute">Channel <span class="mono">${esc(S.cfg?.channel)}</span> · owner <span class="mono">${short(S.cfg?.owner)}</span> · you <span class="mono">${esc(S.me)}</span></p></section>`;
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) { S.tab = b.dataset.tab; history.replaceState(null, '', '#' + S.tab); return render(); }
  if (b.id === 'lang') { lang = lang === 'ru' ? 'en' : 'ru'; store.set('lang', lang); return render(); }
  if (b.dataset.copy !== undefined) { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = t('copied'); return; }
  const { act, id, side } = b.dataset;
  if (act === 'take') takeOffer(id);
  else if (act === 'cancel') cancelOffer(id);
  else if (act === 'accept') acceptDeal(id).catch((err) => alert(err.message));
  else if (act === 'reject') rejectDeal(id);
  else if (act === 'lock') submitLock(id, side, $('#lk-' + id));
  else if (act === 'verify') verifyLeg(id, side, $(`#vf-${id}-${side}`));
  else if (act === 'claimed') claimDone(id);
  else if (act === 'backup') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ deals: S.deals, myOffers: S.myOffers, settings: S.settings }, null, 2)], { type: 'application/json' }));
    a.download = `otc4ai-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  }
});
document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'offer') postOffer(e.target);
  if (e.target.id === 'settings') {
    const f = e.target;
    if (f.addr.value.trim() && !tap.isAddr(f.addr.value)) return alert('Invalid Bitcoin address');
    S.settings = { addr: f.addr.value.trim(), auth: f.auth.value.trim(), indexer: f.indexer.value.trim() };
    store.set('settings', S.settings); $('#saved').textContent = t('saved');
  }
});

async function tick() {
  S.tip = await tap.tipHeight().catch(() => S.tip);
  announce();
  for (const d of Object.values(S.deals)) await pollPreimage(d);
  render();
}
render();
connect().catch(() => renderStatus());
tick(); setInterval(tick, 45e3);
