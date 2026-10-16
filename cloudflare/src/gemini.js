// AI vision providers for /api/scan-resep.
//
// Faithful JS port of server.py's provider implementations, limited to the
// three most common: Google Gemini (generateContent), OpenAI (chat/completions
// with vision), Anthropic (messages with image blocks). Keys come from
// env/secrets ONLY — never embedded in source or artifacts.
//
// Each provider posts the same SYSTEM_PROMPT + USER_PROMPT and expects pure
// JSON (the validate_recipe contract). Malformed output triggers fallback to
// the next provider (same as call_vision_with_fallback).

const SYSTEM_PROMPT = `Anda adalah "Resep in aja", asisten AI zero-waste dari Indonesia.
Tugas Anda: melihat foto bahan makanan dari kulkas pengguna, lalu menghasilkan SATU resep masakan Indonesia praktis dan 2-3 ide menu alternatif yang memanfaatkan bahan-bahan tersebut. Produk kemasan seperti Indomie boleh dikenali dari label yang terlihat; jangan mengarang isi yang tidak terlihat.

Aturan WAJIB:
1. Identifikasi SEMUA bahan makanan yang terlihat di gambar (termasuk yang layu, sisa, atau potongan).
2. Pilih SATU masakan Indonesia rumahan yang paling masuk akal dibuat dari bahan-bahan tersebut. Hindari masakan rumit. Contoh masakan yang baik: tumis kangkung, orek tempe, sayur asem, capcay, nasi goreng sisa, sayur lodeh, soto sederhana, balado, teri tempe, sup sayur.
3. Pisahkan bahan menjadi dua kelompok:
   - "terdeteksi": bahan yang benar-benar terlihat di gambar dan dipakai di resep.
   - "kurang": bahan dapur umum (pantry staples) yang TIDAK terlihat di gambar tapi biasanya dibutuhkan untuk masakan ini, contoh: minyak goreng, garam, gula, bawang putih, bawang merah, cabai, kecap manis, saus tiram, terasi, kemiri, lengkuas, daun salam, daun jeruk, air, kaldu bubuk. Hanya sebut yang benar-benar relevan untuk resep ini (maksimal 6 item).
4. Langkah memasak: 4-7 langkah singkat, jelas, urutan logis, bahasa sehari-hari Indonesia. Setiap langkah WAJIB menyebut bahan/spesifik kuantitas kasar (mis. "2 siung bawang putih, cincang") dan tindakan konkret (panaskan, tumis, rebus, aduk) serta perkiraan durasi ("±3 menit") bila relevan. Hindari langkah terlalu umum seperti "masak sampai matang" tanpa detail.
5. Estimasi waktu masak (menit) dan porsi.

Format output WAJIB JSON murni (TIDAK boleh ada teks di luar JSON, TIDAK boleh markdown code fence):
{
  "namaMasakan": "string",
  "deskripsi": "string 1-2 kalimat menjelaskan masakan ini",
  "waktuMasak": number (menit),
  "porsi": number,
  "bahanTerdeteksi": ["string", ...],
  "bahanKurang": ["string", ...],
  "langkah": ["string", ...],
  "menuAlternatif": ["English dish name searchable on TheMealDB, e.g. Fried Rice", ...]
}
Untuk menuAlternatif: 2-3 nama hidangan berbeda yang memakai bahan terlihat; jangan mengarang URL atau gambar. Jika hanya satu menu masuk akal, boleh array kosong.`;

const USER_PROMPT = 'Tolong identifikasi SEMUA bahan makanan dari seluruh foto/tampilan yang diberikan (foto bisa berisi beberapa bahan; crop dapat mengulang bahan yang sama, jangan dihitung ganda). Buat satu resep Indonesia yang cocok dari gabungan bahan. Output HANYA JSON sesuai format yang ditentukan.';

// provider ordering mirrors server.PROVIDER_ORDER (subset implemented here).
export const PROVIDER_ORDER = ['gemini', 'openai', 'anthropic'];

// --- validation helpers (port of server.py _bounded_* + validate_recipe) ---
function boundedStr(value, maxLen) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > maxLen) return null;
  return v;
}
function boundedStrList(value, maxItems, maxLen) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out = [];
  for (const item of value) {
    const s = boundedStr(item, maxLen);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}
function boundedPositiveInt(value, maximum) {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > maximum) return null;
  return value;
}

export function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return null;
  const nama = boundedStr(recipe.namaMasakan, 200);
  if (nama === null) return null;
  const deskripsi = boundedStr(recipe.deskripsi, 1000) || '';
  const waktu = boundedPositiveInt(recipe.waktuMasak, 24 * 60);
  const porsi = boundedPositiveInt(recipe.porsi, 1000);
  if (waktu === null || porsi === null) return null;
  const bahanTerdeteksi = boundedStrList(recipe.bahanTerdeteksi, 100, 100);
  const bahanKurang = boundedStrList(recipe.bahanKurang, 50, 100);
  const langkah = boundedStrList(recipe.langkah, 50, 500);
  if (bahanTerdeteksi === null || bahanKurang === null || langkah === null) return null;

  const alt = recipe.menuAlternatif || [];
  if (!Array.isArray(alt) || alt.length > 20) return null;
  const menuAlternatif = [];
  for (const item of alt) {
    if (typeof item === 'string') {
      const s = boundedStr(item, 200);
      if (s === null) return null;
      menuAlternatif.push(s);
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const name = boundedStr(item.nama, 200);
      if (name === null) return null;
      menuAlternatif.push({
        nama: name,
        url: boundedStr(item.url || '', 500) || '',
        thumbnail: boundedStr(item.thumbnail || '', 500) || '',
      });
    } else {
      return null;
    }
  }

  return {
    namaMasakan: nama,
    deskripsi,
    waktuMasak: waktu,
    porsi,
    bahanTerdeteksi,
    bahanKurang,
    langkah,
    menuAlternatif,
  };
}

// --- JSON parsing (port of server.parse_recipe) ---
export function parseRecipe(raw) {
  if (!raw) throw new ProviderError('Resep AI kosong. Coba foto ulang.', false, 502);
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new ProviderError('Format respon AI tidak valid. Coba foto ulang dengan pencahayaan lebih baik.', false, 502);
  }
}

export class ProviderError extends Error {
  constructor(message, retryable = true, status = 502) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

// image data-url -> { mime, b64 } for provider payloads.
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/;

export function imageParts(dataUrls) {
  return (dataUrls || []).map((du) => {
    const m = DATA_URL_RE.exec(String(du).trim());
    if (!m) throw new ProviderError('Format data URL gambar tidak valid.', false, 400);
    return { mime: m[1], b64: m[2].replace(/\s+/g, '') };
  });
}

// --- provider calls ---
export function geminiPayload(dataUrls, model) {
  const parts = imageParts(dataUrls).map(({ mime, b64 }) => ({
    inlineData: { mimeType: mime, data: b64 },
  }));
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '' }, // key injected at call time
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: USER_PROMPT }, ...parts] }],
      generationConfig: { maxOutputTokens: 1500 },
    }),
    extract: (d) => d.candidates[0].content.parts[0].text,
  };
}

export function openaiPayload(dataUrls, model) {
  const imageObjs = imageParts(dataUrls).map(({ mime, b64 }) => ({
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' },
  }));
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' }, // key injected
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [{ type: 'text', text: USER_PROMPT }, ...imageObjs] },
      ],
      max_tokens: 1500,
    }),
    extract: (d) => d.choices[0].message.content,
  };
}

export function anthropicPayload(dataUrls, model) {
  const imageObjs = imageParts(dataUrls).map(({ mime, b64 }) => ({
    type: 'image',
    source: { type: 'base64', media_type: mime, data: b64 },
  }));
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': '', // key injected
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [...imageObjs, { type: 'text', text: USER_PROMPT }] }],
    }),
    extract: (d) => d.content[0].text,
  };
}

// Build the concrete provider request given the active key.
export function providerRequest(name, dataUrls, model, apiKey) {
  let req;
  switch (name) {
    case 'gemini':
      req = geminiPayload(dataUrls, model);
      req.headers['x-goog-api-key'] = apiKey;
      break;
    case 'openai':
      req = openaiPayload(dataUrls, model);
      req.headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'anthropic':
      req = anthropicPayload(dataUrls, model);
      req.headers['x-api-key'] = apiKey;
      break;
    default:
      throw new ProviderError(`Provider tidak dikenal: ${name}`, false, 500);
  }
  return req;
}

// Upstream timeout (ms). Vision models can be slow but must not hang the
// worker indefinitely: a stalled provider otherwise blocks failover and burns
// the Free-plan wall-clock budget until the platform kills the request.
export const PROVIDER_TIMEOUT_MS = 30000;

// Call one provider and validate the schema. Returns {provider, model, recipe}
// or throws ProviderError (retryable for transient/malformed).
export async function callProvider(name, dataUrls, model, apiKey, fetchFn) {
  const req = providerRequest(name, dataUrls, model, apiKey);
  let resp;
  try {
    // AbortSignal.timeout is available on the Workers runtime (compat date
    // 2024-09-23+) and in Node >=17.3. The signal is passed in the init so the
    // real fetch aborts on deadline; injected test fakes simply ignore it.
    resp = await fetchFn(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (e) {
    if ((e && e.name === 'AbortError') || (e && e.name === 'TimeoutError')) {
      throw new ProviderError(`Provider ${name} timeout (${PROVIDER_TIMEOUT_MS}ms).`, true, 502);
    }
    throw new ProviderError(`Provider ${name} tidak dapat dihubungi.`, true, 502);
  }
  if (resp.status === 429 || resp.status >= 500) {
    throw new ProviderError(`Provider ${name} sibuk (${resp.status}).`, true, 502);
  }
  if (resp.status !== 200) {
    // Upstream model/request incompatibility can be model-specific. Local
    // image validation happens before fetch and remains fatal; auth stays fatal.
    const retryable = resp.status === 400 || resp.status === 404;
    throw new ProviderError(`Provider ${name} model ${model} error (${resp.status}).`, retryable, 502);
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new ProviderError('Response provider bukan JSON.', true, 502);
  }
  let text;
  try {
    text = req.extract(data);
  } catch {
    throw new ProviderError('Response provider tidak sesuai format.', true, 502);
  }
  let parsed;
  try { parsed = parseRecipe(text); } catch {
    throw new ProviderError('Jawaban AI kosong atau bukan JSON yang valid.', true, 502);
  }
  const recipe = validateRecipe(parsed);
  if (!recipe) throw new ProviderError('Resep dari AI tidak lolos validasi skema.', true, 502);
  return recipe;
}

// Provider chain: try providers in order until one returns a valid recipe.
export async function callVisionWithFallback(dataUrls, config, fetchFn, allowFallback = null) {
  // config: [{ name, apiKey, model }, ...] in preference order.
  // Without consent, only the initially selected vendor may receive images.
  const chain = config.filter(p => allowFallback === true || p.name === config[0]?.name);
  for (const p of chain) {
    try {
      const recipe = await callProvider(p.name, dataUrls, p.model, p.apiKey, fetchFn);
      return { provider: p.name, model: p.model, recipe };
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) throw e; // bad image/request: stop
      if (p === chain[chain.length - 1]) throw e;
      // else continue to next provider
    }
  }
  throw new ProviderError('Semua provider gagal memproses gambar.', true, 502);
}
