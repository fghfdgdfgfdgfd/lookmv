/*
 * source-catalog.js — live catalog straight from the four source sites.
 * Runs in the browser. No local movie database is needed for browsing;
 * data/movies.json is only used as a fallback (wired up from index.html).
 *
 * animex.pro       /wp-json/app/v1/{home,genres,items,search,items/<id>}
 * atlasmind.top    /wp-json/wp/v2/{posts,series,categories}?_embed=1
 * zardfilm.in      /wp-json/wp/v2/{posts,categories}?_embed=1
 *                  (download links come from /api/source-links on our own server)
 * doostihaa.com    /wp-json/doostiha/v1/search?q=...   (poster / year / IMDb)
 *                  /wp-json/wp/v2/{posts,tags}?_embed=1
 */
(function () {
  'use strict';

  var AX = 'https://animex.pro/wp-json/app/v1/';
  var AM = 'https://www.atlasmind.top/wp-json/wp/v2/';
  var ZF = 'https://zardfilm.in/wp-json/wp/v2/';
  var DH = 'https://www.doostihaa.com/wp-json/wp/v2/';
  var DHS = 'https://www.doostihaa.com/wp-json/doostiha/v1/search';
  var itemCache = new Map();

  function getJSON(url, timeout, signal) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, timeout || 8000);
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', function () { ctl.abort(); }, { once: true });
    }
    /* our own /api/* bridge needs the session cookie; third-party sites do not */
    var own = /^\//.test(String(url || ''));
    return fetch(url, { signal: ctl.signal, credentials: own ? 'same-origin' : 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }
  /* zardfilm refuses browser user-agents, so every request for that site goes
   * through our own server (same-origin, with the session cookie). */
  function zardJSON(path, timeout, signal) {
    return getJSON('/api/zard?path=' + encodeURIComponent(path), timeout, signal);
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
  /* Persian digits are common in titles / ratings on the two new sites. */
  function faNum(s) {
    return String(s || '').replace(/[\u06f0-\u06f9]/g, function (c) { return String(c.charCodeAt(0) - 0x06f0); });
  }
  function ratingText(s) {
    var v = faNum(s);
    var m = v.match(/(?:امتیاز(?:\s*فیلم)?|IMDb|rating)[^\d]{0,18}(\d{1,2}(?:[.,]\d{1,2})?)/i)
      || v.match(/(?:امتیاز|IMDb)[^\d]{0,18}(\d{1,2}(?:[.,]\d{1,2})?)\s*از\s*10/i);
    if (!m) return '';
    var n = parseFloat(m[1].replace(',', '.'));
    return isFinite(n) && n > 0 && n <= 10 ? num(n) : '';
  }
  /* Shared title parser for zardfilm / doostihaa. WP titles are marketing
   * strings like "دانلود فیلم X 2025 با زیرنویس فارسی ... English Title 2025". */
  function parseWpTitle(rendered) {
    var s = stripHTML(rendered)
      .replace(/^دانلود\s*(?:و\s*تماشای\s*)?(?:رایگان\s*)?(?:فیلم(?:\s*(?:سینمایی|ایرانی|خارجی))?|سریال|انیمیشن|انیمه|مستند|برنامه\s*تلویزیونی|کارتون)?\s*/i, '')
      .replace(/^فصل\s*(?:\d+|اول|دوم|سوم|چهارم|پنجم)\s*(?:از\s*)?سریال\s*/i, '');
    var prev;
    do {
      prev = s;
      s = s.replace(/\s*(?:بدون\s*سانسور|زیرنویس\s*فارسی\s*چسبیده|زیرنویس\s*فارسی|دوبله\s*فارسی|چسبیده|با\s*لینک\s*مستقیم|تماشای\s*رایگان|دانلود\s*رایگان|رایگان|نسخه\s*BluRay[^\s]*|با)\s*$/i, '');
    } while (s !== prev);
    s = s.replace(/\s*\|\s*.*$/, '').trim();
    var f = faNum(s);
    var year = year4(f);
    var ym = f.match(/(19|20)\d{2}(?:\s*[-–]\s*(?:(19|20)\d{2}|\d{2}))?\s*$/);
    if (ym) s = s.slice(0, ym.index).trim();
    var en = '', fa = s;
    var m = s.match(/([A-Za-z][A-Za-z0-9:.,'()\-&!?]{1,}(?:[ ][A-Za-z0-9:.,'()\-&!?]+)*)/);
    if (m) {
      en = m[1].trim().replace(/\s*(?:19|20)\d{2}(?:\s*[-–]\s*(?:\d{2}|\d{4}))?\s*$/, '').trim();
      fa = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[1].length))
        .replace(/[A-Za-z]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    fa = fa.replace(/\s+(?:با|و|از|در|به)\s*$/, '').trim();
    return { title: fa || en || s, titleEn: en || fa || s, year: year };
  }
  function typeFromText(s) {
    var v = String(s || '');
    if (/انیمه|انیمیشن|کارتون|anime|animation/i.test(v)) return 'anime';
    if (/سریال|serial|series/i.test(v)) return 'series';
    return 'movie';
  }
  var JUNK_TERM = /^(?:دانلود|تماشا|لینک\s*مستقیم|زیرنویس|دوبله|چسبیده|بدون\s*سانسور|نسخه|کیفیت|برترین|جدیدترین|بزودی|تک\s*قسمتی|آرشیوی|رایگان|پخش\s*آنلاین|معرفی|اخبار|IMDb|قسمت|فصل)/i;
  function genreNames(post) {
    var list = (post._embedded && post._embedded['wp:term'] || []);
    var terms = Array.isArray(list) ? list.flat() : [];
    var out = [];
    terms.forEach(function (x) {
      var n = String((x && x.name) || '').replace(/^دانلود\s*(?:فیلم|سریال)\s*/i, '').trim();
      if (n && !JUNK_TERM.test(n) && out.indexOf(n) < 0) out.push(n);
    });
    return out.slice(0, 10);
  }
  function isMediaTitle(s) { return /دانلود|تماشا/i.test(String(s || '').slice(0, 50)); }
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

  function mapZard(post) {
    var names = parseWpTitle(post.title && post.title.rendered);
    var genres = genreNames(post);
    var plot = cleanPlot(stripHTML(post.excerpt && post.excerpt.rendered));
    var rating = ratingText(plot);
    return remember({
      id: 'zf-' + post.id, title: names.title, titleEn: names.titleEn,
      year: names.year || String(post.date || '').slice(0, 4),
      type: typeFromText(String(post.title && post.title.rendered) + ' ' + genres.join(' ')),
      source: 'zardfilm', sourceUrl: post.link || '',
      genres: genres, genre: genres[0] || '', country: '', language: '',
      siteRating: rating, ratingLabel: rating ? 'IMDb' : '', imdb: rating, vote: '',
      poster: posterOf(post), backdrop: '', plot: plot,
      linkCount: 0, topQ: '', added: post.date || '',
      _zfId: post.id, alsoIn: null
    });
  }
  function mapDoosti(post) {
    var names = parseWpTitle(post.title && post.title.rendered);
    var genres = genreNames(post);
    var plot = cleanPlot(stripHTML(post.excerpt && post.excerpt.rendered));
    var intro = stripHTML(post.content && post.content.rendered).slice(0, 500);
    var rating = ratingText(plot + ' ' + intro);
    return remember({
      id: 'dh-' + post.id, title: names.title, titleEn: names.titleEn,
      year: names.year || String(post.date || '').slice(0, 4),
      type: typeFromText(String(post.title && post.title.rendered) + ' ' + genres.join(' ')),
      source: 'doostihaa', sourceUrl: post.link || '',
      genres: genres, genre: genres[0] || '', country: '', language: '',
      siteRating: rating, ratingLabel: rating ? 'IMDb' : '', imdb: rating, vote: '',
      poster: posterOf(post), backdrop: '', plot: plot,
      linkCount: 0, topQ: '', added: post.date || '',
      _dhId: post.id, alsoIn: null
    });
  }
  /* The dedicated doostihaa search API is the fastest, richest source: it
   * already carries poster, year, IMDb and a human-readable type label. */
  function mapDoostiHit(hit) {
    var names = parseWpTitle(hit.title);
    var label = String(hit.type_label || '');
    var rating = num(hit.imdb);
    return remember({
      id: 'dh-' + hit.id, title: names.title, titleEn: names.titleEn,
      year: year4(faNum(hit.year)) || names.year,
      type: typeFromText(label + ' ' + String(hit.title)),
      source: 'doostihaa', sourceUrl: hit.url || '',
      genres: label ? [label] : [], genre: label || '', country: '', language: '',
      siteRating: rating, ratingLabel: rating ? 'IMDb' : '', imdb: rating, vote: '',
      poster: hit.poster || '', backdrop: '', plot: '',
      linkCount: 0, topQ: '', added: '',
      softSub: !!(hit.is_sub || hit.has_sub), _dhId: hit.id, alsoIn: null
    });
  }

  /* ---------------- live endpoints ---------------- */
  /* Related genres are merged into a few broad groups so the list stays short.
     Every group remembers which animex genre names / atlasmind category ids it
     contains, so opening a group still shows everything inside it. */
  var GROUP_DEFS = [
    ['اکشن و ماجراجویی', /\baction|\badventure|اکشن|ماجراجو|جنگی|\bwar\b|وسترن|western|رزمی|martial/],
    ['درام و تاریخی', /\bdrama|درام|تاریخ|\bhistor|بیوگراف|biograph|زندگینامه|سیاسی/],
    ['کمدی و خانوادگی', /\bcomedy|کمدی|طنز|\bfamily|خانواد|\bmusic|موزیک|موسیق/],
    ['ترسناک و هیجان‌انگیز', /\bhorror|ترسناک|وحشت|\bthriller|هیجان|دلهره|\bsuspense/],
    ['جنایی و معمایی', /\bcrime|جنایی|\bmystery|معما|پلیسی|\bnoir|راز/],
    ['علمی‌تخیلی و فانتزی', /\bsci|علمی|تخیل|\bfantasy|فانتزی|ابرقهرمان|\bsuper|ماورا|\bsupernatural/],
    ['انیمیشن و انیمه', /\banimation|انیمیشن|انیمه|\banime|کارتون|\bcartoon|\bmecha/],
    ['عاشقانه', /\bromance|\bromantic|عاشقانه|رمانتیک/],
    ['مستند', /\bdocumentary|مستند|\breality|رئالیتی|\btalk/],
    ['سریال آسیایی', /\bkorea|کره|\bturk|ترک|\bjapan|ژاپن|\bchin|چین|هند|\bbollywood|\bthai|تایلند|\basia/],
    ['ایرانی', /\biran|ایران|\bpersian|\bfarsi/],
    ['کودک و نوجوان', /کودک|نوجوان|\bkids?\b|\bchild/],
    ['ورزشی', /ورزشی|فوتبال|کشتی|\bsports?\b/],
    ['موزیکال', /موزیکال|\bmusical|رقص|\bdance/]
  ];
  /* Categories that carry no genre information (lists, news, coming soon…). */
  var SKIP_CAT = /IMDb|برترین|جدید|بزودی|تکمیل آرشیو|اخبار|افراد|هنرمند|کالکشن|معرفی|تریلر|پخش آنلاین|رایگان|اسکار|دانلود|فصل|قسمت|نسخه|زیرنویس|دوبله|سانسور/;
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
      settled(getJSON(AM + 'categories?per_page=100&hide_empty=1')),
      settled(zardJSON('categories?per_page=100&hide_empty=1')),
      settled(getJSON(DH + 'tags?per_page=100&orderby=count&order=desc&hide_empty=1')),
      settled(getJSON(DH + 'categories?parent=0&per_page=100&hide_empty=1')),
      settled(zardJSON('tags?per_page=100&orderby=count&order=desc&hide_empty=1'))
    ]).then(function (res) {
      var raw = [];
      function push(name, entry) {
        name = String(name || '').replace(/^دانلود\s*(?:فیلم|سریال)\s*/i, '').trim();
        if (!name || (!groupOf(name) && SKIP_CAT.test(name))) return;
        raw.push(Object.assign({ name: name }, entry));
      }
      var ax = res[0], am = res[1], zf = res[2], dht = res[3], dhc = res[4], zft = res[5];
      if (ax.status === 'fulfilled' && ax.value && ax.value.data && ax.value.data.all) {
        Object.keys(ax.value.data.all).forEach(function (n) { push(n, { ax: n }); });
      }
      if (am.status === 'fulfilled' && Array.isArray(am.value)) {
        am.value.forEach(function (c) { push(c.name, { am: c.id }); });
      }
      if (zf.status === 'fulfilled' && Array.isArray(zf.value)) {
        zf.value.forEach(function (c) { push(c.name, { zf: c.id }); });
      }
      if (zft.status === 'fulfilled' && Array.isArray(zft.value)) {
        zft.value.forEach(function (t) { push(t.name, { zfTag: t.id }); });
      }
      if (dht.status === 'fulfilled' && Array.isArray(dht.value)) {
        dht.value.forEach(function (t) { push(t.name, { dhTag: t.id }); });
      }
      if (dhc.status === 'fulfilled' && Array.isArray(dhc.value)) {
        dhc.value.forEach(function (c) { push(c.name, { dhCat: c.id }); });
      }
      if (!raw.length) throw new Error('categories unavailable');
      var groups = {}, loose = {};
      function add(map, key, r) {
        var g = map[key] || (map[key] = { ax: [], am: [], zf: [], zfTag: [], dhTag: [], dhCat: [] });
        if (r.ax && g.ax.indexOf(r.ax) < 0) g.ax.push(r.ax);
        if (r.am != null && g.am.indexOf(r.am) < 0) g.am.push(r.am);
        if (r.zf != null && g.zf.indexOf(r.zf) < 0) g.zf.push(r.zf);
        if (r.zfTag != null && g.zfTag.indexOf(r.zfTag) < 0) g.zfTag.push(r.zfTag);
        if (r.dhTag != null && g.dhTag.indexOf(r.dhTag) < 0) g.dhTag.push(r.dhTag);
        if (r.dhCat != null && g.dhCat.indexOf(r.dhCat) < 0) g.dhCat.push(r.dhCat);
      }
      raw.forEach(function (r) {
        var g = groupOf(r.name);
        if (g) add(groups, g, r); else add(loose, r.name.trim(), r);
      });
      var looseKeys = Object.keys(loose).filter(function (k) { return !SKIP_CAT.test(k); })
        .sort(function (a, b) { return a.localeCompare(b, 'fa'); });
      var names = GROUP_DEFS.map(function (d) { return d[0]; }).filter(function (n) { return groups[n]; });
      if (looseKeys.length <= 5) {
        looseKeys.forEach(function (k) { groups[k] = loose[k]; names.push(k); });
      } else if (looseKeys.length) {
        looseKeys.forEach(function (k) {
          var r = loose[k];
          add(groups, 'متفرقه', {
            ax: r.ax[0] || null, am: r.am[0] == null ? null : r.am[0],
            zf: r.zf[0] == null ? null : r.zf[0],
            zfTag: r.zfTag[0] == null ? null : r.zfTag[0],
            dhTag: r.dhTag[0] == null ? null : r.dhTag[0],
            dhCat: r.dhCat[0] == null ? null : r.dhCat[0]
          });
        });
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
    var per = Math.max(2, Math.ceil((limit || 24) / 4));
    var p = page || 1;
    var res = await Promise.all([
      settled(getJSON(AX + 'items?sort=latest&per_page=' + per + '&page=' + p)),
      settled(getJSON(AM + 'posts?per_page=' + per + '&page=' + p + '&orderby=date&order=desc&_embed=1')),
      settled(getJSON(AM + 'series?per_page=' + per + '&page=' + p + '&orderby=date&order=desc&_embed=1')),
      settled(zardJSON('posts?per_page=' + per + '&page=' + p + '&orderby=date&order=desc&_embed=1')),
      settled(getJSON(DH + 'posts?per_page=' + per + '&page=' + p + '&orderby=date&order=desc&_embed=1'))
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
    if (res[3].status === 'fulfilled') {
      (res[3].value || []).forEach(function (x) { items.push(mapZard(x)); });
      if (res[3].value.length >= per) hasMore = true;
    }
    if (res[4].status === 'fulfilled') {
      (res[4].value || []).filter(function (x) { return isMediaTitle(x.title && x.title.rendered); })
        .forEach(function (x) { items.push(mapDoosti(x)); });
      if (res[4].value.length >= per) hasMore = true;
    }
    if (!items.length) throw new Error('latest unavailable');
    return { items: items, hasMore: hasMore };
  }

  /* resolve a category/tag id once, with a sensible fallback for each site */
  async function findTerm(base, taxonomy, term, fallback) {
    var r = await settled(getJSON(base + taxonomy + '?search=' + encodeURIComponent(term) + '&per_page=10'));
    if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length) return r.value[0].id;
    return fallback;
  }
  async function top(page, limit) {
    var per = Math.max(2, Math.min(limit || 10, 12));
    var p = page || 1;
    var info = await Promise.all([
      settled(getJSON(AX + 'items?sort=rating&per_page=' + per + '&page=' + p)),
      findTerm(AM, 'categories', 'برترین فیلم ها', null),
      findTerm(ZF, 'categories', '250 فیلم برتر IMDB', 6732),
      findTerm(DH, 'tags', '250 فیلم برتر IMDB', 79659)
    ]);
    var ax = info[0], amId = info[1], zfId = info[2], dhId = info[3];
    var jobs = [];
    if (amId) jobs.push(settled(getJSON(AM + 'posts?categories=' + amId + '&per_page=' + per + '&page=' + p + '&_embed=1')));
    if (zfId) jobs.push(settled(zardJSON('posts?categories=' + zfId + '&per_page=' + per + '&page=' + p + '&_embed=1')));
    if (dhId) jobs.push(settled(getJSON(DH + 'posts?tags=' + dhId + '&per_page=' + per + '&page=' + p + '&_embed=1')));
    var rest = await Promise.all(jobs);
    var items = [], hasMore = false;
    if (rest[0] && rest[0].status === 'fulfilled') {
      (rest[0].value || []).forEach(function (x) { items.push(mapAtlas(x, 'movie')); });
      if (rest[0].value.length >= per) hasMore = true;
    }
    if (rest[1] && rest[1].status === 'fulfilled') {
      (rest[1].value || []).forEach(function (x) { items.push(mapZard(x)); });
      if (rest[1].value.length >= per) hasMore = true;
    }
    if (rest[2] && rest[2].status === 'fulfilled') {
      (rest[2].value || []).filter(function (x) { return isMediaTitle(x.title && x.title.rendered); })
        .forEach(function (x) { items.push(mapDoosti(x)); });
      if (rest[2].value.length >= per) hasMore = true;
    }
    if (ax.status === 'fulfilled') {
      var d = ax.value || {};
      (d.data || []).forEach(function (x) { items.push(mapAx(x)); });
      if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
    }
    if (!items.length) throw new Error('top unavailable');
    return { items: items, hasMore: hasMore };
  }

  /* Relevance filter. The source sites use loose full-text search (a WordPress search for "gt"
     also matches "&gt;" inside the page HTML, animex does fuzzy matching, ...), so results that do
     not actually contain the typed words in their title are dropped and the rest is ranked. */
  function normQ(x) {
    return String(x || '').toLowerCase()
      .replace(/[\u200c\u200d\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[\u064A\u0649]/g, '\u06CC').replace(/\u0643/g, '\u06A9').replace(/[\u0622\u0623\u0625]/g, '\u0627')
      .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); })
      .replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function relScore(it, q) {
    var qn = normQ(q);
    if (!qn) return 3;
    var hay = normQ((it.title || '') + ' | ' + (it.titleEn || '')), hayC = hay.replace(/ /g, '');
    var tokens = qn.split(' '), ok = tokens.every(function (t) { return hay.indexOf(t) >= 0 || hayC.indexOf(t) >= 0; });
    if (!ok && hayC.indexOf(qn.replace(/ /g, '')) < 0) return -1;
    var names = [normQ(it.title), normQ(it.titleEn)];
    if (names.some(function (n) { return n === qn; })) return 0;
    if (names.some(function (n) { return n.indexOf(qn) === 0; })) return 1;
    if (names.some(function (n) { return (' ' + n).indexOf(' ' + qn) >= 0; })) return 2;
    return 3;
  }
  function relFilter(items, q) {
    return (items || []).filter(function (it) { return relScore(it, q) >= 0; });
  }
  function relSort(items, q) {
    return items.map(function (it, i) { return { it: it, i: i, s: relScore(it, q) }; })
      .sort(function (a, b) { return a.s - b.s || a.i - b.i; }).map(function (x) { return x.it; });
  }

  async function search(q, page, limit) {
    var p = page || 1, per = limit || 30;
    var term = String(q || '').trim();
    if (!term) throw new Error('empty query');
    var enc = encodeURIComponent(term);
    var dhOffset = (p - 1) * Math.min(per, 10);
    var res = await Promise.all([
      settled(getJSON(AX + 'search?q=' + enc + '&per_page=' + per + '&page=' + p)),
      settled(getJSON(AM + 'posts?search=' + enc + '&per_page=' + per + '&page=' + p + '&_embed=1')),
      settled(getJSON(AM + 'series?search=' + enc + '&per_page=' + per + '&page=' + p + '&_embed=1')),
      settled(zardJSON('posts?search=' + enc + '&per_page=' + per + '&page=' + p + '&_embed=1')),
      settled(getJSON(DHS + '?q=' + enc + '&offset=' + dhOffset))
    ]);
    var items = [], hasMore = false;
    /* every site's results are kept, in order, without deduplication */
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
    if (res[3].status === 'fulfilled') {
      (res[3].value || []).forEach(function (x) { items.push(mapZard(x)); });
      if (res[3].value.length >= per) hasMore = true;
    }
    if (res[4].status === 'fulfilled') {
      var hit = res[4].value || {};
      (hit.results || []).forEach(function (x) { items.push(mapDoostiHit(x)); });
      if (hit.has_more) hasMore = true;
    }
    items = relSort(relFilter(items, term), term);
    if (!items.length) throw new Error('search unavailable');
    return { items: items, hasMore: hasMore };
  }

  /* Streaming search: each source reports as soon as it answers, so the first
     results show up in a fraction of the time the slowest site needs. */
  var searchCache = new Map();
  function searchStream(q, page, per, onItems, signal) {
    var p = page || 1, term = String(q || '').trim(), n = per || 12;
    if (!term) return Promise.reject(new Error('empty query'));
    /* which databases are on is decided by the admin (bot) and delivered by the server */
    var enabled = Object.assign({ d1: true, d2: true, d3: true, d4: true }, window.LM_SOURCES || {});
    var sig = ['d1', 'd2', 'd3', 'd4'].map(function (k) { return enabled[k] === false ? 0 : 1; }).join('');
    var key = term.toLowerCase() + '|' + p + '|' + n + '|' + sig;
    var hit = searchCache.get(key);
    if (hit && Date.now() - hit.t < 300000) {
      if (onItems) onItems(hit.items);
      return Promise.resolve({ items: hit.items, hasMore: hit.hasMore });
    }
    var all = [], hasMore = false, enc = encodeURIComponent(term), T = 6000;
    var jobs = [
      (enabled.d1 !== false ? getJSON(AX + 'search?q=' + enc + '&per_page=' + n + '&page=' + p, T, signal) : Promise.resolve({})).then(function (d) {
        d = d || {};
        if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
        return (d.data || []).map(mapAx);
      }),
      (enabled.d2 !== false ? getJSON(AM + 'posts?search=' + enc + '&per_page=' + n + '&page=' + p + '&_embed=1', T, signal) : Promise.resolve([])).then(function (v) {
        v = v || []; if (v.length >= n) hasMore = true;
        return v.map(function (x) { return mapAtlas(x, 'movie'); });
      }),
      (enabled.d2 !== false ? getJSON(AM + 'series?search=' + enc + '&per_page=' + n + '&page=' + p + '&_embed=1', T, signal) : Promise.resolve([])).then(function (v) {
        v = v || []; if (v.length >= n) hasMore = true;
        return v.map(function (x) { return mapAtlas(x, 'series'); });
      }),
      (enabled.d3 !== false ? zardJSON('posts?search=' + enc + '&per_page=' + n + '&page=' + p + '&_embed=1', T, signal) : Promise.resolve([])).then(function (v) {
        v = v || []; if (v.length >= n) hasMore = true;
        return v.map(mapZard);
      }),
      (enabled.d4 !== false ? getJSON(DHS + '?q=' + enc + '&offset=' + ((p - 1) * Math.min(n, 10)), T, signal) : Promise.resolve({})).then(function (d) {
        d = d || {}; if (d.has_more) hasMore = true;
        return (d.results || []).map(mapDoostiHit);
      })
    ];
    return Promise.all(jobs.map(function (j) {
      return j.then(function (items) {
        items = relFilter(items, term);
        if (items.length) { all = all.concat(items); if (onItems) onItems(items); }
      }, function () { /* one failing source must not hide the others */ });
    })).then(function () {
      if (signal && signal.aborted) throw new Error('aborted');
      if (!all.length) throw new Error('search unavailable');
      all = relSort(all, term);
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
    var mem = (GROUPS && GROUPS[o.genre]) || { ax: [o.genre], am: [], zf: [], dhTag: [], dhCat: [] };
    var axNames = (mem.ax || []).slice(0, 6), amIds = (mem.am || []).slice(0, 8);
    var zfIds = (mem.zf || []).slice(0, 6), zfTags = (mem.zfTag || []).slice(0, 6);
    var dhTags = (mem.dhTag || []).slice(0, 6), dhCats = (mem.dhCat || []).slice(0, 4);
    var per = Math.max(2, Math.ceil(limit / 2));
    var perAx = Math.max(4, Math.ceil(per / Math.max(1, axNames.length)));
    var sortAx = sort === 'rating' ? 'rating' : 'latest';
    var enc = encodeURIComponent(o.genre);
    var kinds = [], requests = [];
    function add(kind, request) { kinds.push(kind); requests.push(request); }
    axNames.forEach(function (g) {
      add('ax', settled(getJSON(AX + 'items?genre=' + encodeURIComponent(g) + '&per_page=' + perAx + '&page=' + page + '&sort=' + sortAx)));
    });
    add('am', (async function () {
      var ids = amIds.slice();
      if (!ids.length && !(GROUPS && GROUPS[o.genre])) {
        var c = await settled(getJSON(AM + 'categories?search=' + enc + '&per_page=10'));
        if (c.status === 'fulfilled') ids = c.value.map(function (x) { return x.id; });
      }
      if (!ids.length) return null;
      return settled(getJSON(AM + 'posts?categories=' + ids.join(',') + '&per_page=' + per + '&page=' + page + '&_embed=1'));
    })());
    add('zf', (async function () {
      var ids = zfIds.slice();
      if (!ids.length && !zfTags.length && !(GROUPS && GROUPS[o.genre])) {
        var c = await settled(zardJSON('categories?search=' + enc + '&per_page=10'));
        if (c.status === 'fulfilled') ids = c.value.map(function (x) { return x.id; });
      }
      if (!ids.length) return null;
      return settled(zardJSON('posts?categories=' + ids.join(',') + '&per_page=' + per + '&page=' + page + '&_embed=1'));
    })());
    add('zfTag', (async function () {
      if (!zfTags.length) return null;
      return settled(zardJSON('posts?tags=' + zfTags.join(',') + '&per_page=' + per + '&page=' + page + '&_embed=1'));
    })());
    add('dhTag', (async function () {
      var tags = dhTags.slice();
      if (!tags.length && !(GROUPS && GROUPS[o.genre])) {
        var c = await settled(getJSON(DH + 'tags?search=' + enc + '&per_page=10'));
        if (c.status === 'fulfilled') tags = c.value.map(function (x) { return x.id; });
      }
      if (!tags.length) return null;
      return settled(getJSON(DH + 'posts?per_page=' + per + '&page=' + page + '&tags=' + tags.join(',') + '&_embed=1'));
    })());
    add('dhCat', (async function () {
      if (!dhCats.length) return null;
      return settled(getJSON(DH + 'posts?per_page=' + per + '&page=' + page + '&categories=' + dhCats.join(',') + '&_embed=1'));
    })());
    var res = await Promise.all(requests);
    var items = [], seen = new Set(), hasMore = false;
    res.forEach(function (r, i) {
      if (!r || r.status !== 'fulfilled') return;
      if (kinds[i] === 'ax') {
        var d = r.value || {};
        (d.data || []).forEach(function (x) {
          var m = mapAx(x);
          if (!seen.has(m.id)) { seen.add(m.id); items.push(m); }
        });
        if (d.meta && d.meta.page < d.meta.total_pages) hasMore = true;
        return;
      }
      var list = r.value || [];
      list.forEach(function (x) {
        var m;
        if (kinds[i] === 'am') m = mapAtlas(x, 'movie');
        else if (/^zf/.test(kinds[i])) m = mapZard(x);
        else { if (!isMediaTitle(x.title && x.title.rendered)) return; m = mapDoosti(x); }
        if (!seen.has(m.id)) { seen.add(m.id); items.push(m); }
      });
      if (list.length >= per) hasMore = true;
    });
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
    if (id.indexOf('zf-') === 0 || id.indexOf('dh-') === 0) {
      var site = id.indexOf('zf-') === 0 ? 'zardfilm' : 'doostihaa';
      return wpSourceDetail(id, site, site === 'zardfilm' ? ZF : DH);
    }
    throw new Error('unknown id');
  }
  async function wpSourceDetail(id, site, base) {
    var sid = id.slice(3);
    var post = site === 'zardfilm' ? await zardJSON('posts/' + sid + '?_embed=1')
      : await getJSON(base + 'posts/' + sid + '?_embed=1');
    if (!post) throw new Error(site + ' item missing');
    var m = site === 'zardfilm' ? mapZard(post) : mapDoosti(post);
    try {
      /* the two new sites keep download links outside their REST responses;
         our own server bridge fetches and normalises them (see server.js). */
      var r = await getJSON('/api/source-links?site=' + site + '&id=' + encodeURIComponent(sid));
      m.links = r.links || [];
      m.linkCount = r.linkCount != null ? r.linkCount : m.links.length;
      m.topQ = r.topQ || '';
      if (r.siteRating) { m.siteRating = r.siteRating; m.imdb = r.siteRating; m.ratingLabel = 'IMDb'; }
      if (r.year) m.year = r.year;
    } catch (e) { m.links = []; }
    return m;
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
