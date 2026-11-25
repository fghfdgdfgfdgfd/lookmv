# Source sites

The live catalog now searches four sites (search / latest / top / categories / detail):

| site | data used |
| --- | --- |
| `animex.pro` | `/wp-json/app/v1/*` (existing) |
| `atlasmind.top` | `/wp-json/wp/v2/*` (existing) |
| `zardfilm.in` | `/api/zard?path=...` server proxy → `wp/v2/{posts,categories,tags}`; links via `/api/source-links?site=zardfilm&id=...` |
| `doostihaa.com` | `/wp-json/doostiha/v1/search?q=...` + `wp/v2/{posts,tags}`; links via `/api/source-links?site=doostihaa&id=...` |

Why the proxies: zardfilm returns HTTP 403 for normal browser user-agents and does not
serve CORS headers for its HTML pages, so both the REST calls and the HTML download
box are fetched by `server.js` with a neutral user-agent. The proxy only accepts
`posts`, `categories` and `tags` paths on `zardfilm.in`.

## What each item carries

- **year** — parsed from the post title (Persian digits included)
- **rating** — `IMDb` value found in the excerpt / intro text
- **links** — normalised `{q, label, ep, season, size, url, sub}` records, ready for
  the existing download panel. Series are grouped by season and episode.

## Categories

`public/source-catalog.js` merges genres/categories/tags from all four sites into
one shared group list (اکشن، درام، کمدی، ترسناک، جنایی، علمی‑تخیلی، انیمیشن،
عاشقانه، مستند، سریال آسیایی، ایرانی، کودک و نوجوان، ورزشی، متفرقه). Opening a group
queries every site with its own category/tag IDs.

## Offline catalog

`scripts/build-movies.js` still builds `data/movies.json` from `atlasmind_all.json`
and `animex_database.json`. If `zardfilm_database.json` and/or
`doostihaa_database.json` are placed next to them, they are merged in as well.
These files use the same normalised item shape emitted by `source-catalog.js`
(`id`, `title`, `titleEn`, `year`, `type`, `source`, `genres`, `siteRating`, `links`…).
