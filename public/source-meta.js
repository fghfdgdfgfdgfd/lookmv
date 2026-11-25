/*
 * source-meta.js — browser-side metadata for lookmv
 * --------------------------------------------------
 * Everything in this file runs in the visitor's browser. No API key, no server
 * proxy. The two source databases are WordPress sites and both of them answer
 * on /wp-json with `Access-Control-Allow-Origin: <the browser's Origin>`, so a
 * plain cross-origin GET from the browser is allowed.
 *
 *  atlasmind (.top / .net)
 *    GET /wp-json/wp/v2/posts/<id>?_embed=1      (films)
 *    GET /wp-json/wp/v2/series/<id>?_embed=1     (series)
 *    GET /wp-json/wp/v2/<posts|series>?slug=...&_embed=1
 *    GET /wp-json/wp/v2/search?search=...&per_page=5
 *      -> title, excerpt.rendered (synopsis), _embedded['wp:featuredmedia'][0].source_url
 *
 *  animex.pro
 *    GET /wp-json/app/v1/search?q=...&per_page=8
 *      -> id, type, title, year, poster, imdb_rate, mal_rate, mdl_rate
 *    GET /wp-json/app/v1/items/<id>
 *      -> the above + synopsis, backdrop, genres, runtime, countries, ...
 *    GET /wp-json/app/v1/items/<id>/extras
 *      -> trailer (when the site has one)
 */
(function () {
  'use strict';

  var WEEK = 7 * 24 * 3600 * 1000;
  var MISS_TTL = 30 * 60 * 1000; // failed/empty lookups are retried after 30 min
  var LS_KEY = 'lm_srcmeta_v1';
  var MAX_CACHE = 2500;
  var CONCURRENCY = 5;

  var cache = {};
  try { cache = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { cache = {}; }
  var pending = new Map();

  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch (e) { /* quota */ }
  }
  function prune() {
    var keys = Object.keys(cache);
    if (keys.length <= MAX_CACHE) return;
    keys.sort(function (a, b) { return (cache[a].at || 0) - (cache[b].at || 0); });
    keys.slice(0, keys.length - MAX_CACHE).forEach(function (k) { delete cache[k]; });
  }
  function read(k) {
    var v = cache[k];
    if (!v) return null;
    var ttl = (v.data && (v.data.poster || v.data.plot || v.data.rating)) ? WEEK : MISS_TTL;
    if (Date.now() - (v.at || 0) > ttl) { delete cache[k]; return null; }
    return v.data;
  }
  function write(k, data) {
    cache[k] = { at: Date.now(), data: data };
    prune();
    persist();
  }

  var STOP = ['دانلود', 'فیلم', 'سریال', 'انیمه', 'انیمیشن', 'مستند', 'film', 'movie',
    'series', 'serial', 'the', 'of', 'and', 'watch', 'download', 'subbed', 'dubbed'];
  function norm(s) {
    return String(s || '').replace(/[\u200c\u200d]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function coreTitle(m) {
    var words = norm(m && (m.titleEn || m.title)).split(' ').filter(function (w) {
      return w && STOP.indexOf(w) < 0 && !(w.length < 2 && !/\p{N}/u.test(w));
    });
    return words.join(' ');
  }
  function stripHTML(s) {
    var d = document.createElement('div');
    d.innerHTML = String(s || '');
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function cleanPlot(s) {
    return String(s || '').replace(/\r/g, '')
      .replace(/(\[\s*(?:&hellip;|…|\.\.\.)\s*\]|(?:&hellip;|…|\.\.\.))\s*$/i, '').trim();
  }
  function year4(v) {
    var m = String(v || '').match(/(19|20)\d{2}/);
    return m ? m[0] : '';
  }
  function num(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n.toFixed(1).replace(/\.0$/, '') : '';
  }
  function originOf(url) {
    try { return new URL(url).origin; } catch (e) { return 'https://www.atlasmind.top'; }
  }

  function getJSON(url, timeout) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, timeout || 9000);
    var own = /^\//.test(String(url || ''));
    return fetch(url, { signal: ctl.signal, credentials: own ? 'same-origin' : 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }

  /* tiny concurrency limiter */
  var running = 0, queue = [];
  function limited(fn) {
    return new Promise(function (resolve, reject) {
      function go() {
        running++;
        Promise.resolve().then(fn).then(resolve, reject).then(function () {
          running--;
          var next = queue.shift();
          if (next) next();
        });
      }
      running < CONCURRENCY ? go() : queue.push(go);
    });
  }

  /* ---------------- atlasmind ---------------- */
  function atlasTarget(m) {
    var url = String(m.sourceUrl || '');
    var origin = /atlasmind\.net/i.test(url) ? 'https://www.atlasmind.net' : originOf(url);
    var path = '';
    try { path = new URL(url).pathname.replace(/\/+$/, ''); } catch (e) {}
    var parts = path.split('/').filter(Boolean);
    var id = (path.match(/\/(\d+)\//) || [])[1] || '';
    var slug = '';
    if (parts.length) slug = parts[parts.length - 1];
    if (slug && /^\d+$/.test(slug)) slug = '';
    return { base: origin + '/wp-json/wp/v2/', type: m.type === 'series' ? 'series' : 'posts', id: id, slug: slug };
  }

  async function atlasMeta(m) {
    var t = atlasTarget(m);
    var post = null;

    if (t.id) {
      try { post = await getJSON(t.base + t.type + '/' + t.id + '?_embed=1'); } catch (e) {}
    }
    if (!post && t.slug) {
      try {
        var bySlug = await getJSON(t.base + t.type + '?slug=' + encodeURIComponent(t.slug) + '&_embed=1');
        post = bySlug && bySlug[0];
      } catch (e) {}
    }
    if (!post) {
      try {
        var found = await getJSON(t.base + 'search?search=' + encodeURIComponent(coreTitle(m)) + '&per_page=5');
        var wanted = m.type === 'series' ? 'series' : 'post';
        var hit = (found || []).filter(function (x) { return !wanted || x.subtype === wanted; })[0] || (found || [])[0];
        if (hit) {
          var kind = hit.subtype === 'series' ? 'series' : 'posts';
          post = await getJSON(t.base + kind + '/' + hit.id + '?_embed=1');
        }
      } catch (e) {}
    }
    if (!post) throw new Error('atlasmind: not found');

    var media = (post._embedded && post._embedded['wp:featuredmedia'] || [])[0] || {};
    var sizes = media.media_details && media.media_details.sizes || {};
    var poster = media.source_url || (sizes.full && sizes.full.source_url) ||
      (sizes.medium && sizes.medium.source_url) || '';
    return {
      poster: poster,
      backdrop: '',
      plot: cleanPlot(stripHTML(post.excerpt && post.excerpt.rendered)),
      year: m.year || year4(post.title && post.title.rendered) || String(post.date || '').slice(0, 4),
      rating: m.siteRating || '',
      ratingLabel: 'سایت',
      imdb: '',
      vote: '',
      sources: ['atlasmind'],
      site: 'atlasmind'
    };
  }

  /* ---------------- animex ---------------- */
  function typeRank(m) {
    if (m.type === 'anime') return ['anime', 'serial', 'movie'];
    if (m.type === 'series') return ['serial', 'korean', 'turkey', 'movie', 'anime'];
    return ['movie', 'serial', 'korean', 'turkey', 'anime'];
  }
  function scoreHit(hit, m, q) {
    var rank = typeRank(m), t = String(hit.type || '').toLowerCase();
    var s = (rank.indexOf(t) + 1 || 20) * 20;
    var a = norm(hit.title), b = coreTitle(m);
    if (a === b) s -= 30;
    else if (a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) s -= 12;
    var y1 = year4(hit.year), y2 = year4(m.year);
    if (y1 && y2 && y1 !== y2) s += 8;
    if (q && a === norm(q)) s -= 5;
    return s;
  }
  function ratingOf(d, type) {
    var imdb = num(d.imdb_rate), mal = num(d.mal_rate), mdl = num(d.mdl_rate);
    if (type === 'anime') {
      if (mal) return { rating: mal, ratingLabel: 'MAL', imdb: imdb, vote: mal };
      if (imdb) return { rating: imdb, ratingLabel: 'IMDb', imdb: imdb, vote: '' };
      if (mdl) return { rating: mdl, ratingLabel: 'MDL', imdb: '', vote: mdl };
    }
    if (type === 'series') {
      if (mdl) return { rating: mdl, ratingLabel: 'MDL', imdb: imdb, vote: mdl };
      if (imdb) return { rating: imdb, ratingLabel: 'IMDb', imdb: imdb, vote: '' };
      if (mal) return { rating: mal, ratingLabel: 'MAL', imdb: '', vote: mal };
    }
    if (imdb) return { rating: imdb, ratingLabel: 'IMDb', imdb: imdb, vote: '' };
    if (mal) return { rating: mal, ratingLabel: 'MAL', imdb: '', vote: mal };
    if (mdl) return { rating: mdl, ratingLabel: 'MDL', imdb: '', vote: mdl };
    return { rating: '', ratingLabel: '', imdb: '', vote: '' };
  }
  function trailerOf(v) {
    if (!v) return null;
    var id = '';
    if (typeof v === 'string') {
      id = (v.match(/(?:v=|youtu\.be\/|embed\/|\/)([\w-]{11})(?:\?|&|$)/) || [])[1] || '';
      if (!id && /^[\w-]{11}$/.test(v)) id = v;
    } else {
      id = v.youtube_id || v.key || v.id || v.videoId || '';
    }
    return id ? {
      key: id,
      embed: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0',
      watch: 'https://www.youtube.com/watch?v=' + encodeURIComponent(id)
    } : null;
  }

  async function animexMeta(m, full) {
    var base = 'https://animex.pro/wp-json/app/v1/';
    var q = coreTitle(m);
    var res = await getJSON(base + 'search?q=' + encodeURIComponent(q) + '&per_page=8');
    var list = (res && res.data) || [];
    if (!list.length && m.title !== m.titleEn) {
      res = await getJSON(base + 'search?q=' + encodeURIComponent(norm(m.title)) + '&per_page=8');
      list = (res && res.data) || [];
    }
    if (!list.length) throw new Error('animex: not found');
    list.sort(function (a, b) { return scoreHit(a, m, q) - scoreHit(b, m, q); });
    var hit = list[0];
    var d = hit;

    if (full && hit.id) {
      try {
        var one = await getJSON(base + 'items/' + hit.id);
        if (one && one.data) d = one.data;
      } catch (e) {}
    }
    var r = ratingOf(d, m.type);
    var out = {
      poster: d.poster || hit.poster || '',
      backdrop: d.backdrop || d.poster || hit.poster || '',
      plot: cleanPlot(d.synopsis),
      year: m.year || year4(d.year || hit.year),
      rating: r.rating,
      ratingLabel: r.ratingLabel,
      imdb: r.imdb,
      vote: r.vote,
      sources: ['animex.pro'],
      site: 'animex',
      trailer: null
    };
    if (full && hit.id) {
      try {
        var ex = await getJSON(base + 'items/' + hit.id + '/extras');
        out.trailer = trailerOf(ex && ex.data && ex.data.trailer);
      } catch (e) {}
    }
    return out;
  }

  /* ---------------- zardfilm / doostihaa ---------------- */
  /* Both are WordPress sites: search their posts, pick the closest title and
   * reuse the featured image / excerpt / IMDb rating found there. */
  function wpScore(post, m) {
    var title = String(post.title && post.title.rendered || '')
      .replace(/^دانلود\s*(?:و\s*تماشای\s*)?(?:فیلم|سریال|انیمیشن|انیمه|مستند)?\s*/i, '');
    var a = norm(title), b = coreTitle(m);
    var s = 0;
    if (a === b) s -= 40;
    else if (a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) s -= 24;
    else {
      var aw = a.split(' '), bw = b.split(' '), hit = 0;
      bw.forEach(function (w) { if (w.length > 2 && aw.indexOf(w) >= 0) hit++; });
      if (bw.length) s -= Math.round(30 * hit / bw.length);
    }
    var y1 = year4(post.title && post.title.rendered), y2 = year4(m.year);
    if (y1 && y2 && y1 !== y2) s += 8;
    return s;
  }
  function wpRating(s) {
    var v = String(s || '').replace(/[\u06f0-\u06f9]/g, function (c) { return String(c.charCodeAt(0) - 0x06f0); });
    var m = v.match(/(?:امتیاز(?:\s*فیلم)?|IMDb|rating)[^\d]{0,18}(\d{1,2}(?:[.,]\d{1,2})?)/i)
      || v.match(/(?:امتیاز|IMDb)[^\d]{0,18}(\d{1,2}(?:[.,]\d{1,2})?)\s*از\s*10/i);
    if (!m) return '';
    var n = parseFloat(m[1].replace(',', '.'));
    return isFinite(n) && n > 0 && n <= 10 ? num(n) : '';
  }
  async function wpMeta(base, m, site, label, proxy) {
    function searchUrl(q) {
      var path = 'posts?search=' + encodeURIComponent(q) + '&per_page=5&_embed=1';
      return proxy ? base + encodeURIComponent(path) : base + path;
    }
    var q = coreTitle(m);
    var r = await getJSON(searchUrl(q));
    var list = Array.isArray(r) ? r : [];
    if (!list.length && m.title !== m.titleEn) {
      r = await getJSON(searchUrl(norm(m.title)));
      list = Array.isArray(r) ? r : [];
    }
    if (!list.length) throw new Error(site + ': not found');
    list.sort(function (a, b) { return wpScore(a, m) - wpScore(b, m); });
    var post = list[0];
    var media = (post._embedded && post._embedded['wp:featuredmedia'] || [])[0] || {};
    var sizes = media.media_details && media.media_details.sizes || {};
    var poster = media.source_url || (sizes.full && sizes.full.source_url) ||
      (sizes.medium && sizes.medium.source_url) || '';
    var plot = cleanPlot(stripHTML(post.excerpt && post.excerpt.rendered));
    var intro = stripHTML(post.content && post.content.rendered).slice(0, 500);
    var rating = wpRating(plot + ' ' + intro);
    return {
      poster: poster,
      backdrop: '',
      plot: plot,
      year: m.year || year4(post.title && post.title.rendered) || String(post.date || '').slice(0, 4),
      rating: rating,
      ratingLabel: rating ? 'IMDb' : '',
      imdb: rating,
      vote: '',
      sources: [label],
      site: site
    };
  }
  function zardMeta(m) { return wpMeta('/api/zard?path=', m, 'zardfilm', 'zardfilm.in', true); }
  function doostiMeta(m) { return wpMeta('https://www.doostihaa.com/wp-json/wp/v2/', m, 'doostihaa', 'doostihaa.com'); }

  /* ---------------- public API ---------------- */
  function key(m) {
    return [m.source || '', m.titleEn || m.title || '', m.year || '', m.type || ''].join('|').toLowerCase();
  }
  async function meta(m, full) {
    var k = key(m);
    var cached = read(k);
    if (cached && (!full || cached.plot || !cached.poster)) return cached;
    var d;
    try {
      d = m.source === 'animex' ? await animexMeta(m, full)
        : m.source === 'zardfilm' ? await zardMeta(m)
          : m.source === 'doostihaa' ? await doostiMeta(m)
            : await atlasMeta(m);
    } catch (e) { d = null; }
    if (d) {
      if (cached) d = Object.assign({}, cached, d);
      write(k, d);
    } else if (full) {
      write(k, { poster: '', plot: '', rating: '', sources: [] });
    }
    return d || cached || null;
  }

  /* batch of covers: cached entries are delivered immediately, the rest are
     fetched with limited concurrency. cb(movie, data) is called for every item. */
  async function batch(items, cb) {
    var jobs = [];
    (items || []).forEach(function (m) {
      if (!m || !m.id) return;
      var k = key(m), cached = read(k);
      if (cached) { cb(m, cached); return; }
      if (pending.has(k)) {
        pending.get(k).then(function (d) { cb(m, d); });
        return;
      }
      var p = limited(function () { return meta(m, false); })
        .then(function (d) { cb(m, d); return d; }, function () { cb(m, null); return null; })
        .finally(function () { pending.delete(k); });
      pending.set(k, p);
      jobs.push(p);
    });
    await Promise.all(jobs);
  }

  window.SourceMeta = {
    get: function (m, full) { return meta(m, !!full); },
    batch: batch,
    key: key,
    clear: function () { cache = {}; try { localStorage.removeItem(LS_KEY); } catch (e) {} }
  };
})();
