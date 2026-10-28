<!-- How the photo map mode gets real-world context from Google Photorealistic 3D Tiles, and the licensing, pricing and caching limits that shape it. -->

# Realistic 3D: Google Photorealistic 3D Tiles

The photo map mode places proposals, corridors, parks and trees on Google's photogrammetric
city mesh, so a design is seen in its real surroundings rather than on a blank ground plane.
Google supplies the content (a textured, non-semantic triangle mesh streamed as OGC 3D Tiles);
our own geometry stays the editable, semantic layer on top of it.

## How it is integrated

- **Mode.** Photo is one of the three map modes (`2d`, `model`, `photo`; see
  `frontend/js/map-mode-loader.js` and `map-mode-transition.js`). It is a layer inside the
  three.js scene of model mode: there is no second renderer and no CesiumJS.
- **Streaming.** `frontend/js/photoreal-mode.js` lazy-loads `3d-tiles-renderer` (pinned in the
  import map in `frontend/index.html`) and streams the tileset into three-mode's scene through
  `TilesRenderer` with `CesiumIonAuthPlugin`, `ReorientationPlugin`, glTF/Draco and compression
  plugins. The camera far plane is clamped while tiles are shown so a tilted view does not
  stream the horizon.
- **Source and token.** The tileset is the `reality-mesh` source `google-photorealistic`
  (Cesium ion asset 2275207) in `frontend/js/browser-source-readers.js`. The ion access token is
  client-side by design and lives in `photoreal-mode.js`; it was rotated on 2026-10-15 and is
  scoped to asset 2275207 and the app's own origins.
- **Supporting modules**, all loaded with the photo group: `photoreal-frame.js` (pure frame math
  from the reoriented true-metre tiles into the EPSG:3857 scene frame), `photoreal-ground.js`
  (bare-ground estimate from the sampled mesh), `photoreal-seam.js` (capping the mesh where it
  is clipped at proposal boundaries), `photoreal-protect.js` (which standing buildings survive
  that carve), `photoreal-parcels.js` (cadastral boundaries drawn on the tiles) and
  `photoreal-attribution.js` (the required Google credit line).
- **Seating and seams.** How proposal geometry is seated on the mesh and the terrain is
  documented in [3d-terrain-fitting.md](3d-terrain-fitting.md); the review of seams between
  authored geometry and the mesh is in [photoreal-seams-review.md](photoreal-seams-review.md).
  Ground rendering in model mode is in [3d-ground.md](3d-ground.md).

## The EEA restriction

**What:** Google's Photorealistic (and 2D satellite) Map Tiles are not served to projects
linked to a billing account with an EEA address.

**Since when:** 8 July 2025, tied to the Google Maps Platform EEA Terms of Service (EU
regulatory compliance). It applies to projects created after that date with an EEA billing
address, and to existing projects modified after it.

**How it is enforced:** by billing address, not IP. A project under an EEA billing account
gets HTTP 403 from `tile.googleapis.com`. It is not geofenced by where the user or browser is.

**Why the ion path works for Zagreb:** when tiles are brokered by Cesium ion, Cesium's (US)
billing account fetches them from Google and serves them under our ion token. Google never
sees an EEA billing address, so there is no 403. The Zagreb mesh exists and its coverage is
confirmed; only the direct-API billing path is blocked.

**Takeaway:** for any EEA city, use the ion path, never a direct Google key. Google's own
`gmp-map-3d` element also still works in the EEA (Google renders it), as a fallback option.

## Free-tier limits and pricing

Checked 2026-06-25; re-verify against the sources below before citing a number in a decision.
Both paths give about 1,000 sessions a month free, but the licensing differs.

**Path A, through Cesium ion (the current path).** It uses the ion Community (free) plan:

- 1,000 Google Photorealistic 3D Tiles root tiles a month, the binding limit (about 1,000
  "open the photo view" events).
- 15 GB a month of streaming, 1,000 global-imagery sessions, 50,000 geocodes, 5 GB storage.
- Personal, non-commercial or evaluation use only.
- The next tier, Commercial Individual, is $149 a month: 5,000 root tiles and 150 GB streaming.

**Path B, a direct Google Maps key (no ion).** It uses Google Maps Platform:

- 1,000 free billable events a month for the Photorealistic 3D Tiles SKU (`C6E1-98B2-DBD0`),
  then per 1,000 events: 0 to 100k $6.00, 100k to 500k $5.10, 500k to 1M $4.20, 1M to 5M
  $3.30, above 5M $2.40.
- A billable event is one root tileset request, about one user session, giving up to three
  hours of streaming; child tiles within the session are free and unlimited.
- No non-commercial restriction, but EEA-blocked (see above).
- Daily cap: at most 10,000 root tileset queries a day.

**The tension:** ion unlocks Zagreb but its free tier is non-commercial only; a direct key is
commercial and cheap (about $6 per 1,000 sessions) but returns 403 for Zagreb.

## Why we do not use Cesium OSM Buildings

Cesium OSM Buildings is a pre-tiled global dataset of OSM building footprints extruded to
height. It has no textures, only coloured extrusions, which is what we already produce from
official footprints, OSM and our own building sources. It adds nothing new. The only thing this
integration adds that we cannot do ourselves is Google's photoreal textured mesh and its real
terrain, so the question is purely "Google photoreal, yes or no, per city".

## Dataset size and caching

- Google's tiles are planet-scale photogrammetry, effectively petabytes; a single city is many
  GB at full detail. A viewport session streams only the tiles in view (tens of MB) thanks to
  level-of-detail refinement.
- Self-hosting or caching is ruled out by the terms, not by size. Google's Map Tiles policies
  prohibit pre-fetching, caching, storing, offline use and derivative extraction (including
  reading measurements off the mesh). Tiles are streamed live per session and never persisted;
  the app only keeps recently viewed tiles in memory for a short time while the mode is used.
- The Google logo and the tiles' attribution must stay on screen while the tiles are shown.

## Decision

The app is not commercial yet, and we avoid paying for as long as possible:

- Use Path A, the Cesium ion Community (free) plan, for all cities, so Zagreb and other EEA
  cities work. 1,000 sessions a month is enough for development and demos.
- Do not add Cesium OSM Buildings (redundant with our own extrusions).
- Revisit licensing when the app goes commercial: either a paid ion plan (keeps Zagreb) or a
  direct Google key (cheaper, but drop EEA cities or fall back to `gmp-map-3d`).

## Sources

- Cesium ion pricing: https://cesium.com/platform/cesium-ion/pricing/
- CesiumJS Photorealistic 3D Tiles tutorial: https://cesium.com/learn/cesiumjs-learn/cesiumjs-photorealistic-3d-tiles/
- Google Maps Platform pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- Map Tiles API usage and billing: https://developers.google.com/maps/documentation/tile/usage-and-billing
- Map Tiles API EEA adjustments: https://developers.google.com/maps/comms/eea/map-tiles
- Map Tiles API policies (caching and derivatives): https://developers.google.com/maps/documentation/tile/policies
