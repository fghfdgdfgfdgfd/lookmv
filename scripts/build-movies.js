#!/usr/bin/env node
/*
 * Builds a single, deduplicated movie catalog from the two source databases.
 * Run: node scripts/build-movies.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ATLAS = path.join(ROOT, '..', 'atlasmind_all.json');
const ANIMEX = path.join(ROOT, '..', 'animex_database.json');
const OUT = path.join(ROOT, 'data', 'movies.json');

const norm = s => String(s || '')
  .replace(/[\u200c\u200d]/g, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

// ignore marketing words so "دانلود فیلم X 2024 ..." matches "X"
const STOP = new Set([
  'دانلود', 'film', 'movie', 'series', 'serial', 'the', 'of', 'and', ' با', 'زیرنویس', 'فارسی',
  'چسبیده', 'بدون', 'سانسور', 'دوبله', 'نسخه', 'اصلی', 'تماشا', '在线', 'watch', 'download',
]);
function keyFor(title, year) {
  const words = norm(title).split(' ').filter(w => w && !STOP.has(w) && !(w.length < 2 && !/\p{N}/u.test(w)));
  const base = words.join(' ');
  const y = String(year || '').match(/(19|20)\d{2}/)?.[0] || '';
  return base + '|' + y;
}

function quality(raw) {
  const s = String(raw || '');
  if (/(2160|4k|uhd)/i.test(s)) return '4K';
  const m = s.match(/(480|540|576|720|1080)/);
  if (m) return m[1] + 'p';
  if (/360/i.test(s)) return '360p';
  return s.trim() || 'نامشخص';
}
function version(label, url) {
  const s = (String(label || '') + ' ' + String(url || '')).toLowerCase();
  if (/dub|دوبله|فارسی|farsi|persian/.test(s)) return 'دوبله فارسی';
  if (/hardsub|چسبیده|subbed|زیرنویس/.test(s)) return 'زیرنویس فارسی چسبیده';
  if (/original|نسخه اصلی|uncut/.test(s)) return 'نسخه اصلی';
  return String(label || 'نسخه اصلی').slice(0, 60);
}

const sizeNum = s => {
  const m = String(s || '').match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return 0;
  return parseFloat(m[1]) * (/gb/i.test(m[2]) ? 1024 : 1);
};

function fromAtlas(it, idx) {
  const links = (it.download_links || []).map(l => ({
    q: quality(l.quality),
    label: version([l.section, l.encoder].filter(Boolean).join(' '), l.url),
    ep: null,
    size: '',
    url: l.url,
  })).filter(l => l.url);
  const genres = (it.genres || []).map(g => g.name).filter(Boolean);
  return {
    id: 'am-' + it.id,
    title: it.name_fa || it.name_en || it.title || '',
    titleEn: it.name_en || it.original_name || '',
    year: String(it.year || '').match(/(19|20)\d{2}/)?.[0] || '',
    type: it.type === 'series' ? 'series' : 'movie',
    source: 'atlasmind',
    sourceUrl: it.url || '',
    genres,
    genre: genres[0] || '',
    country: it.country || '',
    language: it.language || '',
    siteRating: it.rating || '',
    releaseDate: it.release_date || '',
    added: it.date || '',
    links,
  };
}

function fromAnimex(t, ci, ti) {
  const links = [];
  for (const [q, files] of Object.entries(t.qualities || {})) {
    for (const f of files || []) {
      if (!f.url) continue;
      links.push({
        q: quality(f.quality !== 'نامشخص' ? f.quality : (f.tags || []).join(' ') || q),
        label: version((f.tags || []).join(' '), f.url),
        ep: f.episode == null ? null : Number(f.episode),
        size: f.size || '',
        url: f.url,
      });
    }
  }
  const cat = t.category_fa || '';
  const type = /انیمه/.test(cat) ? 'anime' : /سریال/.test(cat) ? 'series' : 'movie';
  return {
    id: `ax-${ci}-${ti}`,
    title: t.name_fa || t.name_en || t.original_name || '',
    titleEn: t.name_en || t.original_name || '',
    year: String(t.year || '').match(/(19|20)\d{2}/)?.[0] || '',
    type,
    source: 'animex',
    sourceUrl: '',
    genres: cat ? [cat] : [],
    genre: cat,
    country: '',
    language: '',
    siteRating: '',
    releaseDate: '',
    added: '',
    links,
  };
}

// richer record wins when the same title exists in both databases
function richness(m) {
  return (m.links.length > 0 ? 2 : 0)
    + (m.genres.length ? 2 : 0)
    + (m.country ? 1 : 0)
    + (m.siteRating ? 1 : 0)
    + (m.releaseDate ? 1 : 0)
    + Math.min(m.links.length / 50, 4);
}

function main() {
  console.log('Reading source databases...');
  const atlas = JSON.parse(fs.readFileSync(ATLAS, 'utf8'));
  const animex = JSON.parse(fs.readFileSync(ANIMEX, 'utf8'));

  const map = new Map();
  let dupes = 0;
  const add = m => {
    const k = keyFor(m.titleEn || m.title, m.year);
    if (!k || k === '|') return;
    const prev = map.get(k);
    if (!prev) { map.set(k, m); return; }
    dupes++;
    if (richness(m) > richness(prev)) {
      // keep the winning record but remember it also existed in the other DB
      map.set(k, { ...m, alsoIn: prev.source });
    } else {
      prev.alsoIn = m.source;
    }
  };

  atlas.items.forEach((it, i) => add(fromAtlas(it, i)));
  animex.categories.forEach((c, ci) => c.titles.forEach((t, ti) => add(fromAnimex(t, ci, ti))));

  const movies = [...map.values()].map(m => ({
    ...m,
    key: undefined,
    // very long series can carry thousands of mirrored links; keep a sane cap
    links: m.links.slice(0, 200),
    linkCount: m.links.length,
  }));
  movies.sort((a, b) => String(b.added).localeCompare(String(a.added)) || a.title.localeCompare(b.title, 'fa'));

  const genres = [...new Set(movies.flatMap(m => m.genres))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'fa'));
  const out = {
    generatedAt: new Date().toISOString(),
    sources: ['atlasmind_all.json', 'animex_database.json'],
    total: movies.length,
    duplicatesRemoved: dupes,
    genres,
    movies,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}`);
  console.log(`  items: ${movies.length} (duplicates removed: ${dupes})`);
  console.log(`  genres: ${genres.length}`);
  console.log(`  size: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);
}
main();
