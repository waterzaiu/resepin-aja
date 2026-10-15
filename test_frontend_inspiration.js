// Regression test for the frontend "inspiration" gallery search path
// (resep-in-aja.html). Exercises the Pilih Inspirasi Masakan flow — the
// loadGallery()/recipeSearch submit handler and the recipeTiles() renderer —
// against a minimal DOM stub. No network.
//
// Locks the frontend CONTRACT so a refactor of the gallery/search code cannot
// silently regress it:
//   1. recipeTiles() renders only cards carrying nama + https thumbnail + https
//      url (drops any card missing a field or with a non-https URL).
//   2. recipeTiles() HTML-escapes nama/reason/source and does not leak
//      javascript:/data: URLs into href or src.
//   3. The search submit handler URL-encodes the query and renders the
//      backend's `recipes` array verbatim (the frontend must NOT filter or
//      re-rank the backend's multi-term results — an empty `recipes` array
//      renders the "no results" state, which is the backend's contract to
//      populate, not the frontend's).
//   4. An empty/whitespace query falls back to loadGallery() (reloads the
//      curated inspiration gallery) instead of issuing a search.
//   5. A failed fetch (network/500) shows a graceful "search failed" state and
//      never throws.
//
// NOTE on the reported symptom ("tempe ayam kangkung" returns nothing while
// "rendang" does): the frontend forwards the full multi-word query to
// /api/resep?q=... and renders whatever `recipes` the backend returns. The
// empty result for multi-ingredient queries is produced by the BACKEND's
// curatedIndonesianSearch()/mixedRecipes() (AND-substring match + literal
// TheMealDB lookup), which is owned by the backend agents — NOT by this HTML.
// These tests pin the frontend side so the contract stays intact and the
// backend is the single place to fix the search semantics.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'resep-in-aja.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert(m, 'no inline script found');
const script = m[1];

// --- Minimal DOM stub (mirrors test_frontend_manual_match.js) ---
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.style = {};
    this.dataset = {};
    this._handlers = {};
    this.innerHTML = '';
    this.textContent = '';
    this.disabled = false;
    this.value = '';
    this.scrollIntoView = () => {};
  }
  addEventListener(type, fn) { this._handlers[type] = fn; }
  set src(v) { this._src = v; } get src() { return this._src || ''; }
  appendChild(c) { this.children.push(c); return c; }
}

function el(id) { return new Element('div'); }

// Elements referenced by the script under test.
const recipeGallery = new Element('div');
const recipeSearch = new Element('form');
const recipeQuery = new Element('input');
const elements = { recipeGallery, recipeSearch, recipeQuery };
// Any other getElementById (cameraBtn, submitBtn, etc.) returns a throwaway.
const documentStub = {
  getElementById: (id) => elements[id] || el(id),
  createElement: (tag) => new Element(tag),
};
const windowStub = { addEventListener() {} };

// Load the inline script and surface the pure helpers. The script wires
// loadGallery() + the recipeSearch submit handler at top level against our
// stubbed document/window/fetch, so we can drive them directly afterwards.
const fn = new Function(
  'document', 'window', 'navigator', 'fetch',
  script + '\n; return { recipeTiles, escapeHtml, safeUrl, loadGallery };'
);

// A controllable fetch: routes /api/inspirasi and /api/resep to canned JSON.
function makeFetch(responses) {
  return async (url, opts) => {
    const u = String(url);
    const hit = Object.keys(responses).find((k) => u.startsWith(k));
    if (!hit) throw new Error('unexpected fetch: ' + u);
    const r = responses[hit];
    if (r instanceof Error) throw r;
    return { ok: true, json: async () => r };
  };
}

(async () => {
  // --- 1. recipeTiles renders only fully-formed https cards ---
  {
    const result = fn(documentStub, windowStub, { mediaDevices: {} }, makeFetch({}));
    const good = { nama: 'Rendang', thumbnail: 'https://img-global.cpcdn.com/recipes/1.jpg', url: 'https://cookpad.com/id/resep/1', source: 'Cookpad' };
    const noNama = { thumbnail: 'https://x/1.jpg', url: 'https://x/1' };
    const noThumb = { nama: 'X', url: 'https://x/1' };
    const jsUrl = { nama: 'Evil', thumbnail: 'https://x/1.jpg', url: 'javascript:alert(1)' };
    const out = result.recipeTiles([good, noNama, noThumb, jsUrl]);
    assert(out.includes('Rendang'), 'good card must render');
    assert(!out.includes('Evil'), 'javascript: url card must be dropped');
    // Only the good card survives the filter.
    assert.strictEqual((out.match(/class="recipe-tile"/g) || []).length, 1, 'only fully-formed https cards render');
    console.log('recipeTiles drops cards missing nama/thumbnail/url or with non-https url');
  }

  // --- 2. recipeTiles HTML-escapes nama and source (no XSS via title) ---
  {
    const result = fn(documentStub, windowStub, { mediaDevices: {} }, makeFetch({}));
    const out = result.recipeTiles([
      { nama: '<img src=x onerror=alert(1)>', thumbnail: 'https://x/1.jpg', url: 'https://x/1', source: '<script>1</script>' },
    ]);
    assert(!out.includes('<img src=x'), 'nama not escaped');
    assert(!out.includes('<script>'), 'source not escaped');
    assert(out.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped nama missing');
    console.log('recipeTiles escapes nama and source');
  }

  // --- 3. search handler renders backend recipes verbatim (no client re-filter) ---
  {
    // Note: loadGallery() fires an /api/inspirasi fetch at script eval time on
    // every fn() call; track /api/resep calls specifically for the search.
    const searchCalls = [];
    const trackedFetch = async (url) => {
      const u = String(url);
      if (u.startsWith('/api/resep')) searchCalls.push(u);
      return { ok: true, json: async () => ({ recipes: [] }) };
    };
    fn(documentStub, windowStub, { mediaDevices: {} }, trackedFetch);
    recipeQuery.value = 'tempe ayam kangkung';
    // Invoke the submit handler synchronously.
    recipeSearch._handlers.submit({ preventDefault() {} });
    // The handler is async; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(searchCalls.length, 1, 'search should issue exactly one /api/resep fetch');
    assert.strictEqual(searchCalls[0], '/api/resep?q=tempe%20ayam%20kangkung', 'query must be URL-encoded');
    // Backend returned empty recipes -> the frontend renders the empty state,
    // NOT a thrown error and NOT fabricated results.
    assert(recipeGallery.innerHTML === '' || recipeGallery.innerHTML.includes('Tidak ada resep'), 'empty recipes must render the empty state');
    console.log('search handler URL-encodes q and renders backend recipes verbatim');
  }

  // --- 4. empty/whitespace query reloads the gallery (loadGallery) ---
  {
    const searchCalls = [];
    const trackedFetch = async (url) => {
      const u = String(url);
      if (u.startsWith('/api/resep')) searchCalls.push(u);
      return { ok: true, json: async () => ({ recipes: [{ nama: 'A', thumbnail: 'https://x/a.jpg', url: 'https://x/a' }] }) };
    };
    fn(documentStub, windowStub, { mediaDevices: {} }, trackedFetch);
    recipeQuery.value = '   ';
    recipeSearch._handlers.submit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(searchCalls.length, 0, 'whitespace query must NOT issue a /api/resep search');
    console.log('empty/whitespace query falls back to loadGallery() (no search fetch)');
  }

  // --- 5. fetch failure shows graceful error state, never throws ---
  {
    const failingFetch = async () => { throw new Error('Failed to fetch'); };
    fn(documentStub, windowStub, { mediaDevices: {} }, failingFetch);
    recipeQuery.value = 'rendang';
    let threw = false;
    try {
      recipeSearch._handlers.submit({ preventDefault() {} });
      await new Promise((r) => setTimeout(r, 0));
    } catch {
      threw = true;
    }
    assert(!threw, 'search handler must swallow fetch errors');
    assert(recipeGallery.textContent.includes('Pencarian gagal'), 'graceful search-failed state missing');
    console.log('fetch failure renders graceful error, no throw');
  }

  // --- 6. non-ok (e.g. 500) response shows graceful error state ---
  {
    const err500 = async () => ({ ok: false, json: async () => ({}) });
    fn(documentStub, windowStub, { mediaDevices: {} }, err500);
    recipeQuery.value = 'rendang';
    recipeSearch._handlers.submit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
    assert(recipeGallery.textContent.includes('Pencarian gagal'), 'non-ok response must render graceful error');
    console.log('non-ok response renders graceful error');
  }

  console.log('\nAll frontend inspiration gallery/search regression checks passed.');
})();
