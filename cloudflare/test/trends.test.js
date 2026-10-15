// Deterministic tests for the honest recent food-trend feed (src/trends.js).
// Run: `npm test` (node --test test/).
//
// All upstream calls are MOCKED — no real network. Tests inject a fake fetch
// (and a fixed `now`) so the 60-day window, cache TTL, timeout, and honest
// empty/unavailable states are exercised deterministically against labelled
// FIXTURES (in-memory RSS XML strings), never against live feeds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getRecentFoodTrends, handleTrends, resetTrendCache, __setFetchTimeout } from '../src/trends.js';

// ---------------------------------------------------------------------------
// Fixtures (clearly labelled, deterministic)
// ---------------------------------------------------------------------------

// A realistic detikFood RSS item, with the same field names/format the real
// feed uses (title/link/pubDate/description with an embedded <img src>).
// The pubDate is relative to FIXED_NOW so it is always within the 60-day
// window regardless of when the suite runs.
const FIXED_NOW = Date.parse('2026-10-14T18:00:00Z');

function detikItem({ title = 'Resep Terbaru', date = 'Mon, 12 Oct 2026 09:00:00 +0700', url = 'https://food.detik.com/resep/d-123/test', img = 'https://akcdn.detik.net.id/community/media/visual/2026/10/12/a.jpg?w=360&q=90' } = {}) {
  return (
    '<item>' +
    `<guid>${url}</guid>` +
    `<pubDate>${date}</pubDate>` +
    `<title>${title}</title>` +
    `<description> <img src="${img}"/> Deskripsi singkat. </description>` +
    `<link>${url}</link>` +
    '</item>'
  );
}

// Full feed document wrapping the given item strings.
function detikFeed(items) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">' +
    '<channel><title>Food - Detikcom</title><link>https://food.detik.com/</link>' +
    `<lastBuildDate>Thu, 15 Oct 2026 01:00:00 +0700</lastBuildDate>` +
    items.join('') +
    '</channel></rss>'
  );
}

// A fake fetch that returns a canned feed body for the detik URL. `hang: true`
// makes it respect the abort signal (so the real timeout path is exercised)
// by never resolving until aborted — it rejects with AbortError exactly as a
// real fetch does when its signal fires.
function fakeFetch({ status = 200, body = null, hang = false } = {}) {
  return async (url, opts = {}) => {
    if (hang) {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        if (signal) signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    return new Response(body, { status, headers: { 'Content-Type': 'application/xml' } });
  };
}

// A valid recent feed with three items (two in-window, one future to be dropped).
function recentFeed() {
  return detikFeed([
    detikItem({ title: 'Resep A', date: 'Mon, 12 Oct 2026 09:00:00 +0700', url: 'https://food.detik.com/resep/d-1/a' }),
    detikItem({ title: 'Resep B', date: 'Sun, 11 Oct 2026 09:00:00 +0700', url: 'https://food.detik.com/resep/d-2/b' }),
    detikItem({ title: 'Future post', date: 'Sun, 20 Dec 2026 09:00:00 +0700', url: 'https://food.detik.com/resep/d-3/c' }),
  ]);
}

// ---------------------------------------------------------------------------
// Setup: reset the module cache before each test so order never leaks state.
// ---------------------------------------------------------------------------
test.beforeEach(() => {
  resetTrendCache();
  __setFetchTimeout(4500); // restore production default
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('getRecentFoodTrends returns dated cards from a valid feed', async () => {
  const data = await getRecentFoodTrends(fakeFetch({ body: recentFeed() }), FIXED_NOW);
  assert.ok(Array.isArray(data.recipes));
  assert.equal(data.recipes.length, 2); // future-dated item dropped
  assert.equal(data.cached, false);
  for (const card of data.recipes) {
    assert.ok(card.nama, 'must have nama');
    assert.ok(card.url, 'must have url');
    assert.ok(card.thumbnail, 'must have thumbnail');
    assert.ok(card.source, 'must have source');
    assert.ok(card.published, 'must have published ISO date');
    assert.ok(!Number.isNaN(Date.parse(card.published)), 'published must parse');
  }
  // Newest-first ordering.
  assert.equal(data.recipes[0].nama, 'Resep A');
});

test('getRecentFoodTrends drops items older than the 60-day window', async () => {
  const feed = detikFeed([
    detikItem({ title: 'Fresh', date: 'Mon, 12 Oct 2026 09:00:00 +0700', url: 'https://food.detik.com/resep/d-1/a' }),
    detikItem({ title: 'Stale', date: 'Mon, 01 Jan 2026 09:00:00 +0700', url: 'https://food.detik.com/resep/d-2/b' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.equal(data.recipes.length, 1);
  assert.equal(data.recipes[0].nama, 'Fresh');
});

test('getRecentFoodTrends drops items without a parseable date', async () => {
  const feed = detikFeed([
    detikItem({ title: 'Dated', date: 'Mon, 12 Oct 2026 09:00:00 +0700', url: 'https://food.detik.com/resep/d-1/a' }),
    detikItem({ title: 'No date', date: '', url: 'https://food.detik.com/resep/d-2/b' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.equal(data.recipes.length, 1);
  assert.equal(data.recipes[0].nama, 'Dated');
});

test('getRecentFoodTrends drops items whose link host is not allowlisted', async () => {
  const feed = detikFeed([
    detikItem({ title: 'OK', url: 'https://food.detik.com/resep/d-1/a' }),
    detikItem({ title: 'Evil', url: 'https://evil.example.com/resep/d-2/b' }),
    detikItem({ title: 'Bad scheme', url: 'javascript:alert(1)' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.equal(data.recipes.length, 1);
  assert.equal(data.recipes[0].nama, 'OK');
});

test('getRecentFoodTrends drops non-https (http://) thumbnails', async () => {
  // An http:// thumbnail must be rejected even when its host is allowlisted,
  // so a mixed-content image can never reach the frontend.
  const feed = detikFeed([
    detikItem({ title: 'Insecure', img: 'http://akcdn.detik.net.id/community/media/visual/2026/10/12/a.jpg' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.equal(data.recipes.length, 1);
  assert.equal(data.recipes[0].thumbnail, ''); // thumbnail dropped, card kept
});

test('getRecentFoodTrends prefers the enclosure url attribute thumbnail', async () => {
  // The real detikFood feed carries its thumbnail in a self-closing
  // <enclosure url="..."/> attribute (not element text). The parser must read
  // that attribute, decode &amp;, and return it.
  const item =
    '<item><guid>https://food.detik.com/resep/d-1/a</guid>' +
    '<pubDate>Mon, 12 Oct 2026 09:00:00 +0700</pubDate>' +
    '<title>Enclosure</title>' +
    '<description>No img here.</description>' +
    '<enclosure length="25000" type="image/jpeg" url="https://akcdn.detik.net.id/community/media/visual/2026/10/12/e.jpg?w=360&amp;q=90"/>' +
    '<link>https://food.detik.com/resep/d-1/a</link></item>';
  const data = await getRecentFoodTrends(fakeFetch({ body: detikFeed([item]) }), FIXED_NOW);
  assert.equal(data.recipes.length, 1);
  assert.equal(data.recipes[0].thumbnail, 'https://akcdn.detik.net.id/community/media/visual/2026/10/12/e.jpg?w=360&q=90');
});

test('getRecentFoodTrends drops non-https (http://) link URLs', async () => {
  const feed = detikFeed([
    detikItem({ title: 'Insecure link', url: 'http://food.detik.com/resep/d-1/a' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.equal(data.recipes.length, 0);
});

test('getRecentFoodTrends returns honest empty state on upstream 500', async () => {
  const data = await getRecentFoodTrends(fakeFetch({ status: 500 }), FIXED_NOW);
  assert.ok(Array.isArray(data.recipes));
  assert.equal(data.recipes.length, 0);
  assert.equal(data.status, 'unavailable');
  assert.ok(data.error, 'must carry an honest error message');
});

test('getRecentFoodTrends returns empty (not fabricated) on non-XML garbage', async () => {
  const data = await getRecentFoodTrends(fakeFetch({ body: 'this is not xml at all' }), FIXED_NOW);
  assert.ok(Array.isArray(data.recipes));
  assert.equal(data.recipes.length, 0);
  assert.equal(data.status, 'unavailable');
});

test('getRecentFoodTrends honours cache TTL (second call within TTL is cached)', async () => {
  const first = await getRecentFoodTrends(fakeFetch({ body: recentFeed() }), FIXED_NOW);
  assert.equal(first.cached, false);
  assert.ok(first.recipes.length > 0);
  // Immediately re-call with a failing fetch — should serve from warm cache.
  const second = await getRecentFoodTrends(fakeFetch({ status: 500 }), FIXED_NOW + 1000);
  assert.equal(second.cached, true);
  assert.ok(second.recipes.length > 0);
});

test('getRecentFoodTrends aborts a hung upstream (timeout) and fails honestly', async () => {
  __setFetchTimeout(50); // shorten the real timeout so the test is fast
  const data = await getRecentFoodTrends(fakeFetch({ hang: true }), FIXED_NOW);
  assert.ok(Array.isArray(data.recipes));
  assert.equal(data.recipes.length, 0);
  assert.equal(data.status, 'unavailable');
});

test('getRecentFoodTrends filters out non-recipe (celebrity/wine/news) articles', async () => {
  // The detikFood RSS is a general culinary-news feed; the recent-recipe feed
  // must keep only recipe articles (/resep/ path or "resep" in title) and drop
  // celebrity, wine, handbag, and lifestyle pieces.
  const feed = detikFeed([
    detikItem({ title: 'Resep Rendang Sapi', url: 'https://food.detik.com/resep/d-1/rendang' }),
    detikItem({ title: 'Resep A', url: 'https://food.detik.com/resep/d-2/a' }),
    detikItem({ title: 'Artis Cantik Bawa Tas Mewah', url: 'https://food.detik.com/berita/d-3/seleb' }),
    detikItem({ title: 'Rekomendasi Wine Mahal', url: 'https://food.detik.com/minuman/d-4/wine' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.ok(data.recipes.length > 0, 'some recipes survive');
  // Every returned card must be a recipe article.
  for (const card of data.recipes) {
    assert.ok(
      /\/resep\//.test(card.url) || /\bresep\b/i.test(card.nama),
      `card "${card.nama}" (${card.url}) must be a recipe article`,
    );
  }
  // The celebrity/wine items must be gone.
  assert.ok(!data.recipes.some((c) => /tas mewah|wine/i.test(c.nama)), 'news items dropped');
});

test('getRecentFoodTrends accepts recipe articles whose title carries the resep marker', async () => {
  // Some recipe items may not be under a /resep/ path; the "resep" title marker
  // is a fallback signal and must keep them.
  const feed = detikFeed([
    detikItem({ title: 'Resep Masakan Rumahan', url: 'https://food.detik.com/food-info/d-1/a' }),
    detikItem({ title: 'Resep Seblak', url: 'https://food.detik.com/resep/d-2/b' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.equal(data.recipes.length, 2);
});

test('getRecentFoodTrends returns a truthful recipe heading', async () => {
  const data = await getRecentFoodTrends(fakeFetch({ body: recentFeed() }), FIXED_NOW);
  assert.equal(data.heading, 'Resep Terbaru', 'heading is the truthful recipe label');
});

test('handleTrends includes the truthful heading in its JSON response', async () => {
  const res = await handleTrends({}, {}, fakeFetch({ body: recentFeed() }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.heading, 'Resep Terbaru');
});

test('getRecentFoodTrends returns honest empty when feed has only non-recipe articles', async () => {
  // If every in-window item is non-recipe news, the recipe feed must be empty
  // (honest), not padded with irrelevant articles.
  const feed = detikFeed([
    detikItem({ title: 'Selebritas Kuliner', url: 'https://food.detik.com/berita/d-1/a' }),
    detikItem({ title: 'Tren Wine', url: 'https://food.detik.com/minuman/d-2/b' }),
  ]);
  const data = await getRecentFoodTrends(fakeFetch({ body: feed }), FIXED_NOW);
  assert.deepEqual(data.recipes, []);
  assert.equal(data.status, 'unavailable');
});

test('handleTrends returns 200 with recipes on success', async () => {
  const res = await handleTrends({}, {}, fakeFetch({ body: recentFeed() }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.recipes));
  assert.ok(body.recipes.length > 0);
  assert.equal(typeof body.cached, 'boolean');
});

test('handleTrends returns 503 with empty recipes on total upstream failure', async () => {
  const res = await handleTrends({}, {}, fakeFetch({ status: 500 }));
  const body = await res.json();
  assert.ok(Array.isArray(body.recipes));
  assert.equal(res.status, 503);
  assert.ok(body.error, '503 must carry an explicit error field');
});
