// Node harness: extract the inline <script> from resep-in-aja.html and run it
// against a minimal DOM stub to verify (a) JS syntax, (b) recipeTiles renders
// reason + recommended + source, (c) youtubeSearchLink produces an encoded
// search URL (no fabricated video URL), and (d) renderResult builds DOM
// including the Astro button and empty-state.
//
// No network, no live AI. Only functions reachable without browser APIs are
// exercised; DOM interactions are stubbed.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'resep-in-aja.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert(m, 'no inline script found');
const script = m[1];

// Minimal element stub.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = { add(){}, remove(){}, toggle(){} };
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
  set src(v){ this._src = v; } get src(){ return this._src || ''; }
  appendChild(c){ this.children.push(c); return c; }
}

function el(id) { return new Element('div'); }
el.cameraBtn = new Element('button');
el.uploadBtn = new Element('button');
el.cameraInput = new Element('input');
el.fileInput = new Element('input');
el.previewImg = new Element('img');
el.cameraVideo = new Element('video');
el.previewEmpty = new Element('div');
el.clearBtn = new Element('button');
el.submitBtn = new Element('button');
el.loadingBox = new Element('div');
el.errorBox = new Element('div');
el.errorMsg = new Element('p');
el.retryBtn = new Element('button');
el.tipsBox = new Element('div');
el.resultContainer = new Element('div');
el.hero = new Element('section');
el.recipeGallery = new Element('div');
el.viralGallery = new Element('div');
el.recipeSearch = new Element('form');
el.recipeQuery = new Element('input');
el.recipeChooser = new Element('section');
el.inputCard = new Element('div');
el.photoCount = new Element('p');

const elements = {
  cameraBtn: el.cameraBtn, uploadBtn: el.uploadBtn, cameraInput: el.cameraInput,
  fileInput: el.fileInput, previewImg: el.previewImg, cameraVideo: el.cameraVideo,
  previewEmpty: el.previewEmpty, clearBtn: el.clearBtn, submitBtn: el.submitBtn,
  loadingBox: el.loadingBox, errorBox: el.errorBox, errorMsg: el.errorMsg,
  retryBtn: el.retryBtn, tipsBox: el.tipsBox, resultContainer: el.resultContainer,
  hero: el.hero, recipeGallery: el.recipeGallery, viralGallery: el.viralGallery,
  recipeSearch: el.recipeSearch, recipeQuery: el.recipeQuery, recipeChooser: el.recipeChooser,
  inputCard: el.inputCard, photoCount: el.photoCount,
};

const documentStub = {
  getElementById: (id) => elements[id] || el(id),
  createElement: (tag) => new Element(tag),
};

const windowStub = {
  addEventListener(){},
};

// Evaluate the script body but skip top-level DOM setup that references real
// browser APIs we can't fully stub (camera, fetch). We only need the pure
// helper functions. Evaluate in a sandbox via new Function with stubbed globals.
const fn = new Function(
  'document', 'window', 'navigator', 'fetch',
  script + '\n; return { recipeTiles, youtubeSearchLink, escapeHtml, safeUrl, UPLOAD_POLICY, ALLOWED_IMAGE_TYPES, renderResult };'
);

let result;
try {
  result = fn(
    documentStub,
    windowStub,
    { mediaDevices: {} },
    () => Promise.reject(new Error('no fetch in test'))
  );
} catch (e) {
  console.error('SCRIPT EVALUATION FAILED:', e.message);
  process.exit(1);
}

console.log('JS syntax OK (script evaluated)');

// --- Test youtubeSearchLink ---
const yt = result.youtubeSearchLink('Nasi Goreng');
assert(yt.startsWith('https://www.youtube.com/results?search_query='), 'yt base wrong: ' + yt);
assert(!/youtube\.com\/watch/.test(yt), 'must NOT be a fabricated watch URL');
assert(yt.includes(encodeURIComponent('resep Nasi Goreng')), 'dish name not encoded in query');
console.log('youtubeSearchLink OK:', yt);

// --- Test recipeTiles renders reason + recommended ---
const cards = [
  { nama: 'Nasi Goreng', thumbnail: 'https://x/1.jpg', url: 'https://x/1', reason: 'nasi', recommended: true, source: 'Cookpad' },
  { nama: 'Ice Cream', thumbnail: 'https://x/2.jpg', url: 'https://x/2', source: 'Cookpad' },
];
const tiles = result.recipeTiles(cards);
assert(tiles.includes('⭐ Recommended'), 'recommended tag missing');
assert(tiles.includes('Relevan: nasi'), 'reason not shown');
assert(tiles.includes('Cookpad'), 'source fallback missing for non-reason card');
// HTML-escape active
const evil = result.recipeTiles([{ nama: '<script>x</script>', thumbnail: 'https://x/1.jpg', url: 'https://x/1' }]);
assert(!/<script>x<\/script>/.test(evil), 'unescaped HTML in title');
console.log('recipeTiles OK (recommended + reason + escape)');

// --- Test renderResult builds DOM with Astro button + empty-state + YouTube ---
// renderResult references document.getElementById inside; our stub returns
// Elements. It also touches imagePreviewUrl (module-scoped let) — set via the
// returned closure is not possible; instead verify via a captured stub that
// resultContainer.innerHTML gets populated.
el.resultContainer.innerHTML = '';
const recipe = {
  namaMasakan: 'Nasi Goreng',
  deskripsi: 'desc',
  waktuMasak: 15,
  porsi: 2,
  bahanTerdeteksi: ['nasi', 'telur'],
  bahanKurang: ['kecap manis', 'garam'],
  langkah: ['Panaskan minyak ±2 menit', 'Tumis 2 siung bawang putih'],
  menuAlternatif: [],
};
result.renderResult(recipe, 'gemini', 'gemini-1.5-flash');
const htmlOut = el.resultContainer.innerHTML;
assert(htmlOut.includes('Terdapat di Astro $$?'), 'Astro button missing');
assert(htmlOut.includes('Belum ada resep tambahan'), 'empty-state missing for empty menuAlternatif');
assert(htmlOut.includes('youtube.com/results'), 'YouTube link missing');
assert(htmlOut.includes('Tutorial Video'), 'YouTube button label missing');
console.log('renderResult OK (Astro button + empty-state + YouTube link)');

// --- Test renderResult with non-empty menuAlternatif shows grid, no empty-state ---
el.resultContainer.innerHTML = '';
const recipe2 = { ...recipe, menuAlternatif: [
  { nama: 'Fried Rice', thumbnail: 'https://x/1.jpg', url: 'https://x/1', reason: 'rice', source: 'TheMealDB' },
]};
result.renderResult(recipe2, 'gemini', 'gemini-1.5-flash');
const htmlOut2 = el.resultContainer.innerHTML;
assert(!htmlOut2.includes('Belum ada resep tambahan'), 'empty-state should be absent');
assert(htmlOut2.includes('Relevan: rice'), 'reason missing in alternatif tile');
console.log('renderResult OK (menuAlternatif grid + reason)');

// --- Test safeUrl rejects non-https / dangerous schemes ---
assert(result.safeUrl('https://cookpad.com/id/resep/1') === true, 'https should pass');
assert(result.safeUrl('https://evil.com/x') === true, 'https host-agnostic should pass');
assert(result.safeUrl('javascript:alert(1)') === false, 'javascript: scheme must be rejected');
assert(result.safeUrl('data:text/html,<script>') === false, 'data: scheme must be rejected');
assert(result.safeUrl('vbscript:msgbox') === false, 'vbscript: scheme must be rejected');
assert(result.safeUrl('  https://x/1  ') === true, 'trimmed https should pass');
assert(result.safeUrl('http://x/1') === false, 'plain http should be rejected');
assert(result.safeUrl('') === false, 'empty URL rejected');
assert(result.safeUrl(null) === false, 'null URL rejected');
console.log('safeUrl OK (https allowlist, dangerous schemes rejected)');

// --- Test recipeTiles drops unsafe URLs (defense-in-depth on dynamic URLs) ---
const unsafeTiles = result.recipeTiles([
  { nama: 'Bad', thumbnail: 'https://x/1.jpg', url: 'javascript:alert(1)' },
  { nama: 'Good', thumbnail: 'https://x/2.jpg', url: 'https://x/2' },
]);
assert(!unsafeTiles.includes('javascript:'), 'javascript: URL must not be rendered');
assert(unsafeTiles.includes('Good'), 'safe https URL must still render');
console.log('recipeTiles OK (unsafe dynamic URLs dropped)');

// --- Test UPLOAD_POLICY constants are defined and sane ---
const up = result.UPLOAD_POLICY;
assert(up && up.maxFiles === 5, 'maxFiles must be 5');
assert(up.maxBytesPerFile === 4 * 1024 * 1024, 'maxBytesPerFile must be 4 MB');
assert(up.maxTotalBytes === 12 * 1024 * 1024, 'maxTotalBytes must be 12 MB');
assert(up.maxDecodedPixels === 16 * 1000 * 1000, 'maxDecodedPixels must be 16M');
assert(Array.isArray(result.ALLOWED_IMAGE_TYPES), 'ALLOWED_IMAGE_TYPES must be array');
assert(result.ALLOWED_IMAGE_TYPES.includes('image/jpeg'), 'jpeg allowed');
assert(result.ALLOWED_IMAGE_TYPES.includes('image/png'), 'png allowed');
assert(result.ALLOWED_IMAGE_TYPES.includes('image/webp'), 'webp allowed');
assert(!result.ALLOWED_IMAGE_TYPES.includes('image/gif'), 'gif must be excluded per policy');
console.log('UPLOAD_POLICY OK (5 files / 4MB each / 12MB total / 16M pixels)');

// --- Test renderResult includes food-safety notice ---
assert(htmlOut.includes('Keamanan pangan'), 'food-safety notice missing');
assert(htmlOut.includes('matang sempurna'), 'food-safety guidance missing');
console.log('renderResult OK (food-safety notice present)');

console.log('\nAll frontend harness checks passed.');
