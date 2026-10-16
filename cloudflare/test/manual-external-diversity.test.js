import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiscovery } from '../src/discovery.js';
import { makeTheMealDBProvider, resetIndoCache } from '../src/external.js';

// Metadata fixture mirrors the existing ResepKoki parser's article structure;
// no live network is used in regression tests.
const articleUrl = 'https://resepkoki.id/resep-soto-ayam/';
const html = `<article><h3><a href="${articleUrl}">Resep Soto Ayam</a></h3><img data-src="https://i0.wp.com/resepkoki.id/wp-content/uploads/2016/04/Soto-ayam.jpg"></article>`;
function provider() {
  resetIndoCache();
  return makeTheMealDBProvider(async (url) => {
    if (url.startsWith('https://resepkoki.id/')) return new Response(html);
    if (url.startsWith('https://cookpad.com/')) return new Response('', { status: 503 });
    return Response.json({ meals: [] });
  });
}

test('manual matching includes attributed gallery references even with deterministic matches', async () => {
  const result = await runDiscovery(['ayam'], {}, provider());
  assert.ok(result.recipes.length > 0);
  assert.ok(result.external_results?.length > 0, 'gallery references must not be gated on zero matches');
  const card = result.external_results.find((c) => c.source_name === 'ResepKoki');
  assert.equal(card.source_url, articleUrl);
  assert.equal(card.title, 'Resep Soto Ayam');
  assert.equal(card.matchScore, undefined);
  assert.equal(card.matchedIngredients, undefined);
  assert.equal(card.verified, false);
  assert.equal(card.match_type, 'external_reference');
  assert.match(card.attribution_text, /ResepKoki/);
  assert.doesNotMatch(card.attribution_text, /TheMealDB/);
  assert.match(card.matchExplanation, /belum.*diverifikasi/i);
  assert.equal(result.ai_generated, false);
  assert.match(result.external_warning, /belum diverifikasi/);
});

for (const prefs of [
  { diet: ['vegan'] }, { excludeAllergens: ['soy'] },
  { maxTimeMinutes: 20 }, { cuisine: 'indonesian' }, { language: 'id' },
]) {
  test(`metadata-only references fail closed for ${JSON.stringify(prefs)}`, async () => {
    let calls = 0;
    const result = await runDiscovery(['ayam'], prefs, {
      search: async () => [],
      references: async () => { calls++; throw new Error('must not be called'); },
    });
    assert.equal(calls, 0);
    assert.deepEqual(result.external_results, []);
    assert.equal(result.external_warning, null);
  });
}

test('supplemental failure preserves deterministic results and external opt-out', async () => {
  const baseline = await runDiscovery(['ayam'], {}, null);
  const failed = await runDiscovery(['ayam'], {}, {
    search: async () => [],
    references: async () => { throw new Error('upstream unavailable'); },
  });
  assert.deepEqual(failed.recipes, baseline.recipes);
  assert.deepEqual(failed.external_results, []);
  assert.deepEqual(baseline.external_results, []);
});

test('manual multi-ingredient references dedupe URLs and reject unrelated titles', async () => {
  const result = await runDiscovery(['ayam', 'tempe'], {}, provider());
  assert.equal(result.external_results.length, 1);
  assert.equal(result.external_results[0].source_url, articleUrl);
  const unrelated = await runDiscovery(['kangkung'], {}, provider());
  assert.deepEqual(unrelated.external_results, []);
});
