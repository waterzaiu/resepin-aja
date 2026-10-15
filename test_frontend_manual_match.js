// Regression test for the manual ingredient-matching UI path.
//
// Reproduces the reported bug: a sparse manual search (one or two ingredients)
// returns an empty `recipes` array from /api/recipes/match (the backend
// deterministic scoring threshold filters everything out), and the frontend
// previously showed a dead-end message while discarding the backend's
// `ai_results` fallback cards.
//
// Verifies renderDiscoveryResults now:
//   1. Renders `ai_results` fallback cards when `recipes` is empty but
//      `ai_results` is populated (instead of the dead-end "no match" text).
//   2. Still shows a helpful dead-end (with fallback_warning) when BOTH are
//      empty.
//   3. Still renders normal deterministic recipe tiles when `recipes` is
//      non-empty.
//   4. Guards fallback card URLs/images with safeUrl (no `javascript:` leak).
//   5. HTML-escapes fallback card titles.
//
// No network. Pure functions exercised against a minimal DOM stub.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'resep-in-aja.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert(m, 'no inline script found');
const script = m[1];

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
const manualResults = new Element('div');
const manualForm = new Element('form');
const manualIngredients = new Element('input');
const filterCuisine = new Element('select');
const filterDiet = new Element('select');
const filterMaxTime = new Element('input');

const elements = {
  manualForm, manualIngredients, manualResults, filterCuisine, filterDiet, filterMaxTime,
};

const documentStub = {
  getElementById: (id) => elements[id] || el(id),
  createElement: (tag) => new Element(tag),
};
const windowStub = { addEventListener() {} };

const fn = new Function(
  'document', 'window', 'navigator', 'fetch',
  script + '\n; return { renderDiscoveryResults, escapeHtml, safeUrl };'
);
const result = fn(documentStub, windowStub, { mediaDevices: {} }, () => Promise.reject(new Error('no fetch')));

// --- 1. recipes empty + ai_results populated => fallback cards rendered ---
manualResults.innerHTML = '';
const fallbackData = {
  recipes: [],
  source: 'ai_fallback',
  fallback: true,
  fallback_warning: 'Hasil hanya dari AI (belum diverifikasi). Periksa resep sebelum memasak.',
  ai_results: [
    { title: 'Chicken Fried Rice', image_url: 'https://x/1.jpg', source_url: 'https://x/1', source_name: 'TheMealDB', attribution_text: 'From TheMealDB' },
    { title: 'Omelette', image_url: 'https://x/2.jpg', source_url: 'https://x/2', source_name: 'TheMealDB' },
  ],
};
result.renderDiscoveryResults(manualResults, fallbackData);
const out1 = manualResults.innerHTML;
assert(out1.includes('Chicken Fried Rice'), 'fallback card title missing');
assert(out1.includes('Omelette'), 'second fallback card missing');
assert(out1.includes('saran terkait'), 'fallback warning banner missing');
assert(!out1.includes('Tidak ada resep yang cocok'), 'dead-end text must NOT appear when fallback cards exist');
console.log('fallback cards rendered when recipes empty + ai_results present');

// --- 2. both empty => helpful dead-end with fallback_warning ---
manualResults.innerHTML = '';
result.renderDiscoveryResults(manualResults, { recipes: [], ai_results: [], fallback: true, fallback_warning: 'Hasil hanya dari AI (belum diverifikasi).' });
const out2 = manualResults.innerHTML;
assert(out2.includes('Tidak ada resep yang cocok'), 'dead-end message missing');
assert(out2.includes('Hasil hanya dari AI'), 'fallback_warning not surfaced in dead-end');
console.log('dead-end with fallback_warning shown when both empty');

// --- 3. non-empty recipes => normal deterministic tiles (unchanged behavior) ---
manualResults.innerHTML = '';
result.renderDiscoveryResults(manualResults, {
  recipes: [{ title: 'Nasi Goreng', cuisine: 'Indonesian', matchScore: 0.74, matchedIngredients: ['rice', 'egg'], missingIngredients: ['shallot'], total_minutes: 20, source_name: 'Resep in aja' }],
  source: 'deterministic',
  fallback: false,
});
const out3 = manualResults.innerHTML;
assert(out3.includes('Nasi Goreng'), 'deterministic tile title missing');
assert(out3.includes('Skor kecocokan: 74%'), 'matchScore % rendering wrong');
console.log('deterministic tiles still render when recipes non-empty');

// --- 4. safeUrl guard: javascript: source_url must not become a link ---
manualResults.innerHTML = '';
result.renderDiscoveryResults(manualResults, {
  recipes: [],
  ai_results: [{ title: 'Evil', image_url: 'https://x/1.jpg', source_url: 'javascript:alert(1)', source_name: 'X' }],
  fallback: true,
});
const out4 = manualResults.innerHTML;
assert(!out4.includes('javascript:'), 'javascript: URL leaked into fallback card');
assert(!out4.includes('<a '), 'unsafe URL must not produce an <a> element');
assert(out4.includes('Evil'), 'card title still rendered when link is unsafe');
console.log('unsafe fallback source_url dropped (rendered as plain div)');

// --- 5. HTML escaping of fallback card title ---
manualResults.innerHTML = '';
result.renderDiscoveryResults(manualResults, {
  recipes: [],
  ai_results: [{ title: '<img src=x onerror=alert(1)>', image_url: '', source_url: '', source_name: 'X' }],
  fallback: true,
});
const out5 = manualResults.innerHTML;
assert(!out5.includes('<img src=x'), 'fallback title not escaped');
console.log('fallback card title HTML-escaped');

// --- 6. layout regression: full-width single-column discovery grid ---
// The discovery results must NOT use the 3-column `.recipe-grid` (which
// collapses to ~100px cells inside the ~360px sidebar and word-wraps/clips).
manualResults.innerHTML = '';
result.renderDiscoveryResults(manualResults, {
  recipes: [{ title: 'Seafood rice', cuisine: 'Asian', matchScore: 0.81, matchedIngredients: ['rice', 'seafood'], missingIngredients: ['lemon'], total_minutes: 25, source_name: 'TheMealDB', attribution_text: 'Recipe data & image from TheMealDB (themealdb.com)' }],
  source: 'deterministic',
  fallback: false,
});
const out6 = manualResults.innerHTML;
assert(out6.includes('class="discovery-grid"'), 'must render full-width discovery-grid');
assert(!out6.includes('class="recipe-grid"'), 'must NOT use 3-col recipe-grid for discovery results');
assert(out6.includes('class="discovery-card"'), 'discovery-card wrapper missing');
assert(out6.includes('Sumber: TheMealDB'), 'readable source attribution missing');
assert(out6.includes('Recipe data &amp; image from TheMealDB (themealdb.com)'), 'full attribution text must not be clipped/truncated');
assert(out6.includes('Seafood rice'), 'readable title missing');
console.log('discovery results use full-width single-column layout with intact attribution');

// --- 7. fallback (ai_results) cards also use full-width layout ---
manualResults.innerHTML = '';
result.renderDiscoveryResults(manualResults, {
  recipes: [],
  ai_results: [{ title: 'Seafood rice', image_url: 'https://x/1.jpg', source_url: 'https://x/1', source_name: 'TheMealDB', attribution_text: 'Recipe data & image from TheMealDB (themealdb.com)' }],
  fallback: true,
});
const out7 = manualResults.innerHTML;
assert(out7.includes('class="discovery-grid"'), 'fallback cards must use full-width discovery-grid');
assert(!out7.includes('class="recipe-grid"'), 'fallback cards must NOT use recipe-grid');
assert(out7.includes('class="discovery-warning"'), 'warning box must use styled discovery-warning class');
assert(out7.includes('class="discovery-media"'), 'fallback card image must use fixed aspect-ratio media');
console.log('fallback cards use full-width layout with styled warning');

console.log('\nAll manual-ingredient-matching regression checks passed.');
