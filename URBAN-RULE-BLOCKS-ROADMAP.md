# Urban Rule → blocks: flexibility roadmap

How we plan to make the generated block buildings more expressive and less "machine-drawn", without
breaking the current parametric model. Early design agreed 2026-07; #1 (simplify) is done.

## The core tension: parametric vs. direct manipulation

Today `generateBuildingInModal()` (`frontend/js/building-blocks.js`) is **purely parametric**: it
discards the old geometry and rebuilds from the sliders every time
(superparcel → setback buffer → inset → ring-with-hole → cut gaps → union wings → chamfer). That's
why results are reliably regenerable and shareable — but arbitrary hand-edits have nowhere to live.

Ideas split into two buckets:
- **Parametric-compatible** — adds *parameters*; geometry still fully regenerated. Cheap, no mode switch.
- **Freeform** — breaks `geometry = f(params)`; needs an explicit mode.

## Target state model

One block-design state object with an explicit source-of-truth flag:

```
{ mode: 'parametric' | 'manual',
  params: { setback, width, chamfer, simplify, gaps:[…], wings:[…] },
  footprint,   // derived in parametric; the source-of-truth in manual/geojson
  height }     // ALWAYS live (extrusion is orthogonal to the footprint)
```

Rules: params are the source; `manual` is a derived override you can always reset from. Switching to
`manual` freezes the footprint, makes vertices draggable, and greys out footprint-shaping sliders.
`height` stays live in both modes. GeoJSON upload and manual vertex-editing are the *same* capability
(an arbitrary footprint) with different input methods.

## Roadmap (ordered)

1. **Simplify + base shapes** — *simplify slider DONE (2026-07)*.
   - ✅ **Simplify (m) slider**: `turf.simplify` (Douglas–Peucker) on the merged outline before the
     setback, so equal-setback buildings stop inheriting parcel jaggies. 0 = follow parcels exactly.
   - ⬜ Optional: alternative base shapes (convex hull / oriented bounding box) as selectable base
     geometry. (Note: the existing `algorithm-select` dropdown is disabled placeholder UI for future
     block *typologies* — fully-closed / one-side-open / circular / Buenos-Aires — a separate thing.)
2. **Drag (+ optional tilt) for gaps & wings** — parametric-compatible. Promote each gap/wing from
   "N evenly spaced, perpendicular" to `{ position (0–1 along perimeter), width, depth/length,
   angleOffset }`. Sliders set defaults for new ones; drag updates position; a rotate handle updates
   angle (default 0 = perpendicular, reads clean). Fully shareable, no mode switch.
3. **Manual footprint mode** — the freeform escape hatch. Draggable base-ring vertices; one-way
   branch from parametric; footprint sliders inert; `height` stays live; "reset to parametric"
   regenerates and discards manual edits (with a warning). Introduces the `mode` flag.
4. **GeoJSON upload** — reuses #3's "custom footprint" plumbing for maximum flexibility.

## Notes

- Sharing already stores both `buildingProposal.parameters` and the final `buildingFeature` polygon,
  so a manual/GeoJSON footprint shares and re-applies fine (it's just geometry); a re-edit checks the
  `mode` flag to decide whether to load sliders or the editable polygon.
- Chamfer is parametric-only (it edits vertices), unlike `height`.
