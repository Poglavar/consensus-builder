# og-proposals Worker

Per-link social preview cards for `/proposals/*`. Social/forum crawlers don't run JS, so the SPA's
static `<head>` makes every share preview identical. This Worker injects per-link `og:*` /
`twitter:card` meta **before the crawler sees the HTML**, so pasted links unfurl into the right
image — including shared AI renders (`?scene=<slug>`), whose card is the AI image itself.

Built per `../../OG-IMAGE-PLAN.md`, extended for `?scene`.

## What it does

- `GET /proposals/:ids?scene=<slug>` → fetches `API_BASE/ai-scene/scene/:slug`, sets `og:image` to
  the render's hosted PNG + a render-specific title/description. Humans still get the normal SPA.
- `GET /proposals/:ids` (no scene) → sets `og:image` to `SITE_BASE/proposals/:firstId/og-image.png`
  and title/description from the proposal.
- `GET /proposals/:id/og-image.png` → serves the proposal's own image as real PNG bytes (redirects a
  hosted/IPFS URL; decodes a base64 `data:` URL; else a branded fallback).

Scenes need no image proxying — their `imageUrl` is already an absolute hosted PNG.

## Deploy (NOT done automatically — touches the prod Cloudflare zone)

```
cd workers/og-proposals
npx wrangler login          # once, if not already authenticated to the account managing the zone
npx wrangler deploy
```

`wrangler.toml` pins the route `urbangametheory.xyz/proposals/*` and the `API_BASE` / `SITE_BASE`
vars. Free Workers plan is sufficient (100k req/day; Cache API absorbs repeats).

## Verify after deploy

```
# Scene card:
curl -A "facebookexternalhit/1.1" "https://urbangametheory.xyz/proposals/123?scene=<slug>" | grep -i 'og:image\|twitter:card'
# Proposal card:
curl -A "facebookexternalhit/1.1" "https://urbangametheory.xyz/proposals/123" | grep -i og:
# Image endpoint:
curl -sI "https://urbangametheory.xyz/proposals/123/og-image.png"   # 200, image/png
# A normal browser load of /proposals/123 must still boot the SPA unchanged.
```

Then run the link through the Facebook Sharing Debugger, X Card Validator, and a Discord/Slack paste.

## Notes / caveats

- **Sub-request loop:** `handleHtml` does `fetch(request)` to get the origin `index.html`. Same-zone
  subrequests should not re-invoke the same Worker — verify on first deploy (add a bypass header or
  fetch a dedicated origin hostname if it does loop).
- **Fallback image:** `DEFAULTS.image` points at `https://urbangametheory.xyz/og-default.png` — add
  that asset (1200×630) or change the constant before relying on the no-image path.
- Provide a real `og-default.png` and confirm scene images are ≥600px on the short side for a
  large-image card.
