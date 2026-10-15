// Focused regression tests for external recipe alias-matching and official
// API failure degradation. Exercises makeTheMealDBProvider directly (mocked
// fetch, no network). These cover the flaw where raw Indonesian ingredients
// (e.g. "telur"/"ayam") were treated as already-normalized canonicals and
// silently produced zero external results.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTheMealDBProvider } from '../src/external.js';
import { normalizeIngredients } from '../src/ingredients.js';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Records every filter term the provider requests, so we can assert the
// provider actually normalizes Indonesian -> English before querying.
function recordingFetch(log) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/filter.php')) {
      const m = u.match(/[?&]i=([^&]+)/);
      log.push(decodeURIComponent(m ? m[1] : ''));
      return jsonResponse({ meals: [{ idMeal: '52772', strMeal: 'X', strMealThumb: '' }] });
    }
    if (u.includes('/lookup.php')) {
      const meal = {
        idMeal: '52772', strMeal: 'Teriyaki Chicken', strCategory: 'Chicken',
        strArea: 'Japanese', strMealThumb: '',
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

test('provider normalizes Indonesian ingredients to canonical English terms', async () => {
  const log = [];
  const provider = makeTheMealDBProvider(recordingFetch(log));
  const recipes = await provider.search(['telur', 'ayam', 'bawang putih', 'santan'], {});

  // These are the actual TheMealDB filter terms the provider must request.
  assert.deepEqual(log, ['egg', 'chicken', 'garlic', 'coconut milk']);
  assert.ok(recipes.length > 0, 'Indonesian input must yield external recipes');
});

test('provider keeps English canonical input working (existing behavior)', async () => {
  const log = [];
  const provider = makeTheMealDBProvider(recordingFetch(log));
  const recipes = await provider.search(['chicken', 'soy sauce'], {});
  assert.deepEqual(log, ['chicken', 'soy sauce']);
  assert.ok(recipes.length > 0);
});

test('provider normalizes the full alias surface used by MEALDB terms', async () => {
  // Every Indonesian alias whose canonical appears in MEALDB_TERMS must reach
  // the API after normalization. Pick a representative multilingual set.
  const cases = [
    ['telur', 'egg'],
    ['mie', 'noodles'],
    ['udang', 'shrimp'],
    ['daging sapi', 'beef'],
    ['tomat', 'tomato'],
    ['jamur', 'mushroom'],
    ['wortel', 'carrot'],
    ['bayam', 'spinach'],
    ['tahu', 'tofu'],
    ['kacang', 'beans'],
    ['pisang', 'banana'],
    ['keju', 'cheese'],
    ['roti', 'bread'],
    ['bawang merah', 'shallot'],
    ['kelapa', 'coconut'],
    ['jagung', 'corn'],
    ['terong', 'eggplant'],
    ['brokoli', 'broccoli'],
    ['kol', 'cabbage'],
    ['mentega', 'butter'],
    ['daun bawang', 'scallion'],
    ['jeruk nipis', 'lime'],
    ['cuka', 'vinegar'],
    ['kecap', 'soy sauce'],
    ['gula', 'sugar'],
    ['garam', 'salt'],
    ['minyak', 'oil'],
    ['tepung', 'flour'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeIngredients([raw])[0], expected, `normalize(${raw})`);
  }
});

test('provider degrades gracefully on official API failure (no throw, empty result)', async () => {
  const failingFetch = async (url) => {
    const u = String(url);
    if (u.includes('/filter.php')) {
      if (u.includes('egg')) throw new Error('network down');
      if (u.includes('chicken')) return new Response('err', { status: 500 });
      if (u.includes('beef')) return new Response('<html>not json</html>', { status: 200 });
      return jsonResponse({ meals: null }); // official API returns meals:null when empty
    }
    if (u.includes('/lookup.php')) throw new Error('lookup down');
    return new Response('Not Found', { status: 404 });
  };

  const provider = makeTheMealDBProvider(failingFetch);
  const recipes = await provider.search(['egg', 'chicken', 'beef', 'garlic'], {});
  assert.deepEqual(recipes, []);
});

test('provider degrades when filter succeeds but lookup fails', async () => {
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('/filter.php')) {
      return jsonResponse({ meals: [{ idMeal: '52772', strMeal: 'X', strMealThumb: '' }] });
    }
    if (u.includes('/lookup.php')) throw new Error('lookup down');
    return new Response('Not Found', { status: 404 });
  };
  const recipes = await makeTheMealDBProvider(fetchFn).search(['egg'], {});
  assert.deepEqual(recipes, []);
});

test('provider returns metadata-only recipes (no prose/images)', async () => {
  const provider = makeTheMealDBProvider(recordingFetch([]));
  const recipes = await provider.search(['ayam', 'kecap'], {});
  assert.ok(recipes.length > 0);
  const r = recipes[0];
  assert.equal(r.title, 'Teriyaki Chicken');
  assert.equal(r.verified, false);
  assert.deepEqual(r.instructions, []);
  assert.equal(r.image_url, '');
  assert.ok(r.source_url.startsWith('https://www.themealdb.com/meal/'));
});
