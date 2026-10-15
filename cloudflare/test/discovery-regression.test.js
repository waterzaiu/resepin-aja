// Regression tests for the deterministic discovery layer (cloudflare/src/discovery.js).
//
// Covers two things that were historically conflated and caused a real
// "tempe ayam kangkung" failure:
//
//   1. Discovery NORMALIZATION — the ingredient canonicalization the matcher
//      and search path apply (tempe->tempeh, ayam->chicken, kangkung->water
//      spinach). This was CORRECT, but it was never pinned, so the failure got
//      misattributed to normalization instead of catalog coverage.
//
//   2. Search-path normalization — searchDiscovery() used to match ONLY
//      title/cuisine/country/description text, so a valid ingredient query
//      (e.g. "telur"/egg or "tahu"/tofu) returned [] even when the seed
//      catalog contained recipes USING that ingredient. It now normalizes the
//      query through the ingredient catalog, the same way matchRecipes does.
//
// Deliberately NOT tested here: whether "tempe"/"ayam"/"kangkung" return
// recipes. That is a seed-catalog (seed.js) coverage question — the 11 seed
// recipes use chicken/tempeh/water-spinach in ZERO of them — and it is out of
// scope for this file. We assert the *relevant* behavior (recipes that DO use
// a queried ingredient surface correctly) rather than a raw count, and we
// assert that a genuinely absent ingredient returns [] (no false positives).

import test from 'node:test';
import assert from 'node:assert/strict';

import { searchDiscovery, matchRecipes, normalizePreferences } from '../src/discovery.js';
import { normalizeIngredients } from '../src/ingredients.js';
import { seedRecipeCatalog } from '../src/seed.js';

// ---------------------------------------------------------------------------
// 1. Normalization parity (the "discovery normalization" the task flags)
// ---------------------------------------------------------------------------

test('discovery normalization maps tempe/ayam/kangkung to canonical English', () => {
  assert.deepEqual(
    normalizeIngredients(['tempe', 'ayam', 'kangkung']),
    ['tempeh', 'chicken', 'water spinach'],
  );
});

test('discovery normalization is idempotent for already-canonical English terms', () => {
  assert.deepEqual(
    normalizeIngredients(['chicken', 'egg', 'tofu']),
    ['chicken', 'egg', 'tofu'],
  );
});

// ---------------------------------------------------------------------------
// 2. searchDiscovery: ingredient relevance, not just text
// ---------------------------------------------------------------------------

test('searchDiscovery surfaces recipes by ingredient relevance ("telur" -> egg)', () => {
  const results = searchDiscovery('telur');
  assert.ok(results.length > 0, 'Indonesian "telur" must surface egg recipes');
  // Relevance, not merely count: every returned recipe must actually use egg.
  for (const r of results) {
    const canonicals = r.ingredients.map((i) => i.canonical.toLowerCase());
    assert.ok(canonicals.includes('egg'), `"${r.title}" must use egg`);
  }
});

test('searchDiscovery surfaces recipes by ingredient relevance ("tahu" -> tofu)', () => {
  const results = searchDiscovery('tahu');
  assert.ok(results.length > 0, 'Indonesian "tahu" must surface tofu recipes');
  for (const r of results) {
    const canonicals = r.ingredients.map((i) => i.canonical.toLowerCase());
    assert.ok(canonicals.includes('tofu'), `"${r.title}" must use tofu`);
  }
});

test('searchDiscovery normalizes multi-word ingredient queries ("bawang merah" -> shallot)', () => {
  const results = searchDiscovery('bawang merah');
  assert.ok(results.length > 0, '"bawang merah" must surface shallot recipes');
  for (const r of results) {
    const canonicals = r.ingredients.map((i) => i.canonical.toLowerCase());
    assert.ok(canonicals.includes('shallot'), `"${r.title}" must use shallot`);
  }
});

test('searchDiscovery accepts English canonical ingredient queries ("egg")', () => {
  const results = searchDiscovery('egg');
  assert.ok(results.length > 0);
  for (const r of results) {
    const canonicals = r.ingredients.map((i) => i.canonical.toLowerCase());
    assert.ok(canonicals.includes('egg'), `"${r.title}" must use egg`);
  }
});

// ---------------------------------------------------------------------------
// 3. No false positives / contract preservation
// ---------------------------------------------------------------------------

test('searchDiscovery returns [] for an ingredient genuinely absent from the seed catalog', () => {
  // An ingredient with no canonical seed recipe must return [] (no false
  // positives). "buncis" -> green beans, which no seed recipe uses.
  assert.deepEqual(searchDiscovery('buncis'), []);
});

test('searchDiscovery surfaces the union of a space-separated ingredient list', () => {
  // "tempe ayam kangkung" must surface recipes using ANY of tempeh / chicken /
  // water spinach (union), ranked — not require all three in one title.
  const results = searchDiscovery('tempe ayam kangkung');
  const titles = results.map((r) => r.title);
  assert.ok(titles.includes('Sambal Goreng Tempe'), 'tempe -> Sambal Goreng Tempe');
  assert.ok(titles.includes('Ayam Goreng Bumbu Kuning'), 'ayam -> Ayam Goreng Bumbu Kuning');
  assert.ok(titles.includes('Tumis Kangkung Bawang Putih'), 'kangkung -> Tumis Kangkung');
});

test('searchDiscovery keeps multi-word ingredients whole (no over-match)', () => {
  // "bawang merah" -> shallot; it must NOT surface recipes that use only
  // "onion" (the per-word split of "bawang").
  const results = searchDiscovery('bawang merah');
  assert.ok(results.length > 0);
  assert.ok(!results.some((r) => r.title === 'Nasi Lemak'), 'Nasi Lemak uses onion, not shallot');
});

test('searchDiscovery preserves empty/whitespace/null -> full catalog', () => {
  assert.ok(searchDiscovery(null).length > 0);
  assert.ok(searchDiscovery('').length > 0);
  assert.ok(searchDiscovery('   ').length > 0);
});

test('searchDiscovery returns [] for gibberish (no false positives)', () => {
  assert.deepEqual(searchDiscovery('zzzznotfound'), []);
});

// ---------------------------------------------------------------------------
// 4. matchRecipes still honours normalization end-to-end (deterministic path)
// ---------------------------------------------------------------------------

test('matchRecipes matches a seed recipe when the ingredient overlaps (normalized)', () => {
  const catalog = seedRecipeCatalog();
  // Miso Soup uses tofu; a raw Indonesian "tahu" must match via normalization.
  const matches = matchRecipes(catalog, ['tahu'], {}, 0.0); // 0.0 to see the raw score
  const miso = matches.find((r) => r.title === 'Miso Soup');
  assert.ok(miso, 'Miso Soup should match "tahu" (tofu) before threshold filtering');
  assert.ok(miso.matchedIngredients.includes('tofu'), 'matched ingredient is canonical "tofu"');
});

test('matchRecipes returns the union for a multi-ingredient query (tempe ayam kangkung)', () => {
  const catalog = seedRecipeCatalog();
  // Each detected ingredient (tempeh / chicken / water spinach) surfaces its
  // own dish; relevance is ranked by overlap, not gated on matching all three.
  const matches = matchRecipes(catalog, ['tempe', 'ayam', 'kangkung'], {});
  const titles = matches.map((r) => r.title);
  assert.ok(matches.length >= 3, `expected >=3 union matches, got ${matches.length}`);
  assert.ok(titles.includes('Sambal Goreng Tempe'), 'tempe dish present');
  assert.ok(titles.includes('Ayam Goreng Bumbu Kuning'), 'chicken dish present');
  assert.ok(titles.includes('Tumis Kangkung Bawang Putih'), 'water-spinach dish present');
  // Every returned recipe must actually use one of the detected ingredients.
  const detected = new Set(['tempeh', 'chicken', 'water spinach']);
  for (const r of matches) {
    assert.ok(
      r.matchedIngredients.some((m) => detected.has(m)),
      `"${r.title}" must overlap at least one detected ingredient`,
    );
  }
});

test('normalizePreferences maps singular filter fields to array forms', () => {
  const p = normalizePreferences({ cuisine: 'italian', diet: 'vegetarian', maxTimeMinutes: 30 });
  assert.deepEqual(p.cuisines, ['italian']);
  assert.deepEqual(p.diet, ['vegetarian']);
  assert.equal(p.maxTimeMinutes, 30);
});
