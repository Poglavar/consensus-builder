# Realistic 3D — Cesium + Google Photorealistic 3D Tiles

Working notes for the `realistic-3d` branch. Goal: evaluate replacing/augmenting the
current Three.js 3D mode with a photorealistic real-world globe, so proposed buildings
and reparcellations sit inside actual city context instead of on a blank background.

Worktree: `/Users/simun/Code/consensus-builder-realistic-3d` · Branch: `realistic-3d`
POC page: `frontend/cesium-poc.html` (standalone, not wired into the app yet).

---

## 1. Current state of the app's 3D

- 3D mode is **Three.js r0.147** (`frontend/js/three-mode.js`), rendering our *own*
  geometry — parcels, roads, proposed buildings — on a flat blank background. No terrain,
  no sky, no real-world context.
- Existing context buildings: **Zagreb** = LOD2 meshes from a PostGIS table; **NYC** =
  live Socrata footprints extruded server-side (flat-top boxes). Belgrade, Ljubljana,
  Buenos Aires, Denver = **no 3D context at all**.
- Plain HTML/CSS/JS, no build step, classic `<script>` tags. Leaflet for 2D.

**What photoreal adds:** real textured buildings/terrain/trees (the "Google Earth" look)
for ~2,500 cities worldwide, for free out of the box — including the 4 cities that have no
3D data today.

---

## 2. Who provides what — Google vs Cesium

Three separate layers; don't conflate them:

| Layer | What it is | Provider |
|---|---|---|
| **Data** | The photogrammetry mesh of the planet (buildings, terrain, trees), served as 3D Tiles from `tile.googleapis.com`. The "Google Earth" content. | **Google** |
| **Format** | *3D Tiles* — the open OGC streaming standard both sides speak. | Cesium (invented it), now vendor-neutral |
| **Renderer + broker** | **CesiumJS** = WebGL engine that draws tiles in the browser. **Cesium ion** = cloud platform that hosts assets + handles auth tokens / quota / billing, and resells Google's tiles as ion asset `2275207` (plus Cesium's own World Terrain, OSM Buildings, Bing imagery). | **Cesium** |

Google = the **content**. Cesium = the **engine + the auth/billing middleman**. They meet
at the 3D Tiles standard.

### Can you use one without the other?

| Setup | Works? | Trade-off |
|---|---|---|
| CesiumJS + Google tiles **via ion token** ← *the POC* | ✅ | One token; ion brokers Google billing; **bypasses the EEA block** (see §4). Simplest. |
| CesiumJS + Google tiles **via direct Google API key** (no ion) | ✅ | Bill Google directly; **but EEA-restricted → Zagreb returns 403**. |
| CesiumJS + **Cesium's own data, no Google** | ✅ | Free-er, but only gray OSM extrusions — no photoreal (see §6). |
| Google tiles + **non-Cesium renderer** (Three.js `3d-tiles-renderer`, deck.gl, Google `gmp-map-3d`) | ✅ | You don't need Cesium to render Google tiles. Lets us keep the existing Three.js scene. |
| ion token alone, no renderer | ❌ | Token is just auth; still need a 3D-tiles renderer. |

You always need **a renderer + data**. Cesium ion is an *optional* broker — but for us it's
the smart default because it unlocks Zagreb.

---

## 3. What is a "3D Tile"?

Not a parcel of land. A **3D Tile is a spatial chunk of the world at a level of detail**,
inside a tree.

- A **tileset** is a hierarchical tree (quadtree/octree). The root is `tileset.json`
  describing bounding volumes; each tile points to child tiles + a content file.
- Each tile has a **bounding volume** and **content** (a glTF/`.glb` mesh, historically
  `b3dm`). The renderer loads coarse tiles when far away and **refines** to finer child
  tiles as the camera zooms in — that's how planet-scale data streams without downloading
  everything.
- **Google photoreal content** = a **textured triangle mesh** from photogrammetry:
  geometry + baked photographic textures. Windows, façades, cars, trees, shadows are all
  *painted into the texture* — it's one continuous "melted" mesh, **not** individual
  selectable building models. You can't click "a building"; semantically it's just mesh.

Contrast: our app's buildings are **discrete, semantic** footprint+height objects we own
and can edit. Google's is a pretty but **non-semantic** photographic blob. They complement
each other — Google for *context*, our geometry for the *proposal*.

A **"root tileset request"** (the billable unit, §5) is the one request that fetches the
top of that tree and opens a streaming session.

---

## 4. The EEA restriction (Zagreb, Ljubljana, etc.)

**What:** Google's Photorealistic (and 2D satellite) Map Tiles are **not served to projects
linked to a billing account with an EEA address**.

**Since when:** **8 July 2025**, tied to the new *Google Maps Platform EEA Terms of Service*
(EU regulatory compliance). Applies to projects created after that date with an EEA billing
address, or existing projects modified after it.

**How it's enforced:** by **billing address, not IP.** A project under an EEA billing
account gets **HTTP 403** from `tile.googleapis.com`. It is *not* geofenced by where the
user/browser is.

**Why the ion path still works for Zagreb:** when we stream via Cesium ion, **Cesium's**
(US) billing account fetches the tiles from Google, then serves them to us under our ion
token. Google never sees an EEA billing address, so no 403. The Zagreb *mesh exists* and
*coverage is confirmed* — only the direct-API billing path is blocked.

**Takeaway:** for any EEA city, **use the ion path, never direct-Google.** Google's own
`gmp-map-3d` element also still works in the EEA (Google renders server-side), as a
fallback option.

---

## 5. Free-tier limits & pricing

Both paths give ~**1,000 sessions/month free**, but licensing differs.

### Path A — via Cesium ion (the POC). Hits the **ion Community (free)** plan:
- **1,000 Google Photorealistic 3D Tiles root tiles / month** ← binding limit (≈ 1,000 "open the 3D view" events)
- 15 GB/month streaming · 1,000 global-imagery sessions · 50,000 geocodes · 5 GB storage
- ⚠️ **Personal / non-commercial / evaluation use only.**
- Next tier up: **Commercial Individual = $149/mo** → 5,000 P3DT/mo, 150 GB streaming.

### Path B — direct Google Maps key (no ion). Hits **Google Maps Platform**:
- **1,000 free billable events / month** for the Photorealistic 3D Tiles SKU (`C6E1-98B2-DBD0`), then per 1,000 events:
  - 0–100k: **$6.00** · 100k–500k: $5.10 · 500k–1M: $4.20 · 1M–5M: $3.30 · 5M+: $2.40
- A "billable event" = **1 root tileset request ≈ 1 user session**, giving up to **3 hours**
  of streaming; child/renderer tiles within the session are **unlimited & free**.
- ✅ **No non-commercial restriction.** But **EEA-blocked** (§4).
- Daily cap: max 10,000 root tileset queries/day.

### The tension this creates
- **ion** → unlocks Zagreb, but free tier is non-commercial-only.
- **direct Google** → commercial-OK and cheap (~$6/1,000 sessions), but Zagreb 403s.
- **Cesium-only (no Google)** → only burns the 15 GB streaming quota, no per-session Google
  charge — the "good enough, ~free" fallback, but gray boxes not photoreal.

---

## 6. Why we don't need Cesium OSM Buildings

**Cesium OSM Buildings** is a pre-tiled global dataset of OSM building footprints extruded
to height. It has **no textures, no windows — just colored shapes/extrusions**. That is
essentially *what we already produce ourselves* (we fetch official footprints + heights and
extrude). So it offers us **nothing new**, and we could just as well fetch OSM and extrude
ourselves with no API.

The **only** thing this whole effort adds that we can't trivially do ourselves is Google's
**photoreal textured mesh** (+ real terrain). That — not OSM — is the entire value
proposition. So: skip OSM Buildings; the question is purely "Google photoreal, yes or no,
per city."

---

## 7. Dataset size & caching (can we self-host/cache?)

- Google P3DT is **planet-scale photogrammetry — effectively petabytes** globally; even a
  single city is many GB at full detail. A *viewport session* only streams the tiles in
  view (tens of MB), thanks to LOD refinement.
- **Caching/self-hosting is off the table — and not for size reasons but legal ones.**
  Google's Map Tiles **policies prohibit pre-fetching, caching, storing, offline use, and
  any derivative extraction** (incl. reading measurements off the mesh). Tiles must be
  streamed live per session. So "download Zagreb once and serve from our own cache" would
  violate the terms. Treat tiles as **stream-only, never persisted**.

---

## 8. Decision for now

App is **not commercial yet** and we want to **avoid paying as long as possible**:

- ✅ Use **Path A — Cesium ion Community (free)** with the existing token. 1,000
  sessions/month is plenty for development and demos.
- ✅ Keep using the **ion path for all cities** (so Zagreb/EEA works).
- ❌ Don't wire in Cesium OSM Buildings (redundant with our own extrusions).
- 🔜 Revisit licensing when the app goes public/commercial: either a paid ion plan (keeps
  Zagreb) or direct-Google (cheaper, but drop EEA cities or fall back to `gmp-map-3d`).

### Token note
The ion access token is client-side by design, but it has been shared in plaintext and is
hardcoded in `cesium-poc.html`. Before anything public, **rotate it** in the ion console and
issue a **scoped token limited to asset 2275207**.

---

## 9. POC status & next steps

**Done:** `frontend/cesium-poc.html` — standalone Cesium page; city dropdown (all 6 cities
fly to their `city-config.js` centers); loads Google photoreal via
`createGooglePhotorealistic3DTileset()`; drops a sample extruded "proposed building" massing,
ground-height sampled off the mesh. Verified live: 185 Google tile requests streamed for NYC;
token valid.

Run it:
```bash
cd frontend && python3 -m http.server 8777
# open http://localhost:8777/cesium-poc.html
```

**Done (real-proposal wiring):** the POC now has a proposal-id box + "Load real proposal"
button. It fetches `GET {backend}/proposals/:id`, reads `geometry.buildings` (GeoJSON
features with `[lng,lat]` footprints + `properties.height` in metres), and renders each as a
ground-clamped extruded massing on the photoreal mesh, then frames the proposal. Verified
end-to-end against real Zagreb proposal `p-o12tetofoo` (4× 120 m towers): camera flew to
Zagreb, ground height sampled off Google's Zagreb mesh (≈280 m ellipsoidal — **confirms
Zagreb coverage via the ion path**), extrusion delta = exactly 120 m, tower colors matched
the stored proposal colors. Note: **no NYC proposals exist locally** — Zagreb (56) and
Buenos Aires (3) are the only cities with saved building proposals, so Zagreb is the live
demo. Coordinates are EPSG:4326 and fed straight to Cesium (do **not** apply the Mercator
horizontal inflation the Three.js path uses).

Backend must be running on :3000 for the live fetch; the POC's `renderProposalBuildings()`
is split from the fetch so it can also be driven directly (exposed via `window.cesiumPOC`).

## 10. Integration into the app — Phase 1 DONE

**Decision:** photoreal is an in-3D toggle, not a separate top-level mode. Inside 3D mode a
"Realistic context" button swaps the Three.js backdrop for the Cesium photoreal globe (same
scene, real context). Both engines coexist; Three.js stays the fallback for no-coverage cities.

**Files (all in this worktree):**
- `frontend/js/photoreal-mode.js` — self-contained module. Lazy-loads CesiumJS from CDN on
  first use, creates one Cesium viewer in `#cesium-container`, loads Google P3DT, renders
  `window.proposedBuildings` as ground-clamped extrusions, frames the proposal (turf bbox) or
  the Leaflet view. Public API `window.PhotorealMode = { activate, deactivate, toggle,
  isActive, getViewer }`.
- `frontend/css/photoreal-mode.css` — `#cesium-container` overlay (z 905, above
  `#three-container`), the `#mode-realistic-toggle` button (visible only while
  `body.three-mode-active`), and `body.realistic-mode-active #three-container { display:none }`.
- `frontend/index.html` — registers the CSS, adds the button + `#cesium-container`, loads
  `js/photoreal-mode.js`.

**Coupling:** the toggle keys off the `three-mode-active` body class that three-mode.js
already sets/clears; a MutationObserver auto-exits photoreal when the user leaves 3D. The one
additive export in three-mode.js is `window.getThree3DGeoView()` — returns the current 3D
camera as `{ targetLng, targetLat, headingDeg, pitchRad, range }` (range converted from the
scene's inflated Web-Mercator metres back to real metres; tilt angle is scale-invariant). The
ion token currently lives as a constant in `photoreal-mode.js`.

**Camera continuity (no fly-in, no starfield):** photoreal opens from the *exact* legacy-3D
vantage point via `camera.lookAt(target, HeadingPitchRange)` (instant — no animation), instead
of flying in from space. The viewer's **skyBox/sun/moon are disabled** (no star backdrop), and
**Cesium World Terrain** is loaded so ground elevation is known *before* the photoreal mesh
streams — that lets the close matched view be placed on the first frame (no wide pull-back, no
underground at high-elevation cities like Denver ~1.6 km). The tileset loads separately from
viewer creation so the camera is positioned before tiles arrive; `applyEntryView()` then
fine-tunes on the photoreal mesh. Verified: skyBox off, world terrain loaded, legacy view
(heading 0, pitch −55°, range 282 m, Zagreb) reproduced in Cesium to the metre (camera 161 m
south of target, height 401 m = ~170 m ground + 231 m). Fallbacks if not in 3D: proposal bbox,
then Leaflet view.

**Verified in the real app** (served frontend, NYC default, injected a real Zagreb proposal):
button hidden in 2D / shown in 3D, Cesium lazy-loads only on activate, 4 entities at exact
120 m, Three.js↔photoreal toggle hides/shows correctly, auto-exit on leaving 3D. Screenshot
showed the 4 towers on Google's Zagreb mesh inside the app UI.

**Next (Phases 2–4, per the agreed parity plan):**
1. Phase 2 — parcels: active proposal's parcel boundaries as ground-clamped Cesium polygons.
2. Phase 3 — roads & parks.
3. Phase 4 — before/after reparcellation visuals.
4. Polish: reuse the app's glTF uploads (`properties.modelUrl`) instead of plain extrusions;
   transparency/solid toggle; pause the Three.js render loop while photoreal is shown
   (currently it keeps rendering to a hidden canvas — minor waste).
5. Before anything public: rotate the ion token + scope it to asset 2275207.

---

## Sources
- Cesium ion pricing — https://cesium.com/platform/cesium-ion/pricing/
- CesiumJS Photorealistic 3D Tiles tutorial — https://cesium.com/learn/cesiumjs-learn/cesiumjs-photorealistic-3d-tiles/
- Google Maps Platform pricing — https://developers.google.com/maps/billing-and-pricing/pricing
- Map Tiles API usage & billing — https://developers.google.com/maps/documentation/tile/usage-and-billing
- Map Tiles API EEA adjustments — https://developers.google.com/maps/comms/eea/map-tiles
- Map Tiles API policies (caching/derivative) — https://developers.google.com/maps/documentation/tile/policies
