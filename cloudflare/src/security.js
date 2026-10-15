// Security helpers: image validation (no Pillow), multipart parsing, CSP,
// origin/host checks, safe error responses.
//
// KEY DIFFERENCE FROM THE PYTHON SERVER — documented honestly:
//
//   The Python server uses Pillow to (1) decode the image and verify it is a
//   real, non-truncated image, (2) enforce width/height/decoded-pixel limits
//   (decompression-bomb guard), (3) strip EXIF/GPS metadata, (4) flatten
//   animated GIFs, and (5) re-encode to JPEG.
//
//   Cloudflare Workers Free has a ~10ms CPU budget and no Pillow/native image
//   codec. Decoding arbitrary image formats in JS is not feasible within that
//   budget, and pulling in a WASM codec would blow the bundle + CPU limits.
//   Therefore this worker CANNOT decode/re-encode images. It applies the
//   following STRICTER byte-level checks instead:
//
//     * file-size caps (per-file and total) — identical limits to Python
//     * file-count cap — identical
//     * MIME allowlist (jpeg/png/webp/gif) — identical
//     * magic-byte (content signature) verification — verifies the declared
//       format is the actual format WITHOUT decoding pixels
//     * rejection of any file whose magic bytes do not match a claimed type
//
//   What is NOT enforced here (and IS in Python): decoded pixel dimensions,
//   decompression-bomb protection, EXIF/GPS metadata stripping, GIF flattening,
//   JPEG re-encode. The images are forwarded as-is to the AI provider.
//
//   This is a REDUCED validation guarantee vs. the Python deployment. It must
//   not be marketed as identical. The upload limits are enforced and content
//   signatures are verified, but the image is never decoded server-side.

export const MAX_FILES = 5;
export const MAX_BYTES_PER_FILE = 4 * 1024 * 1024; // 4 MB
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024; // 12 MB

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Magic-byte signatures for the four supported formats.
const SIGNATURES = [
  { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { mime: 'image/gif', test: (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  // WebP: "RIFF" .... "WEBP"
  { mime: 'image/webp', test: (b) => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

// Verify a file's declared MIME matches its actual magic bytes.
// Returns a ProviderError-like {message, status} on failure, null on success.
export function verifyImageSignature(bytes, mime) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const sig of SIGNATURES) {
    if (sig.mime === mime) {
      if (!sig.test(u8)) {
        return { message: 'Gambar rusak atau bukan gambar valid.', status: 400 };
      }
      return null;
    }
  }
  return { message: 'Format gambar tidak didukung.', status: 400 };
}

export function mimeAllowed(mime) {
  return ALLOWED_MIME.has(mime);
}

// --- Multipart parsing (minimal, safe, no external deps) ---
// Extracts parts named "image" (with content-type) and "allowFallback".
// Returns { images: [{data: Uint8Array, mime: string}], allowFallback: bool|null }.
export function parseMultipart(rawBytes, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return { images: [], allowFallback: null };
  const boundary = m[1] || m[2];
  const delimiter = new TextEncoder().encode(`--${boundary}`);

  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const images = [];
  let allowFallback = null;

  let idx = 0;
  const parts = [];
  let start = 0;
  // Split by delimiter bytes.
  const positions = [];
  for (let i = 0; i + delimiter.length <= bytes.length; i++) {
    let match = true;
    for (let j = 0; j < delimiter.length; j++) {
      if (bytes[i + j] !== delimiter[j]) { match = false; break; }
    }
    if (match) positions.push(i);
  }

  for (let p = 0; p < positions.length; p++) {
    const segStart = positions[p] + delimiter.length;
    const segEnd = p + 1 < positions.length ? positions[p + 1] : bytes.length;
    let seg = bytes.slice(segStart, segEnd);
    // strip leading \r\n and trailing \r\n
    if (seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.slice(2);
    if (seg[seg.length - 2] === 0x0d && seg[seg.length - 1] === 0x0a) seg = seg.slice(0, -2);
    parts.push(seg);
  }

  for (const seg of parts) {
    if (!seg.length) continue;
    // find \r\n\r\n header/body separator
    let sep = -1;
    for (let i = 0; i + 3 < seg.length; i++) {
      if (seg[i] === 0x0d && seg[i + 1] === 0x0a && seg[i + 2] === 0x0d && seg[i + 3] === 0x0a) {
        sep = i; break;
      }
    }
    if (sep < 0) continue;
    const headerText = new TextDecoder().decode(seg.slice(0, sep));
    const body = seg.slice(sep + 4);

    const nameMatch = /name="?([^";\s]+)"?/.exec(headerText);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    if (fieldName === 'image') {
      const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      const mime = (ctMatch ? ctMatch[1].trim().toLowerCase() : 'image/jpeg');
      images.push({ data: body, mime });
    } else if (fieldName === 'allowFallback') {
      const val = new TextDecoder().decode(body).trim().toLowerCase();
      allowFallback = ['true', '1', 'yes', 'on'].includes(val);
    }
  }

  return { images, allowFallback };
}

// --- CSP / security headers (parity with server.py, nonce-compatible) ---
// The frontend HTML ships inline JS/CSS, so we cannot use a strict nonce-based
// CSP without editing the HTML. We mirror the Python server's same-origin CSP
// (disallows remote script/frame/object, no unsafe-eval), which is compatible
// with the existing frontend.
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function cspHeader(contentType) {
  if (contentType.split(';')[0].trim().toLowerCase() === 'text/html') {
    return "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
  }
  return "default-src 'none'; frame-ancestors 'none'";
}

// Wrap the actual asset response, including SPA fallback HTML and HEAD requests.
// API responses retain the restrictive camera policy in SECURITY_HEADERS.
export function secureAssetResponse(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  const contentType = headers.get('Content-Type') || '';
  headers.set('Content-Security-Policy', cspHeader(contentType));
  if (contentType.split(';')[0].trim().toLowerCase() === 'text/html') {
    headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// --- Host / origin checks (parity with server._host_allowed / _origin_allowed) ---
export function hostAllowed(requestHost, allowedHosts) {
  if (!allowedHosts.length) return true; // no restriction configured
  // Python strips the port and lowercases before comparing; the Host header
  // (and url.host) may carry a port, so mirror that here.
  const host = String(requestHost || '').split(':')[0].trim().toLowerCase();
  if (!host) return false;
  return allowedHosts.some((h) => {
    const a = String(h).split(':')[0].trim().toLowerCase();
    return host === a || host.endsWith('.' + a);
  });
}

export function originAllowed(origin, allowedOrigins) {
  if (!allowedOrigins.length) return true; // no restriction configured (local mode)
  // Python allows same-origin POSTs that omit the Origin header (returns True),
  // and prefix-matches an allowed origin plus a trailing slash.
  if (!origin) return true;
  for (const allowed of allowedOrigins) {
    const a = String(allowed).replace(/\/+$/, '');
    if (origin === allowed || origin.startsWith(a + '/')) return true;
  }
  return false;
}

// Safe error: never echo exception messages (may embed provider URLs/keys).
export function safeError(status, message = 'Terjadi kesalahan di server.') {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}

export function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}
