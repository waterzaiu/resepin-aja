import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { matchRecipes, runDiscovery } from '../src/discovery.js';

for (const path of ['/api/recipes/match', '/api/ingredients/normalize']) {
  test(`${path} rejects null JSON without upstream calls`, async () => {
    const res = await worker.fetch(new Request('https://example.com' + path, { method: 'POST', body: 'null' }), {}, { fetchOverride: () => { throw Error('unexpected network'); } });
    assert.equal(res.status, 400);
  });
}
test('match rejects malformed preference shapes', async () => {
  for (const preferences of [[], 12, { cuisines: 12 }, { excludeAllergens: 'egg' }, { maxTimeMinutes: -1 }, { diet: {} }]) {
    const res = await worker.fetch(new Request('https://example.com/api/recipes/match', { method: 'POST', body: JSON.stringify({ ingredients: ['egg'], preferences }) }), { ENABLE_EXTERNAL_RECIPES: 'false' }, {});
    assert.equal(res.status, 400, JSON.stringify(preferences));
  }
});
const recipe = { title: 'Egg dish', ingredients: [{ canonical: 'egg' }], diet_tags: [], allergen_tags: [], verified: true };
test('diet excludes nonmatching and unknown metadata', () => {
  assert.deepEqual(matchRecipes([recipe], ['egg'], { diet: ['vegan'] }), []);
});
test('time limit excludes unknown duration', () => {
  assert.deepEqual(matchRecipes([recipe], ['egg'], { maxTimeMinutes: 1 }), []);
});
test('allergen exclusions derive from ingredients even if tags are missing', () => {
  assert.deepEqual(matchRecipes([recipe], ['egg'], { excludeAllergens: ['egg'] }), []);
});
test('filtered no-match never falls back to unfiltered cards', async () => {
  let calls = 0;
  const result = await runDiscovery(['egg'], { cuisine: 'Nonexistent' }, null, async () => { calls++; return []; });
  assert.equal(calls, 0);
  assert.deepEqual(result.ai_results, []);
});
test('manual fallback warning never claims AI generated external cards', async () => {
  const result = await runDiscovery(['unknown-ingredient'], {}, null, async () => []);
  assert.doesNotMatch(result.fallback_warning, /hanya dari AI/i);
});
test('external opt-out prevents fallback lookup', async () => {
  let calls = 0;
  const res = await worker.fetch(new Request('https://example.com/api/recipes/match', { method: 'POST', body: JSON.stringify({ ingredients: ['unknown-ingredient'] }) }), { ENABLE_EXTERNAL_RECIPES: 'false' }, { fetchOverride: async () => { calls++; return Response.json({ meals: [] }); } });
  assert.equal(res.status, 200);
  assert.equal(calls, 0);
});
