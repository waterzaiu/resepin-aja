// Ingredient normalization, multilingual aliases, pantry detection.
//
// Faithful JS port of ../ingredients.py. Deterministic (no network, no LLM)
// so matching and tests rely on stable output. Kept in lockstep with the
// Python source of truth; when one changes, update the other.

// id -> en aliases (Indonesian primary second language).
export const INGREDIENT_ALIASES = {
  telur: 'egg', ayam: 'chicken', 'daging ayam': 'chicken',
  kentang: 'potato', nasi: 'rice', beras: 'rice',
  mie: 'noodles', mi: 'noodles', indomie: 'noodles',
  ikan: 'fish', udang: 'shrimp', daging: 'beef',
  'daging sapi': 'beef', sapi: 'beef', tomat: 'tomato',
  jamur: 'mushroom', wortel: 'carrot', bayam: 'spinach',
  kangkung: 'water spinach', tahu: 'tofu', tempe: 'tempeh',
  kacang: 'beans', pisang: 'banana', keju: 'cheese',
  roti: 'bread', bawang: 'onion', 'bawang merah': 'shallot',
  'bawang putih': 'garlic', cabai: 'chili', cabe: 'chili',
  santan: 'coconut milk', kelapa: 'coconut', jagung: 'corn',
  ubi: 'sweet potato', singkong: 'cassava', terong: 'eggplant',
  brokoli: 'broccoli', kol: 'cabbage', kubis: 'cabbage',
  sawi: 'mustard greens', buncis: 'green beans', lada: 'pepper',
  merica: 'pepper', gula: 'sugar', garam: 'salt', minyak: 'oil',
  'minyak goreng': 'oil', kecap: 'soy sauce', 'kecap manis': 'sweet soy sauce',
  tepung: 'flour', 'tepung terigu': 'flour', susu: 'milk', mentega: 'butter',
  'daun bawang': 'scallion', air: 'water', jeruk: 'lime',
  'jeruk nipis': 'lime', 'jeruk lemon': 'lemon', cuka: 'vinegar',
  terasi: 'shrimp paste', 'saus tiram': 'oyster sauce', kaldu: 'stock',
  // English identity terms.
  egg: 'egg', chicken: 'chicken', potato: 'potato', rice: 'rice',
  noodles: 'noodles', noodle: 'noodles', fish: 'fish', shrimp: 'shrimp',
  prawn: 'shrimp', beef: 'beef', tomato: 'tomato', mushroom: 'mushroom',
  carrot: 'carrot', spinach: 'spinach', tofu: 'tofu', tempeh: 'tempeh',
  beans: 'beans', banana: 'banana', cheese: 'cheese', bread: 'bread',
  onion: 'onion', shallot: 'shallot', garlic: 'garlic', chili: 'chili',
  chilli: 'chili', coconut: 'coconut', 'coconut milk': 'coconut milk',
  corn: 'corn', 'sweet potato': 'sweet potato', cassava: 'cassava',
  eggplant: 'eggplant', aubergine: 'eggplant', broccoli: 'broccoli',
  cabbage: 'cabbage', pepper: 'pepper', sugar: 'sugar', salt: 'salt',
  oil: 'oil', 'soy sauce': 'soy sauce', 'sweet soy sauce': 'sweet soy sauce',
  flour: 'flour', milk: 'milk', butter: 'butter', scallion: 'scallion',
  'spring onion': 'scallion', water: 'water', lime: 'lime', lemon: 'lemon',
  vinegar: 'vinegar', 'oyster sauce': 'oyster sauce', stock: 'stock',
};

export const PANTRY_ITEMS = new Set([
  'salt', 'water', 'oil', 'sugar', 'pepper', 'salt and pepper',
]);

export const NON_INGREDIENT = new Set([
  'rasa', 'goreng', 'segar', 'bungkus', 'buah', 'potong', 'merk', 'kemasan',
  'bahan', 'dapur', 'sisa', 'seperempat', 'setengah', 'iris', 'cincang',
  'gram', 'kg', 'ml', 'sendok', 'sdt', 'sdm', 'buah', 'butir', 'siung',
]);

// Canonical English term for each alias, longest key first (so "daging sapi"
// beats "sapi"). Deterministic, matches ingredients.py `canonicalize`.
export function canonicalize(ingredient) {
  if (ingredient === null || ingredient === undefined) return null;
  let text = String(ingredient).trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const keys = Object.keys(INGREDIENT_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of keys) {
    if (text === alias) return INGREDIENT_ALIASES[alias];
  }
  const words = text.split(' ').filter((w) => !NON_INGREDIENT.has(w) && w.length > 1);
  if (!words.length) return null;
  const translated = words.map((w) => INGREDIENT_ALIASES[w] || w);
  if (words.some((w) => INGREDIENT_ALIASES[w])) {
    const joined = [...new Set(translated)].join(' ');
    if (Object.values(INGREDIENT_ALIASES).includes(joined)) return joined;
    return INGREDIENT_ALIASES[words[0]] || translated[0];
  }
  return [...new Set(translated)].join(' ');
}

export function normalizeIngredients(ingredients) {
  if (!Array.isArray(ingredients)) return [];
  const seen = new Set();
  const out = [];
  for (const item of ingredients) {
    const canon = canonicalize(item);
    if (canon && !seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

export function isPantry(canonicalIngredient) {
  return PANTRY_ITEMS.has(canonicalIngredient);
}

export function aliasLanguages(ingredient) {
  const target = canonicalize(ingredient);
  if (!target) return [];
  return Object.keys(INGREDIENT_ALIASES)
    .filter((a) => INGREDIENT_ALIASES[a] === target)
    .sort();
}

// Deterministic allergen derivation from the actual ingredient catalog, NOT
// from an LLM (port of recipe_discovery.derive_allergens + ALLERGEN_INGREDIENT_MAP).
// Unknown ingredients map to no allergen (fail-safe: never invent one).
export const ALLERGEN_INGREDIENT_MAP = {
  milk: 'milk', butter: 'milk', cream: 'milk', cheese: 'milk', yogurt: 'milk',
  egg: 'egg', soy: 'soy', 'soy sauce': 'soy', tofu: 'soy', tempeh: 'soy',
  wheat: 'gluten', flour: 'gluten', bread: 'gluten', noodles: 'gluten',
  pasta: 'gluten', fish: 'fish', shrimp: 'shellfish', prawn: 'shellfish',
  crab: 'shellfish', lobster: 'shellfish', peanut: 'peanut', almond: 'tree nut',
  cashew: 'tree nut', walnut: 'tree nut', hazelnut: 'tree nut', sesame: 'sesame',
  tahini: 'sesame',
};

// Common phrases that would otherwise produce a FALSE allergen via naive token
// matching ("coconut milk" is not dairy, "peanut butter" is peanut not dairy).
const ALLERGEN_FALSE_POSITIVE_PHRASES = {
  'coconut milk': new Set(['milk']),
  'coconut cream': new Set(['milk']),
  'soy milk': new Set(['milk']),
  'almond milk': new Set(['milk']),
  'oat milk': new Set(['milk']),
  'peanut butter': new Set(['milk']),
  'cocoa butter': new Set(['milk']),
  'shea butter': new Set(['milk']),
  'coconut butter': new Set(['milk']),
};

export function deriveAllergens(ingredientNames) {
  const allergens = new Set();
  for (const raw of ingredientNames || []) {
    const text = String(raw).trim().toLowerCase();
    if (!text) continue;
    // Apply false-positive suppression first, keyed on the whole phrase.
    const suppress = new Set();
    for (const [phrase, tags] of Object.entries(ALLERGEN_FALSE_POSITIVE_PHRASES)) {
      if (text.includes(phrase)) for (const t of tags) suppress.add(t);
    }
    for (const [key, tag] of Object.entries(ALLERGEN_INGREDIENT_MAP)) {
      let matched = false;
      if (text === key) matched = true;
      else if (key.includes(' ') && ` ${text} `.includes(` ${key} `)) matched = true;
      else if (!key.includes(' ') && text.split(' ').includes(key)) matched = true;
      if (matched && !suppress.has(tag)) allergens.add(tag);
    }
  }
  return [...allergens].sort();
}
