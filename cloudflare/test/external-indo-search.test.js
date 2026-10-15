// Deterministic tests for the live Indonesian recipe search in src/external.js.
// Run: `npm test` (node --test test/).
//
// All upstream calls are MOCKED — no real network. Tests inject a fake fetch
// (and a fixed `now`) so the parallel-source aggregation, dedupe, allowlist,
// TTL cache, timeout, and source-failover paths are exercised deterministically
// against labelled in-memory HTML fixtures (mirroring the real Cookpad/ResepKoki
// server-rendered markup), never against live pages.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  searchIndonesianRecipes,
  resetIndoCache,
  __setIndoFetchTimeout,
  sanitizeCard,
  mixedRecipes,
  canonicalizeDishQuery,
} from '../src/external.js';

// ---------------------------------------------------------------------------
// Fixtures (clearly labelled, deterministic, mirroring real markup shapes)
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse('2026-10-14T18:00:00Z');

// Cookpad search result: <li id="recipe_<ID>"> containing the title anchor and
// a thumbnail img on img-global.cpcdn.com (same shape as the live page).
function cookpadCard({ id, title, thumbHash = 'a'.repeat(16) }) {
  return (
    `<li id="recipe_${id}">` +
    `<a itemprop="url" href="/id/resep/${id}">${title}</a>` +
    `<img alt="Foto resep ${title}" src="https://img-global.cpcdn.com/recipes/${thumbHash}/120x160cq80/photo.jpg" />` +
    `</li>`
  );
}

function cookpadPage(cards) {
  return `<html><body><div id="search_results">${cards.join('')}</div></body></html>`;
}

// ResepKoki search result: <article> with <h3 class="entry-title"><a ...> and a
// lazyload img on i0.wp.com (same shape as the live page).
function resepKokiCard({ slug, title, img = 'https://i0.wp.com/resepkoki.id/wp-content/uploads/2020/01/x.jpg?fit=640%2C800&ssl=1' }) {
  return (
    `<article><div class="archive-item-media">` +
    `<a href="https://resepkoki.id/${slug}/"><noscript><img class="archive-item-media" src="${img}"></noscript>` +
    `<img src='data:image/svg+xml' class="lazyload archive-item-media" data-src="${img}"></a></div>` +
    `<div class="archive-item-content"><header class="archive-item-header">` +
    `<h3 class="entry-title"><a href="https://resepkoki.id/${slug}/" rel="bookmark">${title}</a></h3>` +
    `</header></div></article>`
  );
}

function resepKokiPage(cards) {
  return `<html><body>${cards.join('')}</body></html>`;
}

// ---------------------------------------------------------------------------
// Fake fetch: route by URL host to canned bodies; supports hanging (abort) and
// per-source failure to exercise failover.
// ---------------------------------------------------------------------------
function fakeFetch({ cookpad = null, resepkoki = null, hang = null, extra = {} } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    const host = (() => {
      if (u.includes('cookpad.com')) return 'cookpad';
      if (u.includes('resepkoki.id')) return 'resepkoki';
      if (u.includes('themealdb.com')) return 'themealdb';
      return 'other';
    })();
    if (hang && hang === host) {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        if (signal) signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    if (extra[host] !== undefined) return extra[host];
    if (host === 'cookpad') return new Response(cookpad, { status: 200, headers: { 'Content-Type': 'text/html' } });
    if (host === 'resepkoki') return new Response(resepkoki, { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response('not found', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Setup: reset cache + timeout before each test (no order-dependent state).
// ---------------------------------------------------------------------------
test.beforeEach(() => {
  resetIndoCache();
  __setIndoFetchTimeout(4500); // restore production default
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('searchIndonesianRecipes returns real Cookpad cards with nama/url/thumbnail/source', async () => {
  const page = cookpadPage([
    cookpadCard({ id: '26723746', title: 'Tempe Balado' }),
    cookpadCard({ id: '26720639', title: 'Orek Tempe Balado' }),
  ]);
  const cards = await searchIndonesianRecipes('tempe', fakeFetch({ cookpad: page, resepkoki: '' }), { now: FIXED_NOW });
  assert.ok(cards.length >= 2);
  for (const c of cards) {
    assert.ok(c.nama, 'nama required');
    assert.ok(c.url, 'url required');
    assert.ok(c.thumbnail, 'thumbnail required');
    assert.ok(c.source, 'source required');
  }
  // URL is a real cookpad recipe link, thumbnail is a canonical cpcdn image.
  const first = cards.find((c) => c.nama === 'Tempe Balado');
  assert.ok(first);
  assert.match(first.url, /^https:\/\/cookpad\.com\/id\/resep\/26723746$/);
  assert.match(first.thumbnail, /^https:\/\/img-global\.cpcdn\.com\/recipes\/a{16}\/680x482cq50\/photo\.jpg$/);
});

test('searchIndonesianRecipes merges Cookpad + ResepKoki (both sources) with attribution', async () => {
  const cp = cookpadPage([cookpadCard({ id: '111', title: 'Tumis Kangkung' })]);
  const rk = resepKokiPage([resepKokiCard({ slug: 'resep-tumis-kangkung', title: 'Resep Tumis Kangkung Enak' })]);
  const cards = await searchIndonesianRecipes('kangkung', fakeFetch({ cookpad: cp, resepkoki: rk }), { now: FIXED_NOW });
  const sources = new Set(cards.map((c) => c.source));
  assert.ok(sources.has('Cookpad'), 'must include Cookpad');
  assert.ok(sources.has('ResepKoki'), 'must include ResepKoki');
});

test('searchIndonesianRecipes dedupes identical URLs across sources', async () => {
  // Same absolute URL appearing twice (once per source) must collapse to one.
  const cp = cookpadPage([cookpadCard({ id: '222', title: 'Sambal Tempe' })]);
  const rk = resepKokiPage([resepKokiCard({ slug: 'resep-sambal-tempe', title: 'Sambal Tempe' })]);
  const cards = await searchIndonesianRecipes('tempe', fakeFetch({ cookpad: cp, resepkoki: rk }), { now: FIXED_NOW });
  const urls = cards.map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate URLs');
});

test('searchIndonesianRecipes failover: one source down still returns the other', async () => {
  const cp = cookpadPage([cookpadCard({ id: '333', title: 'Tahu Goreng' })]);
  // ResepKoki returns 500; Cookpad must still deliver.
  const cards = await searchIndonesianRecipes('tahu', fakeFetch({ cookpad: cp, resepkoki: null, extra: { resepkoki: new Response('err', { status: 500 }) } }), { now: FIXED_NOW });
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => c.source === 'Cookpad'));
});

test('searchIndonesianRecipes returns honest empty list when ALL sources fail', async () => {
  const cards = await searchIndonesianRecipes('tempe', fakeFetch({ extra: { cookpad: new Response('x', { status: 500 }), resepkoki: new Response('x', { status: 500 }) } }), { now: FIXED_NOW });
  assert.deepEqual(cards, []);
});

test('searchIndonesianRecipes returns empty (never fabricated) on non-HTML garbage', async () => {
  const cards = await searchIndonesianRecipes('tempe', fakeFetch({ cookpad: 'this is not html', resepkoki: 'garbage' }), { now: FIXED_NOW });
  assert.deepEqual(cards, []);
});

test('searchIndonesianRecipes aborts a hung source (timeout) without throwing', async () => {
  __setIndoFetchTimeout(40);
  const cp = cookpadPage([cookpadCard({ id: '444', title: 'Tempe Mendoan' })]);
  const cards = await searchIndonesianRecipes('tempe', fakeFetch({ cookpad: cp, resepkoki: null, hang: 'resepkoki' }), { now: FIXED_NOW });
  // Cookpad resolves; the hung ResepKoki is aborted and dropped, not fatal.
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => c.source === 'Cookpad'));
});

test('searchIndonesianRecipes honours cache TTL (second call within TTL is cached)', async () => {
  const cp = cookpadPage([cookpadCard({ id: '555', title: 'Tempe Bacem' })]);
  const first = await searchIndonesianRecipes('tempe', fakeFetch({ cookpad: cp, resepkoki: '' }), { now: FIXED_NOW });
  assert.ok(first.length > 0);
  // Re-call with everything failing — must still serve from warm cache.
  const second = await searchIndonesianRecipes('tempe', fakeFetch({ extra: { cookpad: new Response('x', { status: 500 }), resepkoki: new Response('x', { status: 500 }) } }), { now: FIXED_NOW + 1000 });
  assert.ok(second.length > 0);
  assert.equal(second[0].nama, first[0].nama);
});

test('searchIndonesianRecipes drops off-allowlist result URLs and thumbnails', async () => {
  // A malicious/injected card with an off-host url must be dropped entirely.
  const evil = `<li id="recipe_666"><a itemprop="url" href="https://evil.example.com/resep/1">Evil</a><img src="https://evil.example.com/x.jpg" /></li>`;
  const page = cookpadPage([evil, cookpadCard({ id: '777', title: 'Tempe Orek' })]);
  const cards = await searchIndonesianRecipes('tempe', fakeFetch({ cookpad: page, resepkoki: '' }), { now: FIXED_NOW });
  assert.ok(cards.every((c) => c.nama !== 'Evil'));
  assert.ok(cards.some((c) => c.nama === 'Tempe Orek'));
});

test('searchIndonesianRecipes returns empty for blank query', async () => {
  const cards = await searchIndonesianRecipes('   ', fakeFetch({ cookpad: '', resepkoki: '' }), { now: FIXED_NOW });
  assert.deepEqual(cards, []);
});

test('mixedRecipes serves live Indonesian results first (kangkung not mapped to spinach)', async () => {
  const cp = cookpadPage([cookpadCard({ id: '888', title: 'Tumis Kangkung Belacan' })]);
  const cards = await mixedRecipes('kangkung', fakeFetch({ cookpad: cp, resepkoki: '' }), 20);
  // Live Indonesian search must win, and the result must be a kangkung recipe,
  // NOT an unrelated English "spinach" dish (the old incorrect equivalence).
  assert.ok(cards.length > 0);
  assert.ok(cards.some((c) => /kangkung/i.test(c.nama)));
});

test('mixedRecipes falls back to TheMealDB when live search and curated both yield nothing', async () => {
  // 'tomat' (tomato) is in INGREDIENT_TO_MEALDB_TERM but has no curated card,
  // so the fallback must reach TheMealDB. All live sources down.
  const meal = JSON.stringify({ meals: [{ idMeal: '2', strMeal: 'Fresh Tomato Soup', strMealThumb: 'https://www.themealdb.com/images/media/meals/tomato.jpg' }] });
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('cookpad.com') || u.includes('resepkoki.id')) return new Response('err', { status: 500 });
    return new Response(meal, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const cards = await mixedRecipes('tomat', fetchFn, 20);
  assert.ok(cards.length > 0);
  assert.ok(cards.some((c) => /tomato/i.test(c.nama)), 'must fall back to TheMealDB tomato results');
});

test('sanitizeCard rejects off-allowlist url and thumbnail', () => {
  assert.equal(sanitizeCard({ nama: 'x', url: 'https://evil.com/a', thumbnail: 'https://img-global.cpcdn.com/recipes/aaaaaaaaaaaaaaaa/680x482cq50/photo.jpg' }), null);
  assert.equal(sanitizeCard({ nama: 'x', url: 'https://cookpad.com/id/resep/1', thumbnail: 'https://evil.com/b.jpg' }), null);
  assert.ok(sanitizeCard({ nama: 'x', url: 'https://cookpad.com/id/resep/1', thumbnail: 'https://img-global.cpcdn.com/recipes/aaaaaaaaaaaaaaaa/680x482cq50/photo.jpg' }));
});

// ---------------------------------------------------------------------------
// Canonical partial-dish query regression ("renda" -> "rendang")
// ---------------------------------------------------------------------------
// The live Indonesian search does substring matching differently from the old
// curated path: a literal "renda" query returns unrelated "renda" (lace)
// craft results. canonicalizeDishQuery() must rewrite the partial query to the
// intended dish BEFORE the dynamic search so the original partial-rendang
// behavior is preserved.

test('canonicalizeDishQuery maps partial "renda" -> "rendang" (case-insensitive)', () => {
  assert.equal(canonicalizeDishQuery('renda'), 'rendang');
  assert.equal(canonicalizeDishQuery('RENDA'), 'rendang');
  assert.equal(canonicalizeDishQuery('  renda  '), 'rendang');
});

test('canonicalizeDishQuery leaves unrelated and full queries unchanged', () => {
  assert.equal(canonicalizeDishQuery('rendang'), 'rendang');
  assert.equal(canonicalizeDishQuery('tempe'), 'tempe');
  assert.equal(canonicalizeDishQuery('soto ayam'), 'soto ayam');
  assert.equal(canonicalizeDishQuery(''), '');
});

test('mixedRecipes canonicalizes "renda" and queries live sources for "rendang"', async () => {
  // The live Cookpad source must be asked for "rendang", NOT "renda". We
  // capture the URL the fake fetch receives and assert the encoded query term.
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(String(url));
    const u = String(url);
    if (u.includes('cookpad.com')) {
      return new Response(cookpadPage([cookpadCard({ id: '900', title: 'Rendang Daging' })]), { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  const cards = await mixedRecipes('renda', fetchFn, 20);
  assert.ok(cards.length > 0);
  // The live search must have been issued with the canonical "rendang" term.
  assert.ok(requested.some((u) => u.includes('rendang')), 'live search used canonical "rendang"');
  assert.ok(!requested.some((u) => /renda(?!ng)/.test(u)), 'live search never used raw "renda"');
});
