// Honest recent food-trend feed (replaces the static "viral" label path).
//
// The old /api/viral endpoint returned a STATIC, hard-coded Cookpad card list
// (COOKPAD_RENDANG) and labelled it "Viral Foodies". That list never changes,
// is not date-bound, and its "viral" framing was asserted without any
// popularity evidence — exactly the kind of unverifiable claim this module
// exists to remove.
//
// This module instead fetches REAL, DATED culinary articles from accessible
// RSS feeds at request time, keeps only items published within a bounded
// 60-day window, and returns them with their actual publication date + source
// so the UI can show "recent" rather than "viral". Nothing here fabricates a
// trend, a date, or a popularity signal — every card carries the source feed's
// own title/link/date. When a feed is unreachable or stale, the result is an
// HONEST empty state (or an explicitly-labelled fallback), never invented data.
//
// Sources (verified reachable, date-bearing, safe https, no auth):
//   * https://food.detik.com/rss        — detikFood RSS (Indonesian culinary
//     news). Primary source. Items carry <title>, <link>, <pubDate>, and a
//     description-embedded thumbnail. Host allowlisted.
//   * https://news.google.com/rss/search?q=...  — Google News RSS (optional
//     secondary). Real dated articles but links are news.google.com redirect
//     wrappers, so they are used only as a fallback when detik is down, and
//     are clearly labelled. (NOT enabled by default; see SOURCES below.)
//
// Design constraints (Cloudflare Workers Free: ~10ms CPU, no long-lived state,
// no external npm deps — parser is hand-rolled on purpose):
//   * No runtime dependencies. A minimal RSS/XML parser (no DOMParser on the
//     Worker) extracts item title/link/pubDate/thumbnail defensively.
//   * Fetch with a hard timeout (AbortController) so a hung upstream cannot
//     stall the worker past its CPU budget.
//   * 60-day freshness bound enforced against each item's parsed pubDate.
//   * In-memory cache with TTL so a burst of tab opens doesn't re-fetch; the
//     cache is per-isolate and never persisted (honest about that limitation).

import { jsonResponse } from './security.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Hard cap on how old an item may be (ms). Anything older is dropped so the
// feed is genuinely "recent" and the window is bounded and deterministic.
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

// Per-feed fetch timeout. Bounded so the whole handler stays within the
// Workers CPU wall-clock budget even when an upstream hangs.
let FETCH_TIMEOUT_MS = 4500;

// How many items to return at most.
const MAX_ITEMS = 18;

// Truthful heading for the recent-recipe feed. The old endpoint was labelled
// "Viral Foodies" (an unverifiable popularity claim); the feed is now a
// dated, recipe-only listing. This heading is returned in the response so the
// frontend can render an honest label instead of implying "viral" or mixing
// in general culinary news.
const TRUTHFUL_HEADING = 'Resep Terbaru';

// Cache TTL. Per-isolate only (no KV), so a cold isolate re-fetches; this is
// deliberate — we never want to serve a silently-stale snapshot longer than
// this window, and we are honest in the response about `cached`.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Allowlisted hosts for the returned article URL and thumbnail. Anything off
// this list is dropped rather than surfaced, mirroring sanitizeCard()'s
// approach in external.js. Google News redirect URLs are NOT in this list by
// default (see note above); if a secondary source is enabled, its host must be
// added here deliberately.
const ALLOWED_LINK_HOSTS = new Set([
  'food.detik.com',
  'www.detik.com',
  'detik.com',
  'news.detik.com',
]);
const ALLOWED_IMG_HOSTS = new Set([
  'akcdn.detik.net.id',
  'cdn.detik.net.id',
  'img-global.cpcdn.com',
]);

// Ordered source list. Each entry must be https (safe), date-bearing, and
// free of auth. Only the primary is enabled by default.
const SOURCES = [
  {
    name: 'detikFood',
    url: 'https://food.detik.com/rss',
    enabled: true,
    // Allowlist of item "source" attributes we trust to attribute. Empty means
    // attribute to the feed name itself.
    attribution: 'detikFood',
  },
  // Google News RSS — real dated articles, but links are redirect wrappers.
  // Left disabled by default because the link host is not a clean article URL.
  // To enable: set enabled: true AND add the host to ALLOWED_LINK_HOSTS, and
  // decide how the UI links out (the wrapper URL is still a valid news.google
  // reader link). Intentionally commented to make the trade-off explicit.
  // {
  //   name: 'GoogleNews',
  //   url: 'https://news.google.com/rss/search?q=makanan%20kuliner%20indonesia&hl=id&gl=ID&ceid=ID:id',
  //   enabled: false,
  //   attribution: 'Google News',
  // },
];

// ---------------------------------------------------------------------------
// Minimal RSS/XML parsing (no DOMParser on Workers, no deps)
// ---------------------------------------------------------------------------

// Decode the common XML/HTML entities we expect in feed text. Anything not
// listed is left as-is (titles are rendered HTML-escaped by the frontend).
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'",
  '&apos;': "'", '&nbsp;': ' ',
};
function decodeEntities(text) {
  return String(text == null ? '' : text).replace(/&(amp|lt|gt|quot|#039|apos|nbsp);/g, (m) => ENTITIES[m] || m);
}

// Extract text between <tag>...</tag> (first occurrence, non-greedy, no attrs).
// Tolerant of CDATA and nested-free content. Returns '' when absent.
function tagText(xml, tag) {
  const open = new RegExp('<' + tag + '(?:\\s[^>]*)?>');
  const close = new RegExp('</' + tag + '\\s*>');
  const o = xml.search(open);
  if (o < 0) return '';
  const after = xml.slice(o).replace(open, '');
  const c = after.search(close);
  const raw = c < 0 ? after : after.slice(0, c);
  return decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

// Split an RSS document into <item>...</item> chunks. Handles self-closing and
// namespaced forms defensively.
function splitItems(xml) {
  const chunks = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) chunks.push(m[1]);
  return chunks;
}

// Extract the first https URL from an item's description (detikFood embeds
// its thumbnail there) — used only when the feed provides no usable
// <enclosure>. HTTPS-ONLY: any http:// or protocol-relative (//) URL is
// rejected so a mixed-content thumbnail can never reach the frontend (whose
// safeUrl() allowlist also requires https, but we must not rely on the client
// to do the enforcement).
function extractImageUrl(description) {
  const m = /https:\/\/[^\s"'<>]+/i.exec(description || '');
  if (!m) return '';
  return m[0].replace(/["'>]+$/, '').trim();
}

// detikFood also emits a self-closing <enclosure ... url="..."/> element whose
// thumbnail is carried in the `url` ATTRIBUTE, not as element text (so
// tagText() cannot read it). Extract that attribute defensively. The URL is
// XML-entity-encoded (&amp;), so decode before validating. HTTPS-only.
function extractEnclosureUrl(itemXml) {
  const m = /<enclosure\b[^>]*\burl="([^"]+)"/i.exec(itemXml || '');
  if (!m) return '';
  return decodeEntities(m[1]).trim();
}

// Parse a feed's pubDate into epoch ms. Accepts the RFC-822 variants used by
// detik (+0700) and Google News (GMT). Returns NaN when unparseable.
function parsePubDate(text) {
  const s = String(text || '').trim();
  if (!s) return NaN;
  const t = Date.parse(s);
  return t;
}

// ---------------------------------------------------------------------------
// Host allowlist validation (mirrors external.js sanitizeCard semantics) PLUS
// a strict https-only scheme check. Rejecting non-https here (rather than
// trusting the frontend) keeps mixed-content and javascript:/data: schemes out
// of both the returned `url` and `thumbnail` fields.
function hostAllowed(url, allow) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return allow.has(u.hostname) || allow.has(u.hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

// True when an item is an actual RECIPE article rather than general culinary
// news. detikFood recipe articles live under /resep/ (e.g.
// https://food.detik.com/resep/d-123/...); non-recipe articles (celebrity,
// wine, lifestyle) live under /berita/, /minuman/, etc. and are dropped. A
// title is also checked for the "resep" marker as a fallback for feeds that
// put the category in the title instead of the path.
function isRecipeArticle(link, title) {
  const url = String(link || '');
  const text = String(title || '').toLowerCase();
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // Unparseable URL: fall through to title-only check below.
  }
  if (/(^|\/)resep(\/|$)/.test(path)) return true;
  if (/\bresep\b/.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Feed fetch + normalization
// ---------------------------------------------------------------------------

async function fetchFeed(source, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(source.url, {
      headers: { 'User-Agent': 'ResepInAja/1.0 (trends)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: controller.signal,
    });
    if (resp.status !== 200) return { source: source.name, ok: false, reason: 'HTTP ' + resp.status };
    const text = await resp.text();
    return { source: source.name, ok: true, text };
  } catch (err) {
    return { source: source.name, ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function parseItems(source, xml) {
  const now = Date.now();
  const out = [];
  const seen = new Set();
  for (const chunk of splitItems(xml)) {
    const title = tagText(chunk, 'title');
    const link = tagText(chunk, 'link');
    const pubStr = tagText(chunk, 'pubDate');
    const description = tagText(chunk, 'description');
    const encoded = tagText(chunk, 'encoded') || '';

    if (!title || !link) continue;
    if (seen.has(link)) continue;
    seen.add(link);

    // Recipe-article filter: the detikFood RSS is a GENERAL culinary-news
    // feed (celebrity, wine, restaurant, lifestyle pieces), not a recipe-only
    // feed. Without a filter the "recent recipes" feed surfaces unrelated
    // news. Keep only actual RECIPE articles, identified by a `/resep/` path
    // segment in the link OR the "resep" category marker in the title. This
    // makes the feed honestly a recipe feed, not a food-news feed.
    if (!isRecipeArticle(link, title)) continue;

    const publishedMs = parsePubDate(pubStr);
    if (!Number.isFinite(publishedMs)) continue; // no date -> not verifiably recent
    if (now - publishedMs < 0) continue;          // future date -> reject
    if (now - publishedMs > MAX_AGE_MS) continue; // too old -> drop

    if (!hostAllowed(link, ALLOWED_LINK_HOSTS)) continue;

    // Prefer the enclosure's url ATTRIBUTE (the real detikFood thumbnail),
    // then the description/encoded <img src>. hostAllowed() enforces https +
    // allowlist; a missing/off-list thumbnail is left '' (safe fallback).
    const thumb = extractEnclosureUrl(chunk) || extractImageUrl(description) || extractImageUrl(encoded) || '';
    const thumbnail = thumb && hostAllowed(thumb, ALLOWED_IMG_HOSTS) ? thumb : '';

    out.push({
      nama: title,
      url: link,
      source: source.name,
      thumbnail,
      published: new Date(publishedMs).toISOString(),
      publishedMs,
    });
  }
  // Newest first.
  out.sort((a, b) => b.publishedMs - a.publishedMs);
  return out;
}

// ---------------------------------------------------------------------------
// Cache (in-memory, per-isolate)
// ---------------------------------------------------------------------------
let cache = { at: 0, items: null, lastError: null, lastSuccessAt: 0 };

// Test-only hook: clear the in-memory cache so deterministic tests can run
// against a cold cache regardless of test order. No-op in production.
export function resetTrendCache() {
  cache = { at: 0, items: null, lastError: null, lastSuccessAt: 0 };
}

// Test-only hook: override the fetch timeout so timeout tests don't wait the
// full 4.5s. No-op in production.
export function __setFetchTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) FETCH_TIMEOUT_MS = ms;
}

// ---------------------------------------------------------------------------
// Main entry: fetch + bound + normalize the recent-trend feed
// ---------------------------------------------------------------------------
//
// Returns { recipes: [{nama,url,source,thumbnail,published}], ...meta }.
// Guarantees:
//   * recipes is ALWAYS an array (possibly empty) — never null/undefined.
//   * Every card carries a real `published` ISO date and `source`.
//   * On upstream failure, an honest `status`/`error` is returned with an
//     empty list (or a stale cache, clearly flagged `cached`).
export async function getRecentFoodTrends(fetchFn = fetch, now = Date.now()) {
  // Serve warm cache (respecting TTL) without re-fetching.
  if (cache.items !== null && now - cache.at < CACHE_TTL_MS) {
    return {
      recipes: cache.items,
      source: 'detikFood',
      heading: TRUTHFUL_HEADING,
      window_days: 60,
      cached: true,
      generated_at: new Date(now).toISOString(),
    };
  }

  const enabled = SOURCES.filter((s) => s.enabled);
  const errors = [];
  let items = [];

  for (const source of enabled) {
    const res = await fetchFeed(source, fetchFn);
    if (!res.ok) {
      errors.push({ source: source.name, reason: res.reason });
      continue;
    }
    const parsed = parseItems(source, res.text);
    if (!parsed.length) {
      errors.push({ source: source.name, reason: 'no items in window' });
      continue;
    }
    items = items.concat(parsed);
    cache.lastSuccessAt = now;
  }

  // Merge + dedupe by url, keep newest-first, cap.
  const seen = new Set();
  const unique = [];
  for (const it of items.sort((a, b) => b.publishedMs - a.publishedMs)) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    unique.push(it);
    if (unique.length >= MAX_ITEMS) break;
  }

  const body = {
    recipes: unique,
    source: enabled.map((s) => s.name),
    heading: TRUTHFUL_HEADING,
    window_days: 60,
    cached: false,
    generated_at: new Date(now).toISOString(),
  };

  // Distinguish "no data at all (and we have nothing cached)" from
  // "upstream failed but we still have a stale snapshot".
  if (!unique.length) {
    if (cache.items && cache.items.length) {
      // Stale cache is better than a blank wall, but it is clearly flagged.
      body.recipes = cache.items;
      body.cached = true;
      body.stale = true;
      body.note = 'Sumber sedang tidak tersedia; menampilkan data terakhir yang berhasil dimuat.';
    } else {
      body.status = 'unavailable';
      body.error = 'Belum ada data tren terbaru yang bisa dimuat.';
      if (errors.length) body.errors = errors;
    }
  }

  // Only cache a genuinely fresh, non-empty result.
  if (unique.length && !body.stale) {
    cache = { at: now, items: unique, lastError: null, lastSuccessAt: now };
  }

  return body;
}

// ---------------------------------------------------------------------------
// Route handler for GET /api/viral (kept contract-compatible with the old
// endpoint so the parent's frontend wiring needs no schema change).
// ---------------------------------------------------------------------------
// Signature matches the other route handlers in index.js: they receive the
// already-resolved fetchFn (ctx.fetchOverride in tests, real fetch in prod).
// Call it as `handleTrends(request, env, fetchFn)` from handle().
//
// Response shape:
//   { recipes: [{nama, url, source, thumbnail, published}] }
// The frontend recipeTiles() reads nama/thumbnail/url + source; the extra
// `published` field is additive and ignored by the existing renderer, so no
// HTML edit is strictly required — but to show dates honestly the parent
// SHOULD update the viral page copy and, ideally, render the date.
export async function handleTrends(request, env, fetchFn) {
  const effectiveFetch = typeof fetchFn === 'function' ? fetchFn : fetch;
  const data = await getRecentFoodTrends(effectiveFetch, Date.now());
  if (data.status === 'unavailable') {
    // Honest 503 + message; body still includes recipes: [] so clients can
    // render an empty state instead of crashing.
    return jsonResponse({ recipes: [], status: 'unavailable', error: data.error, ...(data.errors ? { errors: data.errors } : {}) }, 503);
  }
  return jsonResponse({ recipes: data.recipes, source: data.source, heading: data.heading, window_days: data.window_days, cached: !!data.cached, stale: !!data.stale, generated_at: data.generated_at });
}
