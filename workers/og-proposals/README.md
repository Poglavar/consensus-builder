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
- `GET /designs/<cid>[,<cid>…]` and `GET /agreements/<cid>` (no scene) → read `API_BASE/designs/<cid>`
  or `API_BASE/agreements/<cid>` (the first design of a multi-design link), set `og:image` to
  `SITE_BASE/designs/<cid>/og-image.png` (or `/agreements/…`) and the title/description from the
  record's content.
- `GET /designs/<cid>/og-image.png`, `GET /agreements/<cid>/og-image.png` → redirect to the record's
  hosted before/after pair (`screenshotPairUrl`), else its thumbnail (`screenshotUrl`), else the site card.

Scenes need no image proxying — their `imageUrl` is already an absolute hosted PNG.

## Deploy (NOT done automatically — touches the prod Cloudflare zone)

```
cd workers/og-proposals
npx wrangler login          # once, if not already authenticated to the account managing the zone
npx wrangler deploy
```

`wrangler.toml` pins the routes `urbangametheory.xyz/designs/*` and `urbangametheory.xyz/agreements/*` and the `API_BASE` / `SITE_BASE`
vars. Free Workers plan is sufficient (100k req/day; Cache API absorbs repeats).

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
- **Fallback image:** `DEFAULTS.image` points at `https://urbangametheory.xyz/og-default.png` — add
  that asset (1200×630) or change the constant before relying on the no-image path.
- Provide a real `og-default.png` and confirm scene images are ≥600px on the short side for a
  large-image card.
