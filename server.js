#!/usr/bin/env node
'use strict';
/*
 * lookmv — small zero-dependency Node server.
 * Accounts live in data/users.json, sessions in data/sessions.json,
 * the movie catalog in data/movies.json (built by scripts/build-movies.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data'); // immutable catalog shipped with the image
const STORAGE = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : DATA; // writable/persistent user data
fs.mkdirSync(STORAGE, { recursive: true });
const USERS_FILE = path.join(STORAGE, 'users.json');
const SESSIONS_FILE = path.join(STORAGE, 'sessions.json');
const CACHE_FILE = path.join(STORAGE, 'enrich-cache.json');
const HOME_FEED_FILE = path.join(STORAGE, 'home-feed.json');
const FEATURED_FILE = path.join(STORAGE, 'featured.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DAY = 86400000;
const TZ_OFFSET = 3.5 * 3600000; // Asia/Tehran

/* ------------------------------ storage ------------------------------ */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[storage] read', file, e.message); return fallback; }
}
let store = readJSON(USERS_FILE, { users: [] });
if (!Array.isArray(store.users)) store = { users: [] };
let sessions = readJSON(SESSIONS_FILE, { sessions: {} });
if (!sessions.sessions || typeof sessions.sessions !== 'object') sessions = { sessions: {} };
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify(store));
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
let cache = readJSON(CACHE_FILE, {});
let config = readJSON(CONFIG_FILE, { omdbKey: '', tmdbKey: '', youtubeFallback: false });
// Railway and other container hosts should provide secrets as environment variables.
config.tmdbKey = process.env.TMDB_API_KEY || process.env.TMDB_KEY || config.tmdbKey || '';
config.omdbKey = process.env.OMDB_API_KEY || process.env.OMDB_KEY || config.omdbKey || '';

const saveTimers = new Map();
function persist(which) {
  for (const f of which) {
    clearTimeout(saveTimers.get(f));
    saveTimers.set(f, setTimeout(() => {
      const data = f === 'users' ? store : f === 'sessions' ? sessions : cache;
      const file = f === 'users' ? USERS_FILE : f === 'sessions' ? SESSIONS_FILE : CACHE_FILE;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    }, 100));
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}
function verifyPassword(user, password) {
  try {
    const a = Buffer.from(user.hash, 'hex');
    const b = Buffer.from(hashPassword(password, user.salt), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
const cleanUser = u => ({ id: u.id, email: u.email, createdAt: u.createdAt });
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()) && e.length <= 254;

function newSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.sessions[token] = { userId, createdAt: Date.now() };
  persist(['sessions']);
  res.setHeader('Set-Cookie', `lm_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
  return token;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)lm_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions.sessions[m[1]];
  if (!s) return null;
  const u = store.users.find(x => x.id === s.userId);
  if (!u) { delete sessions.sessions[m[1]]; persist(['sessions']); return null; }
  return u;
}
function destroySession(req, res) {
  const m = /(?:^|;\s*)lm_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (m) { delete sessions.sessions[m[1]]; persist(['sessions']); }
  res.setHeader('Set-Cookie', 'lm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* ------------------------------ catalog ------------------------------ */
console.log('Loading movie catalog…');
const catalog = readJSON(path.join(DATA, 'movies.json'), { movies: [], genres: [] });
/* Titles without at least one downloadable video link are never shown anywhere
 * (home rows, featured, search, categories, recommendations). */
const hasDownload = m => (m.links || []).some(l => l && l.url && !l.sub);
const MOVIES = (catalog.movies || []).filter(hasDownload);
const DROPPED_NO_LINK = (catalog.movies || []).length - MOVIES.length;
/* Episode/season are not stored in the source data (ep is always null),
 * so they are derived once at startup from the file name in each link. */
function parseEpisode(url) {
  let f = String(url || '').split('?')[0].split('/').pop() || '';
  try { f = decodeURIComponent(f); } catch { /* keep raw */ }
  f = f.replace(/\.[a-z0-9]{2,4}$/i, '');
  let m = /S(\d{1,2})[ ._-]?E(\d{1,4})/i.exec(f);
  if (m) return { season: +m[1], ep: +m[2] };
  m = /(?:^|[^a-z0-9])S(\d{1,2})[ ._]?-[ ._]?(\d{1,4})(?![0-9a-z])/i.exec(f);
  if (m) return { season: +m[1], ep: +m[2] };
  const season = (/(?:^|[^a-z0-9])S(\d{1,2})(?![a-z0-9])/i.exec(f) || [])[1];
  m = /(?:^|[^a-z0-9])(?:EP?|Episode)[ ._-]?(\d{1,4})(?![0-9a-z])/i.exec(f);
  if (m) return { season: season ? +season : 1, ep: +m[1] };
  m = /[ ._]-[ ._](\d{1,4})(?:v\d)?(?=[ ._\[\(]|$)/.exec(f);
  if (m) return { season: season ? +season : 1, ep: +m[1] };
  m = /[ ._-](\d{1,3})(?:v\d)?[ ._-](?:\d{3,4}p|4k|web|hdtv|farsi|hardsub|dub)/i.exec(f);
  if (m) return { season: season ? +season : 1, ep: +m[1] };
  return null;
}
for (const m of MOVIES) {
  if (m.type === 'movie') continue;
  for (const l of m.links || []) {
    if (l.ep != null) continue;
    const e = parseEpisode(l.url);
    if (e) { l.ep = e.ep; l.season = e.season; continue; }
    /* directory links such as .../Series/Name/S02/720p/ : a whole season, not one episode */
    if (/\/$/.test(String(l.url || '').split('?')[0])) {
      const sm = /\/S(\d{1,2})(?:\/|$)/i.exec(l.url), qm = /\/(2160p|1080p|720p|480p)/i.exec(l.url);
      l.folder = true; l.season = sm ? +sm[1] : 1;
      if (qm && (!l.q || l.q === 'نامشخص')) l.q = qm[1].toLowerCase();
    }
  }
}

/* ------------------------------ subtitles ------------------------------ */
/* Some catalog entries carry separate .ass/.srt files next to the videos.
 * Mark them so the player never mistakes a subtitle for a video source. */
const SUB_EXT_RE = /\.(srt|ssa|ass|vtt)$/i;
const VIDEO_EXT_RE = /\.(mkv|mp4|avi|webm|mov|m4v)$/i;
const CATALOG_HOSTS = new Set();
for (const m of MOVIES) {
  for (const l of m.links || []) {
    const clean = String(l.url || '').split(/[?#]/)[0];
    if (SUB_EXT_RE.test(clean)) l.sub = true;
    try { CATALOG_HOSTS.add(new URL(l.url).hostname.toLowerCase()); } catch { /* ignore */ }
  }
}

const SUB_MAX = 8 * 1024 * 1024;
const SUB_TTL = 6 * 3600000;
const SUB_MISS_TTL = 10 * 60000;
const subCache = new Map();
const subMiss = new Map();

function allowedSubtitleHost(host) {
  host = String(host || '').toLowerCase();
  if (!host) return false;
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(host)) return false;
  if (CATALOG_HOSTS.has(host)) return true;
  return /(^|\.)hollowofthealley\.space$/i.test(host) || /(^|\.)animex\.pro$/i.test(host);
}

/* The live animex API exposes only the MKV files. Their separate subtitles,
 * when the uploader provided them, live in a "sub" folder next to the quality
 * folders and follow the "<series> - <episode>.ass" naming pattern. */
function subtitleCandidates(raw) {
  let u; try { u = new URL(raw); } catch { return []; }
  if (!/^https?:$/.test(u.protocol)) return [];
  let decoded = u.pathname;
  try { decoded = decodeURIComponent(u.pathname); } catch { /* keep raw */ }
  if (SUB_EXT_RE.test(decoded)) return [u.href];
  if (!VIDEO_EXT_RE.test(decoded)) return [];
  const segs = u.pathname.split('/').filter(Boolean).map(s => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const ep = parseEpisode(segs[segs.length - 1] || '');
  if (!ep) return [];
  let qi = -1;
  for (let i = segs.length - 2; i >= 0; i--) {
    if (/^(?:2160p?|1080p?|720p?|480p?|360p?|4k|uhd)(?:[ _-].*)?$/i.test(segs[i])) { qi = i; break; }
  }
  if (qi < 1) return [];
  const root = segs.slice(0, qi);
  const series = root[root.length - 1] || '';
  if (!series) return [];
  const n = ep.ep;
  const nums = [...new Set([String(n).padStart(2, '0'), String(n)])];
  const names = [];
  for (const num of nums) {
    names.push(
      `${series} - ${num}.ass`,
      `${series} - ${num}.srt`,
      `${series} - ${num}.[MixFlixTop].ass`,
      `${series} - ${num}.[SS].ass`,
      `${series} - ${num}.vtt`
    );
  }
  const out = [];
  for (const dir of ['sub', 'Sub']) {
    for (const name of names) {
      out.push(`${u.origin}/${[...root, dir, name].map(encodeURIComponent).join('/')}`);
    }
  }
  return [...new Set(out)];
}

function decodeSubtitle(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf);
    if (swapped.length % 2 === 0) swapped.swap16();
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    try {
      const alt = new TextDecoder('windows-1256').decode(buf);
      if (!alt.includes('\uFFFD')) text = alt;
    } catch { /* decoder unavailable */ }
  }
  return text.replace(/^\uFEFF/, '');
}

const vttPad = (n, w = 2) => String(n).padStart(w, '0');
function assClock(value) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(String(value || '').trim());
  if (!m) return null;
  return `${vttPad(+m[1])}:${vttPad(+m[2])}:${vttPad(+m[3])}.${(m[4] + '00').slice(0, 3)}`;
}
function srtClock(value) {
  const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(String(value || '').trim());
  if (!m) return null;
  return `${vttPad(+m[1])}:${vttPad(+m[2])}:${vttPad(+m[3])}.${(m[4] + '00').slice(0, 3)}`;
}
const cueEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/-->/g, '→');
function assCueText(raw) {
  let text = String(raw || '');
  const drawing = /\\p[1-9]/.test(text);
  text = text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  text = text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  if (!text) return '';
  if (drawing && /^[mnlbspc\d\s.,-]+$/i.test(text)) return '';
  return cueEscape(text);
}
function assFields(line, count) {
  const out = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const at = line.indexOf(',', start);
    if (at < 0) break;
    out.push(line.slice(start, at));
    start = at + 1;
  }
  out.push(line.slice(start));
  return out;
}
function assToVtt(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cues = [];
  let inEvents = false, fields = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[Events\]/i.test(line)) { inEvents = true; continue; }
    if (/^\[[^\]]+\]/.test(line)) { inEvents = false; continue; }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(line)) {
      fields = line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) continue;
    const body = line.slice(line.indexOf(':') + 1).trim();
    const f = assFields(body, fields ? fields.length : 10);
    const field = name => {
      const i = fields ? fields.indexOf(name) : -1;
      return i >= 0 ? f[i] : null;
    };
    const start = assClock(field('start') ?? f[1]);
    const end = assClock(field('end') ?? f[2]);
    if (!start || !end || end <= start) continue;
    const cue = assCueText(field('text') ?? f[9]);
    if (!cue) continue;
    cues.push({ start, end, text: cue });
  }
  cues.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const seen = new Set();
  const out = ['WEBVTT', ''];
  for (const cue of cues) {
    const key = cue.start + '|' + cue.end + '|' + cue.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue.start + ' --> ' + cue.end, cue.text, '');
  }
  return out.join('\n');
}
function srtToVtt(text) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out = ['WEBVTT', ''];
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) continue;
    const m = /^\s*(\S+)\s*-->\s*(\S+)/.exec(lines[at]);
    if (!m) continue;
    const start = srtClock(m[1]), end = srtClock(m[2]);
    if (!start || !end || end <= start) continue;
    let body = lines.slice(at + 1).join('\n')
      .replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '');
    body = body.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    if (!body) continue;
    out.push(start + ' --> ' + end, cueEscape(body), '');
  }
  return out.join('\n');
}
function toVtt(text, url) {
  const clean = String(url || '').split(/[?#]/)[0];
  if (/\.(ass|ssa)$/i.test(clean) || /^\s*\[Script Info\]/i.test(text)) return assToVtt(text);
  if (/\.srt$/i.test(clean)) return srtToVtt(text);
  if (/\.vtt$/i.test(clean)) return /^WEBVTT/i.test(text.trim()) ? text.replace(/\r\n?/g, '\n') : 'WEBVTT\n\n' + text;
  if (text.includes('-->')) return srtToVtt(text);
  return assToVtt(text);
}

async function fetchSub(url, method, timeout) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'accept': '*/*',
        'referer': 'https://animex.pro/'
      }
    });
    if (method === 'HEAD') return { status: r.status, len: Number(r.headers.get('content-length') || 0) };
    if (!r.ok) return { status: r.status, buf: null };
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: 200, buf };
  } catch {
    return { status: 0, buf: null };
  } finally {
    clearTimeout(timer);
  }
}
function sendVtt(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}
const BY_ID = new Map(MOVIES.map(m => [m.id, m]));
const SEARCH_INDEX = MOVIES.map(m => ({
  ref: m,
  text: [m.title, m.titleEn, m.year, m.genre, ...(m.genres || [])].join(' ').toLowerCase().replace(/[\u200c\u200d]/g, ''),
}));
console.log(`  ${MOVIES.length} titles (${DROPPED_NO_LINK} hidden: no download link), ${(catalog.genres || []).length} genres`);

const FEATURED_POOL = MOVIES.filter(m => m.type === 'movie' && (m.links || []).some(l => !l.sub));
function featured() {
  const pool = FEATURED_POOL.length ? FEATURED_POOL : MOVIES;
  const hour = Math.floor(Date.now() / 3600000);
  let saved = readJSON(FEATURED_FILE, null);
  if (!saved || saved.hour !== hour || !BY_ID.has(saved.id)) {
    const h = crypto.createHash('sha256').update(String(hour) + '|lookmv-featured').digest();
    let idx = h.readUInt32BE(0) % pool.length;
    if (saved && pool.length > 1 && pool[idx].id === saved.id) idx = (idx + 1) % pool.length; // never repeat the previous hour's pick
    const movie = pool[idx];
    saved = { hour, id: movie.id, changedAt: new Date(hour * 3600000).toISOString() };
    const tmp = FEATURED_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(saved)); fs.renameSync(tmp, FEATURED_FILE);
  }
  const movie = BY_ID.get(saved.id) || pool[0];
  return {
    movie: summary(movie),
    changedAt: saved.changedAt,
    nextChangeInSeconds: Math.ceil((3600000 - (Date.now() % 3600000)) / 1000),
  };
}
function summary(m) {
  const videoLinks = (m.links || []).filter(l => !l.sub);
  return {
    id: m.id, title: m.title, titleEn: m.titleEn, year: m.year, type: m.type,
    genre: m.genre, genres: m.genres, country: m.country, language: m.language,
    siteRating: m.siteRating, linkCount: videoLinks.length,
    topQ: [...new Set(videoLinks.map(l => l.q))].sort((a, b) => {
      const rank = q => { const i = ['4K', '1080p', '720p', '480p'].indexOf(q); return i < 0 ? 99 : i; };
      return rank(a) - rank(b);
    })[0] || '',
    source: m.source, added: m.added, alsoIn: m.alsoIn || null,
  };
}
function queryMovies(p) {
  const ids = String(p.get('ids') || '').split(',').filter(Boolean);
  if (ids.length) {
    const arr = ids.map(id => BY_ID.get(id)).filter(Boolean);
    return { items: arr.map(summary), total: arr.length, page: 1, limit: arr.length, hasMore: false };
  }
  const q = String(p.get('q') || '').trim().toLowerCase().replace(/[\u200c\u200d]/g, '');
  const genre = String(p.get('genre') || '');
  const type = String(p.get('type') || '');
  const sort = String(p.get('sort') || 'new');
  let list = SEARCH_INDEX;
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    list = list.filter(x => words.every(w => x.text.includes(w)));
  }
  if (genre) list = list.filter(x => x.ref.genre === genre || (x.ref.genres || []).includes(genre));
  if (type) list = list.filter(x => x.ref.type === type);
  const arr = list.map(x => x.ref);
  if (sort === 'title') arr.sort((a, b) => a.title.localeCompare(b.title, 'fa'));
  else if (sort === 'links') arr.sort((a, b) => (b.linkCount || b.links.length) - (a.linkCount || a.links.length));
  else if (sort === 'rating') arr.sort((a, b) => {
    const score = m => { const n = Number.parseFloat(String(m.siteRating || '').replace(',', '.')); return Number.isFinite(n) ? n : -1; };
    return score(b) - score(a) || (b.linkCount || b.links.length) - (a.linkCount || a.links.length);
  });
  else arr.sort((a, b) => String(b.added).localeCompare(String(a.added))); 
  const page = Math.max(1, Number(p.get('page') || 1) | 0);
  const limit = Math.min(60, Math.max(1, Number(p.get('limit') || 24) | 0));
  return {
    items: arr.slice((page - 1) * limit, page * limit).map(summary),
    total: arr.length, page, limit, hasMore: page * limit < arr.length,
  };
}

/* ------------------- two extra source sites (link bridge) ------------------- */
/* zardfilm.in renders its download box only in the HTML page (the wp/v2 REST
 * response has no links), and that HTML is not served with CORS headers. This
 * bridge fetches it server-side and returns a normalised link list to the
 * browser. doostihaa.com is reachable directly, but it goes through here too so
 * both new sources share one parser and one cache. */
const SOURCE_ORIGINS = {
  zardfilm: 'https://zardfilm.in',
  doostihaa: 'https://www.doostihaa.com',
};
const SOURCE_TTL = 12 * 3600000;
const SOURCE_MAX = 400;
const sourceLinkCache = new Map();

function srcText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#0*38;|&amp;/gi, '&').replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/[\u200c\u200d]/g, '')
    .replace(/\s+/g, ' ').trim();
}
function srcDigits(s) {
  return String(s || '').replace(/[\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) - 0x06f0));
}
function srcQuality(v) {
  const s = String(v || '');
  if (/(2160|4k|uhd)/i.test(s)) return '4K';
  const m = s.match(/(480|540|576|720|1080)/);
  if (m) return m[1] + 'p';
  return /\d/.test(s) ? s.trim() : '';
}
function srcYear(v) { return (srcDigits(v).match(/(19|20)\d{2}/) || [])[0] || ''; }
function srcRating(v) {
  const s = srcDigits(v);
  const m = s.match(/(?:امتیاز(?:\s*فیلم)?|IMDb| rating)[^\d]{0,18}(\d{1,2}(?:[.,]\d{1,2})?)/i)
    || s.match(/(?:امتیاز|IMDb)[^\d]{0,18}(\d{1,2}(?:[.,]\d{1,2})?)\s*از\s*10/i);
  if (!m) return '';
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 10 ? String(n) : '';
}
function validSrcLink(u) {
  if (!/^https?:\/\//i.test(u)) return false;
  if (/(^|\/)(stream|play|embed)(\/|\?|$)/i.test(u)) return false;
  return true;
}
function pushLink(out, seen, link) {
  if (!link || !validSrcLink(link.url) || seen.has(link.url)) return;
  seen.add(link.url);
  link.q = srcQuality(link.q);
  out.push(link);
}

/* zardfilm's version-3 download box:
 *   .zdl-box (version) -> .zdl-season[data-zdl-season] / .zdl-ep rows (series)
 *   .zdl-box (version) -> .zdl-row rows (movies) */
function parseZardLinks(html) {
  const out = [], seen = new Set();
  String(html || '').split(/<section class="zdl-box\b[^>]*>/i).slice(1).forEach(chunk => {
    const hm = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const note = chunk.match(/<div class="zdl-note"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i);
    const label = [hm && srcText(hm[1]), note && srcText(note[1])].filter(Boolean).join(' · ');
    const seasons = [];
    let sm;
    const sr = /data-zdl-season="(\d+)"/gi;
    while ((sm = sr.exec(chunk))) seasons.push({ at: sm.index, n: +sm[1] });

    const er = /<div class="zdl-ep\b[^>]*>([\s\S]*?)(?=<div class="zdl-ep\b|<\/section>|$)/gi;
    let em;
    while ((em = er.exec(chunk))) {
      const block = em[1];
      let season = 1;
      for (const s of seasons) { if (s.at < em.index) season = s.n; else break; }
      const en = block.match(/class="zdl-en"[^>]*>([\s\S]*?)<\/span>/i);
      let ep = en ? parseInt(srcDigits(srcText(en[1])).match(/\d+/) || '0', 10) : 0;
      for (const tag of block.matchAll(/<a\b([^>]*)>/gi)) {
        const a = tag[1];
        if (!/class="[^"]*\bzdl-qs\b/.test(a)) continue;
        const href = (a.match(/href="([^"]+)"/i) || [])[1];
        if (!href) continue;
        let epUrl = href.match(/S(\d{1,2})[ ._-]?E(\d{1,4})/i);
        if (epUrl) { season = +epUrl[1]; ep = +epUrl[2]; }
        if (!ep) ep = parseInt((href.match(/[?&]episode=(\d+)/i) || [])[1] || '0', 10);
        const q = (a.match(/data-zdl-q="([^"]*)"/i) || [])[1]
          || (href.match(/(480|540|576|720|1080|2160)/) || [])[1] || '';
        pushLink(out, seen, {
          q: q, label: label, name: '', group: label, ep: ep || null, season: season || null,
          size: '', url: href.replace(/&#0*38;/g, '&').replace(/&amp;/g, '&'),
          sub: /\.(srt|ssa|ass|vtt)(\?|$)/i.test(href) || undefined,
        });
      }
    }

    const rr = /<div class="zdl-row\b[^>]*>([\s\S]*?)(?=<div class="zdl-row\b|<\/section>|$)/gi;
    let rm;
    while ((rm = rr.exec(chunk))) {
      const block = rm[1];
      const q = (block.match(/<bdi[^>]*>([^<]+)<\/bdi>/i) || [])[1] || '';
      const sz = block.match(/class="zdl-sz"[^>]*>([\s\S]*?)<\/div>/i);
      let url = '';
      for (const tag of block.matchAll(/<a\b([^>]*)>/gi)) {
        const a = tag[1];
        if (!/\bdata-zdl-dl\b|\bzdl-btn\b/.test(a)) continue;
        url = (a.match(/href="([^"]+)"/i) || [])[1] || '';
        if (url) break;
      }
      if (!url) url = (block.match(/data-zdl-copy="([^"]+)"/i) || [])[1] || '';
      if (!url) continue;
      pushLink(out, seen, {
        q: q, label: label, name: '', group: label, ep: null, season: null,
        size: sz ? srcText(sz[1]) : '',
        url: url.replace(/&#0*38;/g, '&').replace(/&amp;/g, '&'),
      });
    }
  });
  return out;
}

/* doostihaa stores direct download URLs as plain <a href> elements in the post
 * content. The surrounding text gives the version; the URL gives quality and
 * episode (S01E01) for series. */
function parseDoostiLinks(html) {
  const out = [], seen = new Set();
  let group = '';
  const tokens = String(html || '').match(/<\/?(?:p|h[1-6]|div|li|br|tr|table)\b[^>]*>|[^<]+|<[^>]+>/gi) || [];
  for (const tok of tokens) {
    if (/^<a\b/i.test(tok)) {
      const href = (tok.match(/href="([^"]+)"/i) || [])[1];
      if (!href || !/\.(mp4|mkv|avi|webm|mov|m4v|srt|ssa|ass|vtt)(\?|$)/i.test(href)) continue;
      let q = srcQuality((href.match(/(?:^|[./_-])(480|540|576|720|1080|2160)p?/i) || [])[1] || '');
      if (!q) q = srcQuality(tok);
      const epM = href.match(/S(\d{1,2})[ ._-]?E(\d{1,4})/i);
      pushLink(out, seen, {
        q: q, label: group, name: '', group: group,
        ep: epM ? +epM[2] : null, season: epM ? +epM[1] : null,
        size: '', url: href.replace(/&#0*38;/g, '&').replace(/&amp;/g, '&'),
        sub: /\.(srt|ssa|ass|vtt)(\?|$)/i.test(href) || undefined,
      });
      continue;
    }
    if (/^<\//.test(tok) || /^<[^a/]/.test(tok)) continue;
    const text = srcText(tok);
    if (!text) continue;
    if (/[()（]/.test(text) && /(نسخه|دوبله|زیرنویس|سانسور|کیفیت|sub|dub)/i.test(text)) group = text.replace(/^[(\s]+|[)\s]+$/g, '');
    else if (/(نسخه|دوبله فارسی|زیرنویس چسبیده|سانسور نشده)/.test(text) && text.length < 90) group = text;
  }
  return out;
}

async function sourcePage(url, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout || 10000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lookmv/1.0)', 'Accept-Language': 'fa,en;q=0.8' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function sourceLinks(site, id) {
  const key = site + ':' + id;
  const hit = sourceLinkCache.get(key);
  if (hit && Date.now() - hit.at < SOURCE_TTL) return hit.data;
  const origin = SOURCE_ORIGINS[site];
  if (!origin || !/^\d+$/.test(String(id))) throw new Error('bad source');
  const api = origin + '/wp-json/wp/v2/posts/' + id + '?_fields=link,title,excerpt,content,categories';
  const post = JSON.parse(await sourcePage(api, 9000));
  if (!post || !post.link) throw new Error('post missing');
  const link = new URL(post.link);
  if (link.origin !== origin) throw new Error('bad origin');
  const html = site === 'zardfilm'
    ? await sourcePage(link.href, 14000)
    : (post.content && post.content.rendered) || '';
  const links = site === 'zardfilm' ? parseZardLinks(html) : parseDoostiLinks(html);
  const title = srcText(post.title && post.title.rendered);
  const excerpt = srcText(post.excerpt && post.excerpt.rendered);
  const content = srcText(post.content && post.content.rendered);
  const data = {
    links: links,
    linkCount: links.length,
    topQ: [...new Set(links.map(l => l.q).filter(Boolean))]
      .sort((a, b) => ['4K', '1080p', '720p', '480p'].indexOf(a) - ['4K', '1080p', '720p', '480p'].indexOf(b))[0] || '',
    siteRating: srcRating((excerpt + ' ' + content).slice(0, 900)),
    year: srcYear(title) || srcYear(excerpt),
  };
  sourceLinkCache.set(key, { at: Date.now(), data: data });
  if (sourceLinkCache.size > SOURCE_MAX) {
    const old = [...sourceLinkCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, sourceLinkCache.size - SOURCE_MAX);
    for (const [k] of old) sourceLinkCache.delete(k);
  }
  return data;
}


/* ------------------------- daily home feed ------------------------- */
const localDay = () => new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10);
let homeFeed = readJSON(HOME_FEED_FILE, { day: '', top: [], latest: [], source: 'local' });
let homeFeedJob = null;
/* Daily category rows: every Tehran day the server picks a few random real catalog genres
 * and ~12 random titles for each. Yesterday's genres/titles are excluded so rows are replaced day by day. */
const DAILY_ROW_COUNT = 5, DAILY_ROW_ITEMS = 12;
const GENRE_EXCLUDE = new Set(['سریال', 'فیلم', 'متفرقه', 'نامشخص', 'adult', 'science-fiction', 'sports', 'diy']);
const GENRE_INDEX = new Map(); // genre -> [movie ids that have links]
for (const m of MOVIES) {
  if (!(m.links || []).some(l => !l.sub)) continue;
  for (const g of new Set([m.genre, ...(m.genres || [])].filter(Boolean))) {
    if (GENRE_EXCLUDE.has(g)) continue;
    if (!GENRE_INDEX.has(g)) GENRE_INDEX.set(g, []);
    GENRE_INDEX.get(g).push(m.id);
  }
}
const DAILY_HOME_CATEGORIES = [...GENRE_INDEX.entries()].filter(([, ids]) => ids.length >= 60).map(([g]) => g);
function seededRng(seed) {
  let a = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function seededShuffle(list, seed) {
  const rnd = seededRng(seed), a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function buildDailyRows(day, prev) {
  const prevGenres = new Set(prev?.genres || []), prevIds = new Set(prev?.ids || []);
  let genres = seededShuffle(DAILY_HOME_CATEGORIES, day + '|lookmv-home-genres');
  const fresh = genres.filter(g => !prevGenres.has(g));
  genres = [...fresh, ...genres.filter(g => prevGenres.has(g))].slice(0, DAILY_ROW_COUNT);
  const used = new Set();
  return genres.map(g => {
    const all = seededShuffle(GENRE_INDEX.get(g), day + '|lookmv-home-items|' + g).filter(id => !used.has(id));
    const ids = [...all.filter(id => !prevIds.has(id)), ...all.filter(id => prevIds.has(id))].slice(0, DAILY_ROW_ITEMS);
    ids.forEach(id => used.add(id));
    return { genre: g, ids };
  });
}
const normTitle = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const TITLE_LOOKUP = new Map();
for (const m of MOVIES) {
  for (const title of [m.titleEn, m.title]) {
    const key = normTitle(title);
    if (!key) continue;
    if (!TITLE_LOOKUP.has(key)) TITLE_LOOKUP.set(key, []);
    TITLE_LOOKUP.get(key).push(m);
  }
}
function matchRemoteMovie(item) {
  const titles = [item.title, item.original_title].map(normTitle).filter(Boolean);
  const year = String(item.release_date || '').slice(0, 4);
  const matches = titles.flatMap(t => TITLE_LOOKUP.get(t) || []).filter(m => m.type === 'movie');
  if (!matches.length) return null;
  const usable = matches.filter(m => (m.links || []).length);
  const pool = usable.length ? usable : matches;
  return pool.find(m => year && String(m.year || '') === year) || pool[0];
}
function shuffled(input) {
  const a = input.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function localTopIds() {
  const score = m => {
    const n = Number.parseFloat(String(m.siteRating || '').replace(',', '.'));
    return Number.isFinite(n) ? n : -1;
  };
  return MOVIES.filter(m => m.type === 'movie' && (m.links || []).length)
    .sort((a, b) => score(b) - score(a) || (b.linkCount || b.links.length) - (a.linkCount || a.links.length))
    .slice(0, 50).map(m => m.id);
}
function localLatestIds() {
  return MOVIES.filter(m => (m.links || []).length)
    .sort((a, b) => String(b.added || b.year || '').localeCompare(String(a.added || a.year || '')))
    .slice(0, 50).map(m => m.id);
}
function uniqueIds(ids) { return [...new Set(ids.filter(id => BY_ID.has(id)))]; }
function saveHomeFeed() {
  const tmp = HOME_FEED_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(homeFeed));
  fs.renameSync(tmp, HOME_FEED_FILE);
}
async function refreshHomeFeed() {
  const day = localDay();
  if (homeFeed.day === day && homeFeed.top?.length >= 10 && homeFeed.latest?.length >= 10 && Array.isArray(homeFeed.rows) && homeFeed.rows.length) return homeFeed;
  if (homeFeedJob) return homeFeedJob;
  homeFeedJob = (async () => {
    let remoteTop = [], remoteLatest = [], usedTMDb = false;
    if (config.tmdbKey) {
      const base = 'https://api.themoviedb.org/3/movie/';
      const key = '?api_key=' + encodeURIComponent(config.tmdbKey) + '&language=en-US&page=1';
      const results = await Promise.allSettled([
        getJSON(base + 'top_rated' + key),
        getJSON(base + 'now_playing' + key + '&region=US'),
      ]);
      if (results[0].status === 'fulfilled') remoteTop = (results[0].value.results || []).map(matchRemoteMovie).filter(Boolean).map(m => m.id);
      if (results[1].status === 'fulfilled') remoteLatest = (results[1].value.results || []).map(matchRemoteMovie).filter(Boolean).map(m => m.id);
      usedTMDb = remoteTop.length > 0 || remoteLatest.length > 0;
    }
    // Only titles that exist in the local catalog are shown, so every card remains watchable/downloadable.
    // If TMDb has fewer than ten local matches, complete the row from the local catalog.
    const topFallback = localTopIds();
    const latestFallback = localLatestIds();
    const top = uniqueIds([...remoteTop, ...topFallback]).slice(0, 50);
    const latest = uniqueIds([...remoteLatest, ...latestFallback]).slice(0, 50);
    const prevRows = homeFeed.rows || [];
    const prev = { genres: prevRows.map(r => r.genre), ids: prevRows.flatMap(r => r.ids || []) };
    const rows = buildDailyRows(day, prev);
    homeFeed = { day, refreshedAt: new Date().toISOString(), source: usedTMDb ? 'tmdb+catalog' : 'catalog', top, latest, genres: rows.map(r => r.genre), rows };
    saveHomeFeed();
    return homeFeed;
  })().finally(() => { homeFeedJob = null; });
  return homeFeedJob;
}
async function dailyHomeFeed() {
  try { await refreshHomeFeed(); }
  catch (e) { console.warn('[home-feed] refresh failed:', e.message); }
  const feed = homeFeed;
  const top = shuffled(feed.top || []).slice(0, 10).map(id => BY_ID.get(id)).filter(Boolean);
  const latest = shuffled(feed.latest || []).slice(0, 10).map(id => BY_ID.get(id)).filter(Boolean);
  return {
    day: feed.day || localDay(), source: feed.source || 'catalog',
    top: top.map(summary), latest: latest.map(summary),
    genres: feed.genres || [],
    rows: (feed.rows || []).map(r => ({ genre: r.genre, items: (r.ids || []).map(id => BY_ID.get(id)).filter(Boolean).map(summary) })).filter(r => r.items.length),
  };
}
function recommendations(ids, limit = 10) {
  const savedMovies = ids.map(id => BY_ID.get(id)).filter(Boolean);
  const counts = new Map();
  for (const m of savedMovies) {
    for (const g of new Set([m.genre, ...(m.genres || [])].filter(Boolean))) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const genres = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  if (!genres.length) return { items: [], genres: [] };
  const selected = new Set(ids);
  const pool = MOVIES.map(m => {
    if (selected.has(m.id) || !(m.links || []).length) return null;
    const own = new Set([m.genre, ...(m.genres || [])].filter(Boolean));
    let overlap = 0;
    for (const g of own) if (counts.has(g)) overlap += counts.get(g);
    return overlap ? { m, overlap } : null;
  }).filter(Boolean).sort((a, b) => b.overlap - a.overlap);
  // Shuffle a broad high-match pool so the row changes on each visit, not just the order of a fixed list.
  const candidates = pool.slice(0, Math.max(60, limit * 12));
  return { items: shuffled(candidates).slice(0, limit).map(x => summary(x.m)), genres };
}

/* --------------------------- enrichment API --------------------------- */
async function getJSON(url, timeout = 6500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'lookmv/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function posterTMDB(p) { return p ? 'https://image.tmdb.org/t/p/w500' + p : ''; }
function backdropTMDB(p) { return p ? 'https://image.tmdb.org/t/p/w1280' + p : ''; }
function youtube(key) {
  return key ? {
    key,
    embed: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(key) + '?autoplay=1&rel=0',
    watch: 'https://www.youtube.com/watch?v=' + encodeURIComponent(key),
  } : null;
}

async function enrichFromTMDb(title, year, isTV) {
  const key = config.tmdbKey;
  if (!key) return null;
  const pathName = isTV ? 'tv' : 'movie';
  const search = await getJSON(`https://api.themoviedb.org/3/search/${pathName}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(title)}&year=${encodeURIComponent(year || '')}&language=en-US`);
  const hit = (search.results || [])[0];
  if (!hit) return null;
  const detail = await getJSON(`https://api.themoviedb.org/3/${pathName}/${hit.id}?api_key=${encodeURIComponent(key)}&append_to_response=videos&language=en-US`);
  const vids = (detail.videos?.results || []).filter(v => v.site === 'YouTube');
  const trailer = vids.find(v => v.type === 'Trailer') || vids.find(v => v.type === 'Teaser') || vids[0];
  return {
    source: 'TMDb',
    year: String(detail.release_date || detail.first_air_date || '').slice(0, 4),
    plot: detail.overview || '',
    poster: posterTMDB(detail.poster_path),
    backdrop: backdropTMDB(detail.backdrop_path),
    genres: (detail.genres || []).map(g => g.name),
    vote: detail.vote_average ? Number(detail.vote_average).toFixed(1) : '',
    trailer: youtube(trailer?.key),
  };
}
async function enrichFromOMDb(title, year) {
  const key = config.omdbKey;
  if (!key) return null;
  const d = await getJSON(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&y=${encodeURIComponent(year || '')}&apikey=${encodeURIComponent(key)}`);
  if (!d || d.Response === 'False') return null;
  return {
    source: 'OMDb',
    imdb: d.imdbRating && d.imdbRating !== 'N/A' ? d.imdbRating : '',
    imdbId: d.imdbID || '',
    year: d.Year || '',
    plot: d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
    poster: d.Poster && d.Poster !== 'N/A' ? d.Poster : '',
    genres: String(d.Genre || '').split(',').map(s => s.trim()).filter(Boolean),
    rated: d.Rated || '',
  };
}
async function enrichFromJikan(title) {
  const d = await getJSON(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`);
  const a = d?.data?.[0];
  if (!a) return null;
  return {
    source: 'Jikan',
    imdb: a.score ? Number(a.score).toFixed(1) : '',
    year: String(a.year || ''),
    plot: a.synopsis || '',
    poster: a.images?.jpg?.large_image_url || '',
    genres: (a.genres || []).map(g => g.name),
    trailer: null, // trailers come only from the validated chain in findTrailer()
  };
}
async function enrichFromTVmaze(title) {
  const d = await getJSON(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`);
  if (!d || d.name == null) return null;
  return {
    source: 'TVmaze',
    imdb: d.rating?.average ? Number(d.rating.average).toFixed(1) : '',
    year: String(d.premiered || '').slice(0, 4),
    plot: String(d.summary || '').replace(/<[^>]*>/g, ''),
    poster: d.image?.original || d.image?.medium || '',
    genres: d.genres || [],
  };
}
async function enrichFromIMDbUnofficial(title) {
  const d = await getJSON(`https://imdb.iamidiotareyoutoo.com/search?q=${encodeURIComponent(title)}`);
  const r = d?.description?.[0];
  if (!r) return null;
  return { source: 'IMDb', imdb: r.imdb_rating || '', imdbId: r.imdb_id || '', year: String(r['#YEAR'] || r.metadata?.year || ''), poster: r['#IMG_POSTER'] || r.img_poster || '' };
}
async function youtubeFallback(title) {
  if (config.youtubeFallback !== true) return null; // scraping YouTube search is opt-in only
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6500);
    const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(title + ' official trailer'), { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await r.text();
    clearTimeout(t);
    const m = /"videoId":"([\w-]{11})"/.exec(html);
    return youtube(m?.[1]);
  } catch { return null; }
}

const EMPTY = { imdb: '', year: '', plot: '', poster: '', backdrop: '', genres: [], trailer: null, sources: [] };
/* ------------------- trailers: free, no API key, strict matching -------------------
   Order (first validated hit wins):
     anime        : Jikan -> AniList -> Dailymotion
     movie/series : iTunes preview (direct video) -> Dailymotion
   Optional last resort (off by default): YouTube search page, config.youtubeFallback = true.
   A candidate is accepted only if its title equals the wanted title (after normalising)
   and the year is within +-1 when both are known. No match -> no trailer (never a guess). */
const normT = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/\(\s*(19|20)\d{2}\s*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const coreT = s => normT(s).replace(/^(the|a|an) /, '');
const yearOf = v => { const m = String(v == null ? '' : v).match(/(?:19|20)\d{2}/); return m ? Number(m[0]) : 0; };
const yearOk = (a, b) => { const x = yearOf(a), y = yearOf(b); return !x || !y || Math.abs(x - y) <= 1; };
const sameTitle = (cands, want) => { const w = coreT(want); return !!w && cands.some(c => c && coreT(c) === w); };
const isHttps = (u, hosts) => { try { const x = new URL(u); return x.protocol === 'https:' && hosts.some(h => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; } };
const ytId = v => (/^[\w-]{11}$/.test(String(v || '')) ? String(v) : '');

async function postJSON(url, body, timeout = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'lookmv/1.0' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function dailymotion(id) {
  if (!/^[a-z0-9]{5,20}$/i.test(String(id || ''))) return null;
  return { key: id, kind: 'dailymotion', embed: 'https://www.dailymotion.com/embed/video/' + id + '?autoplay=1&ui-logo=0&sharing-enable=false', watch: 'https://www.dailymotion.com/video/' + id };
}
const tag = (t, source) => (t ? { ...t, source } : null);

async function trailerJikan(title, year) {
  const d = await getJSON('https://api.jikan.moe/v4/anime?limit=5&q=' + encodeURIComponent(title), 5000);
  for (const a of d?.data || []) {
    const names = [a.title, a.title_english, a.title_japanese, ...(a.titles || []).map(x => x.title)];
    if (!sameTitle(names, title) || !yearOk(year, a.year || a.aired?.prop?.from?.year)) continue;
    const id = ytId(a.trailer?.youtube_id);
    if (id) return tag(youtube(id), 'Jikan');
  }
  return null;
}
async function trailerAniList(title, year) {
  const d = await postJSON('https://graphql.anilist.co', {
    query: 'query($s:String){Page(perPage:5){media(search:$s,type:ANIME,sort:SEARCH_MATCH){title{romaji english native} synonyms seasonYear startDate{year} trailer{id site}}}}',
    variables: { s: title },
  });
  for (const a of d?.data?.Page?.media || []) {
    const names = [a.title?.romaji, a.title?.english, a.title?.native, ...(a.synonyms || [])];
    if (!sameTitle(names, title) || !yearOk(year, a.seasonYear || a.startDate?.year)) continue;
    const site = String(a.trailer?.site || '').toLowerCase();
    if (site === 'youtube' && ytId(a.trailer.id)) return tag(youtube(a.trailer.id), 'AniList');
    if (site === 'dailymotion') { const t = dailymotion(a.trailer.id); if (t) return tag(t, 'AniList'); }
  }
  return null;
}
async function trailerITunes(title, year, type) {
  const tv = type === 'series';
  const d = await getJSON('https://itunes.apple.com/search?limit=10&country=us&term=' + encodeURIComponent(title) +
    (tv ? '&media=tvShow&entity=tvSeason' : '&media=movie&entity=movie'), 5000);
  for (const r of d?.results || []) {
    if (!isHttps(r.previewUrl, ['apple.com', 'mzstatic.com'])) continue;
    const names = tv ? [String(r.collectionName || '').replace(/,\s*(season|series)\s*\d+.*$/i, ''), r.artistName] : [r.trackName];
    if (!sameTitle(names, title) || !yearOk(year, r.releaseDate)) continue;
    return { kind: 'file', video: r.previewUrl, watch: r.trackViewUrl || r.collectionViewUrl || r.previewUrl, source: 'iTunes' };
  }
  return null;
}
const DM_BAD = /\b(reaction|react|review|breakdown|explained|explanation|fan ?made|parody|spoof|recap|ending|scene|clip|behind the scenes|interview|gameplay|game|ost|soundtrack|full movie|full episode|episode \d+|cam|leak(ed)?)\b/;
async function trailerDailymotion(title, year) {
  const core = coreT(title);
  // very short titles ("It", "Her") are too ambiguous without a year to check against
  if (core.length < 3 || (!yearOf(year) && core.split(' ').length === 1 && core.length <= 4)) return null;
  const q = encodeURIComponent(title + ' ' + (yearOf(year) || '') + ' official trailer');
  for (const flags of ['&flags=verified', '']) {
    let d;
    try { d = await getJSON('https://api.dailymotion.com/videos?fields=id,title,duration&limit=10&sort=relevance&search=' + q + flags, 5000); } catch { continue; }
    for (const v of d?.list || []) {
      const nt = ' ' + normT(v.title) + ' ';
      if (!nt.includes(' ' + core + ' ')) continue;
      if (!/\b(trailer|teaser)\b/.test(nt) || DM_BAD.test(nt)) continue;
      if (!(v.duration >= 30 && v.duration <= 420)) continue;
      const ys = (nt.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
      if (yearOf(year) && ys.length && !ys.some(y => Math.abs(y - yearOf(year)) <= 1)) continue;
      const t = dailymotion(v.id);
      if (t) return tag(t, 'Dailymotion');
    }
  }
  return null;
}
async function findTrailer(title, year, type) {
  if (!/[a-z0-9]/i.test(title)) return null; // non-Latin titles cannot be matched safely
  const chain = type === 'anime'
    ? [trailerJikan, trailerAniList, trailerDailymotion]
    : [trailerITunes, trailerDailymotion];
  for (const fn of chain) {
    try { const t = await fn(title, year, type); if (t) return t; } catch { /* provider down or rate-limited: try the next one */ }
  }
  if (config.youtubeFallback === true) { const t = await youtubeFallback(title); if (t) return tag(t, 'YouTube'); }
  return null;
}
const trailerJobs = new Map();
function trailerFor(title, year, type) {
  type = ['anime', 'series'].includes(type) ? type : 'movie';
  const k = 'trailer|' + [coreT(title), yearOf(year) || '', type].join('|');
  const hit = cache[k];
  if (hit && Date.now() - hit.at < (hit.data?.trailer ? 30 : 0.5) * DAY) return Promise.resolve(hit.data.trailer || null);
  if (!trailerJobs.has(k)) {
    trailerJobs.set(k, limited_(() => findTrailer(title, year, type)).catch(() => undefined).then(t => {
      if (t !== undefined) { cache[k] = { at: Date.now(), data: { trailer: t || null } }; persist(['cache']); }
      return t || null;
    }).finally(() => trailerJobs.delete(k)));
  }
  return trailerJobs.get(k);
}

async function enrich(title, year, type, lite = false) {
  const ck = (lite ? 'lite|' : '') + [title, year, type].join('|').toLowerCase();
  if (cache[ck] && Date.now() - cache[ck].at < 7 * DAY) return { ...cache[ck].data, cached: true };
  if (lite) { const full = cache[[title, year, type].join('|').toLowerCase()]; if (full && Date.now() - full.at < 7 * DAY) return { ...full.data, cached: true }; }
  const out = { ...EMPTY, sources: [] };
  const providers = [];
  if (type === 'anime') providers.push(['Jikan', () => enrichFromJikan(title)]);
  providers.push(['TMDb', () => enrichFromTMDb(title, year, type === 'series' || type === 'anime')]);
  providers.push(['OMDb', () => enrichFromOMDb(title, year)]);
  providers.push(['IMDb', () => enrichFromIMDbUnofficial(title)]);
  providers.push(['TVmaze', () => enrichFromTVmaze(title)]);

  const results = await Promise.allSettled(providers.map(([, fn]) => fn()));
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const d = r.value;
    out.sources.push(d.source);
    for (const k of ['imdb', 'year', 'plot', 'poster', 'backdrop', 'imdbId', 'rated', 'vote']) {
      if (!out[k] && d[k]) out[k] = d[k];
    }
    if (!out.trailer && d.trailer) out.trailer = d.trailer;
    if (d.genres?.length && !out.genres.length) out.genres = d.genres;
  }
  if (!lite && !out.trailer) {
    const t = await trailerFor(title, year, type);
    if (t) { out.trailer = t; out.sources.push(t.source); }
  }
  /* a lookup that found nothing (e.g. offline) is retried after 30 minutes, not a week */
  const found = out.sources.length > 0;
  cache[ck] = { at: found ? Date.now() : Date.now() - 7 * DAY + 30 * 60000, data: out };
  persist(['cache']);
  return out;
}

/* ---- covers / year / rating for many cards at once (cached, limited concurrency) ---- */
const LIM = { max: 6, run: 0, q: [] };
function limited_(fn) {
  return new Promise((resolve, reject) => {
    const go = () => { LIM.run++; fn().then(resolve, reject).finally(() => { LIM.run--; const n = LIM.q.shift(); if (n) n(); }); };
    LIM.run < LIM.max ? go() : LIM.q.push(go);
  });
}
const coverJobs = new Map();
function coverFor(m) {
  const title = m.titleEn || m.title, year = m.year || '', type = m.type || 'movie';
  const k = [title, year, type].join('|');
  if (!coverJobs.has(k)) {
    const job = limited_(() => enrich(title, year, type, true)).catch(() => null).finally(() => setTimeout(() => coverJobs.delete(k), 60000));
    coverJobs.set(k, job);
  }
  return coverJobs.get(k);
}

/* ------------------- image proxy: the SERVER downloads images -------------------
 * The browser never contacts TMDb / Amazon / MyAnimeList / TVmaze etc. Every poster
 * or backdrop URL we hand to the client is rewritten to /img/<id>. The server fetches
 * the original once, keeps it on disk (STORAGE_DIR/img-cache) and serves it from there.
 * Only URLs that the server itself registered can be fetched, so this is not an open proxy. */
const IMG_DIR = path.join(STORAGE, 'img-cache');
fs.mkdirSync(IMG_DIR, { recursive: true });
const IMG_URLS = new Map();          // id -> [primary url, ...fallback urls]
const IMG_MAX = 8 * 1024 * 1024;
const IMG_TTL = 30 * DAY;
const imgJobs = new Map();
const privateHost = h => /^(localhost|.*\.local|.*\.internal)$/i.test(h) || h === '::1' || h === '[::1]'
  || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
function imgUrl(u, alts = []) {
  if (!u || typeof u !== 'string') return '';
  if (u.startsWith('/img/')) return u;
  const list = [];
  for (const x of [u, ...alts]) {
    try {
      const p = new URL(String(x).startsWith('//') ? 'https:' + x : x);
      if (/^https?:$/.test(p.protocol) && !privateHost(p.hostname)) list.push(p.href);
    } catch { /* skip */ }
  }
  if (!list.length) return '';
  const id = crypto.createHash('sha1').update(list[0]).digest('hex').slice(0, 24);
  IMG_URLS.set(id, list);
  return '/img/' + id;
}
/* IMDb/Amazon posters come as ..._SX300.jpg; ask for a bigger one when used as a hero background */
const bigImg = u => String(u || '').replace(/(m\.media-amazon\.com\/.*\._V1_)[^.\/]*(\.\w+)$/, '$1SX1200$2');
const imgPath = id => path.join(IMG_DIR, id);
function readImgCache(id, allowStale) {
  try {
    const st = fs.statSync(imgPath(id) + '.img');
    if (!allowStale && Date.now() - st.mtimeMs > IMG_TTL) return null;
    return { buf: fs.readFileSync(imgPath(id) + '.img'), type: fs.readFileSync(imgPath(id) + '.type', 'utf8') };
  } catch { return null; }
}
async function downloadImage(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lookmv/1.0)', Accept: 'image/*' } });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return null;
    if (Number(r.headers.get('content-length') || 0) > IMG_MAX) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length && buf.length <= IMG_MAX ? { buf, type } : null;
  } catch { return null; } finally { clearTimeout(t); }
}
function getImage(id) {
  const hit = readImgCache(id, false);
  if (hit) return Promise.resolve(hit);
  const urls = IMG_URLS.get(id);
  if (!urls) return Promise.resolve(readImgCache(id, true));      // unknown after a restart: serve disk copy if any
  if (imgJobs.has(id)) return imgJobs.get(id);
  const job = (async () => {
    for (const url of urls) {
      const got = await downloadImage(url);
      if (!got) continue;
      try {
        fs.writeFileSync(imgPath(id) + '.type.tmp', got.type); fs.renameSync(imgPath(id) + '.type.tmp', imgPath(id) + '.type');
        fs.writeFileSync(imgPath(id) + '.img.tmp', got.buf);   fs.renameSync(imgPath(id) + '.img.tmp', imgPath(id) + '.img');
      } catch (e) { console.warn('[img] cache write failed:', e.message); }
      return got;
    }
    return readImgCache(id, true);                                  // origin down: serve a stale copy if we have one
  })().finally(() => imgJobs.delete(id));
  imgJobs.set(id, job);
  return job;
}
const within = (ms, p) => Promise.race([p, new Promise(ok => setTimeout(() => ok(null), ms))]);

/* what the client may see: same data, but images point at our own /img/ endpoint */
const publicInfo = d => d ? { ...d, poster: imgUrl(d.poster), backdrop: imgUrl(d.backdrop) } : d;
const pickCover = d => d ? { poster: imgUrl(d.poster), backdrop: imgUrl(d.backdrop), imdb: d.imdb || d.vote || '', year: d.year || '' } : null;

/* Resolve art from a trusted Atlasmind catalog entry when metadata APIs miss it.
   This is used only for the hourly featured title and its result is persisted. */
async function featuredSourceArtwork(m) {
  if (m.source === 'animex') {
    const id = String(m.id || '').match(/^ax-\d+-(\d+)$/)?.[1];
    if (!id) return null;
    try {
      const result = JSON.parse(await sourcePage('https://animex.pro/wp-json/app/v1/items/' + id, 8000));
      const item = result && (result.data || result);
      const poster = item && (item.poster || item.image || '');
      const backdrop = item && (item.backdrop || poster);
      return poster || backdrop ? { poster, backdrop } : null;
    } catch { return null; }
  }
  if (m.source !== 'atlasmind' || !m.sourceUrl) return null;
  let source;
  try { source = new URL(m.sourceUrl); } catch { return null; }
  if (!['www.atlasmind.top', 'atlasmind.top', 'www.atlasmind.net', 'atlasmind.net'].includes(source.hostname)) return null;
  const id = (source.pathname.match(/^\/(\d+)(?:\/|$)/) || [])[1];
  if (!id) return null;
  try {
    const apiUrl = source.origin + '/wp-json/wp/v2/posts/' + id + '?_embed=1';
    const post = JSON.parse(await sourcePage(apiUrl, 8000));
    const media = (post._embedded && post._embedded['wp:featuredmedia'] || [])[0] || {};
    const sizes = media.media_details && media.media_details.sizes || {};
    const poster = media.source_url || sizes.full?.source_url || sizes.large?.source_url || sizes.medium?.source_url || '';
    return poster ? { poster, backdrop: poster } : null;
  } catch { return null; }
}

/* featured movie: summary + rating + year + cached cover resolved on the server */
async function featuredFull() {
  const f0 = featured();
  const fullFile = path.join(STORAGE, 'featured-details.json');
  const cached = readJSON(fullFile, null);
  const hour = Math.floor(Date.now() / 3600000);
  const samePick = cached && cached.hour === hour && cached.id === f0.movie.id && cached.value;
  if (samePick && cached.value.image) {
    const savedSources = Array.isArray(cached.imageSources) ? cached.imageSources : [];
    if (savedSources.length) {
      const registered = imgUrl(savedSources[0], savedSources.slice(1));
      if (registered) cached.value.image = registered;
    }
    return cached.value;
  }

  const f = samePick ? { ...cached.value } : { ...f0 };
  const m = BY_ID.get(f.movie.id);
  f.info = null;
  f.image = '';
  if (!m) return f;
  f.links = (m.links || []).filter(l => !l.sub).map(l => ({ name: l.name || l.fileName || '', url: l.url, q: l.q || '', label: l.label || '' }));

  let info = await within(6000, enrich(m.titleEn || m.title, m.year || '', m.type || 'movie').catch(() => null));
  info = info || { ...EMPTY };
  if (!info.backdrop && !info.poster) {
    const art = await featuredSourceArtwork(m);
    if (art) info = { ...info, ...art };
  }
  f.info = publicInfo(info);

  const candidates = [...new Set([info.backdrop, info.poster].filter(Boolean))];
  const previousSources = samePick && Array.isArray(cached.imageSources) ? cached.imageSources : [];
  const rawSources = [...new Set([...candidates, ...previousSources])];
  if (rawSources.length) {
    const primary = bigImg(rawSources[0]);
    const sources = [...new Set([primary, ...rawSources])];
    const proxy = imgUrl(primary, sources.slice(1));
    if (proxy) {
      f.image = proxy;
      // Persist the source URLs with the hourly pick; the authenticated /img request
      // downloads and keeps the image on the server without delaying page rendering.
      getImage(proxy.slice(5)).catch(() => {});
    }
    const tmp = fullFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ hour, id: f.movie.id, imageSources: sources, value: f }));
    fs.renameSync(tmp, fullFile);
    return f;
  }

  const tmp = fullFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ hour, id: f.movie.id, imageSources: [], value: f }));
  fs.renameSync(tmp, fullFile);
  return f;
}

/* ------------------------------- HTTP -------------------------------- */
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(s);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) { req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function file(res, name) {
  const p = path.join(PUBLIC, name);
  if (!p.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(p, (e, b) => {
    if (e) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(b);
  });
}
const attempts = new Map();
function limited(ip) {
  const now = Date.now(), a = attempts.get(ip) || { n: 0, until: now + 600000 };
  if (now > a.until) { a.n = 0; a.until = now + 600000; }
  a.n++; attempts.set(ip, a);
  return a.n > 8;
}

async function api(req, res, u) {
  const p = u.pathname, method = req.method;
  const ip = req.socket.remoteAddress || '?';

  if (p === '/api/me' && method === 'GET') {
    const user = sessionUser(req);
    return json(res, 200, { authenticated: !!user, user: user ? cleanUser(user) : null });
  }
  if (p === '/api/signup' && method === 'POST') {
    if (limited(ip)) return json(res, 429, { error: 'too_many_requests' });
    const b = await body(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return json(res, 400, { error: 'invalid_email' });
    if (String(b.password || '').length < 8) return json(res, 400, { error: 'weak_password' });
    if (store.users.some(x => x.email === email)) return json(res, 409, { error: 'email_exists' });
    const user = { id: crypto.randomUUID(), email, ...makePassword(b.password), createdAt: new Date().toISOString() };
    store.users.push(user); persist(['users']); newSession(res, user.id);
    return json(res, 201, { ok: true, user: cleanUser(user) });
  }
  if (p === '/api/login' && method === 'POST') {
    if (limited(ip)) return json(res, 429, { error: 'too_many_requests' });
    const b = await body(req);
    const email = String(b.email || '').trim().toLowerCase();
    const user = store.users.find(x => x.email === email);
    if (!user || !verifyPassword(user, String(b.password || ''))) return json(res, 401, { error: 'invalid_credentials' });
    newSession(res, user.id);
    return json(res, 200, { ok: true, user: cleanUser(user) });
  }
  const user = sessionUser(req);
  if (!['/api/logout'].includes(p) && !user) return json(res, 401, { error: 'unauthorized' });

  /* Subtitle bridge: fetches the remote .srt/.ass file (no browser CORS),
   * converts it to WebVTT and caches the result. Pass either the subtitle
   * file itself or the episode's video URL; in the latter case the known
   * "sub/<series> - <episode>.ass" locations are probed automatically. */
  if (p === '/api/subtitle' && method === 'GET') {
    const raw = String(u.searchParams.get('u') || '').trim();
    if (!raw) return json(res, 400, { error: 'missing u' });
    const candidates = subtitleCandidates(raw).filter(c => {
      try { return allowedSubtitleHost(new URL(c).hostname); } catch { return false; }
    });
    if (!candidates.length) return json(res, 404, { error: 'no subtitle' });
    const now = Date.now();
    const cached = subCache.get(raw);
    if (cached && now - cached.at < SUB_TTL) return sendVtt(res, cached.vtt);
    const missed = subMiss.get(raw);
    if (missed && now - missed < SUB_MISS_TTL) return json(res, 404, { error: 'no subtitle' });

    const deadline = now + 9000;
    let found = null;
    for (const candidate of candidates.slice(0, 18)) {
      if (Date.now() > deadline) break;
      const hit = subCache.get(candidate);
      if (hit && Date.now() - hit.at < SUB_TTL) { found = hit; break; }
      const head = await fetchSub(candidate, 'HEAD', 3500);
      let got = null;
      if (head.status === 200) {
        if (head.len && head.len > SUB_MAX) continue;
        got = await fetchSub(candidate, 'GET', 4500);
      } else if (head.status === 403 || head.status === 405 || head.status === 501) {
        /* some CDNs refuse HEAD but serve GET */
        got = await fetchSub(candidate, 'GET', 4500);
      } else continue;
      if (!got || got.status !== 200 || !got.buf || !got.buf.length || got.buf.length > SUB_MAX) continue;
      const vtt = toVtt(decodeSubtitle(got.buf), candidate);
      if (!vtt || !vtt.includes('-->')) continue;
      found = { vtt, at: Date.now(), url: candidate };
      break;
    }

    if (!found) {
      if (Date.now() <= deadline) subMiss.set(raw, Date.now());
      return json(res, 404, { error: 'no subtitle' });
    }
    subCache.set(raw, found);
    subCache.set(found.url, found);
    if (subCache.size > 120) {
      const old = [...subCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, subCache.size - 120);
      for (const [key] of old) subCache.delete(key);
    }
    return sendVtt(res, found.vtt);
  }

  if (p === '/api/logout' && method === 'POST') { destroySession(req, res); return json(res, 200, { ok: true }); }
  if (p === '/api/change-email' && method === 'POST') {
    const b = await body(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return json(res, 400, { error: 'invalid_email' });
    if (!verifyPassword(user, String(b.password || ''))) return json(res, 401, { error: 'wrong_password' });
    if (store.users.some(x => x.email === email && x.id !== user.id)) return json(res, 409, { error: 'email_exists' });
    user.email = email; persist(['users']);
    return json(res, 200, { ok: true, user: cleanUser(user) });
  }
  if (p === '/api/change-password' && method === 'POST') {
    const b = await body(req);
    if (!verifyPassword(user, String(b.currentPassword || ''))) return json(res, 401, { error: 'wrong_password' });
    if (String(b.newPassword || '').length < 8) return json(res, 400, { error: 'weak_password' });
    const pw = makePassword(b.newPassword);
    user.salt = pw.salt; user.hash = pw.hash; persist(['users']);
    // sign out every session of this account
    for (const [t, s] of Object.entries(sessions.sessions)) if (s.userId === user.id) delete sessions.sessions[t];
    persist(['sessions']); destroySession(req, res);
    return json(res, 200, { ok: true, loggedOut: true });
  }
  if (p === '/api/delete-account' && method === 'POST') {
    const b = await body(req);
    if (!verifyPassword(user, String(b.password || ''))) return json(res, 401, { error: 'wrong_password' });
    store.users = store.users.filter(x => x.id !== user.id); persist(['users']);
    for (const [t, s] of Object.entries(sessions.sessions)) if (s.userId === user.id) delete sessions.sessions[t];
    persist(['sessions']); destroySession(req, res);
    return json(res, 200, { ok: true });
  }

  /* public catalog endpoints also require login, per "login at entry" */
  if (p === '/api/catalog') return json(res, 200, {
    total: MOVIES.length, genres: catalog.genres || [],
    generatedAt: catalog.generatedAt, sources: catalog.sources || [],
    duplicatesRemoved: catalog.duplicatesRemoved || 0,
  });
  if (p === '/api/movies') return json(res, 200, queryMovies(u.searchParams));
  /* zardfilm blocks normal browser user-agents on its REST API, so the browser
   * asks us to fetch the public wp/v2 path with a neutral user-agent. */
  if (p === '/api/zard' && method === 'GET') {
    const sub = String(u.searchParams.get('path') || '');
    if (!/^(posts|categories|tags)(?:\/|\?|$)/.test(sub) || /\.\.|:[^/]\/\/|\\\//.test(sub)) {
      return json(res, 400, { error: 'invalid_path' });
    }
    const url = SOURCE_ORIGINS.zardfilm + '/wp-json/wp/v2/' + sub;
    const hit = sourceLinkCache.get('api:' + url);
    if (hit && Date.now() - hit.at < 180000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=60' });
      return res.end(hit.data);
    }
    try {
      const text = await sourcePage(url, 12000);
      sourceLinkCache.set('api:' + url, { at: Date.now(), data: text });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=60' });
      return res.end(text);
    } catch (e) { return json(res, 502, { error: 'source_unavailable' }); }
  }
  /* Normalised download links for the two extra sources (zardfilm / doostihaa). */
  if (p === '/api/source-links' && method === 'GET') {
    const site = String(u.searchParams.get('site') || '');
    const id = String(u.searchParams.get('id') || '').replace(/\D/g, '');
    if (!SOURCE_ORIGINS[site] || !id) return json(res, 400, { error: 'invalid_source' });
    try { return json(res, 200, await sourceLinks(site, id)); }
    catch (e) { console.error('[source-links]', site, id, e.message); return json(res, 502, { error: 'source_unavailable' }); }
  }
  if (p === '/api/home-feed' && method === 'GET') return json(res, 200, await dailyHomeFeed());
  if (p === '/api/recommendations' && method === 'GET') {
    const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
    const limit = Math.min(60, Math.max(1, Number(u.searchParams.get('limit') || 10) | 0));
    return json(res, 200, recommendations(ids, limit));
  }
  if (p.startsWith('/api/movies/')) {
    const id = decodeURIComponent(p.slice('/api/movies/'.length));
    const m = BY_ID.get(id);
    return m ? json(res, 200, m) : json(res, 404, { error: 'not found' });
  }
  if (p === '/api/covers') {
    const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 36);
    const out = {}, pending = [], end = Date.now() + 4000;
    await Promise.all(ids.map(async id => {
      const m = BY_ID.get(id); if (!m) return;
      const T = Symbol('t');
      const r = await Promise.race([coverFor(m), new Promise(ok => setTimeout(() => ok(T), Math.max(50, end - Date.now())))]);
      if (r === T) pending.push(id); else out[id] = pickCover(r);
    }));
    return json(res, 200, { covers: out, pending });
  }
  /* metadata is fetched in the visitor's browser from the source sites; this
     endpoint only returns the daily catalog pick (no external API calls). */
  if (p === '/api/featured') return json(res, 200, await featuredFull());
  if (p === '/api/trailer') {
    const title = String(u.searchParams.get('q') || '').trim().slice(0, 160);
    if (!title) return json(res, 400, { error: 'missing q' });
    return json(res, 200, { trailer: await trailerFor(title, u.searchParams.get('year') || '', u.searchParams.get('type') || 'movie') });
  }
  if (p === '/api/enrich') {
    const title = String(u.searchParams.get('q') || '').trim();
    if (!title) return json(res, 400, { error: 'missing q' });
    return json(res, 200, publicInfo(await enrich(title, u.searchParams.get('year') || '', u.searchParams.get('type') || 'movie')));
  }
  return json(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (u.pathname === '/health') return json(res, 200, { ok: true });
    if (u.pathname.startsWith('/img/')) {
      if (!sessionUser(req)) return json(res, 401, { error: 'unauthorized' });
      const id = u.pathname.slice(5);
      if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 404, { error: 'not found' });
      const img = await getImage(id);
      if (!img) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.buf.length, 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
      return res.end(img.buf);
    }
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    const name = (u.pathname === '/' || u.pathname === '/login' || u.pathname === '/register') ? 'index.html' : u.pathname === '/favicon.ico' ? 'favicon-32.png' : decodeURIComponent(u.pathname.slice(1));
    return file(res, name);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) json(res, 500, { error: 'server_error' });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`lookmv running at http://localhost:${PORT}`);
  console.log(`users: ${USERS_FILE}`);
  console.log(`API config: ${CONFIG_FILE}`);
  // The browser now builds the home lists itself from the source sites.
  // No external metadata is fetched on the server.
});
