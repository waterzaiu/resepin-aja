# Resep in aja — Cloudflare Workers (Free plan)

Deterministic recipe discovery/search/gallery + AI vision scan proxy, deployed
on Cloudflare Workers. No external runtime dependencies.

## What this is

A single Worker (`src/index.js`) that mirrors the Python server's HTTP API so
the existing `resep-in-aja.html` frontend works unchanged when served
same-origin. Routes:

| Method | Path | Notes |
|--------|------|-------|
| GET | `/` | Static UI (served by the ASSETS binding) |
| GET | `/api/resep?q=` | External gallery (official APIs only) |
| GET | `/api/viral` | Static Cookpad rendang cards |
| GET | `/api/inspirasi` | Curated inspiration gallery |
| GET | `/api/recipes/search?q=` | Search seed catalog |
| GET | `/api/recipes/<id>` | Single recipe |
| GET | `/health`, `/ready` | Liveness/readiness |
| POST | `/api/scan-resep` | AI vision scan (multipart) — needs ≥1 AI key |
| POST | `/api/recipes/match` | Deterministic matching |
| POST | `/api/ingredients/normalize` | Ingredient normalization |

Discovery/search/gallery work with **zero** keys. Only `/api/scan-resep`
requires at least one AI vision key.

## Prerequisites

- Node.js 18+ and npm.
- A Cloudflare account (Free plan is enough).

## Deploy (exact steps)

Run everything from the `cloudflare/` directory.

```bash
cd cloudflare

# 1. Install the pinned Wrangler version
npm install

# 2. Stage the frontend for the ASSETS binding (required)
#    `public/` is gitignored; this copy must be re-created on each checkout.
mkdir -p public
cp ../resep-in-aja.html public/index.html

# 3. Set AI vision secret(s) — pick ONE or more (never hardcode in code)
npx wrangler secret put GEMINI_API_KEY     # Google Gemini (free tier)
# npx wrangler secret put OPENAI_API_KEY   # OpenAI (paid)
# npx wrangler secret put ANTHROPIC_API_KEY # Anthropic ($5 free credit)

# 4. Verify the build without deploying (safe)
npx wrangler deploy --dry-run

# 5. Deploy
npx wrangler deploy
```

After deploy, Wrangler prints the `*.workers.dev` URL. `/api/scan-resep` is
only enabled once at least one secret is set; without any key it returns
`503` while discovery/search/gallery keep working.

### Deploying from the Cloudflare dashboard (alternative)

If you deploy from the dashboard instead of `wrangler deploy`, you must
replicate the secret + config manually:

1. Workers & Pages → Create application → Create Worker.
2. Add the secrets above under **Settings → Variables and Secrets → Add** (type
   **Secret**). The non-sensitive vars are already in `wrangler.jsonc`.
3. The ASSETS binding + routing is configured in `wrangler.jsonc`; the
   dashboard UI requires the `public/` directory to be uploaded as the static
   asset directory. Using `wrangler deploy` is recommended because it honors
   `wrangler.jsonc` automatically.

## Local dev

```bash
cd cloudflare
npm install
mkdir -p public && cp ../resep-in-aja.html public/index.html
cp .dev.vars.example .dev.vars   # then fill in real key(s) — never commit
npm run dev                       # wrangler dev, serves localhost
```

`.dev.vars` is gitignored. Use `.dev.vars.example` as the template.

## Tests

```bash
cd cloudflare
npm test
```

## Configuration

`wrangler.jsonc` holds non-sensitive config only:

- `assets.directory: "./public"` + `binding: "ASSETS"` — serves the UI. The
  repo **root is deliberately not** the assets directory: it contains secrets
  (`.api-keys.enc.json`, `.env`) that must never be uploaded as assets.
- `not_found_handling: "single-page-application"` — unknown paths fall back to
  `index.html` rather than 404.
- `vars.*` — non-sensitive tuning (`PROVIDER`, `GEMINI_MODEL`,
  `ALLOW_CROSS_PROVIDER_FALLBACK`, `ENABLE_EXTERNAL_RECIPES`).

Secrets are **never** declared in `wrangler.jsonc` (Cloudflare has no
declarative secrets field). They are read from env at runtime and managed via
`wrangler secret put` (production) or `.dev.vars` (local).

## Secrets & security

- **Never commit** `.dev.vars`, `.dev.vars.*`, `public/`, or
  `.api-keys.enc.json` (the latter lives at the repo root).
- At least one AI vision key is required for `/api/scan-resep`. Photos are sent
  to the chosen provider only (cross-provider fallback is opt-in and off by
  default via `ALLOW_CROSS_PROVIDER_FALLBACK`).
- Optionally restrict hosts/origins for public deployments with
  `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` (CSV, added as vars or secrets). Omitted
  by default = allow all, no CORS headers.
- No authentication: `/api/scan-resep` is open and consumes paid AI quota. A
  per-IP rate limit mitigates abuse but is not a substitute for auth. This is a
  hackathon prototype — add auth before any serious production use.

## Limitations

- **Free-plan Worker limits** apply (CPU time, subrequests, daily requests).
  AI scan is the only paid-quota consumer; discovery/search/gallery are free.
- TheMealDB metadata-only (no instruction prose/images redistributed) per its
  ToS; full content is linked, never copied.
- Allergen tags are derived, not authoritative; AI fallback results are labeled
  `verified: false`.
