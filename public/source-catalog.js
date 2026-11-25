/*
 * source-catalog.js — live catalog straight from the two source sites.
 * Runs in the browser. No local movie database is needed for browsing;
 * data/movies.json is only used as a fallback (wired up from index.html).
 *
 * animex.pro     /wp-json/app/v1/{home,genres,items,search,items/<id>}
 * atlasmind.top  /wp-json/wp/v2/{posts,series,categories}?_embed=1
 */
(function () {
  'use strict';

  var AX = 'https://animex.pro/wp-json/app/v1/';
  var AM = 'https://www.atlasmind.top/wp-json/wp/v2/';
  var itemCache = new Map();

  function getJSON(url, timeout, signal) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, timeout || 8000);
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', function () { ctl.abort(); }, { once: true });
    }
    return fetch(url, { signal: ctl.signal, credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }
  function stripHTML(s) {
    var d = document.createElement('div'); d.innerHTML = String(s || '');
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function norm(s) {
    return String(s || '').replace(/[\u200c\u200d]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function year4(v) { var m = String(v || '').match(/(19|20)\d{2}/); return m ? m[0] : ''; }
  function num(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n.toFixed(1).replace(/\.0$/, '') : '';
  }
  /* WordPress excerpts often end with a literal "..." / "[…]" — strip it. */
  function cleanPlot(s) {
    return String(s || '').replace(/\r/g, '')
      .replace(/(\[\s*(?:&hellip;|…|\.\.\.)\s*\]|(?:&hellip;|…|\.\.\.))\s*$/i, '')
      .replace(/\[…\]\s*$/, '').trim();
  }
  function remember(m) { if (m && m.id) itemCache.set(m.id, m); return m; }
  function settled(p) { return p.then(function (v) { return { status: 'fulfilled', value: v }; }, function (e) { return { status: 'rejected', reason: e }; }); }

  /* ---------------- mapping ---------------- */
  function axType(t) {
    t = String(t || '').toLowerCase();
    if (t === 'anime') return 'anime';
    if (t === 'serial' || t === 'korean' || t === 'turkey') return 'series';
    return 'movie';
  }
  function axRating(d, type) {
    var imdb = num(d.imdb_rate), mal = num(d.mal_rate), mdl = num(d.mdl_rate);
    if (type === 'anime') {
      if (mal) return { rating: mal, ratingLabel: 'MAL', imdb: imdb, vote: mal };
      if (imdb) return { rating: imdb, ratingLabel: 'IMDb', imdb: imdb, vote: '' };
    } else if (type === 'series') {
      if (mdl) return { rating: mdl, ratingLabel: 'MDL', imdb: imdb, vote: mdl };
      if (imdb) return { rating: imdb, ratingLabel: 'IMDb', imdb: imdb, vote: '' };
    }
    if (imdb) return { rating: imdb, ratingLabel: 'IMDb', imdb: imdb, vote: '' };
    if (mal) return { rating: mal, ratingLabel: 'MAL', imdb: '', vote: mal };
    if (mdl) return { rating: mdl, ratingLabel: 'MDL', imdb: '', vote: mdl };
    return { rating: '', ratingLabel: '', imdb: '', vote: '' };
  }
  function mapAx(it) {
    var type = axType(it.type), r = axRating(it, type);
    return remember({
      id: 'ax-' + it.id, title: axName(it.title_fa || it.title), titleEn: axName(it.title),
      year: String(it.year || ''), type: type, source: 'animex',
      sourceUrl: it.web_url || 'https://animex.pro/' + (it.type || 'anime') + '/' + (it.slug || ''),
      genres: it.genres || [], genre: (it.genres || [])[0] || '',
      country: (it.countries || []).join(' · '), language: '',
      siteRating: r.rating, ratingLabel: r.ratingLabel, imdb: r.imdb, vote: r.vote,
      poster: it.poster || '', backdrop: it.backdrop || it.poster || '',
      plot: cleanPlot(it.synopsis),
      softSub: /سافت\s*ساب|soft/i.test(String(it.sub_status || '')),
      linkCount: Number(it.episodes_aired || 0), topQ: '', added: '',
      seasons: it.seasons || null, _axId: it.id, alsoIn: null
    });
  }
  /* WP titles look like:
     "دانلود فیلم <فارسی> <English> 2026 بدون سانسور با زیرنویس فارسی چسبیده"
     The old parser left the connector "با" in the name and mixed digits from
     the two languages. This one strips the marketing tail, then takes the
     last contiguous Latin run as the original (English) title and everything
     before it as the Persian title. */
  function parseAtlasTitle(rendered) {
    var s = stripHTML(rendered)
      .replace(/^دانلود\s*(?:فیلم|سریال|انیمیشن|انیمه|مستند|برنامه\s*تلویزیونی)?\s*/i, '');
    var prev;
    do {
      prev = s;
      s = s.replace(/\s*(?:بدون\s*سانسور|زیرنویس\s*فارسی\s*چسبیده|زیرنویس\s*فارسی|دوبله\s*فارسی|چسبیده|نسخه\s*BluRay[^\s]*|با)\s*$/i, '');
    } while (s !== prev);
    s = s.trim();
    var year = (s.match(/(19|20)\d{2}\s*$/) || [])[0] || '';
    if (year) s = s.replace(/(19|20)\d{2}\s*$/, '').trim();

    var en = '', fa = s;
    var m = s.match(/([A-Za-z][A-Za-z0-9:.,'()\-&!? ]*)\s*$/);
    if (m) { en = m[1].trim(); fa = s.slice(0, m.index).trim(); }
    fa = fa.replace(/[A-Za-z]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\s+(?:با|و|از|در|به)\s*$/, '').trim();
    return { title: fa || en || s, titleEn: en || fa || s, year: year };
  }
  function axName(v) {
    var s = String(v || '').replace(/\s*\|\s*.*$/, '').trim();
    if (s.split(/\s+/).length > 2) s = s.replace(/\s+(19|20)\d{2}$/, '').trim();
    return s;
  }
  function posterOf(post) {
    var media = (post._embedded && post._embedded['wp:featuredmedia'] || [])[0] || {};
    var sizes = media.media_details && media.media_details.sizes || {};
    return media.source_url || (sizes.full && sizes.full.source_url) ||
      (sizes.medium && sizes.medium.source_url) || '';
  }
  function termsOf(post) {
    return ((post._embedded && post._embedded['wp:term'] || []).flat())
      .map(function (x) { return x.name; }).filter(Boolean);
  }
  function mapAtlas(post, type) {
    var names = parseAtlasTitle(post.title && post.title.rendered);
    var terms = termsOf(post);
    return remember({
      id: 'am-' + post.id, title: names.title, titleEn: names.titleEn,
      year: names.year || String(post.date || '').slice(0, 4),
      type: type, source: 'atlasmind', sourceUrl: post.link || '',
      genres: terms, genre: terms[0] || '',
      country: '', language: '', siteRating: '', ratingLabel: 'سایت',
      imdb: '', vote: '',
      poster: posterOf(post), backdrop: '',
      plot: cleanPlot(stripHTML(post.excerpt && post.excerpt.rendered)),
      linkCount: 0, topQ: '', added: post.date || '',
      _amId: post.id, alsoIn: null
    });
  }

  /* ---------------- live endpoints ---------------- */
  /* Related genres are merged into a few broad groups so the list stays short.
     Every group remembers which animex genre names / atlasmind category ids it
     contains, so opening a group still shows everything inside it. */
  var GROUP_DEFS = [
    ['اکشن و ماجراجویی', /\baction|\badventure|اکشن|ماجراجو|جنگی|\bwar\b|وسترن|western|رزمی|martial|ورزش|\bsport/],
    ['درام و تاریخی', /\bdrama|درام|تاریخ|\bhistor|بیوگراف|biograph|زندگینامه|سیاسی/],
    ['کمدی و خانوادگی', /\bcomedy|کمدی|طنز|\bfamily|خانواد|\bmusic|موزیک|موسیق/],
    ['ترسناک و هیجان‌انگیز', /\bhorror|ترسناک|وحشت|\bthriller|هیجان|دلهره|\bsuspense/],
    ['جنایی و معمایی', /\bcrime|جنایی|\bmystery|معما|پلیسی|\bnoir|راز/],
    ['علمی‌تخیلی و فانتزی', /\bsci|علمی|تخیل|\bfantasy|فانتزی|ابرقهرمان|\bsuper|ماورا|\bsupernatural/],
    ['انیمیشن و انیمه', /\banimation|انیمیشن|انیمه|\banime|کارتون|\bcartoon|\bmecha/],
    ['عاشقانه', /\bromance|\bromantic|عاشقانه|رمانتیک/],
    ['مستند', /\bdocumentary|مستند|\breality|رئالیتی|\btalk/],
    ['سریال آسیایی', /\bkorea|کره|\bturk|ترک|\bjapan|ژاپن|\bchin|چین|هند|\bbollywood|\bthai|تایلند|\basia/],
    ['ایرانی', /\biran|ایران|\bpersian/]
  ];
  var GROUPS = null, catPromise = null;
  function normName(n) {
    return String(n || '').replace(/[\u200c\u200d]/g, ' ').replace(/ي/g, 'ی').replace(/ك/g, 'ک').toLowerCase();
  }
  function groupOf(name) {
    var n = normName(name);
    for (var i = 0; i < GROUP_DEFS.length; i++) if (GROUP_DEFS[i][1].test(n)) return GROUP_DEFS[i][0];
    return null;
  }
  function loadCategories() {
    return Promise.all([
      settled(getJSON(AX + 'genres')),
      settled(getJSON(AM + 'categories?per_page=100&hide_empty=1'))
    ]).then(function (res) {
      var ax = res[0], am = res[1], raw = [];
      if (ax.status === 'fulfilled' && ax.value && ax.value.data && ax.value.data.all) {
        Object.keys(ax.value.data.all).forEach(function (n) { raw.push({ name: n, ax: n, am: null }); });
      }
      if (am.status === 'fulfilled' && Array.isArray(am.value)) {
        am.value.forEach(function (c) {
          var n = String(c.name || '').replace(/^دانلود\s*(فیلم|سریال)\s*/i, '').trim();
          if (n && !/^(Top|Trailerz|تریلر|بزودی|تکمیل آرشیو|برترین|جدیدترین)/i.test(n)) raw.push({ name: n, ax: null, am: c.id });
        });
      }
      if (!raw.length) throw new Error('categories unavailable');
      var groups = {}, loose = {};
      function add(map, key, r) {
        var g = map[key] || (map[key] = { ax: [], am: [] });
        if (r.ax && g.ax.indexOf(r.ax) < 0) g.ax.push(r.ax);
        if (r.am != null && g.am.indexOf(r.am) < 0) g.am.push(r.am);
      }
      raw.forEach(function (r) {
        var g = groupOf(r.name);
        if (g) add(groups, g, r); else add(loose, r.name.trim(), r);
      });
      var looseKeys = Object.keys(loose).sort(function (a, b) { return a.localeCompare(b, 'fa'); });
      var names = GROUP_DEFS.map(function (d) { return d[0]; }).filter(function (n) { return groups[n]; });
      if (looseKeys.length <= 6) {
        looseKeys.forEach(function (k) { groups[k] = loose[k]; names.push(k); });
      } else {
        looseKeys.forEach(function (k) { add(groups, 'متفرقه', { ax: loose[k].ax[0] || null, am: loose[k].am[0] == null ? null : loose[k].am[0] }); loose[k].ax.slice(1).forEach(function (x) { add(groups, 'متفرقه', { ax: x, am: null }); }); });
        names.push('متفرقه');
      }
      GROUPS = groups;
      return names;
    });
  }
  function categories() {
    if (!catPromise) catPromise = loadCategories().catch(function (e) { catPromise = null; throw e; });
    return catPromise;
  }

  async function latest(page, limit) {
    var per = Math.max(2, Math.ceil(limit / 2));
    var p = page || 1;
    var res = await Promise.all([
      settled(getJSON(AX + 'items?sort=latest&per_page=' + per + '&page=' + p)),
      settled(getJSON(AM + 'posts?per_page=' + per + '&page=' + p + '&orderby=date&order=desc&_embed=1')),
      settled(getJSON(AM + 'series?per_page=' + per + '&page=' + p + '&orderby=date&order=desc&_embed=1'))
    ]);
    var items = [], hasMore = false;
    if (res[1].status === 'fulfilled') {
      (res[1].value || []).forEach(function (x) { items.push(mapAtlas(x, 'movie')); });
      if (res[1].value.length >= per) hasMore = true;
    }
    if (res[2].status === 'fulfilled') {
      (res[2].value || []).forEach(function (x) { items.push(mapAtlas(x, 'series')); });
      if (res[2].value.length >= per) hasMore = true;
    }
    if (res[0].status === 'fulfilled') {
      var d = res[0].value || {};
      (d.data || []).forEach(function (x) { items.push(mapAx(x)); });
      if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
    }
    if (!items.length) throw new Error('latest unavailable');
    return { items: items, hasMore: hasMore };
  }

  async function top(page, limit) {
    var per = Math.max(2, Math.min(limit || 10, 12));
    var p = page || 1;
    var pair = await Promise.all([
      settled(getJSON(AX + 'items?sort=rating&per_page=' + per + '&page=' + p)),
      /* atlasmind's "برترین فیلم ها" category */
      settled(getJSON(AM + 'categories?search=' + encodeURIComponent('برترین فیلم ها') + '&per_page=20'))
    ]);
    var ax = pair[0], cats = pair[1], am = null;
    if (cats.status === 'fulfilled' && cats.value.length) {
      var ids = cats.value.map(function (c) { return c.id; }).join(',');
      am = await settled(getJSON(AM + 'posts?categories=' + ids + '&per_page=' + per + '&page=' + p + '&_embed=1'));
    }
    var items = [], hasMore = false;
    if (am && am.status === 'fulfilled') {
      (am.value || []).forEach(function (x) { items.push(mapAtlas(x, 'movie')); });
      if (am.value.length >= per) hasMore = true;
    }
    if (ax.status === 'fulfilled') {
      var d = ax.value || {};
      (d.data || []).forEach(function (x) { items.push(mapAx(x)); });
      if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
    }
    if (!items.length) throw new Error('top unavailable');
    return { items: items, hasMore: hasMore };
  }

  async function search(q, page, limit) {
    var p = page || 1, per = limit || 30;
    var term = String(q || '').trim();
    if (!term) throw new Error('empty query');
    var res = await Promise.all([
      settled(getJSON(AX + 'search?q=' + encodeURIComponent(term) + '&per_page=' + per + '&page=' + p)),
      settled(getJSON(AM + 'posts?search=' + encodeURIComponent(term) + '&per_page=' + per + '&page=' + p + '&_embed=1')),
      settled(getJSON(AM + 'series?search=' + encodeURIComponent(term) + '&per_page=' + per + '&page=' + p + '&_embed=1'))
    ]);
    var items = [], hasMore = false;
    /* both sites' results are kept, in order, without deduplication */
    if (res[0].status === 'fulfilled') {
      var d = res[0].value || {};
      (d.data || []).forEach(function (x) { items.push(mapAx(x)); });
      if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
    }
    if (res[1].status === 'fulfilled') {
      (res[1].value || []).forEach(function (x) { items.push(mapAtlas(x, 'movie')); });
      if (res[1].value.length >= per) hasMore = true;
    }
    if (res[2].status === 'fulfilled') {
      (res[2].value || []).forEach(function (x) { items.push(mapAtlas(x, 'series')); });
      if (res[2].value.length >= per) hasMore = true;
    }
    if (!items.length) throw new Error('search unavailable');
    return { items: items, hasMore: hasMore };
  }

  /* Streaming search: each source reports as soon as it answers, so the first
     results show up in a fraction of the time the slowest site needs. */
  var searchCache = new Map();
  function searchStream(q, page, per, onItems, signal) {
    var p = page || 1, term = String(q || '').trim(), n = per || 12;
    if (!term) return Promise.reject(new Error('empty query'));
    var key = term.toLowerCase() + '|' + p + '|' + n;
    var hit = searchCache.get(key);
    if (hit && Date.now() - hit.t < 300000) {
      if (onItems) onItems(hit.items);
      return Promise.resolve({ items: hit.items, hasMore: hit.hasMore });
    }
    var all = [], hasMore = false, enc = encodeURIComponent(term), T = 6000;
    var jobs = [
      getJSON(AX + 'search?q=' + enc + '&per_page=' + n + '&page=' + p, T, signal).then(function (d) {
        d = d || {};
        if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
        return (d.data || []).map(mapAx);
      }),
      getJSON(AM + 'posts?search=' + enc + '&per_page=' + n + '&page=' + p + '&_embed=1', T, signal).then(function (v) {
        v = v || []; if (v.length >= n) hasMore = true;
        return v.map(function (x) { return mapAtlas(x, 'movie'); });
      }),
      getJSON(AM + 'series?search=' + enc + '&per_page=' + n + '&page=' + p + '&_embed=1', T, signal).then(function (v) {
        v = v || []; if (v.length >= n) hasMore = true;
        return v.map(function (x) { return mapAtlas(x, 'series'); });
      })
    ];
    return Promise.all(jobs.map(function (j) {
      return j.then(function (items) {
        if (items.length) { all = all.concat(items); if (onItems) onItems(items); }
      }, function () { /* one failing source must not hide the others */ });
    })).then(function () {
      if (signal && signal.aborted) throw new Error('aborted');
      if (!all.length) throw new Error('search unavailable');
      searchCache.set(key, { t: Date.now(), items: all, hasMore: hasMore });
      if (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value);
      return { items: all, hasMore: hasMore };
    });
  }

  async function browse(opt) {
    var o = opt || {}, sort = o.sort || 'new', page = o.page || 1, limit = o.limit || 30;
    if (o.q) return search(o.q, page, limit);
    if (!o.genre) return sort === 'rating' ? top(page, limit) : latest(page, limit);
    if (!GROUPS) { try { await categories(); } catch (e) {} }
    var mem = (GROUPS && GROUPS[o.genre]) || { ax: [o.genre], am: [] };
    var axNames = mem.ax.slice(0, 6), amIds = mem.am.slice(0, 8);
    var per = Math.max(2, Math.ceil(limit / 2));
    var perAx = Math.max(4, Math.ceil(per / Math.max(1, axNames.length)));
    var sortAx = sort === 'rating' ? 'rating' : 'latest';
    var axJobs = axNames.map(function (g) {
      return settled(getJSON(AX + 'items?genre=' + encodeURIComponent(g) + '&per_page=' + perAx + '&page=' + page + '&sort=' + sortAx));
    });
    var amJob = (async function () {
      var ids = amIds.slice();
      if (!ids.length && !(GROUPS && GROUPS[o.genre])) {
        var c = await settled(getJSON(AM + 'categories?search=' + encodeURIComponent(o.genre) + '&per_page=10'));
        if (c.status === 'fulfilled') ids = c.value.map(function (x) { return x.id; });
      }
      if (!ids.length) return null;
      return settled(getJSON(AM + 'posts?categories=' + ids.join(',') + '&per_page=' + per + '&page=' + page + '&_embed=1'));
    })();
    var res = await Promise.all(axJobs.concat([amJob]));
    var posts = res.pop();
    var items = [], seen = new Set(), hasMore = false;
    res.forEach(function (r) {
      if (r.status !== 'fulfilled') return;
      var d = r.value || {};
      (d.data || []).forEach(function (x) {
        var m = mapAx(x);
        if (!seen.has(m.id)) { seen.add(m.id); items.push(m); }
      });
      if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
    });
    if (posts && posts.status === 'fulfilled') {
      (posts.value || []).forEach(function (x) {
        var m = mapAtlas(x, 'movie');
        if (!seen.has(m.id)) { seen.add(m.id); items.push(m); }
      });
      if (posts.value.length >= per) hasMore = true;
    }
    if (!items.length) throw new Error('browse unavailable');
    return { items: items, hasMore: hasMore };
  }

  /* ---------------- detail / links ---------------- */
  function normQ(s) {
    var v = String(s || '');
    if (/(2160|4k|uhd)/i.test(v)) return '4K';
    var m = v.match(/(480|540|576|720|1080)/);
    return m ? m[1] + 'p' : 'نامشخص';
  }
  function sizeText(bytes) {
    var n = Number(bytes); if (!n) return '';
    return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : (n / 1048576).toFixed(0) + ' MB';
  }
  var FA_ORD = { 'اول': 1, 'دوم': 2, 'سوم': 3, 'چهارم': 4, 'پنجم': 5, 'ششم': 6,
    'هفتم': 7, 'هشتم': 8, 'نهم': 9, 'دهم': 10, 'یازدهم': 11, 'دوازدهم': 12 };
  function seasonFrom(title) {
    var t = String(title || ''), m;
    if ((m = t.match(/(?:فصل|Season|سری)\s*(\d+)/i))) return Number(m[1]);
    if ((m = t.match(/فصل\s*(اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم|یازدهم|دوازدهم)/))) return FA_ORD[m[1]];
    if ((m = t.match(/\bS(\d+)\b/i))) return Number(m[1]);
    return null;
  }
  function seasonOfEpisode(e, groupSeason) {
    var f = String(e.file_name || '');
    var m = f.match(/\bS(\d+)\s*E\d+\b/i) || f.match(/\bS(\d+)\b/i);
    if (m) return Number(m[1]);
    if (e.season != null) return Number(e.season);
    return groupSeason || null;
  }
  function isSubUrl(u) { return /\.(srt|ssa|ass|vtt)(\?|$)/i.test(String(u || '')); }
  function axLinks(d) {
    var links = [];
    (d.download_groups || []).forEach(function (g) {
      var sg = seasonFrom(g.title);
      (g.sources || []).forEach(function (s) {
        var q = normQ(s.resolution || s.label || '');
        var eps = s.episodes || [];
        if (!eps.length) {
          if (s.url) links.push({
            q: q, label: s.label || '', name: s.label || '',
            group: g.title || '', folder: s.kind === 'folder', url: s.url, size: '',
            sub: isSubUrl(s.url) || undefined
          });
          return;
        }
        eps.forEach(function (e) {
          links.push({
            q: q, label: '', name: e.file_name || s.label || '', group: g.title || '',
            ep: e.number == null ? null : Number(e.number),
            season: seasonOfEpisode(e, sg),
            size: sizeText(e.size), url: e.url,
            sub: isSubUrl(e.url) || undefined,
            soft: e.sub_type === 'soft' || undefined
          });
        });
      });
    });
    return links;
  }
  async function detail(id) {
    var cached = itemCache.get(id);
    if (cached && cached.links) return cached;
    if (id.indexOf('ax-') === 0) {
      var sid = id.slice(3);
      var res = await getJSON(AX + 'items/' + encodeURIComponent(sid));
      var d = res && res.data;
      if (!d) throw new Error('animex item missing');
      var base = mapAx(d);
      base.links = axLinks(d);
      base.linkCount = base.links.length;
      base.topQ = [...new Set(base.links.map(function (l) { return l.q; }))]
        .sort(function (a, b) { return ['4K', '1080p', '720p', '480p'].indexOf(a) - ['4K', '1080p', '720p', '480p'].indexOf(b); })[0] || '';
      return base;
    }
    if (id.indexOf('am-') === 0) {
      var mid = id.slice(3);
      var post = null, type = 'movie';
      try { post = await getJSON(AM + 'posts/' + mid + '?_embed=1'); } catch (e) {
        try { post = await getJSON(AM + 'series/' + mid + '?_embed=1'); type = 'series'; } catch (e2) {}
      }
      if (!post) throw new Error('atlasmind item missing');
      var m = mapAtlas(post, type);
      /* qualities / episodes live in the small local link cache */
      var local = window.SourceCatalog.local && await window.SourceCatalog.local.full(id);
      if (local) {
        m.links = local.links || [];
        m.siteRating = local.siteRating || '';
        m.topQ = local.topQ || '';
        m.linkCount = local.linkCount || m.links.length;
        m.plot = m.plot || cleanPlot(local.plot);
        m.genres = m.genres.length ? m.genres : (local.genres || []);
      } else m.links = [];
      return m;
    }
    throw new Error('unknown id');
  }
  async function byIds(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var hit = itemCache.get(ids[i]);
      if (hit) out.push(hit);
    }
    return out;
  }

  window.SourceCatalog = {
    categories: categories, latest: latest, top: top, search: search, searchStream: searchStream, browse: browse,
    detail: detail, byIds: byIds, local: null, item: function (id) { return itemCache.get(id) || null; }
  };
})();
