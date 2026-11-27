'use strict';
/*
 * tgstore — uses a Telegram channel as lookmv's database.
 *
 *  • SNAPSHOT: the whole state (users, my-lists, notes, home history, notice, …) is one JSON document
 *    that lives in the channel as a PINNED message. On every start the bot reads it back with
 *    getChat → pinned_message → getFile. Writes are debounced and edit that same message in place
 *    (fallback: send a new document, pin it, delete the old one).
 *  • LOG: every event (signup, email/password change, delete, my-list, notes, daily home rows…) is also
 *    posted as a readable message, throttled to stay under Telegram's per-channel rate limit.
 *  • POINTER: which channel is active (and the list of known channels) is stored as a pinned message in the
 *    admin's private chat with the bot, so switching channels from the bot survives restarts with no server disk.
 *  • No TELEGRAM_BOT_TOKEN  →  "local" dev mode (state in one local file). Never used in production.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const SNAP_NAME = 'lookmv-db';
const PTR_TAG = 'LOOKMV_POINTER';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const emptyState = () => ({
  v: 1, rev: 0, updatedAt: '',
  users: [],                // { id, email, salt, hash, createdAt, notifSeen? }
  lists: {},                // userId -> [movieId]
  notes: {},                // userId -> { movieId -> [{ t, x }] }
  home: { day: '', top: [], latest: [], source: 'local', genres: [], rows: [] },
  history: [],              // [{ day, genres, ids, rows:[{genre,ids}], top, latest, topShown?, latestShown? }]
  notice: null, maint: null, sources: {},
});
function normalizeState(s) {
  const e = emptyState();
  if (!s || typeof s !== 'object' || !Array.isArray(s.users)) return null;
  const out = { ...e, ...s };
  out.users = s.users; out.lists = s.lists && typeof s.lists === 'object' ? s.lists : {};
  out.notes = s.notes && typeof s.notes === 'object' ? s.notes : {};
  out.home = { ...e.home, ...(s.home || {}) };
  out.history = Array.isArray(s.history) ? s.history : [];
  out.sources = s.sources && typeof s.sources === 'object' ? s.sources : {};
  return out;
}

/* "@name", "name", "https://t.me/name", "t.me/c/123/4", "-100123…"  →  { chat_id } | { error } */
function parseChannelRef(input) {
  let s = String(input || '').trim();
  if (!s) return { error: 'empty' };
  if (/^-?\d{5,}$/.test(s)) return { chat_id: s.startsWith('-') ? s : '-100' + s };
  let m = /(?:https?:\/\/)?(?:t|telegram)\.(?:me|dog)\/c\/(\d+)/i.exec(s);
  if (m) return { chat_id: '-100' + m[1] };
  if (/(?:t|telegram)\.(?:me|dog)\/(\+|joinchat\/)/i.test(s) || /^\+[\w-]{8,}$/.test(s)) return { error: 'invite' };
  m = /(?:https?:\/\/)?(?:t|telegram)\.(?:me|dog)\/([A-Za-z][\w]{3,31})/i.exec(s);
  if (m) return { chat_id: '@' + m[1] };
  m = /^@?([A-Za-z][\w]{3,31})$/.exec(s);
  if (m) return { chat_id: '@' + m[1] };
  return { error: 'bad_ref' };
}

function createStore(opts) {
  const token = String(opts.token || '').trim();
  const adminId = String(opts.adminId || '').trim();
  const envRaw = String(opts.envChannel || '').trim();
  const localFile = opts.localFile;
  const legacy = typeof opts.legacy === 'function' ? opts.legacy : () => null;
  const say = (...a) => console.log('[store]', ...a);
  const warn = (...a) => console.warn('[store]', ...a);
  const local = !token;

  const S = {
    state: emptyState(),
    mode: local ? 'local' : 'telegram',
    status: local ? 'connecting' : 'connecting',   // connecting | ready | no_channel | error | readonly
    lastError: '',
    channels: [],               // [{ id, title, username }]
    active: null,               // chat id string
    activeInfo: null,           // last inspectChannel result
    snapMsgId: 0, ptrMsgId: 0, hadData: false,
    lastSavedAt: 0, lastSavedBytes: 0, lastSavedRev: 0,
    botId: 0,
  };
  const readyCbs = [];
  /* fn runs every time the state is (re)loaded: first connect and after a channel switch */
  S.onReady = fn => { readyCbs.push(fn); if (S.status === 'ready') { try { fn(); } catch (e) { warn('onReady:', e.message); } } };
  S.isReady = () => S.status === 'ready';

  /* ------------------------------ raw Bot API ------------------------------ */
  async function api(method, payload, o = {}) {
    if (!token) return { ok: false, code: 0, desc: 'no token' };
    try {
      let init;
      if (o.files) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(payload || {})) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        for (const [k, f] of Object.entries(o.files)) fd.append(k, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
        init = { method: 'POST', body: fd };
      } else {
        init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) };
      }
      const r = await fetch(API + '/bot' + token + '/' + method, { ...init, signal: AbortSignal.timeout(o.timeout || 20000) });
      const d = await r.json().catch(() => null);
      if (!d) return { ok: false, code: r.status, desc: 'bad response' };
      if (!d.ok) return { ok: false, code: d.error_code || r.status, desc: String(d.description || ''), retry: d.parameters && d.parameters.retry_after };
      return { ok: true, result: d.result };
    } catch (e) { return { ok: false, code: 0, desc: (e && e.name) || 'network' }; }
  }
  /* retries network errors and 429 (honouring retry_after); returns the last response */
  async function apiRetry(method, payload, o = {}, tries = 4) {
    let r;
    for (let i = 0; i < tries; i++) {
      r = await api(method, payload, o);
      if (r.ok) return r;
      if (r.code === 429) { await sleep(Math.min(40, (r.retry || 5) + 1) * 1000); continue; }
      if (r.code === 0 || r.code >= 500) { await sleep(1500 * (i + 1)); continue; }
      return r;
    }
    return r;
  }
  async function downloadFile(file_id) {
    const g = await apiRetry('getFile', { file_id });
    if (!g.ok || !g.result.file_path) return null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(API + '/file/bot' + token + '/' + g.result.file_path, { signal: AbortSignal.timeout(60000) });
        if (r.ok) return Buffer.from(await r.arrayBuffer());
      } catch { /* retry */ }
      await sleep(1500);
    }
    return null;
  }
  const parseSnapshotBuf = buf => {
    try {
      const raw = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
      return normalizeState(JSON.parse(raw.toString('utf8')));
    } catch { return null; }
  };
  const isSnapDoc = msg => !!(msg && msg.document && String(msg.document.file_name || '').startsWith(SNAP_NAME));

  async function getBotId() {
    if (S.botId) return S.botId;
    const r = await apiRetry('getMe', {});
    if (r.ok) S.botId = r.result.id;
    return S.botId;
  }

  /* ------------------------------ channel inspection ------------------------------ */
  async function inspectChannel(chatRef) {
    const c = await apiRetry('getChat', { chat_id: chatRef });
    if (!c.ok) {
      const d = c.desc.toLowerCase();
      if (c.code === 0 || c.code >= 500) return { ok: false, transient: true, reason: 'network', desc: c.desc };
      return { ok: false, reason: d.includes('not found') ? 'not_found' : 'denied', desc: c.desc };
    }
    const chat = c.result;
    if (!['channel', 'supergroup'].includes(chat.type)) return { ok: false, reason: 'not_channel', desc: chat.type };
    const botId = await getBotId();
    const mem = await apiRetry('getChatMember', { chat_id: chat.id, user_id: botId });
    const m = mem.ok ? mem.result : null;
    const isAdmin = !!m && (m.status === 'creator' || m.status === 'administrator');
    const isCh = chat.type === 'channel';
    const can = k => m && (m.status === 'creator' || m[k] === true);
    const info = {
      ok: true, id: String(chat.id), title: chat.title || '', username: chat.username || '', type: chat.type,
      isAdmin,
      canPost: isAdmin && (isCh ? can('can_post_messages') : true),
      canEdit: isAdmin && (isCh ? can('can_edit_messages') : can('can_pin_messages')),
      canDelete: isAdmin && can('can_delete_messages'),
      pinned: chat.pinned_message || null,
    };
    info.snapshotPinned = isSnapDoc(info.pinned);
    return info;
  }
  /* fallback when the pinned message is not ours: forward the known snapshot message to the admin and read its document */
  async function readViaForward(chatId, msgId) {
    if (!adminId || !msgId) return null;
    const f = await apiRetry('forwardMessage', { chat_id: adminId, from_chat_id: chatId, message_id: msgId, disable_notification: true });
    if (!f.ok) return null;
    const msg = f.result;
    apiRetry('deleteMessage', { chat_id: adminId, message_id: msg.message_id }, {}, 1);
    return isSnapDoc(msg) ? { file_id: msg.document.file_id, message_id: msgId } : null;
  }
  /* { state|null, msgId, found } — found=false means "channel has no snapshot"; throws on a transient read failure */
  async function readSnapshot(info, knownMsgId) {
    let doc = null;
    if (info.snapshotPinned) doc = { file_id: info.pinned.document.file_id, message_id: info.pinned.message_id };
    else if (knownMsgId) doc = await readViaForward(info.id, knownMsgId);
    if (!doc) return { state: null, msgId: 0, found: false };
    const buf = await downloadFile(doc.file_id);
    if (!buf) throw new Error('snapshot download failed');
    const st = parseSnapshotBuf(buf);
    if (!st) throw new Error('snapshot is not valid lookmv data');
    return { state: st, msgId: doc.message_id, found: true };
  }

  /* ------------------------------ pointer (admin DM) ------------------------------ */
  async function readPointer() {
    if (!adminId) return null;
    const c = await apiRetry('getChat', { chat_id: adminId });
    if (!c.ok) return null;
    const p = c.result.pinned_message;
    if (!p || !p.text || !p.text.includes(PTR_TAG)) return null;
    try {
      const j = JSON.parse(p.text.slice(p.text.indexOf('{')));
      S.ptrMsgId = p.message_id;
      return j && typeof j === 'object' ? j : null;
    } catch { return null; }
  }
  async function writePointer() {
    if (!adminId || local) return false;
    const ptr = { channels: S.channels, active: S.active, env: envRaw, snap: S.snapMsgId || 0, hadData: !!S.hadData };
    const text = '🔗 ' + PTR_TAG + ' — اتصال ذخیره‌سازی lookmv (این پیام را حذف نکنید)\n' + JSON.stringify(ptr);
    if (S.ptrMsgId) {
      const e = await apiRetry('editMessageText', { chat_id: adminId, message_id: S.ptrMsgId, text, disable_web_page_preview: true }, {}, 2);
      if (e.ok || /not modified/i.test(e.desc)) return true;
    }
    const s = await apiRetry('sendMessage', { chat_id: adminId, text, disable_notification: true, disable_web_page_preview: true });
    if (!s.ok) { warn('pointer write failed:', s.desc); return false; }
    S.ptrMsgId = s.result.message_id;
    await apiRetry('pinChatMessage', { chat_id: adminId, message_id: S.ptrMsgId, disable_notification: true }, {}, 2);
    return true;
  }

  /* ------------------------------ snapshot writing ------------------------------ */
  let dirty = false, flushing = null, debounceT = null, maxT = null, failCount = 0, alerted = false;
  function encode() {
    S.state.updatedAt = new Date().toISOString();
    let data = Buffer.from(JSON.stringify(S.state), 'utf8'), name = SNAP_NAME + '.json';
    if (data.length > 15 * 1024 * 1024) { data = zlib.gzipSync(data); name = SNAP_NAME + '.json.gz'; }
    return { data, name };
  }
  const caption = () => '🗄 lookmv DB · rev ' + S.state.rev + ' · ' + S.state.users.length + ' users · ' + new Date().toISOString();

  async function writeSnapshotToChannel(chatId) {
    const { data, name } = encode();
    const cap = caption();
    const file = { data, name, type: 'application/json' };
    if (S.snapMsgId) {
      const e = await apiRetry('editMessageMedia', {
        chat_id: chatId, message_id: S.snapMsgId,
        media: { type: 'document', media: 'attach://f', caption: cap },
      }, { files: { f: file } }, 3);
      if (e.ok) return { ok: true, bytes: data.length, mode: 'edit' };
      if (/not modified/i.test(e.desc)) return { ok: true, bytes: data.length, mode: 'same' };
      warn('edit failed (' + e.desc + '), sending a new snapshot');
    }
    const s = await apiRetry('sendDocument', { chat_id: chatId, caption: cap, disable_notification: true }, { files: { document: file }, timeout: 60000 }, 3);
    if (!s.ok) return { ok: false, desc: s.desc };
    const oldId = S.snapMsgId;
    S.snapMsgId = s.result.message_id;
    const p = await apiRetry('pinChatMessage', { chat_id: chatId, message_id: S.snapMsgId, disable_notification: true }, {}, 3);
    if (!p.ok) { warn('pin failed:', p.desc); return { ok: false, desc: 'pin: ' + p.desc, partial: true }; }
    if (oldId && oldId !== S.snapMsgId) apiRetry('deleteMessage', { chat_id: chatId, message_id: oldId }, {}, 1);
    return { ok: true, bytes: data.length, mode: 'new' };
  }

  async function doFlush() {
    if (S.status !== 'ready') return;
    const revNow = S.state.rev;
    dirty = false;
    if (local) {
      try {
        const tmp = localFile + '.tmp';
        fs.mkdirSync(path.dirname(localFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(S.state)); fs.renameSync(tmp, localFile);
        S.lastSavedAt = Date.now(); S.lastSavedRev = revNow;
      } catch (e) { warn('local save failed:', e.message); dirty = true; failCount++; }
      return;
    }
    const r = await writeSnapshotToChannel(S.active);
    if (r.ok) {
      failCount = 0; alerted = false;
      S.lastSavedAt = Date.now(); S.lastSavedBytes = r.bytes; S.lastSavedRev = revNow; S.lastError = '';
      if (!S.hadData || S.ptrSnap !== S.snapMsgId) { S.hadData = true; S.ptrSnap = S.snapMsgId; writePointer(); }
    } else {
      dirty = true; failCount++; S.lastError = r.desc || 'unknown';
      warn('snapshot save failed (' + failCount + '):', S.lastError);
      if (failCount >= 3 && !alerted && opts.onAlert) {
        alerted = true;
        opts.onAlert('⚠️ ذخیرهٔ اطلاعات در کانال تلگرام ناموفق است (' + failCount + ' بار پشت‌سرهم).\nدلیل: ' + S.lastError + '\n\nبررسی کنید ربات در کانال ادمین باشد و دسترسی ارسال پیام، ویرایش پیام و حذف پیام داشته باشد. تغییرات تا اتصال دوباره در حافظهٔ سرور نگه داشته می‌شود و دوباره تلاش می‌شود.');
      }
    }
  }
  function flushNow() {
    clearTimeout(debounceT); clearTimeout(maxT); debounceT = maxT = null;
    if (flushing) return flushing.then(() => (dirty ? flushNow() : undefined));
    /* nothing to do: return WITHOUT touching `flushing` (an async body that finishes synchronously would
       leave a stale resolved promise in it and make every later flush recurse forever) */
    if (!dirty || S.status !== 'ready') return Promise.resolve();
    flushing = (async () => {
      try { while (dirty && S.status === 'ready') { const before = failCount; await doFlush(); if (dirty && failCount > before) break; } }
      finally { flushing = null; }
    })();
    return flushing;
  }
  function schedule() {
    if (S.status !== 'ready') return;
    clearTimeout(debounceT);
    debounceT = setTimeout(() => flushNow().then(() => { if (dirty) retryLater(); }), local ? 150 : 4000);
    if (!maxT) maxT = setTimeout(() => { maxT = null; flushNow(); }, local ? 1000 : 20000);
  }
  let retryT = null;
  function retryLater() {
    if (retryT) return;
    retryT = setTimeout(() => { retryT = null; flushNow().then(() => { if (dirty) retryLater(); }); }, Math.min(120000, 10000 * Math.max(1, failCount)));
  }
  /* call after EVERY change of S.state */
  S.touch = () => { S.state.rev++; dirty = true; schedule(); };
  S.flushNow = () => { dirty = dirty || S.status === 'ready' && S.lastSavedRev !== S.state.rev; return flushNow(); };

  /* ------------------------------ readable event log ------------------------------ */
  const queue = []; let sending = false, draining = false;
  const pendingList = new Map(); let listT = null;
  function enqueue(html) {
    const t = String(html);
    for (let i = 0; i < t.length; i += 3800) queue.push(t.slice(i, i + 3800));
    if (queue.length > 400) queue.splice(0, queue.length - 400);
    pump();
  }
  async function pump() {
    if (sending || local) return;
    sending = true;
    try {
      while (queue.length && !draining) {
        if (S.status !== 'ready' || !S.active) { await sleep(3000); continue; }
        const text = queue[0];
        const r = await api('sendMessage', { chat_id: S.active, text, parse_mode: 'HTML', disable_notification: true, disable_web_page_preview: true });
        if (r.ok || (r.code >= 400 && r.code < 500 && r.code !== 429)) queue.shift();
        if (!r.ok && r.code === 429) await sleep(Math.min(40, (r.retry || 5) + 1) * 1000);
        else await sleep(3400);   // ≈17 messages / minute, below the 20/min channel limit
      }
    } finally { sending = false; }
  }
  S.log = html => { if (!local) enqueue(html); };
  /* my-list changes are batched per user for 45s so a burst becomes ONE channel message */
  function flushPendingList() {
    clearTimeout(listT); listT = null;
    for (const [em, v] of pendingList) {
      enqueue('📌 <b>لیست من</b> · <code>' + esc(em) + '</code>'
        + (v.add.length ? '\n➕ ' + v.add.map(esc).join('، ') : '') + (v.del.length ? '\n➖ ' + v.del.map(esc).join('، ') : ''));
    }
    pendingList.clear();
  }
  S.logList = (email, add, title) => {
    if (local) return;
    const e = pendingList.get(email) || { add: [], del: [] };
    (add ? e.add : e.del).push(title);
    pendingList.set(email, e);
    if (!listT) listT = setTimeout(flushPendingList, 45000);
  };
  /* on shutdown: send whatever log messages are still waiting (no throttle delay), within maxMs */
  S.drainLogs = async (maxMs = 8000) => {
    if (local) return;
    flushPendingList(); draining = true;
    const t0 = Date.now();
    while (queue.length && Date.now() - t0 < maxMs && S.status === 'ready' && S.active) {
      const r = await api('sendMessage', { chat_id: S.active, text: queue[0], parse_mode: 'HTML', disable_notification: true, disable_web_page_preview: true }, { timeout: 6000 });
      if (r.ok || (r.code >= 400 && r.code < 500 && r.code !== 429)) queue.shift(); else break;
    }
  };

  /* ------------------------------ connect / init ------------------------------ */
  const setReady = () => { S.status = 'ready'; readyCbs.forEach(f => { try { f(); } catch (e) { warn('onReady:', e.message); } }); };

  async function initLocal() {
    try { const j = JSON.parse(fs.readFileSync(localFile, 'utf8')); const st = normalizeState(j); if (st) S.state = st; else throw new Error('x'); }
    catch { const lg = legacy(); S.state = normalizeState({ ...emptyState(), ...(lg || {}) }) || emptyState(); if (lg) dirty = true; }
    say('LOCAL dev mode (no TELEGRAM_BOT_TOKEN): state file', localFile);
    S.status = 'ready'; setReady(); if (dirty) schedule();
  }

  async function connect() {
    if (local) return initLocal();
    for (let attempt = 0; ; attempt++) {
      try {
        const ptr = await readPointer();
        const envRef = envRaw ? parseChannelRef(envRaw) : null;
        S.channels = (ptr && Array.isArray(ptr.channels)) ? ptr.channels.filter(c => c && c.id) : [];
        S.hadData = !!(ptr && ptr.hadData);
        let knownSnap = ptr && ptr.snap || 0;
        let wanted = null;
        if (ptr && ptr.active && (!envRaw || ptr.env === envRaw)) wanted = ptr.active;
        else if (envRef && envRef.chat_id) { wanted = envRef.chat_id; knownSnap = 0; S.hadData = false; }
        else if (envRaw) { S.status = 'error'; S.lastError = 'TELEGRAM_CHANNEL: ' + (envRef && envRef.error === 'invite' ? 'لینک دعوت خصوصی قابل استفاده نیست؛ @username یا شناسهٔ عددی بدهید' : 'مقدار نامعتبر'); return; }
        if (!wanted) { S.status = 'no_channel'; S.lastError = ''; say('no channel configured'); return; }
        const info = await inspectChannel(wanted);
        if (!info.ok) {
          if (info.transient) throw new Error('telegram unreachable');
          S.status = 'error'; S.lastError = 'کانال در دسترس نیست: ' + info.desc; S.active = wanted; warn(S.lastError);
          await sleep(30000); continue;
        }
        S.active = info.id; S.activeInfo = info;
        if (!S.channels.some(c => c.id === info.id)) S.channels.push({ id: info.id, title: info.title, username: info.username });
        S.channels = S.channels.map(c => c.id === info.id ? { id: info.id, title: info.title, username: info.username } : c);
        if (!info.canPost) { S.status = 'error'; S.lastError = 'ربات در کانال «' + info.title + '» ادمین با دسترسی ارسال پیام نیست'; warn(S.lastError); await sleep(30000); continue; }
        const snap = await readSnapshot(info, knownSnap);
        if (snap.found) {
          S.state = snap.state; S.snapMsgId = snap.msgId; S.hadData = true; S.ptrSnap = snap.msgId;
          say('loaded snapshot from channel', info.id, 'rev', S.state.rev, 'users', S.state.users.length);
        } else if (S.hadData) {
          S.status = 'readonly'; S.lastError = 'قبلاً در این کانال دیتا ذخیره شده بود ولی پیام پین‌شدهٔ دیتابیس پیدا نشد (احتمالاً پین برداشته شده). برای محافظت از اطلاعات، چیزی نوشته نمی‌شود. پیام «lookmv DB» را دوباره پین کنید.';
          warn(S.lastError); await sleep(30000); continue;
        } else {
          const lg = legacy();
          S.state = normalizeState({ ...emptyState(), ...(lg || {}) }) || emptyState();
          S.state.rev = 1; dirty = true;
          say('channel is empty → starting fresh' + (lg ? ' (imported legacy local data)' : ''));
        }
        S.lastError = '';
        setReady();
        if (dirty) { await flushNow(); }
        else if (S.ptrSnap !== undefined) writePointer();
        return;
      } catch (e) {
        S.status = 'connecting'; S.lastError = String(e && e.message || e);
        warn('connect attempt', attempt + 1, 'failed:', S.lastError);
        await sleep(Math.min(60000, 3000 * (attempt + 1)));
      }
    }
  }
  S.init = () => (S._init = S._init || connect());

  /* ------------------------------ channel management (bot UI) ------------------------------ */
  S.inspect = async ref => {
    const p = typeof ref === 'string' && /^-?\d+$/.test(ref) ? { chat_id: ref } : parseChannelRef(ref);
    if (p.error) return { ok: false, reason: p.error };
    return inspectChannel(p.chat_id);
  };
  S.currentChannel = () => S.channels.find(c => c.id === S.active) || null;
  S.addChannel = async info => {
    if (!S.channels.some(c => c.id === info.id)) S.channels.push({ id: info.id, title: info.title, username: info.username });
    return writePointer();
  };
  S.removeChannel = async id => {
    if (id === S.active) return false;
    S.channels = S.channels.filter(c => c.id !== id);
    return writePointer();
  };
  /* mode: 'copy' = write the current data into the new channel · 'use' = load the data that already is there */
  S.switchTo = async (info, mode) => {
    if (!info || !info.ok || !info.canPost) return { ok: false, desc: 'ربات در این کانال دسترسی ارسال پیام ندارد' };
    /* never copy a state that was not loaded from the channel (e.g. read-only / still connecting) over another channel */
    if (mode !== 'use' && !['ready', 'no_channel'].includes(S.status)) return { ok: false, desc: 'ذخیره‌سازی فعلی هنوز آماده/سالم نیست؛ فقط «استفاده از دیتای آن کانال» مجاز است' };
    await flushNow().catch(() => {});
    if (mode !== 'use' && S.status === 'no_channel') {            // first channel ever: start from the old local data, if any
      const lg = legacy(); S.state = normalizeState({ ...emptyState(), ...(lg || {}) }) || emptyState();
    }
    const prev = { active: S.active, snapMsgId: S.snapMsgId, hadData: S.hadData, ptrSnap: S.ptrSnap, state: S.state, status: S.status };
    S.status = 'connecting';
    try {
      if (mode === 'use') {
        const snap = await readSnapshot(info, 0);
        if (!snap.found) throw new Error('در آن کانال دیتابیسی پیدا نشد');
        S.state = snap.state; S.snapMsgId = snap.msgId;
      } else {
        S.snapMsgId = info.snapshotPinned ? info.pinned.message_id : 0;
        S.state.rev++;
        S.status = 'ready'; S.active = info.id;
        const r = await writeSnapshotToChannel(info.id);
        if (!r.ok) throw new Error(r.desc || 'نوشتن در کانال ناموفق بود');
        S.lastSavedAt = Date.now(); S.lastSavedBytes = r.bytes; S.lastSavedRev = S.state.rev;
      }
      S.active = info.id; S.activeInfo = info; S.hadData = true; S.ptrSnap = S.snapMsgId;
      if (!S.channels.some(c => c.id === info.id)) S.channels.push({ id: info.id, title: info.title, username: info.username });
      S.status = 'ready'; dirty = false; S.lastError = '';
      await writePointer();
      setReady();
      return { ok: true };
    } catch (e) {
      S.active = prev.active; S.snapMsgId = prev.snapMsgId; S.hadData = prev.hadData; S.ptrSnap = prev.ptrSnap; S.state = prev.state; S.status = prev.status;
      return { ok: false, desc: String(e && e.message || e) };
    }
  };
  /* real round-trip: save now, then read the pinned message back and compare */
  S.selfTest = async () => {
    if (local) return { ok: true, local: true };
    if (S.status !== 'ready') return { ok: false, desc: 'وضعیت: ' + S.status + (S.lastError ? ' — ' + S.lastError : '') };
    S.state.rev++; dirty = true;
    await flushNow();
    if (dirty) return { ok: false, desc: 'ذخیره ناموفق: ' + S.lastError };
    const info = await inspectChannel(S.active);
    if (!info.ok) return { ok: false, desc: 'خواندن کانال ناموفق: ' + info.desc };
    S.activeInfo = info;
    let snap; try { snap = await readSnapshot(info, S.snapMsgId); } catch (e) { return { ok: false, desc: String(e.message) }; }
    if (!snap.found) return { ok: false, desc: 'پیام پین‌شدهٔ دیتابیس پیدا نشد (ربات باید اجازهٔ پین کردن داشته باشد)' };
    const same = snap.state.rev === S.state.rev && snap.state.users.length === S.state.users.length;
    return { ok: same, desc: same ? '' : 'نسخهٔ خوانده‌شده (rev ' + snap.state.rev + ') با نسخهٔ سرور (rev ' + S.state.rev + ') یکی نیست', rev: snap.state.rev, users: snap.state.users.length, canEdit: info.canEdit, canDelete: info.canDelete, bytes: S.lastSavedBytes };
  };
  S.saveSummary = () => ({ rev: S.state.rev, lastSavedAt: S.lastSavedAt, lastSavedRev: S.lastSavedRev, bytes: S.lastSavedBytes, pending: dirty || S.lastSavedRev !== S.state.rev, failCount });
  S.parseChannelRef = parseChannelRef;
  S.api = api;
  return S;
}

module.exports = { createStore, parseChannelRef, emptyState };
