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
let config = readJSON(CONFIG_FILE, { omdbKey: '', tmdbKey: '', youtubeFallback: true });
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
const MOVIES = catalog.movies || [];
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
const BY_ID = new Map(MOVIES.map(m => [m.id, m]));
const SEARCH_INDEX = MOVIES.map(m => ({
  ref: m,
  text: [m.title, m.titleEn, m.year, m.genre, ...(m.genres || [])].join(' ').toLowerCase().replace(/[\u200c\u200d]/g, ''),
}));
console.log(`  ${MOVIES.length} titles, ${(catalog.genres || []).length} genres`);

const FEATURED_POOL = MOVIES.filter(m => m.type === 'movie');
function featured() {
  const pool = FEATURED_POOL.length ? FEATURED_POOL : MOVIES;
  const day = Math.floor((Date.now() + TZ_OFFSET) / DAY);
  const h = crypto.createHash('sha256').update(String(day) + '|lookmv-featured').digest();
  const idx = h.readUInt32BE(0) % pool.length;
  const movie = pool[idx];
  return {
    movie: summary(movie),
    day,
    nextChangeInHours: Math.ceil((DAY - ((Date.now() + TZ_OFFSET) % DAY)) / 3600000),
  };
}
function summary(m) {
  return {
    id: m.id, title: m.title, titleEn: m.titleEn, year: m.year, type: m.type,
    genre: m.genre, genres: m.genres, country: m.country, language: m.language,
    siteRating: m.siteRating, linkCount: m.linkCount ?? m.links.length,
    topQ: [...new Set((m.links || []).map(l => l.q))].sort((a, b) => {
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


/* ------------------------- daily home feed ------------------------- */
const localDay = () => new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10);
let homeFeed = readJSON(HOME_FEED_FILE, { day: '', top: [], latest: [], source: 'local' });
let homeFeedJob = null;
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
  if (homeFeed.day === day && homeFeed.top?.length >= 10 && homeFeed.latest?.length >= 10) return homeFeed;
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
    homeFeed = { day, refreshedAt: new Date().toISOString(), source: usedTMDb ? 'tmdb+catalog' : 'catalog', top, latest };
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
    trailer: youtube(a.trailer?.youtube_id),
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
  if (!config.youtubeFallback) return null;
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
async function enrich(title, year, type, lite = false) {
  const ck = (lite ? 'lite|' : '') + [title, year, type].join('|').toLowerCase();
  if (cache[ck] && Date.now() - cache[ck].at < 7 * DAY) return { ...cache[ck].data, cached: true };
  if (lite) { const full = cache[[title, year, type].join('|').toLowerCase()]; if (full && Date.now() - full.at < 7 * DAY) return { ...full.data, cached: true }; }
  const out = { ...EMPTY, sources: [] };
  const providers = [];
  if (type === 'anime' || type === 'series') providers.push(['Jikan', () => enrichFromJikan(title)]);
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
  if (!lite && !out.trailer && !out.sources.includes('Jikan') && !out.sources.includes('TMDb')) {
    const t = await youtubeFallback(title);
    if (t) { out.trailer = t; out.sources.push('YouTube'); }
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

/* featured movie: summary + rating + year + background image resolved on the server in one response */
async function featuredFull() {
  const f = featured();
  const m = BY_ID.get(f.movie.id);
  f.info = null; f.image = '';
  if (!m) return f;
  const info = await within(6000, enrich(m.titleEn || m.title, m.year || '', m.type || 'movie').catch(() => null));
  if (!info) return f;
  f.info = publicInfo(info);
  const raw = info.backdrop || info.poster;
  if (raw) {
    const url = imgUrl(raw === info.poster ? bigImg(raw) : raw, [raw]);
    const id = url.slice(5);
    if (await within(5000, getImage(id))) f.image = url;   // only send it once it is really on our disk
  }
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
    total: catalog.total ?? MOVIES.length, genres: catalog.genres || [],
    generatedAt: catalog.generatedAt, sources: catalog.sources || [],
    duplicatesRemoved: catalog.duplicatesRemoved || 0,
  });
  if (p === '/api/movies') return json(res, 200, queryMovies(u.searchParams));
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
  if (p === '/api/featured') return json(res, 200, featured());
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
    const name = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
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
