// Deterministic recipe discovery + matching.
//
// Faithful JS port of ../recipe_discovery.py (the deterministic matching and
// normalization layer) plus server.py's run_discovery / search_discovery /
// get_recipe_by_id orchestration. No LLM here; AI fallback is wired in
// index.js (the caller), exactly as server.py does.

import { normalizeIngredients, isPantry, canonicalize, deriveAllergens } from './ingredients.js';
import { seedRecipeCatalog } from './seed.js';

export const MIN_SCORE = 0.45; // RECIPE_MATCH_MIN_SCORE (overridable via env at module init in index.js)

// ---------------------------------------------------------------------------
// Internal normalized recipe format (port of normalize_recipe)
// ---------------------------------------------------------------------------
export function normalizeRecipe(recipe) {
  const ingredients = recipe.ingredients || [];
  const prep = recipe.prep_minutes;
  const cook = recipe.cook_minutes;
  const total =
    (prep != null && cook != null)
      ? prep + cook
      : (prep != null ? prep : (cook != null ? cook : null));

  const normalizedIngredients = ingredients.map((ing) => {
    const canonical = ing.canonical || (ing.name ? canonicalize(ing.name) : '') || '';
    return {
      canonical,
      amount: ing.amount ?? null,
      unit: ing.unit || '',
      optional: Boolean(ing.optional),
      pantry_staple: Boolean(ing.pantry_staple) || isPantry(canonical),
    };
  });

  let instructions = recipe.instructions || [];
  if (typeof instructions === 'string') {
    instructions = instructions.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  return {
    id: recipe.id || recipe.external_id || '',
    title: recipe.title || recipe.nama || '',
    description: recipe.description || '',
    cuisine: recipe.cuisine || '',
    country: recipe.country || recipe.area || '',
    language: recipe.language || 'id',
    servings: recipe.servings ?? null,
    prep_minutes: recipe.prep_minutes ?? null,
    cook_minutes: recipe.cook_minutes ?? null,
    total_minutes: total,
    difficulty: recipe.difficulty || '',
    meal_type: recipe.meal_type || '',
    diet_tags: recipe.diet_tags || [],
    allergen_tags: recipe.allergen_tags || [],
    instructions,
    image_url: recipe.image_url || recipe.thumbnail || '',
    source_type: recipe.source_type || 'external',
    source_name: recipe.source_name || '',
    source_url: recipe.source_url || recipe.url || '',
    external_id: recipe.external_id || '',
    license: recipe.license || '',
    attribution_text: recipe.attribution_text || '',
    verified: Boolean(recipe.verified),
    ingredients: normalizedIngredients,
  };
}

function requiredIngredients(recipe) {
  return recipe.ingredients.filter((i) => !i.optional && !i.pantry_staple);
}
function allIngredients(recipe) {
  return recipe.ingredients.filter((i) => !i.pantry_staple);
}

function explain(recipe, matched, missing, unused, requiredNames) {
  const parts = [];
  if (matched.length) {
    parts.push(`You already have ${matched.length} of ${requiredNames.length} main ingredients (${matched.slice(0, 3).join(', ')}).`);
  }
  if (missing.length) {
    parts.push(`Still need ${missing.slice(0, 3).join(', ')}.`);
  }
  if (unused.length) {
    parts.push(`Recipe does not use your ${unused.slice(0, 3).join(', ')}.`);
  }
  if (!recipe.verified && recipe.source_type === 'external') {
    parts.push('External source — check the original recipe before cooking.');
  }
  return parts.length ? parts.join(' ') : 'No strong ingredient match.';
}

// ---------------------------------------------------------------------------
// Deterministic matching (port of match_recipes)
// ---------------------------------------------------------------------------
export function matchRecipes(recipes, ingredients, preferences = {}, minScore = MIN_SCORE) {
  const detected = normalizeIngredients(ingredients);
  const detectedSet = new Set(detected);

  const cuisines = ((preferences.cuisines) || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  const diet = ((preferences.diet) || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  const excludeAllergens = ((preferences.excludeAllergens) || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  const maxTime = preferences.maxTimeMinutes;
  const language = preferences.language;

  const results = [];
  for (const raw of recipes) {
    const recipe = normalizeRecipe(raw);

    // Hard filters (exclusion, not scoring).
    if (cuisines.length && !cuisines.includes(recipe.cuisine.toLowerCase())) continue;
    if (excludeAllergens.length) {
      const recipeAllergens = new Set([...recipe.allergen_tags, ...deriveAllergens(recipe.ingredients.map((i) => i.canonical))].map((a) => String(a).toLowerCase()));
      if ([...recipeAllergens].some((a) => excludeAllergens.includes(a))) continue;
      // FAIL CLOSED on unknown metadata (no ingredient data => cannot exclude).
      if (!recipe.ingredients.length) continue;
    }
    if (maxTime != null) {
      const total = recipe.total_minutes;
      if (total == null || !Number.isFinite(total) || total > maxTime) continue;
    }
    if (diet.length && !diet.every((d) => recipe.diet_tags.map((tag) => String(tag).toLowerCase()).includes(d))) continue;
    if (language && recipe.language && recipe.language !== language) continue;

    const required = requiredIngredients(recipe);
    const allIng = allIngredients(recipe);
    const requiredNames = required.map((i) => i.canonical);
    const allNames = allIng.map((i) => i.canonical);

    const matched = requiredNames.filter((n) => detectedSet.has(n));
    const missing = requiredNames.filter((n) => !detectedSet.has(n));
    const unused = detected.filter((n) => !allNames.includes(n));

    if (!requiredNames.length) continue; // no usable ingredient info

    const availableRatio = matched.length / requiredNames.length;
    const usageRatio = detected.length ? matched.length / detected.length : 0.0;

    let prefBonus = 0.0;
    if (diet.length) {
      const recipeDiet = new Set(recipe.diet_tags.map((d) => String(d).toLowerCase()));
      if ([...recipeDiet].some((d) => diet.includes(d))) prefBonus = 1.0;
    }
    const verifiedBonus = recipe.verified ? 1.0 : 0.0;

    // Relevance score used for RANKING. `missing` and `usageRatio` both already
    // reflect how much of the recipe/query is covered by `availableRatio`, so
    // we do NOT also subtract a per-missing-ingredient penalty — that double
    // count was the reason a single-overlap recipe (e.g. a chicken dish for a
    // "tempe ayam kangkung" query) was pushed below the threshold and dropped,
    // returning zero results despite a real ingredient match.
    let score =
      0.55 * availableRatio +
      0.25 * usageRatio +
      0.10 * verifiedBonus +
      0.10 * prefBonus;
    score = Math.max(0.0, Math.min(1.0, score));

    // Union matching: a recipe that uses at least ONE of the user's detected
    // ingredients is relevant. For a single-ingredient query we still require
    // the relevance threshold (avoid flooding a lone "telur" with every egg
    // recipe's neighbours); for a multi-ingredient query we surface the union
    // (any overlap) and let the score rank relevance, so "tempe ayam kangkung"
    // returns chicken dishes, tempeh dishes, AND water-spinach dishes instead
    // of an empty result.
    const hasOverlap = matched.length >= 1;
    if (!hasOverlap) continue;
    if (score < minScore && detected.length <= 1) continue;

    results.push({
      ...recipe,
      matchedIngredients: matched,
      missingIngredients: missing,
      unusedIngredients: unused,
      matchScore: Math.round(score * 1000) / 1000,
      matchExplanation: explain(recipe, matched, missing, unused, requiredNames),
    });
  }

  results.sort((a, b) => (b.matchScore - a.matchScore) || ((b.verified ? 1 : 0) - (a.verified ? 1 : 0)));
  return results;
}

// ---------------------------------------------------------------------------
// Discovery pipeline (port of discover_recipes) — no Supabase in Workers Free:
// seed catalog is always the curated source; TheMealDB is the optional
// external source (official API only, no scraping).
// ---------------------------------------------------------------------------
export async function discoverRecipes(ingredients, preferences = {}, externalProvider = null) {
  const curated = seedRecipeCatalog();
  const external = externalProvider ? await externalProvider.search(ingredients, preferences) : [];
  const combined = [...curated, ...external];
  const matches = matchRecipes(combined, ingredients, preferences);
  return {
    matches,
    curated_count: curated.length,
    external_count: external.length,
    supabase_available: false, // Supabase is not reachable from Workers Free (no Postgres driver + credentials would be exposed).
  };
}

// ---------------------------------------------------------------------------
// Orchestration (port of server.run_discovery)
// ---------------------------------------------------------------------------
export async function runDiscovery(ingredients, preferences, externalProvider = null, aiFallbackFn = null) {
  const prefs = normalizePreferences(preferences);
  const seeded = seedRecipeCatalog();

  const discovery = await discoverRecipes(ingredients, prefs, externalProvider);
  const matches = [...discovery.matches];

  // Seed catalog is always available, so no separate seed-merge is needed
  // here (unlike Python where Supabase availability gates it). Matches already
  // include the seed catalog.
  matches.sort((a, b) => (b.matchScore - a.matchScore) || ((b.verified ? 1 : 0) - (a.verified ? 1 : 0)));

  const aiFallback = matches.length === 0;

  // AI fallback (parity with server._ai_fallback_recommendations): when the
  // deterministic matcher yields nothing (sparse input like a single "telur"),
  // populate `ai_results` with related gallery cards so the frontend still
  // surfaces something useful instead of a dead-end. Shape matches the Python
  // contract: {title, image_url, source_url, source_type, source_name,
  // verified, attribution_text}. `aiFallbackFn` is lookupRecipeCards bound to
  // the worker's fetch (see index.js).
  let ai_results = [];
  const hasFilters = Object.values(prefs).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
  if (aiFallback && !hasFilters && typeof aiFallbackFn === 'function') {
    try {
      const names = normalizeIngredients(ingredients);
      const cards = await aiFallbackFn(names, ingredients);
      ai_results = (cards || []).map((c) => ({
        title: c.nama || '',
        image_url: c.thumbnail || '',
        source_url: c.url || '',
        source_type: 'external',
        source_name: c.source || 'TheMealDB',
        verified: false,
        attribution_text: 'Recipe data & image from TheMealDB (themealdb.com).',
      }));
    } catch {
      ai_results = [];
    }
  }

  return {
    recipes: matches.slice(0, 10),
    source: matches.length ? 'deterministic' : 'ai_fallback',
    // Legacy source/ai_results names retained until the frontend migrates.
    actual_source: matches.length ? 'deterministic' : (ai_results.length ? 'external_fallback' : 'no_matches'),
    ai_generated: false,
    fallback: aiFallback,
    ai_results,
    fallback_warning: aiFallback
      ? (ai_results.length ? 'Referensi resep eksternal, bukan hasil AI. Periksa resep asli sebelum memasak.' : 'Tidak ada resep yang cocok dengan bahan dan filter Anda.')
      : null,
    sources: {
      supabase_available: false,
      curated_count: discovery.curated_count,
      external_count: discovery.external_count,
      seed_catalog_used: true,
    },
    detected_ingredients: normalizeIngredients(ingredients),
  };
}

export function normalizePreferences(preferences) {
  const prefs = preferences || {};
  const out = {};
  if (prefs.cuisine) out.cuisines = [prefs.cuisine];
  if (prefs.cuisines) out.cuisines = [...prefs.cuisines];
  if (prefs.diet) out.diet = Array.isArray(prefs.diet) ? [...prefs.diet] : [prefs.diet];
  if (prefs.diets) out.diet = [...prefs.diets];
  if (prefs.excludeAllergens) out.excludeAllergens = [...prefs.excludeAllergens];
  if (prefs.maxTimeMinutes) out.maxTimeMinutes = prefs.maxTimeMinutes;
  if (prefs.language) out.language = prefs.language;
  return out;
}

// ---------------------------------------------------------------------------
// Search + lookup (port of server.search_discovery / get_recipe_by_id)
// ---------------------------------------------------------------------------
export function searchDiscovery(query) {
  const q = (query || '').trim().toLowerCase();
  const seeded = seedRecipeCatalog();
  const normalized = seeded.map((r) => normalizeRecipe(r));
  if (!q) return normalized.slice(0, 20);

  // Normalize the query through the ingredient catalog so Indonesian (and
  // English) ingredient queries surface recipes that USE that ingredient —
  // the same canonicalization matchRecipes applies. Previously only
  // title/cuisine/country/description text was searched, so a valid ingredient
  // query like "ayam" (chicken) or "telur" (egg) returned nothing even when
  // the catalog contained recipes using the canonical ("chicken"/"egg").
  //
  // A space-separated query can be EITHER a multi-word ingredient ("bawang
  // merah" -> shallot) OR a list of ingredients ("tempe ayam kangkung" ->
  // tempeh + chicken + water spinach). canonicalize() already resolves the
  // former correctly, so we split into individual ingredients ONLY when the
  // full phrase does not itself resolve to a compound ingredient: compare the
  // full-phrase canonical against the first word's canonical — if they differ,
  // the phrase is a compound ("bawang merah" -> shallot != onion), so keep it
  // whole; if they match, the phrase is a list ("tempe ayam kangkung" ->
  // tempeh == tempeh), so canonicalize each word for union matching.
  const fullCanon = canonicalize(query);
  const firstWordCanon = canonicalize(query.split(/\s+/)[0]);
  const queryParts =
    fullCanon && firstWordCanon && fullCanon !== firstWordCanon
      ? [query] // compound ingredient — keep whole
      : query.split(/[\s,]+/).filter(Boolean); // list of ingredients — split

  const qCanonical = normalizeIngredients(queryParts).map((s) => s.toLowerCase());

  const out = [];
  for (const r of normalized) {
    const hay = [r.title, r.cuisine, r.country, r.description].join(' ').toLowerCase();
    const ingredientNames = r.ingredients.map((i) => i.canonical.toLowerCase());

    // Text match (existing behavior).
    if (hay.includes(q)) {
      out.push(r);
      continue;
    }

    // Ingredient match: the query (or a comma-separated part) must
    // canonicalize to an ingredient the recipe actually uses.
    if (qCanonical.some((c) => c && ingredientNames.includes(c))) out.push(r);
  }
  return out.slice(0, 20);
}

export function getRecipeById(recipeId) {
  const id = (recipeId || '').trim();
  for (const r of seedRecipeCatalog()) {
    if (r.id === id || r.external_id === id) {
      return { recipe: normalizeRecipe(r) };
    }
  }
  return { error: 'Recipe tidak ditemukan.' };
}

// Re-export for callers that want a single import surface.
export { deriveAllergens };
