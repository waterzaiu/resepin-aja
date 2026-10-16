// Cloudflare Workers entry — "Resep in aja" (Free plan).
//
// Mirrors the Python server's HTTP API contract so the existing
// resep-in-aja.html frontend works unchanged (when served same-origin). All
// routes from server.py's do_GET/do_POST are implemented:
//
//   GET  /                       -> serve resep-in-aja.html (via ASSETS, see wrangler)
//   GET  /api/resep?q=...        -> external gallery (official APIs only)
//   GET  /api/viral              -> recent food trends (dated detikFood RSS)
//   GET  /api/inspirasi          -> curated inspiration gallery
//   GET  /api/recipes/search?q=  -> search seed catalog
//   GET  /api/recipes/<id>       -> single recipe
//   GET  /health, /ready         -> liveness/readiness
//   POST /api/scan-resep         -> AI vision scan (multipart)
//   POST /api/recipes/match      -> deterministic matching
//   POST /api/ingredients/normalize -> normalization
//
// Secrets are read from env only (never embedded). Discovery/search/gallery
// work with zero keys; only /api/scan-resep needs at least one AI key.

import {
  runDiscovery,
  searchDiscovery,
  getRecipeById,
  normalizeRecipe,
} from './discovery.js';
import {
  callVisionWithFallback,
  ProviderError,
  PROVIDER_ORDER,
} from './gemini.js';
import {
  recommendedCards,
  lookupRecipeCards,
  rankCards,
  mixedRecipes,
  ingredientQuery,
  makeTheMealDBProvider,
} from './external.js';
import { normalizeIngredients, canonicalize } from './ingredients.js';
import { handleTrends } from './trends.js';
import {
  MAX_FILES,
  MAX_BYTES_PER_FILE,
  MAX_TOTAL_BYTES,
  mimeAllowed,
  verifyImageSignature,
  parseMultipart,
  jsonResponse,
  safeError,
  hostAllowed,
  originAllowed,
  secureAssetResponse,
} from './security.js';

export default {
  async fetch(request, env, ctx) {
    try {
      // `ctx.fetchOverride` lets tests inject a mocked upstream fetch; in
      // production (Cloudflare) it is undefined and the real fetch is used.
      const fetchFn = ctx && typeof ctx.fetchOverride === 'function' ? ctx.fetchOverride : fetch;
      return await handle(request, env, ctx, fetchFn);
    } catch (e) {
      // Never leak exception messages (may embed provider URLs/keys).
      console.error('Unhandled error:', e && e.constructor && e.constructor.name);
      return safeError(500);
    }
  },
};

async function handle(request, env, ctx, fetchFn) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // Host allowlist (parity with server._host_allowed).
  const allowedHosts = parseList(env.ALLOWED_HOSTS);
  const reqHost = request.headers.get('host') || url.host;
  if (!hostAllowed(reqHost, allowedHosts)) {
    return safeError(400, 'Host tidak diizinkan.');
  }

  // Origin check for state-changing requests (parity with server._origin_allowed).
  if (method === 'POST') {
    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    const origin = request.headers.get('Origin');
    // Same-origin POSTs carry an Origin equal to the request origin; if no
    // allowlist is configured, allow any origin but keep credentials off.
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
      return safeError(403, 'Origin tidak diizinkan.');
    }
  }

  // Worker-first routing ensures assets never bypass response security policy.
  // Keep API/health misses out of the SPA fallback.
  if ((method === 'GET' || method === 'HEAD') &&
      path !== '/api' && !path.startsWith('/api/') &&
      path !== '/health' && path !== '/ready' && env.ASSETS) {
    return secureAssetResponse(await env.ASSETS.fetch(request));
  }

  if (method === 'GET') {
    if (path === '/' || path === '/index.html') {
      // No ASSETS binding configured (e.g. local tests).
      return new Response('Static assets not mounted (configure assets binding).', { status: 404 });
    } else if (path.startsWith('/api/resep')) {
      const q = url.searchParams.get('q') || '';
      if (!q.trim() || q.length > 80) {
        return safeError(400, 'Kata kunci harus 1–80 karakter.');
      }
      const cards = await mixedRecipes(q, fetchFn);
      return jsonResponse({ recipes: cards });
    } else if (path === '/api/viral') {
      // Honest recent food-trend feed (dated detikFood RSS), replacing the old
      // static COOKPAD_RENDANG list that asserted "viral" without evidence.
      // Returns { recipes: [{nama,url,source,thumbnail,published}], ... }.
      return handleTrends(request, env, fetchFn);
    } else if (path === '/api/inspirasi') {
      const cards = await mixedRecipes('masakan rumahan ayam telur', fetchFn);
      const recipes = cards.length
        ? cards
        : (await lookupRecipeCards(['Fried Rice', 'Chicken Curry', 'Ramen', 'Noodles', 'Omelette', 'Soup'], [], fetchFn));
      return jsonResponse({ recipes });
    } else if (path === '/health' || path === '/ready') {
      return health(env);
    } else if (path.startsWith('/api/recipes/search')) {
      const q = url.searchParams.get('q') || '';
      return jsonResponse({ recipes: searchDiscovery(q) });
    } else if (path.startsWith('/api/recipes/')) {
      const id = path.slice('/api/recipes/'.length).split('?')[0];
      const result = getRecipeById(id);
      if (result.error) return safeError(404, result.error);
      return jsonResponse(result);
    } else {
      return safeError(404, 'Not found');
    }
  }

  if (method === 'POST') {
    if (path === '/api/scan-resep') return scan(request, env, fetchFn);
    if (path === '/api/recipes/match') return match(request, env, fetchFn);
    if (path === '/api/ingredients/normalize') return normalize(request);
    return safeError(404, 'Not found');
  }

  return safeError(405, 'Method not allowed');
}

function validPreferences(prefs) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return false;
  for (const key of ['cuisines', 'diets', 'excludeAllergens']) {
    if (prefs[key] != null && (!Array.isArray(prefs[key]) || !prefs[key].every((x) => typeof x === 'string'))) return false;
  }
  for (const key of ['cuisine', 'language']) {
    if (prefs[key] != null && typeof prefs[key] !== 'string') return false;
  }
  if (prefs.diet != null && typeof prefs.diet !== 'string' && !(Array.isArray(prefs.diet) && prefs.diet.every((x) => typeof x === 'string'))) return false;
  return prefs.maxTimeMinutes == null || (Number.isFinite(prefs.maxTimeMinutes) && prefs.maxTimeMinutes > 0);
}

function parseList(s) {
  if (!s) return [];
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}

function health(env) {
  const active = PROVIDER_ORDER.filter((p) => env[`${p.toUpperCase()}_API_KEY`]);
  const ok = active.length > 0;
  return jsonResponse({
    ok,
    ready: ok,
    active_providers: active,
    preferred: env.PROVIDER || 'auto',
    chain: active,
    models: Object.fromEntries(active.map((p) => [p, providerModel(p, env)])),
    supabase_configured: false,
    external_recipes_enabled: env.ENABLE_EXTERNAL_RECIPES !== 'false',
    pillow_available: false,
    cross_provider_fallback: env.ALLOW_CROSS_PROVIDER_FALLBACK === 'true',
  }, ok ? 200 : 503);
}

function providerModel(name, env) {
  switch (name) {
    case 'gemini': return env.GEMINI_MODEL || 'gemini-1.5-flash';
    case 'openai': return env.OPENAI_MODEL || 'gpt-4o-mini';
    case 'anthropic': return env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
    default: return '';
  }
}

// --- POST /api/recipes/match ---
async function match(request, env, fetchFn) {
  try {
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!raw.length) {
      return safeError(400, 'Request body kosong.');
    }
    if (raw.length > 1_000_000) {
      return safeError(413, 'Request body terlalu besar.');
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return safeError(400, 'Body harus JSON valid.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return safeError(400, 'Body harus objek JSON.');
    const ingredients = body.ingredients;
    const preferences = body.preferences ?? {};
    if (!validPreferences(preferences)) return safeError(400, 'Format preferences tidak valid.');
    if (!Array.isArray(ingredients) || !ingredients.length) {
      return safeError(400, "Field 'ingredients' (array) wajib diisi.");
    }
    if (!ingredients.every((i) => typeof i === 'string')) {
      return safeError(400, 'Setiap ingredient harus string.');
    }
    if (ingredients.length > 50) {
      return safeError(400, 'Maksimal 50 bahan.');
    }

    const externalProvider = env.ENABLE_EXTERNAL_RECIPES !== 'false'
      ? makeTheMealDBProvider(fetchFn)
      : null;
    // Bind lookupRecipeCards to the worker fetch so runDiscovery can populate
    // ai_results fallback cards when deterministic matching yields nothing.
    const aiFallbackFn = externalProvider
      ? (names, ingredients) => lookupRecipeCards(names, ingredients, fetchFn)
      : null;
    const result = await runDiscovery(ingredients, preferences, externalProvider, aiFallbackFn);
    return jsonResponse(result);
  } catch (e) {
    console.error('match error:', e && e.constructor && e.constructor.name);
    return safeError(500);
  }
}

// --- POST /api/ingredients/normalize ---
async function normalize(request) {
  try {
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!raw.length) {
      return safeError(400, 'Request body kosong.');
    }
    if (raw.length > 100_000) {
      return safeError(413, 'Request body terlalu besar.');
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return safeError(400, 'Body harus JSON valid.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return safeError(400, 'Body harus objek JSON.');
    const ingredients = body.ingredients;
    if (!Array.isArray(ingredients)) {
      return safeError(400, "Field 'ingredients' (array) wajib diisi.");
    }
    if (!ingredients.every((i) => typeof i === 'string')) {
      return safeError(400, 'Setiap ingredient harus string.');
    }
    const normalized = normalizeIngredients(ingredients);
    // Per-input mapping: each input maps to its OWN canonical (null for filler
    // or unknown), NOT the deduped `normalized` index. Index-alignment against
    // the deduped list misattributes canonicals when entries collapse (e.g.
    // ['  ', 'garam', ...] -> '  ' would steal 'salt' and shift the rest).
    const mapping = ingredients.map((input) => ({ input, canonical: canonicalize(input) }));
    return jsonResponse({ normalized, mapping });
  } catch (e) {
    console.error('normalize error:', e && e.constructor && e.constructor.name);
    return safeError(500);
  }
}

// --- POST /api/scan-resep ---
async function scan(request, env, fetchFn) {
  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return safeError(400, 'Expected multipart/form-data');
    }

    const raw = new Uint8Array(await request.arrayBuffer());
    if (!raw.length) {
      return safeError(400, 'Request body kosong.');
    }
    if (raw.length > MAX_TOTAL_BYTES + (MAX_FILES * 4096)) {
      return safeError(413, `Request terlalu besar (maks ${MAX_TOTAL_BYTES / (1024 * 1024)} MB foto).`);
    }
    const { images, allowFallback } = parseMultipart(raw, contentType);

    if (!images.length) {
      return safeError(400, 'Gambar tidak ditemukan dalam request.');
    }
    if (images.length > MAX_FILES) {
      return safeError(400, `Maksimal ${MAX_FILES} foto.`);
    }
    let total = 0;
    for (const img of images) {
      total += img.data.length;
      if (img.data.length > MAX_BYTES_PER_FILE) {
        return safeError(400, `Maksimal ${MAX_BYTES_PER_FILE / (1024 * 1024)} MB per foto.`);
      }
      if (!mimeAllowed(img.mime)) {
        return safeError(400, 'Format gambar tidak didukung.');
      }
      // Content-signature verification (no pixel decode on Workers Free).
      const sigErr = verifyImageSignature(img.data, img.mime);
      if (sigErr) return safeError(sigErr.status, sigErr.message);
    }
    if (total > MAX_TOTAL_BYTES) {
      return safeError(400, `Maksimal ${MAX_FILES} foto, total ${MAX_TOTAL_BYTES / (1024 * 1024)} MB.`);
    }

    // Build data URLs for the provider (base64).
    const dataUrls = images.map((img) => {
      const b64 = base64Encode(img.data);
      return `data:${img.mime};base64,${b64}`;
    });

    // Provider chain from active keys (preferred first).
    const chain = buildProviderChain(env);
    if (!chain.length) {
      return safeError(503, 'Belum ada API key yang dikonfigurasi. Set minimal salah satu: ' +
        PROVIDER_ORDER.map((p) => p.toUpperCase() + '_API_KEY').join(', ') + '.');
    }

    const crossFallback = env.ALLOW_CROSS_PROVIDER_FALLBACK === 'true';
    let providerUsed;
    let modelUsed;
    let recipe;
    try {
      const res = await callVisionWithFallback(dataUrls, chain, fetchFn, crossFallback || allowFallback);
      providerUsed = res.provider;
      modelUsed = res.model;
      recipe = res.recipe;
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.status === 503 && /api key/i.test(e.message)) {
          return safeError(503, 'Belum ada API key yang dikonfigurasi. Set minimal salah satu: ' +
            PROVIDER_ORDER.map((p) => p.toUpperCase() + '_API_KEY').join(', ') + '.');
        }
        return safeError(e.status, e.message);
      }
      console.error('scan error:', e && e.constructor && e.constructor.name);
      return safeError(502, 'Semua provider gagal memproses gambar.');
    }

    // Enrich with alternatives (parity with server.handle_scan).
    const detected = recipe.bahanTerdeteksi || [];
    const query = ingredientQuery(detected);
    const cards = query ? await mixedRecipes(query, fetchFn) : [];
    let alt = rankCards(cards, detected);
    if (!alt.length) {
      alt = recommendedCards(detected);
    }
    if (!alt.length && recipe.menuAlternatif && recipe.menuAlternatif.length) {
      alt = await lookupRecipeCards(recipe.menuAlternatif, detected, fetchFn);
    }
    recipe.menuAlternatif = alt;

    return jsonResponse({
      recipe,
      provider: providerUsed,
      model: modelUsed,
    });
  } catch (e) {
    console.error('scan error:', e && e.constructor && e.constructor.name);
    return safeError(500);
  }
}

function buildProviderChain(env) {
  const chain = [];
  for (const name of PROVIDER_ORDER) {
    const key = env[`${name.toUpperCase()}_API_KEY`];
    if (key) {
      const models = name === 'gemini'
        ? [providerModel(name, env), 'gemini-3.1-flash-lite', 'gemini-2.5-flash']
        : [providerModel(name, env)];
      for (const model of new Set(models)) chain.push({ name, apiKey: key, model });
    }
  }
  return chain;
}

// Base64 encode a Uint8Array in chunks (avoids stack overflow on large inputs).
function base64Encode(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
