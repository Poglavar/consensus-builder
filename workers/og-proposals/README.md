# og-proposals Worker

Per-link social preview cards for shared design and agreement links, `/designs/*` and
`/agreements/*`. Social/forum crawlers don't run JS, so the SPA's
static `<head>` makes every share preview identical. This Worker injects per-link `og:*` /
`twitter:card` meta **before the crawler sees the HTML**, so pasted links unfurl into the right
image — including shared AI renders (`?scene=<slug>`), whose card is the AI image itself.

Built per `../../OG-IMAGE-PLAN.md`, extended for `?scene`.

## What it does

- `GET /designs/<cid>[,<cid>…]?scene=<slug>` (or `/agreements/<cid>?scene=<slug>`) → fetches
  `API_BASE/ai-scene/scene/:slug`, sets `og:image` to the render's hosted PNG + a render-specific
  title/description. Humans still get the normal SPA.
- `GET /designs/<cid>[,<cid>…]` (no scene) → validates every CID and uses the complete ordered list
  for the canonical URL and `SITE_BASE/designs/<comma-separated-cids>/og-image.png` image URL. The
  metadata describes the shared plan as a whole and declares the preview dimensions as 1200×630.
- `GET /designs/<cid>[,<cid>…]/og-image.png` → redirects to
  `API_BASE/map-previews/<comma-separated-cids>/image.png`, which frames the whole plan.
- `GET /agreements/<cid>` and `/agreements/<cid>/og-image.png` retain agreement-specific metadata
  and image behavior.

Scenes need no image proxying — their `imageUrl` is already an absolute hosted PNG.

## Deploy (NOT done automatically — touches the prod Cloudflare zone)

Deploy the backend map-preview endpoint first. The Share tab automatically warms its selected CID
set with `POST API_BASE/map-previews` and JSON `{ "cids": ["<cid>", "…"] }`, without blocking the
share link. Older links generate their image on the first GET. The backend retries transient render
failures once; a remaining 503 includes Retry-After and is never cached as a generic replacement.
Keep the API's existing uploads/images and uploads/metadata directories persistent across releases.

```
cd workers/og-proposals
npx wrangler login          # once, if not already authenticated to the account managing the zone
npx wrangler deploy
```

`wrangler.toml` pins the routes `urbangametheory.xyz/designs/*` and `urbangametheory.xyz/agreements/*` and the `API_BASE` / `SITE_BASE`
vars.

## Verify after deploy

```
# Scene card:
curl -A "facebookexternalhit/1.1" "https://urbangametheory.xyz/designs/<cid>?scene=<slug>" | grep -i 'og:image\|twitter:card'
# Design and agreement cards:
curl -A "facebookexternalhit/1.1" "https://urbangametheory.xyz/designs/<cid>" | grep -i og:
curl -A "facebookexternalhit/1.1" "https://urbangametheory.xyz/agreements/<cid>" | grep -i og:
# Image endpoint:
curl -sI "https://urbangametheory.xyz/designs/<cid>/og-image.png"   # 302 to the hosted image
# A normal browser load of /designs/<cid> must still boot the SPA unchanged.
```

Then run the link through the Facebook Sharing Debugger, X Card Validator, and a Discord/Slack paste.

## Notes / caveats

- **Sub-request loop:** `handleHtml` does `fetch(request)` to get the origin `index.html`. Same-zone
  subrequests should not re-invoke the same Worker — verify on first deploy (add a bypass header or
  fetch a dedicated origin hostname if it does loop).
- `DEFAULTS.image` is the existing site globe card. The 1200×630 dimensions apply only to generated
  design map previews; agreement and scene image dimensions are not declared here.
