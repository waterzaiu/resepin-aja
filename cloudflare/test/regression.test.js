// Regression suite for Workers API surface — manual ingredient entry,
// gallery/search normalization, and scan mock. Owns cloudflare/test only.
//
// These tests lock the FRONTEND CONTRACT (resep-in-aja.html) and pin the
// current normalization behavior for malformed inputs, so a refactor that
// silently changes what the frontend receives is caught here.
//
// Run: `npm test` (node --test test/).

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { canonicalize, normalizeIngredients } from '../src/ingredients.js';
import {
  normalizeIngredientKeyword,
  ingredientQuery,
  rankCards,
  scoreCard,
  recommendedCards,
  sanitizeCard,
  mixedRecipes,
  lookupRecipeCards,
  COOKPAD_RENDANG,
} from '../src/external.js';
import { searchDiscovery, getRecipeById } from '../src/discovery.js';
import { parseMultipart, verifyImageSignature } from '../src/security.js';
import { seedRecipeCatalog } from '../src/seed.js';

// ---------------------------------------------------------------------------
// Helpers (mirror worker.test.js conventions)
// ---------------------------------------------------------------------------
function makeEnv(overrides = {}) {
  return {
    GEMINI_API_KEY: 'test-gemini-key',
    GEMINI_MODEL: 'gemini-1.5-flash',
    ...overrides,
  };
}

async function callWorker(workerFetch, path, { method = 'GET', body, headers = {}, env = makeEnv(), fetchOverride } = {}) {
  const init = { method, headers };
  if (body) init.body = body;
  const request = new Request(`https://example.com${path}`, init);
  const ctx = { fetchOverride: fetchOverride || fakeFetch() };
  return workerFetch(request, env, ctx);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(overrides = {}) {
  return async (url) => {
    const u = String(url);
    if (overrides[u]) return overrides[u];
    if (u.includes('themealdb.com/api/json/v1/1/search.php')) {
      return jsonResponse({ meals: [{ idMeal: '52772', strMeal: 'Teriyaki Chicken', strMealThumb: 'https://www.themealdb.com/images/media/meals/xx.jpg' }] });
    }
    if (u.includes('themealdb.com/api/json/v1/1/filter.php')) {
      return jsonResponse({ meals: [{ idMeal: '52772', strMeal: 'Teriyaki Chicken', strMealThumb: 'https://www.themealdb.com/images/media/meals/xx.jpg' }] });
    }
    if (u.includes('themealdb.com/api/json/v1/1/lookup.php')) {
      const meal = {
        idMeal: '52772', strMeal: 'Teriyaki Chicken', strCategory: 'Chicken', strArea: 'Japanese',
        strMealThumb: 'https://www.themealdb.com/images/media/meals/xx.jpg',
        strIngredient1: 'chicken', strMeasure1: '200g',
        strIngredient2: 'soy sauce', strMeasure2: '3 tbs',
        strIngredient3: 'sugar', strMeasure3: '1 tbs',
      };
      for (let i = 4; i <= 20; i++) { meal[`strIngredient${i}`] = ''; meal[`strMeasure${i}`] = ''; }
      return jsonResponse({ meals: [meal] });
    }
    return new Response('Not Found', { status: 404 });
  };
}

function concatBytes(arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ===========================================================================
// 1. Manual ingredient entry — POST /api/ingredients/normalize
// ===========================================================================
// Frontend sends a comma-split array of free-text strings; the worker must
// return a stable `{ normalized, mapping }` response. These tests pin the
// contract and expose the dedup-misalignment + non-string bugs below.

test('normalize returns correct canonical mapping for unique inputs', async () => {
  const res = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['telur', 'bawang putih', 'kecap manis'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.normalized, ['egg', 'garlic', 'sweet soy sauce']);
  assert.deepEqual(body.mapping, [
    { input: 'telur', canonical: 'egg' },
    { input: 'bawang putih', canonical: 'garlic' },
    { input: 'kecap manis', canonical: 'sweet soy sauce' },
  ]);
});

test('normalize returns deduped `normalized` list (correct)', async () => {
  const res = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['  ', 'garam', 'ayam', 'bawang putih'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // The deduped canonical list is CORRECT (filler dropped, order preserved).
  assert.deepEqual(body.normalized, ['salt', 'chicken', 'garlic']);
});

// FIXED: the `mapping` array now computes each input's canonical via
// `canonicalize(input)` (index.js), so entries are correctly attributed even
// when normalizeIngredients drops OR dedupes entries. This test now asserts
// the per-input truth (previously it pinned the buggy index-aligned output).
test('normalize mapping is per-input correct after drop/dedup', async () => {
  const res = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['telur', 'Telur', 'egg', 'bawang putih'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // `normalized` is correct (deduped): only egg + garlic survive.
  assert.deepEqual(body.normalized, ['egg', 'garlic']);
  // `mapping` is now per-input correct:
  //   telur       -> egg    (correct)
  //   Telur       -> egg    (correct, was misattributed to garlic)
  //   egg         -> egg    (correct, was null)
  //   bawang putih -> garlic (correct, was null)
  assert.deepEqual(body.mapping, [
    { input: 'telur', canonical: 'egg' },
    { input: 'Telur', canonical: 'egg' },
    { input: 'egg', canonical: 'egg' },
    { input: 'bawang putih', canonical: 'garlic' },
  ]);
});

// FIXED (was BUG): /api/ingredients/normalize now rejects non-string entries
// (400) for parity with /api/recipes/match. Previously numbers/objects flowed
// into canonicalize() and produced garbage canonicals ("123", "object").
test('normalize rejects non-string entries with 400 (parity with /match)', async () => {
  const res = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['telur', 123, null, {}] }),
  });
  assert.equal(res.status, 400);
});

test('normalize rejects missing/empty ingredients array with 400', async () => {
  const noField = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(noField.status, 400);
  const notArray = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ingredients: 'telur' }),
  });
  assert.equal(notArray.status, 400);
});

test('normalize rejects empty body and invalid JSON', async () => {
  const empty = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '',
  });
  assert.equal(empty.status, 400);
  const bad = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
  });
  assert.equal(bad.status, 400);
});

// ===========================================================================
// 2. Manual ingredient entry — POST /api/recipes/match
// ===========================================================================
test('match validates ingredients are all strings (rejects non-string)', async () => {
  const res = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['telur', 123] }),
  });
  assert.equal(res.status, 400);
});

test('match enforces 50-ingredient cap (boundary inclusive)', async () => {
  const over = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: Array(51).fill('telur') }),
  });
  assert.equal(over.status, 400);

  const atCap = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: Array(50).fill('telur') }),
  });
  assert.equal(atCap.status, 200);
  const body = await atCap.json();
  assert.equal(body.detected_ingredients.length, 1); // dedup -> single 'egg'
});

test('match returns ai_fallback shape with no deterministic matches', async () => {
  // A single exotic ingredient matches nothing in the seed catalog.
  const res = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['durian'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'ai_fallback');
  assert.equal(body.fallback, true);
  assert.ok(Array.isArray(body.recipes));
  assert.ok(Array.isArray(body.detected_ingredients));
});

test('match rejects a JSON array body (not an object)', async () => {
  const res = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([1, 2, 3]),
  });
  assert.equal(res.status, 400);
});

// ===========================================================================
// 3. Gallery / search normalization of malformed inputs
// ===========================================================================
test('GET /api/resep 400s on missing, whitespace-only, and >80-char q', async () => {
  assert.equal((await callWorker(worker.fetch, '/api/resep')).status, 400);
  assert.equal((await callWorker(worker.fetch, '/api/resep?q=')).status, 400);
  assert.equal((await callWorker(worker.fetch, '/api/resep?q=%20%20%20')).status, 400);
  assert.equal((await callWorker(worker.fetch, '/api/resep?q=' + 'x'.repeat(81))).status, 400);
});

test('GET /api/resep accepts exactly 80-char q (boundary)', async () => {
  const res = await callWorker(worker.fetch, '/api/resep?q=' + 'x'.repeat(80));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.recipes));
});

test('searchDiscovery normalizes empty/null/whitespace query to full catalog', () => {
  // Frontend relies on /api/resep for gallery search, but /api/recipes/search
  // must not throw on malformed q.
  assert.ok(searchDiscovery(null).length > 0);
  assert.ok(searchDiscovery('').length > 0);
  assert.ok(searchDiscovery('   ').length > 0);
});

test('GET /api/recipes/search returns [] for a query matching nothing', async () => {
  const res = await callWorker(worker.fetch, '/api/recipes/search?q=zzzznotfound');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.recipes, []);
});

test('GET /api/recipes/<id> 404s on empty and whitespace id', async () => {
  assert.equal((await callWorker(worker.fetch, '/api/recipes/')).status, 404);
  assert.equal((await callWorker(worker.fetch, '/api/recipes/%20%20')).status, 404);
});

test('getRecipeById trims and matches by id or external_id', () => {
  const catalog = seedRecipeCatalog();
  const first = catalog[0];
  assert.ok(getRecipeById(first.id).recipe);
  assert.ok(getRecipeById(first.external_id).recipe);
  assert.ok(getRecipeById('  ' + first.id + '  ').recipe); // trims
});

// ===========================================================================
// 4. external.js normalization helpers — malformed inputs
// ===========================================================================
test('ingredientQuery and normalizeIngredientKeyword tolerate null/non-array', () => {
  assert.equal(ingredientQuery(null), '');
  assert.equal(ingredientQuery('telur ayam'), ''); // not an array -> no words
  assert.deepEqual(normalizeIngredientKeyword('  '), []);
  assert.deepEqual(normalizeIngredientKeyword('telur!!  ayam'), ['egg', 'chicken']);
});

test('rankCards drops empty/unknown keywords and dedupes', () => {
  const card = { nama: 'Nasi Goreng Telur', url: 'https://cookpad.com/id/resep/1', thumbnail: 'https://img-global.cpcdn.com/recipes/1/x.jpg', source: 'Cookpad' };
  assert.deepEqual(rankCards([], ['telur']), []);
  assert.deepEqual(rankCards(null, ['telur']), []);
  const ranked = rankCards([card], ['telur', 'telur', '  ']);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].recommended, true);
});

test('scoreCard returns zero for empty keywords', () => {
  assert.deepEqual(scoreCard({ nama: 'X' }, []), { score: 0, reason: null });
});

test('recommendedCards triggers only on indomie/mie + rendang', () => {
  assert.equal(recommendedCards(['indomie', 'rendang']).length, COOKPAD_RENDANG.length);
  assert.equal(recommendedCards(['mie', 'rendang']).length, COOKPAD_RENDANG.length);
  assert.deepEqual(recommendedCards(['rendang']), []);
  assert.deepEqual(recommendedCards(['indomie']), []);
});

test('sanitizeCard drops non-allowlisted url/thumbnail hosts and nulls', () => {
  assert.equal(sanitizeCard(null), null);
  assert.equal(sanitizeCard({ nama: 'x', url: 'not-a-url', thumbnail: 'https://img-global.cpcdn.com/1.jpg' }), null);
  assert.equal(sanitizeCard({ nama: 'x', url: 'https://cookpad.com/id/1', thumbnail: '' }), null);
  assert.ok(sanitizeCard({ nama: 'x', url: 'https://cookpad.com/id/1', thumbnail: 'https://img-global.cpcdn.com/1.jpg' }));
});

test('mixedRecipes returns [] for empty/whitespace query without fetching', async () => {
  let called = false;
  const spy = async () => { called = true; return jsonResponse({ meals: [] }); };
  assert.deepEqual(await mixedRecipes('', spy), []);
  assert.deepEqual(await mixedRecipes('   ', spy), []);
  assert.equal(called, false);
});

// ===========================================================================
// 5. Scan mock — multipart + signature edge cases
// ===========================================================================
test('POST /api/scan-resep 400s on non-multipart content type', async () => {
  const res = await callWorker(worker.fetch, '/api/scan-resep', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 400);
});

test('POST /api/scan-resep 400s on missing boundary / no image parts', async () => {
  const enc = new TextEncoder();
  const noImage = await callWorker(worker.fetch, '/api/scan-resep', {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
    body: enc.encode('--B\r\nContent-Disposition: form-data; name="allowFallback"\r\n\r\ntrue\r\n--B--\r\n'),
  });
  assert.equal(noImage.status, 400);
});

test('parseMultipart returns empty images when boundary absent', () => {
  const out = parseMultipart(new Uint8Array([1, 2, 3]), 'text/plain');
  assert.deepEqual(out.images, []);
  assert.equal(out.allowFallback, null);
});

test('verifyImageSignature returns null on valid magic bytes, error object on failure', () => {
  // Contract: returns null on success, {message, status:400} on failure.
  // Valid JPEG (FF D8 FF) -> null.
  assert.equal(verifyImageSignature(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'), null);
  // Valid PNG (89 50 4E 47 0D 0A 1A 0A) -> null.
  assert.equal(verifyImageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'), null);
  // Empty bytes -> error object.
  assert.ok(verifyImageSignature(new Uint8Array([]), 'image/jpeg'));
  // Truncated JPEG (only 2 magic bytes, needs 3) -> error object.
  assert.ok(verifyImageSignature(new Uint8Array([0xff, 0xd8]), 'image/jpeg'));
  // JPEG magic claimed as webp (mime/bytes mismatch) -> error object.
  assert.ok(verifyImageSignature(new Uint8Array([0xff, 0xd8, 0xff]), 'image/webp'));
  // Unsupported mime -> error object.
  assert.ok(verifyImageSignature(new Uint8Array([0xff, 0xd8, 0xff]), 'image/bmp'));
});

// ===========================================================================
// 6. Frontend gallery contract (recipeTiles fields) under malformed upstream
// ===========================================================================
test('gallery cards always carry nama/thumbnail/url (recipeTiles contract)', async () => {
  // /api/viral now returns dated detikFood trend cards via handleTrends(); its
  // cards always carry nama/url but thumbnail MAY be empty (safe fallback).
  // /api/inspirasi and /api/resep still require nama+thumbnail+url. Mock the
  // detik RSS upstream so /api/viral resolves to a real dated card here.
  const detikFeed = new Response(
    '<?xml version="1.0"?><rss version="2.0"><channel><title>Food</title><link>https://food.detik.com/</link>' +
    '<item><guid>https://food.detik.com/resep/d-1/a</guid>' +
    '<pubDate>Mon, 12 Oct 2026 09:00:00 +0700</pubDate>' +
    '<title>Resep Terbaru</title>' +
    '<description><![CDATA[ <img src="https://akcdn.detik.net.id/community/media/visual/2026/10/12/a.jpg?w=360&amp;q=90"/> Deskripsi. ]]></description>' +
    '<link>https://food.detik.com/resep/d-1/a</link></item>' +
    '</channel></rss>',
    { status: 200, headers: { 'Content-Type': 'application/xml' } },
  );
  const res = await callWorker(worker.fetch, '/api/viral', { fetchOverride: async () => detikFeed });
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const card of body.recipes) {
    assert.ok(card.nama, 'card needs nama');
    assert.ok(card.url, 'card needs url');
    // thumbnail is OPTIONAL for the recent feed (safe fallback when missing),
    // but when present it must be https.
    if (card.thumbnail) assert.ok(/^https:\/\//.test(card.thumbnail), 'thumbnail must be https');
  }
});

test('lookupRecipeCards degrades gracefully when upstream 404s', async () => {
  const cards = await lookupRecipeCards(['Unknown Dish'], [], async () => new Response('{}', { status: 404 }));
  assert.deepEqual(cards, []);
});
