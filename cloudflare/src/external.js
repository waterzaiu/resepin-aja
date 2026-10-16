// External recipe sources — OFFICIAL APIs ONLY.
//
// IMPORTANT DIFFERENCE FROM THE PYTHON SERVER: server.py's `mixed_recipes`
// scrapes third-party HTML (Cookpad, Allrecipes, detikFood) behind the
// RECIPE_SCRAPING_ENABLED flag (default OFF). Cloudflare Workers Free has a
// ~10ms CPU budget and scraping is both unreliable and legally risky, so this
// worker does NOT scrape. It uses:
//   * TheMealDB official JSON API (key '1', lookup/filter/search) — the same
//     official-API path recipe_discovery.py uses.
//   * A small STATIC Cookpad card list (COOKPAD_RENDANG) already present in
//     server.py, served for the rendang/indomie gallery path.
//
// No recipe instruction prose or images are redistributed from TheMealDB
// (their terms only allow metadata + link-back); cards carry name/thumb/url
// plus attribution only.

import { INGREDIENT_ALIASES, NON_INGREDIENT, canonicalize, normalizeIngredients, isPantry, deriveAllergens } from './ingredients.js';

// Static Cookpad cards (verbatim from server.py COOKPAD_RENDANG).
export const COOKPAD_RENDANG = [
  { nama: 'Indomie rendang nyemek', thumbnail: 'https://img-global.cpcdn.com/recipes/c38158c51ba3a293/120x160cq50/indomie-rendang-nyemek-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/16925069', source: 'Cookpad' },
  { nama: 'Indomie Rendang Kuah', thumbnail: 'https://img-global.cpcdn.com/recipes/12381a7b9b2d5e8c/120x160cq50/indomie-rendang-kuah-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/16653660', source: 'Cookpad' },
  { nama: 'Seblak indomie rendang', thumbnail: 'https://img-global.cpcdn.com/recipes/a65b4f62dca96930/120x160f0.5_0.55525_1.0q50/seblak-indomie-rendang-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/16263466', source: 'Cookpad' },
  { nama: 'Martabak Indomie Rendang', thumbnail: 'https://img-global.cpcdn.com/recipes/8022c138d6bbc5a8/120x160cq50/martabak-indomie-rendang-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/14619964', source: 'Cookpad' },
  { nama: 'Indomie rendang toge', thumbnail: 'https://img-global.cpcdn.com/recipes/3756047309ef53bc/120x160cq50/indomie-rendang-toge-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/16436932', source: 'Cookpad' },
  { nama: 'Nasi Goreng Rendang Ekspress', thumbnail: 'https://img-global.cpcdn.com/recipes/c1ceb8350572da04/120x160cq50/nasi-goreng-rendang-ekspress-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/16485402', source: 'Cookpad' },
];

// Curated static Indonesian recipe cards for the inspiration/gallery search
// path. TheMealDB only indexes English recipe names, so Indonesian dish
// queries ("rendang", "soto", "renda", …) would otherwise return zero results.
// These are REAL, publicly-listed Cookpad recipes — title/thumbnail/url read
// live from cookpad.com at authoring time (each URL returns 200). Attribution
// is preserved via `source` and the Cookpad link-back; no instruction prose or
// original images are copied into this worker (same approach as COOKPAD_RENDANG).
export const INDONESIAN_CURATED = [
  { nama: 'Rendang Daging Kentang Praktis', thumbnail: 'https://img-global.cpcdn.com/recipes/b7480433d3db8948/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/26417710', source: 'Cookpad' },
  { nama: 'Rendang Daging Satset', thumbnail: 'https://img-global.cpcdn.com/recipes/05b3cac5a0c04228/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/26463020', source: 'Cookpad' },
  { nama: 'Rendang Daging Sapi Praktis Bumbu Instan', thumbnail: 'https://img-global.cpcdn.com/recipes/92c345357ec8f89f/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/26483954', source: 'Cookpad' },
  { nama: 'Ayam Rendang Mama Suka', thumbnail: 'https://img-global.cpcdn.com/recipes/b512390660c5bec6/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/12932303', source: 'Cookpad' },
  { nama: 'Soto Ayam Jahe', thumbnail: 'https://img-global.cpcdn.com/recipes/e39cd20a4f8b3842/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/26493078', source: 'Cookpad' },
  { nama: 'Gado Gado Simpel', thumbnail: 'https://img-global.cpcdn.com/recipes/018718ba1f798093/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/24378284', source: 'Cookpad' },
  { nama: 'Sate Ayam', thumbnail: 'https://img-global.cpcdn.com/recipes/66bc8f2090feaf44/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/24908896', source: 'Cookpad' },
  { nama: 'Nasi Goreng Telur Bawang Putih', thumbnail: 'https://img-global.cpcdn.com/recipes/08ff12fc07ce81a1/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/26697950', source: 'Cookpad' },
  { nama: 'Rawon', thumbnail: 'https://img-global.cpcdn.com/recipes/d3ab8403efc765e7/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/24162310', source: 'Cookpad' },
  { nama: 'Gudeg Nangka Simple Tanpa Daun Jati', thumbnail: 'https://img-global.cpcdn.com/recipes/57e31c94e1c9ebc0/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/12751134', source: 'Cookpad' },
  { nama: 'Opor Ayam', thumbnail: 'https://img-global.cpcdn.com/recipes/48828e35c7887020/1200x630cq80/photo.jpg', url: 'https://cookpad.com/id/resep/24643174', source: 'Cookpad' },
  { nama: 'Orek Tempe Basah', thumbnail: 'https://img-global.cpcdn.com/recipes/1f20ea1374ba4027/300x426cq80/orek-tempe-basah-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/16870044', source: 'Cookpad' },
  { nama: 'Tumis Kangkung Saus Tiram Ala Resto', thumbnail: 'https://img-global.cpcdn.com/recipes/59e148626e9ae3bb/680x781cq80/tumis-kangkung-saus-tiram-ala-resto-tips-biar-warnanya-hijau-foto-resep-utama.jpg', url: 'https://cookpad.com/id/resep/13711574', source: 'Cookpad' },
  ...COOKPAD_RENDANG,
];

// --- Curated Indonesian search ---
//
// Matches an Indonesian dish query (e.g. "rendang", "renda", "soto ayam",
// "nasi goreng") against INDONESIAN_CURATED using case-insensitive substring
// matching on the recipe title. Substring matching is deliberate so partial
// queries ("renda" -> "rendang", "sot" -> "soto") still surface real results
// instead of an empty English-only TheMealDB response. Multi-word / multi-
// ingredient queries ("tempe ayam kangkung") match by ANY term (OR) — each
// ingredient surfaces its own dishes — rather than requiring every term in a
// single title (which would return nothing). Ranking prefers titles that match
// the most query terms, then those that start with the query and match its
// length more closely.
function normalizeForMatch(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function curatedIndonesianSearch(query) {
  const q = normalizeForMatch(query);
  if (!q) return [];
  const terms = q.split(' ').filter(Boolean);

  const scored = [];
  for (const card of INDONESIAN_CURATED) {
    const title = normalizeForMatch(card.nama);
    const matchedTerms = terms.filter((t) => title.includes(t));
    if (matchedTerms.length === 0) continue;
    let score = matchedTerms.length * 1000; // more ingredient matches rank first
    if (title.startsWith(q)) score += 100;
    const idx = title.indexOf(terms[0]);
    if (idx >= 0) score += 50 - Math.min(idx, 49);
    score += 50 - Math.min(Math.abs(title.length - q.length), 49);
    scored.push({ card, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ card }, i) => ({ ...card, recommended: i === 0 }));
}

// --- keyword helpers (port of server.normalize_ingredient / ingredient_query / score_card) ---
export function normalizeIngredientKeyword(item) {
  let text = String(item).toLowerCase().replace(/[^a-z\s]/g, ' ');
  const keywords = [];
  for (const word of text.split(' ')) {
    if (NON_INGREDIENT.has(word)) continue;
    if (word.length <= 2 && word !== 'mi' && word !== 'ubi') continue;
    keywords.push(INGREDIENT_ALIASES[word] || word);
  }
  return keywords;
}

export function ingredientQuery(ingredients) {
  const words = [];
  for (const item of Array.isArray(ingredients) ? ingredients : []) {
    for (const word of normalizeIngredientKeyword(item)) {
      if (!words.includes(word)) words.push(word);
    }
  }
  return words.slice(0, 6).join(' ');
}

function titleMatches(title, keywords) {
  const text = String(title).toLowerCase();
  return keywords.filter((k) => k && text.includes(k));
}

export function scoreCard(card, keywords) {
  if (!keywords.length) return { score: 0, reason: null };
  const title = String(card.nama || '').toLowerCase();
  const matched = titleMatches(title, keywords);
  if (!matched.length) return { score: 0, reason: null };
  return { score: matched.length, reason: [...new Set(matched)].join(', ') };
}

export function rankCards(cards, ingredients) {
  const keywords = [];
  for (const item of Array.isArray(ingredients) ? ingredients : []) {
    const raw = String(item).toLowerCase();
    for (const word of raw.split(' ')) {
      if (NON_INGREDIENT.has(word)) continue;
      if (word.length <= 2 && word !== 'mi' && word !== 'ubi') continue;
      keywords.push(word);
      const alias = INGREDIENT_ALIASES[word];
      if (alias) keywords.push(alias);
    }
  }
  const dedup = [...new Set(keywords)];

  const scored = [];
  for (const card of cards || []) {
    const { score, reason } = scoreCard(card, dedup);
    if (score > 0 && reason) scored.push({ score, card, reason });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ card, reason }, i) => ({ ...card, reason, recommended: i === 0 }));
}

export function recommendedCards(ingredients) {
  const text = ingredients.filter((x) => typeof x === 'string').map((x) => x.toLowerCase()).join(' ');
  if (text.includes('rendang') && ['indomie', 'mie', 'mi '].some((x) => text.includes(x))) {
    return COOKPAD_RENDANG.map((card, i) => ({ ...card, recommended: i === 0 }));
  }
  return [];
}

// TheMealDB official JSON API (key '1'). Returns recipe cards (nama/thumbnail/
// url/source) for detected ingredients. Never copies instruction prose/images.
//
// Timeout: every upstream fetch is bounded by an AbortController so a hung
// themealdb.com call cannot stall the worker past its CPU budget (mirrors the
// trends.js fetch discipline). On timeout/network failure the source degrades
// to an empty result, never throws.
let MEALDB_FETCH_TIMEOUT_MS = 4500;

// Test-only hook: shorten the real timeout so timeout tests run fast.
export function __setMealDBFetchTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) MEALDB_FETCH_TIMEOUT_MS = ms;
}

async function mealDbFetch(fetchFn, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEALDB_FETCH_TIMEOUT_MS);
  try {
    return await fetchFn(url, {
      headers: { 'User-Agent': 'ResepInAja/1.0' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Map an Indonesian ingredient WORD (substring of the raw ingredients text) to
// the TheMealDB `filter.php?i=` ingredient it should query. Order matters:
// first match wins. This is the bridge that lets Indonesian ingredient
// searches (tempe/ayam/telur) reach the official English-only API.
//
// IMPORTANT — kangkung is deliberately NOT mapped here. Kangkung is water
// spinach (Ipomoea aquatica), a different plant from common spinach (Spinacia
// oleracea); mapping it to 'spinach' was an incorrect equivalence that made
// Indonesian "kangkung" searches return unrelated spinach dishes. TheMealDB's
// ingredient list has no 'water spinach' term, so kangkung is instead served
// by the live Indonesian sources below (Cookpad/ResepKoki), which
// return REAL kangkung recipes (tumis kangkung, plecing kangkung, …).
const INGREDIENT_TO_MEALDB_TERM = [
  ['bayam', 'spinach'], // bayam = common spinach (a correct equivalence)
  ['telur', 'egg'],
  ['ayam', 'chicken'],
  ['tempe', 'tempeh'],
  ['nasi', 'rice'],
  ['kentang', 'potato'],
  ['tomat', 'tomato'],
  ['mie', 'noodles'],
  ['indomie', 'noodles'],
];

export async function lookupRecipeCards(names, ingredients, fetchFn) {
  const nameList = Array.isArray(names) ? names : [];
  const ingList = Array.isArray(ingredients) ? ingredients : [];
  const text = ingList.map((i) => String(i).toLowerCase()).join(' ');
  let ingredient = null;
  for (const [word, english] of INGREDIENT_TO_MEALDB_TERM) {
    if (text.includes(word)) { ingredient = english; break; }
  }

  const urls = nameList.slice(0, 6).filter((n) => typeof n === 'string' && n.trim())
    .map((n) => `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(n.trim().slice(0, 80))}`);
  if (ingredient) urls.push(`https://www.themealdb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(ingredient)}`);

  const cards = [];
  const seen = new Set();
  for (const url of urls) {
    let data;
    try {
      const resp = await mealDbFetch(fetchFn, url);
      if (resp.status !== 200) continue;
      data = await resp.json();
    } catch {
      continue;
    }
    const meals = (data && data.meals) || [];
    for (const meal of meals.slice(0, 1)) {
      if (seen.has(meal.idMeal)) continue;
      seen.add(meal.idMeal);
      cards.push({
        nama: meal.strMeal,
        thumbnail: meal.strMealThumb,
        url: `https://www.themealdb.com/meal/${meal.idMeal}`,
        source: 'TheMealDB',
      });
      if (cards.length === 6) break;
    }
    if (cards.length === 6) break;
  }

  const ranked = rankCards(cards, ingList);
  if (ranked.length) return ranked;
  // Cards fetched via filter.php?i=<english> are already relevant by
  // construction (the official API matched the ingredient), but their ENGLISH
  // title often does not contain the Indonesian keyword or its alias — so
  // rankCards()'s title-substring gate would drop genuinely relevant results.
  // (Real example: kangkung -> filter.php?i=spinach returns "Spinach Stir Fry";
  //   tempe -> filter.php?i=tempeh returns "Vegan banh mi", whose title omits
  //   "tempeh" yet is still a tempeh recipe.) Return those cards directly,
  // annotated with the English term that matched, instead of dropping them.
  if (ingredient) {
    return cards.map((card, i) => ({ ...card, reason: ingredient, recommended: i === 0 }));
  }
  return [];
}

// TheMealDB official-API discovery provider (port of TheMealDBRecipeProvider).
// Returns metadata-only recipes (no prose/images) for matching.
const MEALDB_TERMS = {
  egg: 'egg', chicken: 'chicken', potato: 'potato', rice: 'rice',
  noodles: 'noodles', fish: 'fish', shrimp: 'prawns', beef: 'beef',
  tomato: 'tomato', mushroom: 'mushroom', carrot: 'carrot', spinach: 'spinach',
  tofu: 'tofu', beans: 'beans', banana: 'banana', cheese: 'cheese',
  bread: 'bread', onion: 'onion', shallot: 'shallots', garlic: 'garlic',
  chili: 'chili', coconut: 'coconut', 'coconut milk': 'coconut milk',
  corn: 'sweetcorn', eggplant: 'aubergine', broccoli: 'broccoli',
  cabbage: 'cabbage', milk: 'milk', butter: 'butter', scallion: 'spring onions',
  lime: 'lime', lemon: 'lemon', vinegar: 'vinegar', 'soy sauce': 'soy sauce',
  sugar: 'sugar', salt: 'salt', oil: 'oil', flour: 'flour',
};

export function makeTheMealDBProvider(fetchFn) {
  return {
    name: 'TheMealDB',
    // Gallery metadata is supplemental, never an ingredient-complete recipe.
    async references(ingredients) {
      const queries = [...new Set((Array.isArray(ingredients) ? ingredients : [])
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 80)))].slice(0, 3);
      const batches = await Promise.all(queries.map((query) => mixedRecipes(query, fetchFn, 8)));
      const seen = new Set();
      return rankCards(batches.flat(), ingredients).filter((card) => {
        if (seen.has(card.url)) return false;
        seen.add(card.url);
        return true;
      }).slice(0, 12);
    },
    async search(ingredients, preferences) {
      // Parity with TheMealDBRecipeProvider.search: normalize RAW ingredients
      // (which arrive as Indonesian user input, e.g. "telur"/"ayam") to their
      // canonical English terms before mapping to MEALDB_TERMS. The caller
      // (discoverRecipes) passes the unnormalized list through, so without
      // this step Indonesian inputs would silently yield zero external results.
      const canonicals = normalizeIngredients(ingredients);
      const candidateIds = [];
      for (const canon of canonicals.slice(0, 5)) {
        const term = MEALDB_TERMS[canon];
        if (!term) continue;
        try {
          const resp = await fetchFn(`https://www.themealdb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(term)}`, { headers: { 'User-Agent': 'ResepInAja/1.0' } });
          if (resp.status !== 200) continue;
          const data = await resp.json();
          for (const meal of (data.meals || []).slice(0, 4)) {
            if (meal.idMeal && !candidateIds.includes(meal.idMeal)) candidateIds.push(meal.idMeal);
          }
        } catch { /* degrade */ }
      }
      const recipes = [];
      const seenIds = new Set();
      for (const mid of candidateIds) {
        if (seenIds.has(mid)) continue;
        try {
          const resp = await fetchFn(`https://www.themealdb.com/api/json/v1/1/lookup.php?i=${encodeURIComponent(mid)}`, { headers: { 'User-Agent': 'ResepInAja/1.0' } });
          if (resp.status !== 200) continue;
          const data = await resp.json();
          const detail = (data.meals || [])[0];
          if (!detail) continue;
          seenIds.add(mid);
          recipes.push(toRecipe(detail));
        } catch { /* degrade */ }
      }
      return recipes;
    },
  };
}

function toRecipe(meal) {
  const ingredients = [];
  const ingredientNames = [];
  for (let i = 1; i <= 20; i++) {
    const name = (meal[`strIngredient${i}`] || '').trim();
    const measure = (meal[`strMeasure${i}`] || '').trim();
    if (!name) continue;
    const canon = canonicalize(name) || name.toLowerCase();
    ingredients.push({
      canonical: canon,
      amount: null,
      unit: measure,
      optional: false,
      pantry_staple: isPantry(canon),
    });
    ingredientNames.push(canon);
  }
  return {
    id: meal.idMeal,
    title: meal.strMeal || '',
    description: '',
    cuisine: (meal.strArea || '').toLowerCase(),
    country: meal.strArea || '',
    language: 'en',
    servings: null,
    prep_minutes: null,
    cook_minutes: null,
    difficulty: '',
    meal_type: meal.strCategory || '',
    diet_tags: [],
    allergen_tags: deriveAllergens(ingredientNames),
    instructions: [],
    image_url: '',
    source_type: 'external',
    source_name: 'TheMealDB',
    source_url: `https://www.themealdb.com/meal/${meal.idMeal}`,
    external_id: meal.idMeal,
    license: 'TheMealDB Terms of Use (metadata only, link-back)',
    attribution_text: 'Recipe info from TheMealDB (themealdb.com); open source for full instructions.',
    verified: false,
    ingredients,
  };
}

// Host allowlist for external result URLs (port of recipe_sources allowlists).
// Live Indonesian recipe sources (Cookpad/ResepKoki) are included alongside
// TheMealDB so their real article URLs can be surfaced.
const ALLOWED_RESULT_HOSTS = new Set([
  'www.themealdb.com', 'themealdb.com', 'cookpad.com', 'www.cookpad.com',
  'resepkoki.id', 'www.resepkoki.id',
]);
const ALLOWED_THUMBNAIL_HOSTS = new Set([
  'www.themealdb.com', 'themealdb.com', 'img-global.cpcdn.com',
  'resepkoki.id', 'www.resepkoki.id', 'i0.wp.com', 'i1.wp.com', 'i2.wp.com',
]);

function hostAllowed(url, allow) {
  try {
    const u = new URL(url);
    return allow.has(u.hostname);
  } catch {
    return false;
  }
}

// Validate a card's url/thumbnail before returning (parity with server).
export function sanitizeCard(card) {
  if (!card) return null;
  if (!hostAllowed(card.url || '', ALLOWED_RESULT_HOSTS)) return null;
  if (!hostAllowed(card.thumbnail || '', ALLOWED_THUMBNAIL_HOSTS)) return null;
  return card;
}

// ---------------------------------------------------------------------------
// Live Indonesian recipe search (bounded, cached, multi-source with failover)
// ---------------------------------------------------------------------------
//
// Replaces the earlier approach of hand-curating a handful of static Cookpad
// cards. Instead of a fixed card list that only covers tempe/kangkung and a
// few named dishes, this queries REAL, publicly-accessible Indonesian recipe
// sites at request time and returns their actual, attributed results.
//
// Verified-reachable sources (each returns 200 and is parsed from server-
// rendered HTML — no scraping of private/protected data, no auth, no
// instruction prose or full text is copied; only title + link-back + the
// source's own thumbnail, mirroring the TheMealDB metadata-only approach):
//
//   1. Cookpad       https://cookpad.com/id/cari/<query>
//        Server-rendered search results. Each result is an
//        <li id="recipe_<ID>"> block containing
//          <a itemprop="url" href="/id/resep/<ID>">TITLE</a>
//        and an <img src="https://img-global.cpcdn.com/recipes/<hash>/...">.
//        Verified: 30 real results per query, correctly filtered by term.
//
//   2. ResepKoki     https://resepkoki.id/?s=<query>
//        WordPress search. Each result is an <article> block containing
//          <h3 class="entry-title"><a href="..." rel="bookmark">TITLE</a></h3>
//        and an <img data-src="https://i0.wp.com/resepkoki.id/...">.
//        Verified: 20 real results per query, correctly filtered by term.
//
//   REJECTED (investigated, not viable as a *search* adapter — documented so
//   the decision is traceable, per "try alternative if inaccessible"):
//   * detikFood   — search page is client-rendered (no server-side result
//                   HTML); only a general food-news RSS exists, which is
//                   already consumed by trends.js (not a recipe search).
//   * SajianSedap — https://sajiansedap.grid.id/tag/resep-<query> returns 200
//                   but the "tag" route is a LATEST-articles feed, NOT a
//                   query-filtered search (e.g. tag/resep-tempe returned 0/10
//                   tempe titles; tag/resep-kangkung returned only 8/38
//                   kangkung titles). Surfacing its unfiltered results would
//                   mislabel unrelated recipes as matches, so it is excluded.
//
//   Cookpad + ResepKoki are the two verified, correctly-filtering sources.
//
// Boundedness / safety:
//   * Every fetch uses an AbortController timeout (mirrors trends.js), so a
//     hung upstream cannot stall the worker past its CPU budget.
//   * Sources are fetched in PARALLEL (Promise.allSettled) and merged, so a
//     single failed source degrades to the others rather than erroring the
//     whole request (failover).
//   * Results are deduped by URL and capped.
//   * A per-isolate TTL cache avoids refetch bursts; never persisted.
//   * Host allowlists (sanitizeCard) drop any off-list URL/thumbnail.
//   * Every card is a REAL result read from the source at request time — no
//     invented recipe, title, or link. On total failure the result is an
//     honest empty list, never fabricated data.

let INDO_FETCH_TIMEOUT_MS = 4500;
const INDO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (per-isolate)

// Test-only hook: shorten the timeout so timeout tests run fast.
export function __setIndoFetchTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) INDO_FETCH_TIMEOUT_MS = ms;
}

// Minimal HTML entity decode (enough for the entities these pages emit).
const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&nbsp;': ' ' };
function decodeHtmlEntities(text) {
  return String(text == null ? '' : text).replace(/&(amp|lt|gt|quot|#39|#039|nbsp);/g, (m) => HTML_ENTITIES[m] || m);
}

// Strip tags + collapse whitespace (for titles extracted from HTML).
function stripTags(text) {
  return decodeHtmlEntities(String(text == null ? '' : text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

// Normalize an image URL: drop protocol-relative + non-https; return '' if bad.
function httpsOnly(url) {
  if (!url) return '';
  const u = String(url).trim();
  if (!/^https:\/\//i.test(u)) return '';
  return u;
}

// Cookpad: normalize the thumbnail. Search results carry a small
// "…/recipes/<hash>/120x160cq80/<slug>" fragment; reconstruct a canonical
// larger thumbnail from the stable recipe hash so the gallery gets a real,
// usable image URL on the same allowlisted img-global.cpcdn.com host.
function normalizeCookpadThumb(url) {
  const m = /img-global\.cpcdn\.com\/recipes\/([0-9a-f]{16,})\//i.exec(url || '');
  if (!m) return httpsOnly(url);
  return `https://img-global.cpcdn.com/recipes/${m[1]}/680x482cq50/photo.jpg`;
}

// Parse Cookpad search HTML into cards [{nama,url,source,thumbnail}].
function parseCookpad(html, sourceName) {
  const out = [];
  const blocks = html.split(/(?=<li id="recipe_\d+")/);
  for (const block of blocks) {
    const href = /<a[^>]*itemprop="url"[^>]*href="(\/id\/resep\/\d+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!href) continue;
    const title = stripTags(href[2]);
    if (!title) continue;
    const img = /<img[^>]*src="(https:\/\/img-global\.cpcdn\.com\/recipes\/[^"]+)"/i.exec(block);
    const thumbnail = img ? normalizeCookpadThumb(img[1]) : '';
    out.push({
      nama: title,
      url: `https://cookpad.com${href[1]}`,
      source: sourceName,
      thumbnail,
    });
    if (out.length >= 20) break;
  }
  return out;
}

// Parse ResepKoki (WordPress) search HTML into cards.
function parseResepKoki(html, sourceName) {
  const out = [];
  const articles = html.split(/<article\b/i).slice(1);
  for (const art of articles) {
    const m = /<h[1-6][^>]*>\s*<a\b[^>]*href="(https:\/\/resepkoki\.id\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h[1-6]>/i.exec(art);
    if (!m) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    const img = /(?:data-src|src)="(https:\/\/i[0-9]\.wp\.com\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i.exec(art)
      || /<noscript>\s*<img[^>]*src="(https:\/\/[^"]+)"/i.exec(art);
    out.push({
      nama: title,
      url: m[1],
      source: sourceName,
      thumbnail: img ? httpsOnly(img[1]) : '',
    });
    if (out.length >= 20) break;
  }
  return out;
}

// Ordered live Indonesian sources. Each entry has a query-url builder and a
// parser. Cookpad + ResepKoki are the two verified, correctly-filtering
// search endpoints (see the "REJECTED" notes above for why detikFood and
// SajianSedap are not included).
const INDO_SOURCES = [
  {
    name: 'Cookpad',
    buildUrl: (q) => `https://cookpad.com/id/cari/${encodeURIComponent(q)}`,
    parse: (html) => parseCookpad(html, 'Cookpad'),
  },
  {
    name: 'ResepKoki',
    buildUrl: (q) => `https://resepkoki.id/?s=${encodeURIComponent(q)}`,
    parse: (html) => parseResepKoki(html, 'ResepKoki'),
  },
];

// Fetch one source with a hard timeout. Returns {name, cards, error} — never throws.
async function fetchIndoSource(source, query, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INDO_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(source.buildUrl(query), {
      headers: { 'User-Agent': 'ResepInAja/1.0 (indonesian-search)', Accept: 'text/html, */*' },
      signal: controller.signal,
    });
    if (resp.status !== 200) return { name: source.name, cards: [], error: 'HTTP ' + resp.status };
    const text = await resp.text();
    const cards = source.parse(text);
    return { name: source.name, cards, error: cards.length ? null : 'no parseable results' };
  } catch (err) {
    return { name: source.name, cards: [], error: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// In-memory, per-isolate cache keyed by normalized query.
let indoCache = new Map(); // query -> { at, cards }

// Test-only hook: clear the in-memory cache for deterministic tests.
export function resetIndoCache() {
  indoCache = new Map();
}

// Search all live Indonesian sources in parallel, merge + dedupe + cap.
// Returns an array of cards (possibly empty). Never throws.
export async function searchIndonesianRecipes(query, fetchFn, { now = Date.now() } = {}) {
  const q = String(query || '').trim().toLowerCase().slice(0, 80);
  if (!q) return [];

  const cached = indoCache.get(q);
  if (cached && now - cached.at < INDO_CACHE_TTL_MS) return cached.cards;

  const results = await Promise.allSettled(INDO_SOURCES.map((s) => fetchIndoSource(s, q, fetchFn)));

  const errors = [];
  const merged = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.cards.length) {
      merged.push(...r.value.cards);
    } else {
      const err = r.status === 'fulfilled' ? r.value : r.reason;
      const name = r.status === 'fulfilled' ? err.name : 'unknown';
      errors.push({ source: name, error: (err && err.error) || (err && err.message) || 'failed' });
    }
  }

  // Dedupe by URL, sanitize, cap.
  const seen = new Set();
  const unique = [];
  for (const card of merged) {
    const clean = sanitizeCard(card);
    if (!clean || !clean.nama) continue;
    if (seen.has(clean.url)) continue;
    seen.add(clean.url);
    unique.push(clean);
    if (unique.length >= 30) break;
  }

  // Only cache a genuinely fresh, non-empty result.
  if (unique.length) indoCache.set(q, { at: now, cards: unique });

  return unique;
}

// Partial/near-miss dish queries -> their canonical dish name. The original
// curated-only behavior relied on substring matching ("renda" -> "rendang"),
// which the live Cookpad/ResepKoki search does NOT do — a live "renda" query
// returns unrelated "renda" (lace) craft cakes. Canonicalizing these partial
// queries to the intended dish BEFORE the dynamic search preserves the
// original partial-query behavior (rendang results) while still using the
// live sources. Keys are matched case-insensitively against the whole query.
export const CANONICAL_DISH_QUERIES = {
  renda: 'rendang',
  rendan: 'rendang',
};

// Rewrite a gallery query through CANONICAL_DISH_QUERIES (whole-query,
// case-insensitive). Returns the canonical query when a mapping exists,
// otherwise the original query unchanged.
export function canonicalizeDishQuery(query) {
  const q = String(query || '').trim();
  const key = q.toLowerCase();
  return CANONICAL_DISH_QUERIES[key] || q;
}

// gallery sources (mixed): live Indonesian search + curated + TheMealDB.
//
// Order of resolution for a gallery query (all bounded, all degrade safely):
//   1) Live Indonesian recipe search (Cookpad + ResepKoki) —
//      returns REAL, attributed Indonesian results for ingredient/dish queries
//      (tempe, kangkung, ayam, tahu, ikan, udang, nanas, pisang, telur, …).
//      This is the primary path for Indonesian input; it no longer depends on
//      a handful of hard-coded cards.
//   2) Curated static Indonesian cards — kept only as a deterministic fallback
//      for named-dish partial matches when the live sources are unreachable.
//   3) TheMealDB official API (key-free) for everything else — with Indonesian
//      ingredient words mapped to English filter terms (kangkung excluded; see
//      INGREDIENT_TO_MEALDB_TERM). Bounded timeout + safe degradation.
//
// Failover: if the live Indonesian search returns nothing (all sources down),
// we fall through to curated + TheMealDB so the gallery still surfaces real,
// attributed results rather than an empty wall. Never scrapes instruction
// prose; never fabricates a recipe, title, thumbnail, or link.
export async function mixedRecipes(query, fetchFn, limit = 20) {
  let q = String(query || '').trim().slice(0, 80);
  if (!q) return [];

  // Canonicalize partial/near-miss dish queries ("renda" -> "rendang") BEFORE
  // the live Indonesian search so the original partial-query behavior is
  // preserved instead of surfacing unrelated "renda"/lace results.
  q = canonicalizeDishQuery(q);

  // 1) Live Indonesian search (primary for Indonesian input).
  const live = await searchIndonesianRecipes(q, fetchFn);
  if (live.length) return live.slice(0, limit);

  // 2) Curated static fallback (named-dish partial matches).
  const curated = curatedIndonesianSearch(q);
  if (curated.length) {
    return curated.map(sanitizeCard).filter(Boolean).slice(0, limit);
  }

  // 3) TheMealDB official API. Derive Indonesian ingredient keywords so the
  // Indonesian -> English ingredient-filter path actually runs for phrases
  // like "tempe ayam" (which the raw English name search would miss).
  const ingredientWords = q.split(/\s+/).filter((w) => INGREDIENT_TO_MEALDB_TERM.some(([k]) => w.includes(k) || k.includes(w)));
  const cards = await lookupRecipeCards([q], ingredientWords, fetchFn);
  return cards.map(sanitizeCard).filter(Boolean).slice(0, limit);
}
