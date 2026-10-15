// Backend regression test for inspiration search: Indonesian ingredient /
// multi-ingredient queries ("tempe", "kangkung", "tempe ayam kangkung") must
// return genuine, relevant recipe cards — not an empty response — matching the
// same contract that makes "rendang" (single-dish query) work.
//
// Two layers are covered:
//   1) curatedIndonesianSearch — OR-matches multi-word queries so each
//      ingredient surfaces its own dishes (was AND, which returned nothing).
//   2) TheMealDB dynamic fallback — mixedRecipes maps Indonesian ingredient
//      words (tempe/ayam/kangkung) to English filter terms and queries the
//      official key-free API with a bounded timeout, degrading safely on
//      timeout/network failure (never throws, never invents data).
//
// All upstream calls are MOCKED — no real network.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INDONESIAN_CURATED,
  curatedIndonesianSearch,
  mixedRecipes,
  lookupRecipeCards,
  sanitizeCard,
  __setMealDBFetchTimeout,
} from '../src/external.js';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Records every TheMealDB URL requested so tests can assert the correct
// English filter term was derived from Indonesian input.
function recordingFetch(log) {
  return async (url) => {
    const u = String(url);
    log.push(u);
    // Ingredient filter returns real TheMealDB cards; name search returns null
    // (English-only, so the Indonesian name never matches) — emulating the
    // real API so the ingredient path is the only one that can yield results.
    if (u.includes('/filter.php')) {
      const m = u.match(/[?&]i=([^&]+)/);
      const term = decodeURIComponent(m ? m[1] : '');
      const meals = {
        spinach: [{ idMeal: '53000', strMeal: 'Spinach Stir Fry', strMealThumb: 'https://www.themealdb.com/images/media/meals/spinach.jpg' }],
        tempeh: [{ idMeal: '53250', strMeal: 'Vegan banh mi', strMealThumb: 'https://www.themealdb.com/images/media/meals/tempeh.jpg' }],
        chicken: [{ idMeal: '52940', strMeal: 'Brown Stew Chicken', strMealThumb: 'https://www.themealdb.com/images/media/meals/chicken.jpg' }],
      }[term] || null;
      return jsonResponse({ meals });
    }
    if (u.includes('/search.php')) return jsonResponse({ meals: null });
    return new Response('Not Found', { status: 404 });
  };
}

// A fetch that hangs until aborted — exercises the real timeout path.
function hangingFetch() {
  return async (url, opts = {}) => new Promise((resolve, reject) => {
    const signal = opts && opts.signal;
    if (!signal) return reject(new Error('no signal'));
    signal.addEventListener('abort', () => reject(new Error('AbortError')));
  });
}

test('curatedIndonesianSearch OR-matches a multi-ingredient query (tempe ayam kangkung)', () => {
  const cards = curatedIndonesianSearch('tempe ayam kangkung');
  assert.ok(cards.length > 0, 'multi-ingredient query returns cards');
  const names = cards.map((c) => c.nama.toLowerCase()).join(' ');
  // Each ingredient must be represented by at least one dish.
  assert.match(names, /tempe/, 'surfaces a tempe dish');
  assert.match(names, /kangkung/, 'surfaces a kangkung dish');
  assert.match(names, /ayam/, 'surfaces an ayam dish');
});

test('mixedRecipes returns relevant cards for "tempe" (curated, no network)', async () => {
  const log = [];
  const cards = await mixedRecipes('tempe', recordingFetch(log));
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => /tempe/i.test(c.nama)));
  assert.ok(cards.every((c) => c.nama && c.thumbnail && c.url && c.source === 'Cookpad'));
});

test('mixedRecipes returns relevant cards for "kangkung" (curated, no network)', async () => {
  const log = [];
  const cards = await mixedRecipes('kangkung', recordingFetch(log));
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => /kangkung/i.test(c.nama)));
});

test('lookupRecipeCards does NOT map kangkung to spinach (kangkung = water spinach)', async () => {
  const log = [];
  const cards = await lookupRecipeCards([], ['kangkung'], recordingFetch(log));
  // kangkung (water spinach) is a different plant from common spinach; the old
  // kangkung -> spinach equivalence returned unrelated spinach dishes. With the
  // fix, TheMealDB has no water-spinach term, so kangkung yields no TheMealDB
  // filter query — it is served by the live Indonesian sources instead.
  assert.ok(!log.some((u) => u.includes('filter.php?i=spinach')), 'must NOT query spinach for kangkung');
  assert.deepEqual(cards, [], 'no TheMealDB cards for kangkung (handled by live Indonesian search)');
});

test('lookupRecipeCards maps bayam -> spinach (bayam is common spinach)', async () => {
  const log = [];
  const cards = await lookupRecipeCards([], ['bayam'], recordingFetch(log));
  assert.ok(log.some((u) => u.includes('filter.php?i=spinach')), 'queries spinach for bayam');
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => c.source === 'TheMealDB'));
  assert.ok(cards.every((c) => /^https:\/\/www\.themealdb\.com\/meal\//.test(c.url)));
});

test('lookupRecipeCards maps tempe -> tempeh and ayam -> chicken', async () => {
  const log = [];
  const cards = await lookupRecipeCards([], ['tempe'], recordingFetch(log));
  assert.ok(log.some((u) => u.includes('filter.php?i=tempeh')));
  assert.ok(cards.length > 0);

  log.length = 0;
  const cards2 = await lookupRecipeCards([], ['ayam'], recordingFetch(log));
  assert.ok(log.some((u) => u.includes('filter.php?i=chicken')));
  assert.ok(cards2.length > 0);
});

test('lookupRecipeCards degrades to [] on upstream timeout (bounded, no throw)', async () => {
  __setMealDBFetchTimeout(50);
  const cards = await lookupRecipeCards([], ['tempe'], hangingFetch());
  assert.deepEqual(cards, []);
  __setMealDBFetchTimeout(4500); // restore
});

test('lookupRecipeCards degrades to [] on network/JSON failure (no throw)', async () => {
  const failingFetch = async () => { throw new Error('network down'); };
  assert.deepEqual(await lookupRecipeCards([], ['tempe'], failingFetch), []);

  const badJson = async () => new Response('<html>not json</html>', { status: 200 });
  assert.deepEqual(await lookupRecipeCards([], ['tempe'], badJson), []);
});

test('every curated card still passes allowlist sanitization', () => {
  for (const card of INDONESIAN_CURATED) {
    assert.match(card.url, /^https:\/\/cookpad\.com\/id\/resep\/\d+$/, `${card.nama} url`);
    assert.match(card.thumbnail, /^https:\/\/img-global\.cpcdn\.com\//, `${card.nama} thumbnail`);
    assert.equal(card.source, 'Cookpad', `${card.nama} source`);
    const s = sanitizeCard(card);
    assert.deepEqual(s, card, `${card.nama} survives sanitization`);
  }
});
