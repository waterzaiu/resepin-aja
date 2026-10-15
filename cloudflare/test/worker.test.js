// Node test suite for the Cloudflare Workers port.
// Run: `npm test` (node --test test/) or `node --test test/`.
//
// All upstream calls are MOCKED (no real network). The worker is exercised via
// the exported `fetch` handler with a simulated Request/Response, and the pure
// modules (discovery, ingredients, gemini, security, external) are unit-tested.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import {
  canonicalize,
  normalizeIngredients,
  deriveAllergens,
} from '../src/ingredients.js';
import {
  normalizeRecipe,
  matchRecipes,
  runDiscovery,
  searchDiscovery,
  getRecipeById,
} from '../src/discovery.js';
import { seedRecipeCatalog } from '../src/seed.js';
import {
  validateRecipe,
  parseRecipe,
  callProvider,
  callVisionWithFallback,
  ProviderError,
} from '../src/gemini.js';
import {
  verifyImageSignature,
  parseMultipart,
  MAX_FILES,
  MAX_BYTES_PER_FILE,
  MAX_TOTAL_BYTES,
} from '../src/security.js';
import {
  COOKPAD_RENDANG,
  rankCards,
  recommendedCards,
  lookupRecipeCards,
  mixedRecipes,
  makeTheMealDBProvider,
} from '../src/external.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEnv(overrides = {}) {
  return {
    GEMINI_API_KEY: 'test-gemini-key',
    GEMINI_MODEL: 'gemini-1.5-flash',
    ...overrides,
  };
}

async function callWorker(workerFetch, path, { method = 'GET', body, headers = {}, env = makeEnv(), fetchOverride = fakeFetch() } = {}) {
  const init = { method, headers };
  if (body) init.body = body;
  const request = new Request(`https://example.com${path}`, init);
  const ctx = { fetchOverride };
  return workerFetch(request, env, ctx);
}

// A fake fetch that routes TheMealDB-style URLs to canned JSON.
function fakeFetch(overrides = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (overrides[u]) return overrides[u];
    if (u.includes('themealdb.com/api/json/v1/1/search.php')) {
      return jsonResponse({
        meals: [{ idMeal: '52772', strMeal: 'Teriyaki Chicken', strMealThumb: 'https://www.themealdb.com/images/media/meals/xx.jpg' }],
      });
    }
    if (u.includes('themealdb.com/api/json/v1/1/filter.php')) {
      return jsonResponse({ meals: [{ idMeal: '52772', strMeal: 'Teriyaki Chicken', strMealThumb: 'https://www.themealdb.com/images/media/meals/xx.jpg' }] });
    }
    if (u.includes('themealdb.com/api/json/v1/1/lookup.php')) {
      const meal = {
        idMeal: '52772',
        strMeal: 'Teriyaki Chicken',
        strCategory: 'Chicken',
        strArea: 'Japanese',
        strMealThumb: 'https://www.themealdb.com/images/media/meals/xx.jpg',
        strIngredient1: 'chicken', strMeasure1: '200g',
        strIngredient2: 'soy sauce', strMeasure2: '3 tbs',
        strIngredient3: 'sugar', strMeasure3: '1 tbs',
        strIngredient4: '', strMeasure4: '',
      };
      for (let i = 5; i <= 20; i++) { meal[`strIngredient${i}`] = ''; meal[`strMeasure${i}`] = ''; }
      return jsonResponse({ meals: [meal] });
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          namaMasakan: 'Tumis Kangkung',
          deskripsi: 'Tumis kangkung sederhana.',
          waktuMasak: 15,
          porsi: 2,
          bahanTerdeteksi: ['kangkung', 'bawang putih'],
          bahanKurang: ['minyak goreng', 'garam'],
          langkah: ['Panaskan minyak', 'Tumis bawang', 'Masukkan kangkung'],
          menuAlternatif: ['Fried Rice'],
        }) }] } }],
      });
    }
    if (u.includes('api.openai.com')) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        namaMasakan: 'Sup Ayam', deskripsi: 'x', waktuMasak: 20, porsi: 2,
        bahanTerdeteksi: ['ayam'], bahanKurang: ['garam'], langkah: ['Rebus ayam'],
        menuAlternatif: [],
      }) } }] });
    }
    if (u.includes('api.anthropic.com')) {
      return jsonResponse({ content: [{ text: JSON.stringify({
        namaMasakan: 'Sayur Asem', deskripsi: 'x', waktuMasak: 25, porsi: 3,
        bahanTerdeteksi: ['kangkung'], bahanKurang: ['garam'], langkah: ['Rebus'],
        menuAlternatif: [],
      }) }] });
    }
    return new Response('Not Found', { status: 404 });
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Wrap detikFood item XML chunks into a full RSS document (mirrors the real
// https://food.detik.com/rss channel wrapper).
function detikRss(items) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">' +
    '<channel><title>Food - Detikcom</title><link>https://food.detik.com/</link>' +
    `<lastBuildDate>Thu, 15 Oct 2026 01:00:00 +0700</lastBuildDate>` +
    items.join('') +
    '</channel></rss>'
  );
}

// ---------------------------------------------------------------------------
// ingredients
// ---------------------------------------------------------------------------
test('canonicalize maps id and en aliases', () => {
  assert.equal(canonicalize('telur'), 'egg');
  assert.equal(canonicalize('Telur'), 'egg');
  assert.equal(canonicalize('egg'), 'egg');
  assert.equal(canonicalize('daging sapi'), 'beef');
  assert.equal(canonicalize('bawang putih'), 'garlic');
});

test('normalizeIngredients dedupes and drops unknown filler', () => {
  const out = normalizeIngredients(['telur', 'Telur', 'egg', '  ', 'garam']);
  assert.deepEqual(out, ['egg', 'salt']);
});

test('deriveAllergens is deterministic and fail-closed', () => {
  assert.deepEqual(deriveAllergens(['egg', 'cheese', 'shrimp']), ['egg', 'milk', 'shellfish']);
  assert.deepEqual(deriveAllergens(['coconut milk']), []);
  assert.deepEqual(deriveAllergens(['peanut butter']), ['peanut']);
  assert.deepEqual(deriveAllergens(['sesuatu yang asing']), []);
});

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------
test('seed catalog is non-empty and normalizes', () => {
  const catalog = seedRecipeCatalog();
  assert.ok(catalog.length >= 5);
  const n = normalizeRecipe(catalog[0]);
  assert.ok(n.title);
  assert.ok(Array.isArray(n.ingredients));
});

test('matchRecipes returns scored matches with required fields', () => {
  const catalog = seedRecipeCatalog();
  // Realistic pantry that matches "Nasi Goreng Sisa Kulkas" (rice, egg, garlic,
  // shallot, sweet soy sauce).
  const ing = ['nasi', 'telur', 'bawang putih', 'bawang merah', 'kecap manis', 'minyak goreng'];
  const matches = matchRecipes(catalog, ing, {});
  assert.ok(matches.length > 0);
  const top = matches[0];
  assert.ok(top.matchScore >= 0 && top.matchScore <= 1);
  assert.ok(Array.isArray(top.matchedIngredients));
  assert.ok(Array.isArray(top.missingIngredients));
  assert.ok(Array.isArray(top.unusedIngredients));
  assert.ok(typeof top.matchExplanation === 'string');
});

test('runDiscovery returns deterministic recipes without AI', async () => {
  const res = await runDiscovery(['nasi', 'telur', 'bawang putih', 'bawang merah', 'kecap manis'], {});
  assert.equal(res.source, 'deterministic');
  assert.ok(res.recipes.length > 0);
  assert.ok(res.sources.seed_catalog_used);
  assert.deepEqual(res.detected_ingredients, normalizeIngredients(['nasi', 'telur', 'bawang putih', 'bawang merah', 'kecap manis']));
});

test('searchDiscovery and getRecipeById', () => {
  const results = searchDiscovery('rendang');
  assert.ok(Array.isArray(results));
  const catalog = seedRecipeCatalog();
  const id = catalog[0].id || catalog[0].external_id;
  const got = getRecipeById(id);
  assert.ok(got.recipe);
  assert.equal(got.error, undefined);
  assert.equal(getRecipeById('does-not-exist').error, 'Recipe tidak ditemukan.');
});

// ---------------------------------------------------------------------------
// gemini
// ---------------------------------------------------------------------------
test('parseRecipe handles code fence and plain JSON', () => {
  const plain = '{"namaMasakan":"X","deskripsi":"","waktuMasak":10,"porsi":1,"bahanTerdeteksi":["a"],"bahanKurang":[],"langkah":["l"],"menuAlternatif":[]}';
  assert.deepEqual(parseRecipe('```json\n' + plain + '\n```'), JSON.parse(plain));
  assert.throws(() => parseRecipe('not json'), ProviderError);
});

test('validateRecipe rejects malformed output', () => {
  const good = { namaMasakan: 'X', deskripsi: 'd', waktuMasak: 10, porsi: 1, bahanTerdeteksi: ['a'], bahanKurang: [], langkah: ['l'], menuAlternatif: [] };
  assert.ok(validateRecipe(good));
  assert.equal(validateRecipe({ ...good, namaMasakan: '' }), null);
  assert.equal(validateRecipe({ ...good, waktuMasak: 'x' }), null);
  assert.equal(validateRecipe({ ...good, langkah: [123] }), null);
});

test('callProvider parses a mocked Gemini response', async () => {
  const dataUrls = ['data:image/jpeg;base64,/9j/2Q=='];
  const recipe = await callProvider('gemini', dataUrls, 'gemini-1.5-flash', 'key', fakeFetch());
  assert.equal(recipe.namaMasakan, 'Tumis Kangkung');
});

test('callVisionWithFallback fails over across providers', async () => {
  // Gemini returns 500 -> should fall to openai which succeeds.
  const fetchFn = async (url) => {
    if (String(url).includes('generativelanguage')) return new Response('err', { status: 500 });
    return fakeFetch()(url);
  };
  const chain = [
    { name: 'gemini', apiKey: 'g', model: 'gemini-1.5-flash' },
    { name: 'openai', apiKey: 'o', model: 'gpt-4o-mini' },
  ];
  const res = await callVisionWithFallback(['data:image/jpeg;base64,/9j/2Q=='], chain, fetchFn, true);
  assert.equal(res.provider, 'openai');
  assert.equal(res.recipe.namaMasakan, 'Sup Ayam');
});

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------
test('verifyImageSignature validates magic bytes', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(verifyImageSignature(jpeg, 'image/jpeg'), null);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(verifyImageSignature(png, 'image/png'), null);
  assert.ok(verifyImageSignature(jpeg, 'image/png')); // wrong declared type
  assert.ok(verifyImageSignature(new Uint8Array([1, 2, 3]), 'image/jpeg'));
});

test('parseMultipart extracts image parts and fields', () => {
  const boundary = 'XYZ';
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const enc = new TextEncoder();
  const header = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const fieldHeader = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="allowFallback"\r\n\r\ntrue\r\n`);
  const end = enc.encode(`--${boundary}--\r\n`);
  const body = concatBytes([header, jpegBytes, enc.encode('\r\n'), fieldHeader, end]);
  const { images, allowFallback } = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(images.length, 1);
  assert.equal(images[0].mime, 'image/jpeg');
  assert.deepEqual([...images[0].data], [...jpegBytes]);
  assert.equal(allowFallback, true);
});

function concatBytes(arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ---------------------------------------------------------------------------
// external
// ---------------------------------------------------------------------------
test('rankCards ranks by keyword overlap', () => {
  const cards = [{ nama: 'Nasi Goreng Telur', url: 'https://cookpad.com/id/resep/1', thumbnail: 'https://img-global.cpcdn.com/recipes/1/x.jpg', source: 'Cookpad' }];
  const ranked = rankCards(cards, ['telur']);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].recommended, true);
});

test('recommendedCards triggers on indomie+rendang', () => {
  const cards = recommendedCards(['indomie', 'rendang']);
  assert.equal(cards.length, COOKPAD_RENDANG.length);
  assert.equal(cards[0].recommended, true);
});

test('lookupRecipeCards returns sanitized TheMealDB cards', async () => {
  const cards = await lookupRecipeCards(['Teriyaki'], ['ayam'], fakeFetch());
  assert.ok(cards.length > 0);
  assert.equal(cards[0].source, 'TheMealDB');
});

test('mixedRecipes is official-API only and sanitized', async () => {
  const cards = await mixedRecipes('teriyaki', fakeFetch());
  assert.ok(Array.isArray(cards));
  if (cards.length) {
    assert.equal(cards[0].source, 'TheMealDB');
  }
});

test('TheMealDB provider builds metadata-only recipes', async () => {
  const provider = makeTheMealDBProvider(fakeFetch());
  const recipes = await provider.search(['chicken', 'soy sauce'], {});
  assert.ok(recipes.length > 0);
  const r = recipes[0];
  assert.equal(r.title, 'Teriyaki Chicken');
  assert.ok(Array.isArray(r.ingredients));
  assert.ok(r.ingredients.length >= 3);
  assert.equal(r.verified, false);
});

// ---------------------------------------------------------------------------
// HTTP integration (mocked upstream)
// ---------------------------------------------------------------------------
test('GET /health reports active providers', async () => {
  const res = await callWorker(worker.fetch, '/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.active_providers.includes('gemini'));
});

test('GET /health 503 when no keys configured', async () => {
  const res = await callWorker(worker.fetch, '/health', { env: makeEnv({ GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }) });
  assert.equal(res.status, 503);
});

test('GET /api/viral returns dated recent-trend cards', async () => {
  // The /api/viral route now proxies handleTrends() -> getRecentFoodTrends(),
  // which fetches the real detikFood RSS. Mock that upstream with a dated,
  // dated feed so the assertion checks the NEW honest contract: cards carry
  // nama/url/thumbnail/source/published, NOT a fabricated `recommended` flag.
  const detik = new Response(detikRss([
    '<item><guid>https://food.detik.com/resep/d-1/a</guid>' +
      '<pubDate>Mon, 12 Oct 2026 09:00:00 +0700</pubDate>' +
      '<title>Resep Terbaru A</title>' +
      '<description> <img src="https://akcdn.detik.net.id/community/media/visual/2026/10/12/a.jpg?w=360&amp;q=90"/> Deskripsi. </description>' +
      '<link>https://food.detik.com/resep/d-1/a</link></item>',
  ]), { status: 200, headers: { 'Content-Type': 'application/xml' } });
  const res = await callWorker(worker.fetch, '/api/viral', { fetchOverride: async () => detik });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.recipes));
  assert.ok(body.recipes.length > 0);
  const card = body.recipes[0];
  assert.ok(card.nama, 'card must have nama');
  assert.ok(card.url, 'card must have url');
  assert.ok(card.thumbnail, 'card must have https thumbnail');
  assert.ok(/^https:\/\//.test(card.thumbnail), 'thumbnail must be https');
  assert.ok(card.source, 'card must have source');
  assert.ok(card.published, 'card must have published ISO date');
  assert.ok(!Number.isNaN(Date.parse(card.published)), 'published must parse');
});

test('GET /api/recipes/search returns seed results', async () => {
  const res = await callWorker(worker.fetch, '/api/recipes/search?q=rendang');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.recipes));
});

test('GET /api/recipes/<id> returns a recipe', async () => {
  const catalog = seedRecipeCatalog();
  const id = catalog[0].id || catalog[0].external_id;
  const res = await callWorker(worker.fetch, `/api/recipes/${id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.recipe);
});

test('POST /api/recipes/match returns deterministic recipes', async () => {
  const res = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['nasi', 'telur', 'bawang putih', 'bawang merah', 'kecap manis'], preferences: {} }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'deterministic');
  assert.ok(body.recipes.length > 0);
});

test('POST /api/recipes/match rejects empty ingredients', async () => {
  const res = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: [] }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/ingredients/normalize normalizes', async () => {
  const res = await callWorker(worker.fetch, '/api/ingredients/normalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['telur', 'bawang putih'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.normalized, ['egg', 'garlic']);
});

test('POST /api/scan-resep returns a validated recipe (mocked Gemini)', async () => {
  const boundary = 'TESTBOUNDARY';
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x00]);
  const enc = new TextEncoder();
  const parts = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpegBytes,
    enc.encode('\r\n'),
    enc.encode(`--${boundary}--\r\n`),
  ];
  const body = concatBytes(parts);
  const res = await callWorker(worker.fetch, '/api/scan-resep', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.recipe.namaMasakan, 'Tumis Kangkung');
  assert.equal(out.provider, 'gemini');
  assert.ok(Array.isArray(out.recipe.menuAlternatif));
});

test('POST /api/scan-resep rejects a non-image payload', async () => {
  const boundary = 'TESTBOUNDARY';
  const enc = new TextEncoder();
  const bad = new Uint8Array([1, 2, 3, 4]);
  const body = concatBytes([
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    bad,
    enc.encode('\r\n'),
    enc.encode(`--${boundary}--\r\n`),
  ]);
  const res = await callWorker(worker.fetch, '/api/scan-resep', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(res.status, 400);
});

test('POST /api/scan-resep rejects too many files', async () => {
  const boundary = 'B';
  const enc = new TextEncoder();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const chunks = [];
  for (let i = 0; i < MAX_FILES + 1; i++) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="f${i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
    chunks.push(jpeg);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = concatBytes(chunks);
  const res = await callWorker(worker.fetch, '/api/scan-resep', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(res.status, 400);
});

test('POST /api/scan-resep 503 when no AI key configured', async () => {
  const boundary = 'B';
  const enc = new TextEncoder();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const body = concatBytes([
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg,
    enc.encode('\r\n'),
    enc.encode(`--${boundary}--\r\n`),
  ]);
  const res = await callWorker(worker.fetch, '/api/scan-resep', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    env: makeEnv({ GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }),
  });
  assert.equal(res.status, 503);
});

test('security headers are present on API responses', async () => {
  const res = await callWorker(worker.fetch, '/api/viral');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
});

test('unknown route returns 404', async () => {
  const res = await callWorker(worker.fetch, '/nope');
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Live frontend endpoint integration (resep-in-aja.html calls these directly)
// ---------------------------------------------------------------------------
// The frontend's loadGallery()/search form hit /api/inspirasi and /api/resep,
// NOT the legacy /api/recipes/search covered above. These are the real gallery
// endpoints and must stay contract-compatible with recipeTiles().

test('GET /api/resep returns sanitized gallery cards (frontend search)', async () => {
  const res = await callWorker(worker.fetch, '/api/resep?q=teriyaki');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.recipes));
  // recipeTiles() requires nama/thumbnail/url on every card, else the card is
  // silently dropped from the gallery.
  for (const card of body.recipes) {
    assert.ok(card.nama, 'card must have nama');
    assert.ok(card.thumbnail, 'card must have thumbnail');
    assert.ok(card.url, 'card must have url');
  }
});

test('GET /api/resep returns 400 for empty or overlong q', async () => {
  assert.equal((await callWorker(worker.fetch, '/api/resep?q=')).status, 400);
  assert.equal((await callWorker(worker.fetch, '/api/resep?q=' + 'x'.repeat(81))).status, 400);
});

test('GET /api/inspirasi returns gallery cards (frontend loadGallery)', async () => {
  const res = await callWorker(worker.fetch, '/api/inspirasi');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.recipes));
  for (const card of body.recipes) {
    assert.ok(card.nama);
    assert.ok(card.thumbnail);
    assert.ok(card.url);
  }
});

test('POST /api/recipes/match response carries fallback + detected_ingredients', async () => {
  const res = await callWorker(worker.fetch, '/api/recipes/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredients: ['nasi', 'telur', 'bawang putih', 'bawang merah', 'kecap manis'], preferences: {} }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // renderDiscoveryResults() reads .source and .fallback (not .ai_results).
  assert.equal(body.source, 'deterministic');
  assert.equal(typeof body.fallback, 'boolean');
  assert.ok(Array.isArray(body.detected_ingredients));
  // Each recipe tile reads title/matchedIngredients/missingIngredients.
  assert.ok(body.recipes.length > 0);
  assert.ok(body.recipes[0].title);
  assert.ok(Array.isArray(body.recipes[0].matchedIngredients));
  assert.ok(Array.isArray(body.recipes[0].missingIngredients));
});

test('GET /api/resep sanitizes non-allowlisted card hosts', async () => {
  // A hostile upstream returning an off-allowlist URL must be dropped by
  // sanitizeCard (mixedRecipes) rather than surfaced to the frontend.
  const hostile = async () => jsonResponse({
    meals: [{ idMeal: '999', strMeal: 'Evil', strMealThumb: 'https://evil.example.com/x.jpg' }],
  });
  // search.php returns the meal; lookupRecipeCards builds url from themealdb
  // (allowlisted) but the thumbnail host is NOT allowlisted -> card dropped.
  const cards = await mixedRecipes('evil', hostile);
  assert.deepEqual(cards, []);
});
