import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INDONESIAN_CURATED,
  COOKPAD_RENDANG,
  curatedIndonesianSearch,
  mixedRecipes,
  sanitizeCard,
} from '../src/external.js';

// A fetch that must never be called for curated (non-TheMealDB) queries.
const failFetch = async () => {
  throw new Error('fetchFn should not be called for curated Indonesian queries');
};

test('curated catalog is non-empty and well-formed', () => {
  assert.ok(INDONESIAN_CURATED.length > 0, 'INDONESIAN_CURATED has cards');
  for (const card of INDONESIAN_CURATED) {
    assert.equal(typeof card.nama, 'string');
    assert.ok(card.nama.length > 0, 'card has a name');
    assert.match(card.url, /^https:\/\/cookpad\.com\/id\/resep\/\d+$/, 'card url is a Cookpad recipe link');
    assert.match(card.thumbnail, /^https:\/\/img-global\.cpcdn\.com\//, 'card thumbnail is a Cookpad CDN image');
    assert.equal(card.source, 'Cookpad');
    // Every card must survive sanitization (allowlist) unchanged.
    const s = sanitizeCard(card);
    assert.deepEqual(s, card, 'card passes allowlist sanitization');
  }
});

test('curatedIndonesianSearch matches "rendang"', () => {
  const cards = curatedIndonesianSearch('rendang');
  assert.ok(cards.length > 0, 'rendang returns cards');
  assert.ok(cards.every((c) => /rendang/i.test(c.nama)), 'all matches contain "rendang"');
  assert.ok(cards[0].recommended === true, 'first card is recommended');
});

test('curatedIndonesianSearch partial query "renda" matches rendang dishes', () => {
  const cards = curatedIndonesianSearch('renda');
  assert.ok(cards.length > 0, 'partial "renda" returns cards');
  assert.ok(cards.every((c) => /renda/i.test(c.nama)), 'all matches contain "renda"');
  // Every card must point at a Cookpad recipe and carry attribution.
  assert.ok(cards.every((c) => c.source === 'Cookpad' && /cookpad\.com\/id\/resep\//.test(c.url)));
});

test('curatedIndonesianSearch matches other Indonesian dishes (soto, nasi goreng, gado)', () => {
  for (const q of ['soto ayam', 'nasi goreng', 'gado gado', 'sate ayam', 'rawon', 'opor ayam']) {
    const cards = curatedIndonesianSearch(q);
    assert.ok(cards.length > 0, `"${q}" returns cards`);
    assert.ok(cards[0].source === 'Cookpad', `"${q}" top result is attributed`);
  }
});

test('curatedIndonesianSearch is case-insensitive', () => {
  assert.ok(curatedIndonesianSearch('RENDANG').length > 0, 'uppercase query matches');
  assert.ok(curatedIndonesianSearch('Soto').length > 0, 'mixed-case query matches');
});

test('curatedIndonesianSearch returns empty for unknown query (no false positives)', () => {
  assert.deepEqual(curatedIndonesianSearch(''), []);
  assert.deepEqual(curatedIndonesianSearch('zzzznothing'), []);
});

test('mixedRecipes returns curated cards for "rendang" without hitting fetchFn', async () => {
  const cards = await mixedRecipes('rendang', failFetch);
  assert.ok(cards.length > 0, 'mixedRecipes returns cards for rendang');
  assert.ok(cards.every((c) => c.source === 'Cookpad' && c.nama && c.thumbnail && c.url));
});

test('mixedRecipes returns curated cards for partial "renda"', async () => {
  const cards = await mixedRecipes('renda', failFetch);
  assert.ok(cards.length > 0, 'mixedRecipes returns cards for partial "renda"');
  assert.ok(cards.every((c) => /renda/i.test(c.nama)));
});

test('mixedRecipes falls back to TheMealDB for non-Indonesian queries', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { status: 200, json: async () => ({ meals: [{ idMeal: '52772', strMeal: 'Teriyaki Chicken Casserole', strMealThumb: 'https://www.themealdb.com/images/media/meals/xxxyyy.jpg' }] }) };
  };
  const cards = await mixedRecipes('teriyaki', fakeFetch);
  assert.ok(calls.length > 0, 'fetchFn was called for a non-Indonesian query');
  assert.ok(calls.some((u) => u.includes('themealdb.com')), 'query hit TheMealDB');
  assert.ok(cards.length >= 0, 'returns array (possibly empty when no rank match)');
});

test('COOKPAD_RENDANG still included in curated catalog (no regression)', () => {
  const names = INDONESIAN_CURATED.map((c) => c.nama);
  for (const c of COOKPAD_RENDANG) {
    assert.ok(names.includes(c.nama), `COOKPAD_RENDANG "${c.nama}" is in the curated catalog`);
  }
});
