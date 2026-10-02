# Current status — 2026-10-02

The phase notes below record their original development dates; “not committed/not deployed” labels in those historical sections are superseded by this release status. The implementation is integrated on `colosseum-worlds-fair`; its site-first/open-ground/subdivision workflows have headed coverage. Changed-land forks now retain their provenance source without superseding it and rebuild the selected site/cadastre/structure geometry. ParcelNFT v2, ProposalMarket v2 and ProposalNFT v3 are upgraded on devnet: fresh program dumps match the built binaries, with zero allocation padding excluded. Live wallet/attestation integration still needs separate production evidence. Refer to [TEST.md](TEST.md), [docs/protocol.md](docs/protocol.md), and [next-steps.md](next-steps.md) for the current verification and follow-up.

# Proposals on a site; parcels as a derived binding (branch `parcel-optional`)

A proposal is a geometric/material fact about a place. Its subject is its **site**: the ground it
occupies. Cadastral parcels are attached to it by an adapter, as its **binding**, because execution
(owner consent, lens attestations, compensation) needs to know whose land the site touches. A proposal
must be complete and valid with an empty binding: on unsurveyed ground, in an explore city, anywhere the
cadastre has nothing.

Inputs: the dependency map in this file's history (agent report, 2026-10-01), `unsurveyed-ground.md`,
`lens-model.md`, `MEMORY.md` decisions of 2026-10-01.

## Vocabulary

| Term | Meaning |
|---|---|
| **site** | The proposal's ground: a MultiPolygon (EPSG:4326). For drawn tools it is authored; for existing tools it is `footprintOf(record)` (union of `footprintParts`); for parcel acts (offer, ownership transfer, vote, road designation) it is the union of the parcels acted on. |
| **binding** | `{ parcels: [{ parcelId, overlapM2, intrusionM }], toleranceM, coverage, unsurveyedM2, source }` — which cadastral parcels the site reaches into, computed from the site and the cadastre. |
| **intrusion** | How far the site reaches into a parcel, as a **width**: the diameter of the largest circle inside `site ∩ parcel`. A 0.3 m sliver along a boundary has intrusion 0.3 m whatever its length or the parcel's area. |
| **tolerance** | `toleranceM`, a parameter. A parcel is bound when its intrusion exceeds it. **Default 0**: any reach into a parcel binds it. A computational floor of 1 mm (`INTRUSION_NOISE_M`) absorbs floating-point noise on shared edges; it is arithmetic, not policy. |
| **coverage** | `complete` (the whole site is over cadastral parcels), `partial` (some of it is unsurveyed ground inside a surveyed region), `none` (the region has no cadastre, e.g. explore). |
| **open ground** | The part of the site not covered by any bound parcel. It is real ground with no cadastral owner known to us. |

## Rules

1. **Binding is computed, never typed in, and authoritative on the server.** The browser cannot tell a
   cadastral hole from the edge of what it loaded (`unsurveyed-ground.md`). The server computes it with
   PostGIS over the full cadastre: `POST /proposals/binding { site, toleranceM }`, a read (like
   `/parcels/under`). The browser may preview with the same pure rule over loaded parcels, labelled as a
   preview; publishing always uses the server's answer.
2. **Same rule in both places.** Bound ⇔ `site ∩ parcel` is non-empty after an inward buffer of
   `max(toleranceM, INTRUSION_NOISE_M) / 2` (equivalent to "largest inscribed circle wider than the
   tolerance"). PostGIS `ST_Buffer(…, -d)` and turf `buffer(…, -d)` in a local metric frame.
3. **The declaration is the binding.** `cadastreParcelIds` stays the durable list of bound parcels, but
   it must equal the binding computed from the site (the strict undeclared-parcels check generalised from
   "≥1 m² covered must be declared" to "declared == binding", both directions, linear tolerance).
4. **Parcel acts still need parcels.** Offer, ownership transfer, vote and road designation are acts on
   parcels; their binding must be non-empty. Every material proposal (buildings, structures, roads,
   tracks, stations, subdivision/readjustment) may have an empty or partial binding.
5. **Records stay immutable.** The binding is fixed at publish/mint with its cadastre snapshot time.
   When the cadastre changes, re-binding produces a new derived record; the old one is never edited.
   *Drift* is the difference between the stored binding and the binding the server computes now for the
   STORED site at the record's own tolerance (`GET /proposals/:id/binding-drift`, a read). A record
   with drift says so in its details; **Re-bind** publishes a new record with the same site and design,
   the current binding as its declaration, and `sourceProposalId`/`replacementOfProposalId` + `rebind`
   pointing at the source, through the ordinary publish path (server binding again). Applying the new
   record supersedes the source like any replacement; owner acceptances never carry over.
6. **Execution follows the binding.**
   - Bound parcels: every attested owner of every bound parcel signs (unchanged).
   - Open ground (`coverage` partial or none): no owner can consent for it, so execution additionally
     requires a lens verdict that may execute (`verdict_may_execute`, e.g. permit/imagery/public owner).
   - Empty binding: executes **only** through such a verdict. The current `0 == 0` shortcut (an
     `executed` verdict counting as "all parcels accepted" when there are none) must be closed.

## Architecture changes

### Record and server (phase 1)
- DB: `site geometry(MultiPolygon,4326)`, `binding jsonb`. Replace CHECK `cadastre_parcel_ids_nonempty`
  with "non-empty OR site present"; keep "declaration matches record".
- Shared pure module `frontend/js/proposals/site-binding.js` (UMD, used by browser and server): site
  derivation, the binding rule over given parcel geometries, coverage, intrusion width, tolerance and
  noise constants. Server SQL mirrors it.
- `POST /proposals/binding`; `precheckProposalCreate`, `assertCanonicalProposalRow`,
  `refuseUndeclaredParcels`, agent recipe schema and MCP zod: empty declaration allowed for material
  goals with a site; declaration must equal the server binding.
- Migration (dry-run default, reversible, backup first): existing rows get `site = footprintOf(record)`
  (or the parcel union for parcel acts) and `binding` = their current declaration, unchanged in meaning.
  Report rows whose recomputed binding at tolerance 0 differs, don't rewrite them.

### Creation (phase 2)
- A proposal starts from a site. Sources: **draw** (new, the default on empty ground: a Ground menu on
  a click where there is no parcel, and a "Draw site" command), a parcel selection (union), a block.
- Drafts carry `site`; `missing-parcels` becomes `missing-site`; `conformanceOf` accepts a site with an
  empty declaration for material goals; the publish gate asks the server binding.
- Tools on a site: structures (park/square/lake/freeform structure) use the site polygon directly; block
  uses the site as its superparcel; detached and row houses need plots, so on bare ground they cut
  synthetic plots from the site (the readjustment slicer) along a chosen frontage edge (default the
  longest edge; the user can pick another); freeform must stay inside the site; roads, tracks and
  stations stop requiring affected parcels.
- The site is shown while drawing, with the live binding preview: bound parcels outlined, intrusion
  width shown on the ones barely touched ("reaches 0.4 m into 1234/5 — include it or change the
  design"), open ground hatched.

### Apply (phase 3)
- Open-ground host: where the server binding leaves part of the site uncovered, that part becomes a
  non-cadastral host piece `ground:<siteHash>` (derived from the site and the authoritative binding,
  never from a gap in loaded parcels). Formations accept it as a parent alongside cadastral anchors.
- Interaction closure gets a geometric index (sites that intersect interact), not only shared
  cadastral anchors, so two bare-ground proposals on the same spot still conflict.
- Corridors on bare ground occupy their ribbon with no arrangement there.

### Subdivision (phase 4)
- Land readjustment with an empty or partial pool: the open ground of the site is a pool with no
  owners; the existing slicer produces plots — only plots: a public strip (a street) is a plot drawn
  by hand and assigned to public land. Proposed plots are proposal content; they
  become parcels only through the authority's own process (out of scope).

### Chain (phase 5, program v3, not deployed in this branch)
- `Proposal` gains `site_hash [u8;32]` and `open_ground: bool` (appended after existing fields so prefix
  readers in market/pledge keep working).
- `mint_and_fund`: parcel list may be empty when `site_hash` is set; still non-empty for parcel acts
  (client-enforced; the program knows only the list and the hash).
- Execution: by consent ⇔ parcel list non-empty AND all accepted AND (NOT `open_ground` OR a
  `verdict_may_execute` verdict). By verdict alone ⇔ `verdict_may_execute`. The `0 == 0` path is gone.
- Decoders (backend lifecycle, frontend chain-data-loader, acceptance-client) read the new fields;
  minters (browser, agents) send them.

### Explore and stats (phase 6)
- Explore city: proposing enabled through the Ground menu and Draw site; banner text changes from
  "proposals need parcels" to what an empty binding means for execution.
- Stats: site metrics always (area, floor area, buildings gained/lost from building sources); binding
  metrics when present (owners, ownership mix, compensation, grain score of resulting plots).

## Status

(filled in per phase)

### Phase 1 — record and server (2026-10-01, built, not committed, not deployed)

**Built**
- `frontend/js/proposals/site-binding.js` (UMD; `window.__siteBinding`, loaded after plan-order.js):
  `DEFAULT_INTRUSION_TOLERANCE_M = 0`, `INTRUSION_NOISE_M = 0.001`, `MAX_INTRUSION_TOLERANCE_M = 1`,
  `PARCEL_ACT_GOALS`, `isParcelAct`, `requiresParcels`, `siteOf`, `intrusionWidth`,
  `bindingFromParcels`, `compareDeclaration`. turf from the global, `globalThis.turf` or `options.turf`.
- `backend/proposals/binding.js`: PostGIS mirror (`BINDING_SQL`), `computeBinding`, `parcelActBinding`,
  `checkProposalBinding` (declared == binding), site validation (Polygon/MultiPolygon, ≤100k vertices,
  ≤500 km² bbox, WGS84 range), parcel cap 5000 → 413.
- `POST /proposals/binding { site, toleranceM?, city? }` and alias `POST /agent/binding` → `{ binding,
  queryMs }`. In `READ_ONLY_POST_PATHS` (no Origin gate, no write limiter); own limiter
  (`PROPOSAL_BINDING_RATE_LIMIT` 1200 / 15 min).
- Create path (free and paid): body accepts `site`, `toleranceM` (a client `binding` is ignored and
  replaced). Empty `cadastreParcelIds` is allowed when the record is not a parcel act and has a site or
  a footprint. The strict check is now "declared == server binding at toleranceM" (both directions),
  still before x402 on the paid route. The server's `site` and `binding` are stored in the new columns
  and in `proposal_data` (served from there; the serializer prefers a selected `binding` column).
- DDL: `site geometry(MultiPolygon,4326)`, `binding jsonb`, CHECK `proposal_cadastre_parcel_ids_or_site`
  (non-empty OR site) replacing `..._nonempty`, GiST on `site`. In `proposals-ddl.sql` (fresh installs)
  and in the new ALTER-only, re-runnable `routes/proposal-site-ddl.sql`, which is in the deploy DDL list
  (unqualified ALTERs resolve to `consensus.proposal` on the server; no CREATE TABLE, so no shadow table).
  The CHECK is added `NOT VALID` (enforced on writes, not re-scanned each deploy; every row that passed
  the old non-empty CHECK passes it). Applied locally twice (idempotent).
- Serializer: empty declaration valid only with a site (column or `proposal_data.site`) and not a
  parcel act; serves `site` and `binding`.
- Agent recipe schema (`anyOf`: non-empty `cadastreParcelIds` or `site`; `site`, `toleranceM`), MCP
  `ugt_submit_proposal` zod (empty declaration needs a site), `docs-agents.md` (§2 binding, §4 recipe,
  §7 error codes), OpenAPI `/agent/binding`, docs endpoint map `proposalBinding`.
- `backend/scripts/migrate-proposal-sites.mjs` (dry run default, `--apply`, `--restore`, `--ids`,
  `--json`, `--help`; backup table `proposal_site_backup_v1` in the proposal's schema, per-row
  transactions that re-measure and verify; idempotent; k/N + ETA logging).
- Removed: `checkDeclaredParcels` / `UNDECLARED_PARCELS` in footprint.js (replaced, not kept beside).

**Decisions where the design left room**
- *Intrusion width* is measured by bisection on the inward-buffer radius in both places (turf
  `buffer` in its azimuthal-equidistant metric frame; PostGIS `ST_Buffer` in EPSG:3765, recursive CTE),
  bracket `[0, sqrt(area/π)]`, stop at max(0.5 mm, 0.05 % of r): width ±1 mm below 2 m, ±0.1 % above.
  Not `ST_MaximumInscribedCircle`: its fixed tolerance (1/1000 of the extent) mis-measures long thin
  slivers, and it needs GEOS ≥ 3.9 (local: PostGIS 3.5.2 / GEOS 3.9.0; prod PG16 version unchecked —
  the bisection needs nothing beyond `ST_Buffer`). Bound-ness is the direct test
  `NOT ST_IsEmpty(ST_Buffer(site∩parcel, -max(tol, noise)/2))`, not derived from the width.
- *Coverage*: open ground = site minus ALL parcels it meets (bound or not — a sub-tolerance touch is
  measurement error, not ownerless ground); a component counts only if it is wider than
  max(tol, noise), so cadastral micro-gaps are not open ground. `complete` = no counted open ground;
  `partial` = some (`unsurveyedM2`), including the case "region has a cadastre, nothing under the
  site" (`unsurveyedM2 = siteM2`); `none` = the region has no cadastre (pure: caller passes
  `regionHasCadastre: false`; server: site outside every cadastral municipality AND `city` is a
  no-cadastre city, currently only `explore`); `unknown` = server only: the site is outside every
  `cadastral_municipality` polygon and the city is not a no-cadastre city — the server holds only the
  Croatian cadastre (`parcel`, HR ids), so Belgrade/NYC/etc. are not "no cadastre" but "not bindable
  here", with a `reason`. A site straddling the edge of the held cadastre is `partial` with the outside
  part in `unknownM2`. For execution: `partial`, `none` and `unknown` all mean ground nobody can consent
  for → needs a `verdict_may_execute` verdict.
- *Unknown coverage on create*: the declaration is accepted unverified and stored as the binding
  (`subject: 'declared-unverified'`, null overlaps) — the old check was equally blind there.
- *Parcel acts without own geometry* (offer, transfer, vote, decide-later, generic parcel): site = union
  of the declared parcels; the binding IS the declaration (`subject: 'declared-parcels'`); the server
  only verifies each id is a current HR parcel (unknown ids → `unbound-parcels`). Recomputing it from
  the union would bind neighbours through cadastral overlap defects, which are not parties to a
  transfer of these titles. Parcel acts WITH geometry (designation, a vote with a park) use the normal
  site rule and must have a non-empty binding.
- *Parcel act detection*: goal in `offer, ownership-transfer(-to-me/-from-me), parcel, as-is,
  decide-later`, or `isVote === true`, or `proposalRole === 'owner-offer'`, or a road designation
  (`roadProposal.definition.polygon` with no centreline). `requiresParcels` = parcel act, or neither a
  site nor a footprint.
- *Authored site vs footprint*: when `site` is sent, the footprint must lie inside it (components of
  footprint − site wider than the floor → `footprint-outside-site`); the binding is computed from the
  site. The authored site is stored as sent (normalised to MultiPolygon); a derived site comes back from
  PostGIS (EPSG:4326, 9 decimals ≈ 0.1 mm, below the 1 mm floor).
- *Land rule reads the whole body*: the body validator keeps only schema fields, so the old check never
  saw `geometry` / `buildingGeometry` (building footprints were unchecked). The rule now reads the full
  authored record with validated values on top.
- *Error codes* (stable, in `BINDING_CODES` and docs-agents.md §7): `undeclared-parcels` (missing; also
  when both), `unbound-parcels` (extra only), `parcels-required`, `site-required`,
  `footprint-outside-site`, `invalid-site`, `invalid-tolerance`, `invalid-footprint`,
  `too-many-parcels` (413). Refusals carry `missing: [{id, overlapM2, intrusionM}]`,
  `extra: [{id, intrusionM}]` and, for old clients, `parcels` (= missing).
- *Migrated rows* keep their declaration: `binding.parcels` = `cadastre_parcel_ids` (with the
  recomputed overlap/intrusion where measured), `source: 'migration:declaration'`, and
  `recomputedDiffers: { missing, extra }` where the tolerance-0 recomputation disagrees.

**Tests** (backend vitest): site-binding 19 (pure rule, shared edge, 1 cm vs 5 cm, sliver width
independent of length, L-shape, coverage cases, parcel acts, siteOf), proposal-binding 35 (validation,
computeBinding, declared == binding missing/extra, parcel acts, unknown coverage, routes incl. paid
precheck before x402, binding route, read-only list), migrate-proposal-sites 7, serializer +1, schema
contract (rewritten + deploy-DDL test), well-known +1, existing tests moved to the new rule
(proposals, agent-proposals, docs, recipe schema). DB parity (opt-in, `RUN_DB_TESTS=1`,
proposal-binding-db.test.js, 4 tests): same sites through SQL and the pure rule on real parcels agree
on bound ids and coverage; intrusion within 1 % (e.g. 0.3521 vs 0.3515 m), areas within 0.1 %.
Mutation-checked: an area-based bound rule and a 3-step bisection both turn the pure tests red.
Full suite: 5933 passed, 1 failing test belongs to the concurrent chain phase
(`mcp-server.test.js` expects the old `ugt_mint_proposal` keys after that phase added site/binding).

**Migration dry run, local DB (836 rows; the local table is an older snapshot)**: 832 migratable
(coverage complete 817, unknown 11 = non-HR cities, partial 4), skipped 4 (3 no site: declared parcels
not current/not HR and no geometry; 1 with no declaration). Recomputed binding at tolerance 0 differs
from the declaration in 329 rows; 13 of them still hold pre-HR numeric ids (local-only legacy data).
Of the 316 HR rows: 93 with missing parcels (313 parcels; by intrusion width <1 cm 61, 1–10 cm 173,
10 cm–1 m 55, ≥1 m 24) and 246 with extra parcels (1424 parcels; mostly block/`buildings` rules that
declare the whole block while their buildings cover only part of it, and roads). Applied to 3 rows
locally, re-run was a no-op, `--restore` returned them byte-identical; the local DB is restored
(backup table `public.proposal_site_backup_v1` left with those 3 rows). Not run anywhere else.

**What phase 2 must know**
- Publish: send `site` (the block/superparcel for block rules, the drawn polygon for drawn tools) and
  exactly `binding.parcels` from `POST /proposals/binding` as `cadastreParcelIds`. A block rule that
  declares the whole block without a block `site` is now refused as `unbound-parcels`.
- At tolerance 0, roads and designs traced from parcel geometry typically reach 1–10 cm into
  neighbours (173 of 313 missing parcels above): the UI must show `touched`/`intrusionM` and offer
  "include it" or "change the design" (or snapping), not silently pass a tolerance.
- `requiresParcels`, `isParcelAct`, `siteOf`, `bindingFromParcels` (preview, `source:
  'client-preview'`) are on `window.__siteBinding`. The preview cannot tell a cadastral hole from the
  edge of loaded data; label it a preview and publish with the server answer.

### Phase 2 — site-first creation (2026-10-01, built, not committed, not deployed)

**Built**
- **Records and drafts.** Drafts carry `fields.site` (MultiPolygon), `fields.toleranceM`,
  `fields.binding` (the preview or server binding the site was built with); records carry `site`,
  `toleranceM` (only when > 0) and `binding`. Draft validation: parcel acts keep `missing-parcels`;
  material goals report `missing-site` only when they have neither parcels, a site, nor their own
  design geometry (`proposals/site-draft.js` `draftGroundIssue`, used by the store and the adapters).
  With no live selection the local declaration is the site's binding parcels (empty on bare ground);
  publish replaces it with the server's. Synthetic design ids (`site:` / `site-plot:`) never reach
  the declaration. `conformanceOf`/`preparePublishRecord` (`formation-depth.js mayHaveEmptyDeclaration`)
  and `data.js requireExactCadastreAnchors` accept an empty declaration for a material record with a
  site or footprint; a chain import may be empty only with a site. `calculateProposalBounds` and
  `computeProposalArea` fall back to / prefer the site. `_buildHashSeed` and the content fingerprint
  include `site`/`toleranceM` when present (older ids unchanged).
- **Publish** (`proposals/publish-binding.js`, `window.__publishBinding`): `uploadProposalToServer`
  first binds the record — `POST /proposals/binding {site = siteOf(record), toleranceM, city}` — and
  publishes exactly the server's parcels as `cadastreParcelIds` with `site`; coverage `unknown` keeps
  the authored declaration (the server stores it unverified); parcel acts are left alone. Bound
  parcels reached into by < 0.5 m are listed with their width in a confirmation ("Include them" /
  "Change the design"). Acceptances on parcels the binding no longer holds are dropped. Server
  refusals `undeclared-parcels`/`unbound-parcels` read as "reaches into … HR-1-5 (4 cm)" lists
  (`refusalMessage`). `buildUploadReadyProposal` keeps a server binding as is, drops a client-preview
  one, and measures the ownership flow over the published declaration; `computeOwnershipFlow` of an
  empty declaration is `[]` (was: every loaded parcel). The mint path binds the site the same way
  before minting and takes its image geometry from the site; "no geometry" / "no parcels and no site"
  now throw instead of silently skipping the mint (the mint call's arguments are the chain phase's).
- **Generators** (sub-agent, details in its report): the main leak was `footprint-geometry.js
  robustUnion` (±0.1 m buffer pair filling concave corners ≈ 3.4 cm into neighbours; bound
  neighbours in 55/60 and 116/120 real selections) and `sanitizePolygonFeature` (the same pair on
  every polygon, and filled holes). Now an exact union with micro-hole filling (`proposals/site-clip.js`),
  `building-blocks.js simplifyAndClipOutline` always clips, the readjustment sweep rotates in a local
  affine frame (`reparcellization-slice.js sliceAlongBearing`), freeform footprints are clipped to the
  block on save, and `site-binding.js` scales centimetre slivers before turf's inward buffer (turf
  returned nothing for them, so the preview missed corner fills the server saw). Roads were left:
  their ribbons genuinely cross neighbours by centimetres (172 of the 234); the site panel shows them.
- **Site-first UI**
  - **Ground menu** (`ui/ground-menu.js` + pure `ui/ground-menu-model.js`): opens from
    `drill-ui.js onMapClick` when nothing is at the point AND the cadastre there is loaded
    (`CadastralParcelRepository.isPointLoaded`, a new read over the per-cell loaded set, false while
    a cell is in flight) or the city has no cadastre; "not loaded" only says so in the status line.
    Actions: Draw a site here, Road, Track, the four stations (`ground.*` commands, surface `ground-menu`).
  - **Site tool** (`js/site-drawing.js`, `window.SiteTool`): click corners (snap to loaded parcel
    corners/edges within 12 px, Alt disables), finish by the first corner / Enter / Finish, Backspace,
    Esc; then `PolygonGeometryEditor` for vertex editing (new `snapCoordinate` option). Holds the
    map-edit lock. Reached from the ground menu, the palette (`site.draw`), the parcel menu
    (`parcel.useAsSite`) and the selection tray (`selection.useAsSite`, the union as an editable site).
  - **Binding preview** in the **site panel**: bound parcels outlined, small (< 0.5 m) intrusions in
    amber with "Reaches 4 cm into … — include it, or change the design" and **Include it** (site ∪
    parcel) / **Trim the site** (site − parcel), touched parcels only under a tolerance > 0, open ground
    hatched (client `openGroundOf`), coverage label (complete / partial / partial-all-open / none /
    unknown) — "Preview" from loaded parcels, then "Cadastre" from the server.
  - **Build palette on a site** (the parcel palette, `buildProposalPaletteHtml` with a site handler):
    park/square/lake are the site (`instantCreateStructureFromSite`); Block and Freeform design on the
    site as one synthetic superparcel; Detached and Row cut synthetic plots
    (`proposals/site-plots.js`, 20 m / 7 m, longest edge by default, click another edge) and open
    their tools on them (`startInstantSiteDesign`; the tools resolve parcels through
    `window.resolveDesignParcelFeature`). Land readjustment is shown disabled with its reason;
    Offer is not offered (parcel act). Transport tools hand over to the corridor/station tools.
  - Stations: placement needs only an alignment; an incomplete footprint is stored with a partial
    (or, in a city without a cadastre, `none`) preview binding instead of being refused. Roads: "No
    parcels affected" no longer exits.
  - **Create dialog**: a site-first draft opens with `siteContext` (site summary line, no selection
    needed, contiguity = one polygon); owner offers stay parcel-only. **Parcel intrusion tolerance (m)**
    in Options (0–1, default 0, with the linear/city explanation) is stamped as `toleranceM`.
  - **Apply on ground without parcels** (phase 3's job): `ProposalManager.siteGroundWithoutParcels`
    (material + empty declaration, or binding coverage partial/none, corridors only when empty) makes
    apply refuse with code `site-ground-without-parcels` and a translated message; creation stores and
    lists the record, selects it (dashed outline) and says "Saved … It can't be applied to the parcel
    map yet…"; Apply to map shows the same message.
  - **Explore**: proposals and stations sections and the Proposals button are back; banner: "No
    parcels here: you can draw a site and propose, but a proposal can only execute through an
    authority's verdict." All new strings in en/hr/es/sr.

**Decisions**
- The site panel's warnings are the "include it or change the design" step; publishing never passes
  a tolerance silently — small intrusions are confirmed at publish.
- A site edited from a selection is a site: its declaration is its binding, not the original selection.
- Selection-based designs (palette on a selection) now carry the selection's union as `site`, so a
  block publishes its whole superparcel binding.
- Touched parcels are hidden at tolerance 0 (sub-millimetre: a snapped corner, a shared edge).
- Open ground in the panel is the client preview geometry; the server reports only its area.

**Tests** (backend vitest): site-draft 19, publish-binding 12, frontend-ground-menu 11 (model,
commands, `isPointLoaded`), formation-depth +3, proposal-drafts +3, proposal-editor-adapters +4,
generator-inside-site 17, site-plots 12; transit-stations and frontend-world-entry moved to the new
rule (station placeable without parcels, explore keeps proposals/stations). Red-checked by reverting
the declaration rule, the bare/not-loaded rule and each generator fix. Full suite: 6048 passed, 6
skipped, 0 failed.

**Verified in a headed browser** (local backend on the docker DB): Zagreb — drawn sites over parcels
(31 bound, "Reaches 22 cm into HR-339164-2685", Trim and Include re-bound as expected), block,
detached (4 plots) and row houses (8 plots) designed on drawn sites and applied, a park published
(server binding of 5 parcels, small-intrusion confirmation, row 1345 read back), a forced mismatch
refused with "HR-339164-2771 (24 cm)"; the create dialog on a site with tolerance 0.05 m. Šibenik
hole — coverage partial, hatched open ground, a square with an empty declaration stored, refused
apply with the message, published (row 1347: `[]`, partial, 372 m²). Explore Tokyo — ground menu,
coverage none, park stored and listed after reload. Phone 375×740 — ground menu peek, drawing,
panel as a bottom sheet. Not verified in the browser: a road drawn across bare ground, minting.

**What phase 3 (apply) must handle**
- Replace `siteGroundWithoutParcels` refusals: host open ground as `ground:<siteHash>` from the
  authoritative binding (`record.binding`, `unsurveyedM2`), not from gaps in loaded parcels.
- Drawn sites that cut parcels partially currently apply through the existing formation code (parks,
  blocks, detached, row applied in Zagreb); check what that does to the remainders and take-whole rules
  once the site, not the selection, is the scope.
- Corridors with an empty declaration take the plain store path (no atomic corridor transaction).
- Stations stored with a partial preview binding; the scope code still assumes full coverage.
- Local records keep the preview binding as their declaration until published; re-binding on publish
  can change it (and drops acceptances outside it).

### Phase 5 — chain (2026-10-01, built and tested on localnet, not committed, not deployed)

**Program (proposal_nft v3)** — `blockchain/solana/programs/proposal_nft/src/lib.rs`
- `Proposal` appends `site_hash [u8;32]`, `open_ground: bool`, `open_ground_cleared: bool`,
  `layout_version: u8` after v2's `verdict_may_execute`. `layout_version` = 3 on every v3 mint, 0 on
  v1/v2 accounts (zero padding; only the mint sets it), so a zero `site_hash` is no longer ambiguous. proposal_market and proposal_pledge read a prefix (`ProposalHead`,
  `ProposalLensView`) and are unchanged in source and behaviour; Anchor's borsh read does not require
  the rest of the account to be consumed.
- `mint_and_fund(parcel_ids, is_conditional, image_uri, sol_amount, lens, verdict_may_execute,
  site_hash, open_ground)`. Empty `parcel_ids` needs a non-zero `site_hash` (`NoParcels` otherwise) and
  `open_ground` (`EmptyBindingIsOpenGround`); `open_ground` needs a `site_hash` (`OpenGroundNeedsSite`).
  Parcel acts still need parcels: client-enforced (phase 1 rules), the program knows only list + hash.
- State machine (full diagram in lens-model.md "proposal_nft v3"):
  - by consent ⇔ parcels non-empty ∧ all accepted ∧ (¬open_ground ∨ open_ground_cleared);
  - an `executed` verdict always needs `verdict_may_execute` (the `acceptance_count ==
    parcel_ids.len()` alternative is gone: it was `0 == 0` for an empty list and dead code otherwise);
    it executes, except on open ground with parcels, where it sets `open_ground_cleared` and the
    proposal executes at the last acceptance (or at once if consent is already complete). Both orders
    work; consent-complete on open ground stays Active (still open to contributions) until the verdict.
  - Why the verdict does not execute open ground with parcels even with `verdict_may_execute`: it
    speaks for unowned ground, not for the bound parcels' owners. Without open ground the v2
    permit-style meaning is unchanged.
  - Clients set `verdict_may_execute = open_ground` (browser create.js and agents' minter default);
    a proposal with open ground minted without it can only expire or be cancelled.
  - `VerdictRecord.verdict` and an appended `VerdictSettled.verdict` = what the verdict said (1/3);
    `VerdictSettled.status` = status after it (0 for a clearance).
  - Funds: Active → cancel_and_refund, Expired → reclaim_expired_funds, Executed → distribute_funds
    (records of accepted parcels, or the owner when none, e.g. an empty binding). No stranded state.
  - 4096 bytes always suffice: one mint transaction caps the variable data at ~1.1 KB.
  - `open_ground` is proposer-declared; the record's server binding is authoritative off chain, so an
    audit can compare `site_hash`/`open_ground` against the record (not built).
- Account versioning: v1/v2 accounts are 4096 bytes zero-initialised and never shrink, so the new
  fields read as zero hash / false / false = exactly v2 behaviour. Proven on localnet against a v2-layout
  genesis fixture (`tests/fixtures/generate-v2-proposal-fixture.mjs`, `v2-proposal.json`, registered in
  Anchor.toml).

**Site hash** — `frontend/js/proposals/site-hash.js` (UMD, `window.__siteHash`, loaded before
proposal-bridge.js): canonical MultiPolygon, coordinates as integers in 1e-7° units, rings de-duplicated,
rotated to the smallest vertex, exterior CCW / holes CW, holes and polygons sorted, compact JSON with
sorted keys → sha256 (WebCrypto). `chainSiteArgs({ site, binding, parcelIds })` → `{ siteHash, openGround }`:
open ground ⇔ no parcels or binding coverage ≠ `complete` (partial, none, unknown). Used by
proposal-bridge.js/create.js and backend/agents/minter.js; decoders render the zero hash as `null`.

**Clients and decoders**
- IDLs: `idl/proposal_nft.json` regenerated (v3); the previous v2 file is kept as
  `idl/legacy/proposal_nft.v2.json`, so the tx decoder tries v3 → v2 → v1. The proof-route pins still
  compare against `legacy/*.v1.json` (devnet is v1); untouched.
- `frontend/js/solana/acceptance-client.js`: `encodeMintAndFundData` takes `siteHash`, `openGround`
  (mirrors the mint rules); `readProposalV2` → `readProposal`, `fetchProposalV2` → `fetchProposal`
  (acceptance-bridge.js updated), decoding `siteHash`, `openGround`, `openGroundCleared`.
- `frontend/js/solana/proposal-bridge.js`: `mintProposal({ ..., site, binding })` or explicit
  `{ siteHash, openGround }`; empty parcel list allowed with a site. `create.js` passes
  `proposal.site`/`proposal.binding` and `verdictMayExecute = openGround`.
- `frontend/js/solana/chain-data-loader.js`, `backend/agents/lifecycle-actions.js`
  (`decodeProposalState`; `settleWithVerdict` reports `status: 'active'` for a clearance),
  `backend/oracle/proposal-lifecycle.js` (`readProposalSite`, lifecycle event evidence `site`),
  `backend/oracle/proposal-consent.js` (`VerdictSettled.verdict`, falls back to `status` for v2 events;
  evidence `clearedOpenGroundOnly`), `backend/solana/tx-decoder.js` (mint summary names the site).
- Agents: `minter.js` `mintProposal({ site, binding })`, `ugt-agent-tools.js` mint (empty list needs a
  site and its server binding), MCP `ugt_mint_proposal` zod (`site`, `binding`, `parcelIds` default []).
  `docs.js` documents the v3 mint/settle.

**Tests**
- Anchor localnet: 158 passing (parcel_nft 6, proposal_market 28, proposal_nft 54, proposal_pledge 70;
  baseline 139). New: mint rules (empty + site ok, no site → NoParcels, not open ground →
  EmptyBindingIsOpenGround, open ground without site), loophole regression (executed verdict on an
  empty binding without verdict_may_execute refused, then expire + reclaim), empty binding executes
  only by verdict + distribute to owner, no acceptance possible on an empty list, cancel refunds,
  open ground with parcels consent-first and verdict-first, without verdict_may_execute (refused,
  cancel refunds), expiry while waiting (reclaim), site hash on a fully bound proposal = v2 behaviour,
  v2-layout account reads zero/false and behaves as before (executed verdict refused, acceptance
  executes, distribute pays); market YES only via a verdict_may_execute verdict / NO on expiry;
  pledge release only after that verdict / refund on expiry. Run per file on a fresh validator each
  (temporary port overrides, reverted): a single full run on this machine hit random 30 s confirmation
  timeouts while another local validator was busy; every test passed in at least one full run too.
- Backend vitest: full suite 6046 passed, 6 skipped. New/updated: site-hash (canonical encoding pinned
  byte for byte, invariances, chainSiteArgs), minter ↔ browser byte parity incl. empty binding + site,
  acceptance-client v3 codec/decoder, chain-data-loader v3 fields, lifecycle-actions decode + clearance,
  lifecycle oracle `readProposalSite`, VerdictSettled v2/v3 decoding, tx-decoder v3/v2/v1 picking,
  market-layout tail, MCP mint schema, agent mint tool site rules, docs v3 args.

**Deploy plan (not executed)**
1. Deploy only after phase 1's record/DDL is live (records must carry `site`/`binding` for minters).
2. `proposal_market` and `proposal_pledge`: no redeploy needed for v3 (prefix readers). If the lens v2
   upgrade of `proposal_market` (Expired → NO) is not yet on devnet, it must go first.
3. Upgrade `proposal_nft` to v3 (`anchor deploy --program-name proposal_nft --provider.cluster devnet`,
   never `anchor keys sync`), then upload its IDL. This is the v1 → v3 jump on devnet (v2 was never
   deployed) unless the lens v2 upgrade ships first; either way existing accounts read as no site.
4. Ship frontend + backend in the same window as step 3: every mint client sends the two trailing args
   and a v2 client's mint fails against v3 (and vice versa).
5. After the deploy: move the hackathon-proof pins to the deployed binary/IDL (snapshot it as
   `legacy/proposal_nft.v3.json` only when a v4 replaces it), and re-read one minted empty-binding
   proposal back from devnet.

### Phase 3 — apply on open ground (2026-10-01, built, not committed, not deployed)

**Built**
- **Open-ground host** (`frontend/js/proposals/open-ground.js`, UMD, `window.__openGround`, loaded after
  site-binding.js). `hasOpenGround(record)`: a material record with a site and an empty declaration, or a
  declaration whose binding coverage is `partial`/`none`. Declared records with coverage `complete`,
  `unknown` (a city whose cadastre the server does not hold) or no binding (legacy) keep the cadastre-only
  path; parcel acts never stand on open ground. `openGroundHost(record, { parcels, occupied, siteHashHex })`
  = site − the DECLARED (= bound) parcels' repository geometry − pieces other proposals already formed on
  that open ground, components narrower than the binding floor dropped (`site-binding.survivesInwardBuffer`,
  now exported), id `ground:<siteHash>` (`window.__siteHash`). Parcels are subtracted one at a time
  through the arrangement's snapped clipper; a failed subtraction or a bound parcel missing from the
  repository throws (never "treat it as open ground"). The host is transient: it is never stored in the
  fabric.
- **Apply** (`proposal-manager.js`): `_applyProposalTransactionBody` computes the host
  (`_openGroundHostFor`, cached by canonical site + declaration when nothing else stands there) and passes
  it with the occupied pieces as `openGroundHost`/`openGroundParents`; `_resolveLiveFormationParents` puts
  them beside the bound cadastral pieces, so the ≥95 % gate is "footprint covered by bound cadastral
  pieces + other formed pieces + the open-ground host". `_resolveAndStampFlatCadastreAnchors`: an
  open-ground record is complete when its footprint lies inside its site (the binding, not loaded
  parcels, says where parcels end). `_loadReplayGround` skips records on open ground only (no client-side
  "parcels under the footprint" lookup). `_rematerializeResolvedScope`, unapply, delete and clear-all
  proceed for seeds on open ground with no cadastral scope; `_resetDerivedFabric` skips an empty
  cadastral scope (an explore plan) and drops stale ground pieces (all on a full reset, by producer on a
  scoped one). Records with no cadastral ids are matched to the city by their authored `city`.
  Readjustment/decide-later on open ground refuse with `readjustment-open-ground` (phase 4).
- **Pieces on open ground** carry `cadastreParcelIds: []` + `groundIds: ['ground:<hash>']` and rootless
  ids `<token>-<n>`; a piece over parcels and open ground carries both. The identity funnel
  (`_assignSyntheticChildIdentitiesImpl`), the live fabric (`normalizeFeature` accepts ground provenance
  only with a producer; `explicitGroundIds`), `formation-edit` (`formationIdentityOf` gains `groundIds`,
  `root`, `anchor`; `baseIdsOfFeatures` skips ground pieces) and the foreign-index allocator (ground
  anchors scanned) understand them. Ground pieces are removed by producer, never by cadastral scope.
  Never offered as cadastral parcels: `cadastreIdsForParcelIds` yields nothing for them, the parcel menu
  shows "Open ground" with only Details/View in 3D/Use as site (`isGround` fact), the parcel panel title
  says "Open ground", server proposal counts skip them, road drawing does not count them as affected
  parcels, the site preview does not send their ids to the repository.
- **Geometric interaction** (`_openGroundInteractions` + `open-ground.geometricInteractions`): the
  formation closure adds, beside shared anchors, standing records whose ground (site, else footprint)
  intersects a member's by ≥ 0.25 m² where at least one of the two is on open ground; transitive; bbox
  grid index (`createBboxIndex`, overflow list for huge entries); each record's ground cached on the
  record object (corridors never cached). A purely cadastral plan skips the pass entirely. Stacking on
  open ground follows the cadastral rule "the taker amends the taken": a newer proposal takes the older
  one's ground piece where they overlap, the older keeps the rest under its own identity, unapply gives
  it back. Explicit Apply still parks overlapping applied alternatives (unchanged, already geometric).
- **Corridors**: a take with an empty declaration is a ribbon on open ground (no arrangement there,
  `corridorOnOpenGroundOnly`); `corridor-cadastre-scope-missing` only when the binding names parcels the
  declaration lacks. Every corridor (also one on bare ground) goes through `createCorridorProposalAtomically`.
- **Removed**: `siteGroundWithoutParcels`, its message, `_refuseSiteGroundWithoutParcels`, the
  `site-ground-without-parcels` code and handling in the editor shell / execution.js, the `groundless`
  plain path for corridors, i18n `proposalDrafts.siteSaved`/`siteNotAppliedYet`. New i18n
  `parcelMenu.groundTitle`/`groundNote` (en/hr/es/sr).
- Closure members that replayed now get one layer redraw per kind after commit (a park cut by a new
  square on the same ground kept its old drawing before).
- **Stats** (sub-agent): `proposals/site-stats.js` (`window.__siteStats`); plan stats, plan-yield,
  grain score, gain (3D panel), density, financials: site metrics always, binding metrics `null` with
  an empty binding, shown as "No parcels here" plus an open-ground note (`groundStats.*` i18n). Owners,
  ownership mix and compensation live only in the readjustment tool (disabled on bare ground).
- **Open-ground audit** (sub-agent): `backend/oracle/open-ground-audit.js` — pure `auditOpenGround(accounts,
  records)` + read-only `runOpenGroundAudit({ pool, connection })`; kinds
  `site-hash-mismatch`, `site-missing`, `open-ground-understated` (the dangerous one), `open-ground-overstated`,
  `parcels-mismatch`, `record-missing`, `record-ambiguous`; v1/v2 accounts (`layout_version` 0) skipped
  as `legacy-layout`. Advisory check `open_ground_audit` in the hackathon proof audit, opt-in
  (`scripts/hackathon-proof-audit.mjs --open-ground`), never fails the audit. A zero hash cannot tell
  v1/v2 from a v3 mint without a site; the account's `layout_version` (3 on every v3 mint) can, so the
  earlier `--v3-since` flag is gone.

**Decisions**
- *The site rule for parcels covered in part.* A proposal takes exactly its site/footprint. A
  park/square/lake cuts a partly covered parcel at the body edge; the outside part stays a piece of that
  parcel (its cadastral anchor and owners; minted as the structure's remainder for a cadastral parent,
  keeping its identity for a formed one). This was already what happened in practice — every apply runs
  inside the rematerialization, where `_rebuildInProgress` enabled the cut — so the "must take whole
  parcels" refusal was dead code; it is now the rule, not a rebuild exception. A structure designed on a
  parcel selection covers whole parcels by construction. A freeform building keeps its two modes: footprint
  parcel (default; remainders back to the owners) and `takeWholeParcels`, a user's explicit choice that
  still refuses a footprint covering only part of a parcel. Whole-parcel rules apply to cadastral
  parcels only: open ground is taken exactly where the footprint covers it, and nothing is minted for
  the rest of the host (open ground is not a parcel and has no owner to return a remainder to).
- *Content formations* (block, row, detached) mint no parcels on open ground: the host only satisfies
  the coverage gate; their buildings are the map presence.
- *A road across a standing structure on open ground is refused* (the structure cannot re-stand on the
  road), exactly as on cadastral ground (checked: a cadastral park crossed by a road refuses too). The
  road tool's "Build through" prompt promises otherwise in both cases — pre-existing, not changed here.

**Tests** (backend vitest; each fix red-checked by reverting it): open-ground-apply 16 (end to end through
the real manager, live fabric, mutation coordinator and formation code: square half on a parcel/half on
the Šibenik-like hole applies and unapply restores the fabric byte for byte; host from the binding — a
complete binding over a local gap is refused, a missing bound parcel is `cadastral-ground-absent`; bare
park rootless and undeclarable; block on a drawn site; freeform building over parcel + open ground;
station with a partial preview binding; geometric closure through the index; cadastral-only plan skips
it; road across a bare park refused; explicit apply parks the overlapping one; newer takes the older's
ground piece without double cover and gives it back; boot replay of an explore plan; bare road applies and
a later cadastral derivation does not trip; corridor with undeclared bound parcels still refused; partial
parcel cut outside a replay), open-ground 14 (pure rules, width floor, index, menu, whole-parcel building
beside open ground), formation-edit +1, stats-open-ground 26 + plan-stats-render +3, open-ground-audit 13 +
hackathon-proof-audit +3. Full suite: 6130 passed, 6 skipped, 0 failed (one run hit a flaky
`index.test.js` under host load 13; it passed 3/3 alone and in the rerun).

**Verified in a headed browser** (local backend on the docker DB, session closed, servers stopped).
Šibenik hole: drew a 426 m² square over HR-330264-488/2 and the hole (server binding: 1 bound parcel,
partial, 227 m² open ground) → applied, body 426 m² with cadastre `HR-330264-488/2` + ground id, the
parcel's 5233 m² rest stays its piece; Unapply → 312 pieces, `HR-330264-488/2` restored with geometry
identical to the cadastral fact; re-apply via Apply to map; reload replays it. Explore Tokyo: park
(rootless `p-…-1`, no cadastre) and a block on a drawn site applied and rendered in 2D and in 3D
(`enterThreeMode`; explore hides the 2D/3D rail); a square drawn over the park: boot replay now gives
park 1792 m² + square 4032 m² (no double cover; before the stacking fix both stood at full size); the
ground piece's panel says "Open ground"; a road across bare ground (road tool via
`requestRoadDrawTool`, roads are disabled in the explore/Šibenik menus) applied through the atomic
corridor transaction and renders; a road across the park refused with "Cannot apply the park: it would
stand on 414 m² of the applied road", rolled back; Plan Stats: "No parcels here", buildings/floor
area/open space as numbers, open-ground note. Zagreb regression: a block on a parcel and a road across 5
parcels (5 corridor pieces) applied as before. Page errors: only two from a build before the
empty-scope fix (boot replay of an explore plan threw "Cadastral replacement scope cannot be empty").

**What phase 4 (subdivision on bare ground) must know**
- Readjustment and decide-later refuse open ground by name (`readjustment-open-ground`) in
  `_applyProposalTransactionBody`; remove that when the slicer can form plots there.
- Plots on open ground must carry `groundIds` and no cadastre ids (rootless `<token>-<n>`); the funnel,
  fabric, identity carry and allocator already accept them. The pool is `openGroundHost` (+ the bound
  parcels' live pieces); `apply/parcels.js` still builds `parentEntries` from cadastral ids only and
  throws "A readjustment plot lies on no declared cadastral parcel" for a plot wholly on open ground, and
  its remainder pass would mint the host's leftover — it must not (open ground has no remainder).
- Ground pieces of other proposals inside the site are `openGroundParents`; a readjustment that takes
  ground another proposal holds is refused today by `formedByProposalIds`/producer checks — decide the
  rule for open ground.
- `site-plots.js` synthetic plots (`site-plot:` ids) are design-time only; making them proposal content
  (phase 4) needs them in the record, not in the fabric.

### Phase 4 — subdivision (2026-10-01, built, not committed, not deployed)

**Built**
- **Pure module** `frontend/js/proposals/subdivision.js` (UMD, `window.__subdivision`, loaded after
  site-plots.js): `sitePool(site, boundParcels)` (bound parcels' parts = site ∩ parcel, open ground =
  site − parcels, subtracted one at a time), `poolShares(contributions, { openGroundM2 })`,
  `ledgerOf(entry, ctx)`, `ownerKeyByGround(plot, pool, shares)`, `OPEN_GROUND_OWNER_KEY = 'open-ground'`.
  (The "plots along a street" layout first built here — `streetPlotsLayout`, `site-plots.js`
  `frontageExtent`/`bandOf` — was removed on 2026-10-01, see "Street layout removed" below.)
- **Apply** (`proposal-manager.js`, `apply/parcels.js`): the `readjustment-open-ground` refusal is gone;
  a readjustment on open ground gets the open-ground host like any formation (`formationOptions`). Plots
  carry per-plot provenance from the cadastral parents AND the ground parents: wholly on open ground →
  `cadastreParcelIds: []`, `groundIds: ['ground:<hash>']`, rootless id `<token>-<n>`; spanning both →
  both; on neither → refusal. The host leaves no remainder, is never consumed from the fabric, and the
  "no cadastral provenance" refusal applies only without a host. Plots assigned to `open-ground` get no
  agent, no ownership transfer and no `ownershipDetails`; a plot assigned to public land goes to the
  City as before. A decide-later merge on open ground (cannot happen: parcel act) is refused as
  `merge-open-ground`.
- **Authoring.** On a drawn site with open ground (coverage partial or none) the palette's Land
  readjustment is enabled and labelled **Subdivide** (`buildProposalPaletteHtml` `labels` option); a
  site wholly over parcels keeps "select parcels instead", coverage `unknown` says the server holds no
  cadastre there. `startSiteSubdivision(siteContext)` (editor shell) creates a reparcellization draft
  with the site and `plan.poolSource: 'site'`; the adapter (and, for the create dialog's Edit, the
  pending plan itself) opens the editor with `sitePool { site, boundParcelIds }`. The editor
  (`reparcellization.js`): title **Subdivision**; pool = the site; bound parcels from the repository
  (all must resolve); owners contribute their part INSIDE the site; an **Open ground (no owner)** entry
  contributes the open area; the 1-owner→public 50/50 rule is skipped; the modes are **Sweep line**
  (default) and **Manual**; a public strip is a plot assigned to public land. Ledger: open ground shows pooled/assigned area, "—" for balance and cash;
  the cash total is hidden with no owners. Saved plan adds `poolSource: 'site'`, `openGroundM2`,
  `ownerShares[].noOwner`. Reopening restores the saved plots and algorithm;
  more open ground than the plan saved (= bound parcels missing) refuses to open.
- **Coverage checks** (`proposal-editor-adapters.js`): for `poolSource: 'site'` the target is the
  draft's SITE, not the plan's pool, so `coverage-gap` / `coverage-excess` / `pool-coverage-mismatch`
  mean "the plots must tile the site exactly: its parcels and its open ground".
- Details panel "Total Area" falls back to the site area when there are no cadastral parents (was 0).
- i18n en/hr/es/sr: `reparcellization.modal.{subdivisionTitle, openGroundOwner, noOwnerBalance,
  siteParcelsMissing, siteUnavailable, siteGroundTaken}`, `siteTool.palette.{subdivide,
  readjustUnknownCadastre}`; removed `siteTool.palette.readjustBareGround`. CSS in modals.css.

**Decisions**
- *Ground another proposal formed on open ground is spoken for*: a subdivision over it is refused at
  apply (`readjustment-taken-ground`, naming the proposal) and at authoring (`siteGroundTaken`), like
  corridor ground. Open ground has no remainders, so any formed ground piece belongs to its producer.
  (Explicit Apply still parks overlapping applied alternatives first, as before.)
- *Shares with open ground are by area*: open ground has no known value, so a value basis would rate it
  at zero. A pool with no open ground keeps the value basis exactly as before.
- *Open ground is a pseudo-owner, not "unassigned"*: assigning a plot to it is a decision (the plot
  stays ownerless ground until the authority's process), so the completeness gate passes; it is never
  an agent and never owed/paid (`cashBalance: null`).
- *A subdivision takes land and outputs only plots*: the sweep line (by contribution) and manual editing
  work on the site pool. A street is not a layout mode: draw it as one plot and assign it to public
  land. (A "plots along a street" mode existed briefly and was removed.) The design-time `site-plot:`
  plots of detached/row are unchanged (they remain design input).
- *A site wholly over parcels is still a selection readjustment*: Subdivide only appears when the site
  has open ground.

**Tests** (backend vitest, each new rule red-checked by reverting it): subdivision 14 (pool split,
zero-owner/empty/mixed/value shares never NaN, open-ground ledger, street layout tiles the site —
middle, frontage, plots-only, rotated non-rectangular pool, turned frontage — and ground-majority
owners), subdivision-apply 5 (bare: rootless plots + ground ids, street to the City, no agent for open
ground, unapply empties, boot replay gives the same ids/geometry; plots covering half the site mint
nothing for the rest; refusal over another proposal's park; mixed: cadastral/ground/both provenance,
HR-1 remainder only, unapply byte-identical; ordinary readjustment unchanged), proposal-editor-adapters
+3 (site tiling valid, parcel-half plan refused against the site, editor opens with the binding's
parcels). Full suite: 6162 passed, 6 skipped, 0 failed.

**Verified in a headed browser** (local backend on the docker DB; session closed, servers stopped).
Explore Tokyo: drew a 7,208 m² site → palette "Subdivide" → Subdivision editor, 0 owners, Plots along a
street (10 × 613 m² + street), Turn the street (6 × 1,090 m² + N–S street), Done → applied 11 rootless
pieces `p-…-1..11`, `ground:<hash>`, total 7,208 m²; plot menu "Open ground · 613 m² · no cadastral
parcel"; 3D shows the plot outlines; reload replays the same 11 ids; Unapply / Apply to map / Unapply
from the details panel; fork → create dialog → Edit reopens the saved plots as Subdivision; published to
the local backend (row 1348: `[]`, coverage none, 11 polygons, poolSource site). Šibenik hole edge: a
1,864 m² site over HR-330264-488/2 (bound, 189 m² in the site, 3 owners) and 1,675 m² of open ground →
3 owners + open ground in the ledger, street along the frontage, applied: plots on open ground rootless,
the plot and street spanning the parcel edge carry `HR-330264-488/2` + ground id, the parcel's 5,244 m²
outside part stays its piece; reload replays; Unapply restores 488/2 with coordinates identical to the
cadastral fact. Zagreb regression: 2 parcels (HR-339270-325/326) → Land readjustment (Sweep line, 4
owners, € basis, no street mode) → applied 4 cadastral plots, no ground ids → Unapply restored both.
Phone 375×740: editor fits, no horizontal scroll. No page errors.

**Open**
- The plots' owner in a mixed pool is by ground majority; owners then show a cash shortfall for ground
  their parcels gave to open-ground plots. A redistribution rule (owners' entitlement first) is a
  design question.
- The automatic name of every readjustment is "Subdivide …" (`data.js` goal label, pre-existing).
- The details panel offer showed 345,000 USDT on the bare-ground subdivision (pre-existing offer
  default, not investigated).

### Phase 6 — layout version, explore polish, Build through, end-to-end pass (2026-10-01, built, not committed, not deployed)

**Built**
- **`layout_version: u8`** appended to the v3 `Proposal` after `open_ground_cleared`
  (`PROPOSAL_LAYOUT_VERSION = 3`, written only by `mint_and_fund`). v1/v2 accounts read 0 (zero
  padding; the v2 genesis fixture has zeros from the site offset to the end) and keep 0 when the v3
  program rewrites them. IDL regenerated (only change: the trailing u8). Decoders return `layoutVersion`
  (offset = after `verdict_may_execute` + 34): `proposal-lifecycle.js` `readProposalSite`,
  `lifecycle-actions.js` `decodeProposalState`, `chain-data-loader.js`, `acceptance-client.js`
  `readProposal`. `open-ground-audit.js` classifies by it (`SITE_LAYOUT_VERSION = 3`: below → skipped as
  `legacy-layout`; v3 with zero hash and a record site → `site-missing`; a v3 mint with no site is now
  checked, not skipped). `v3Since` / `--v3-since` removed (option, CLI flag, plumbing).
- **Explore and Šibenik roads.** Root cause: `city-config.js` mapped the sidebar section `roads` (Zagreb's
  road DATASETS: GUP/DGU/OSM detection, government plan) to the `roadTools` feature, so road drawing was
  off in every city without those datasets (Split, Šibenik, Belgrade, …, explore). The mapping is gone;
  `roadTools` defaults on (`DEFAULT_ENABLED_FEATURES`) and a city can still set `features.roadTools:
  false`. Ground menu and palette now offer Road/Track everywhere. Explore keeps hidden only what needs a
  cadastre or a Zagreb dataset: Layers (parcels, blocks, buildings, road datasets), area monitor (city
  plan/permit data), the parcel game, the cadastre view, walk (no sim location). The 2D/3D/photo strip
  is back in explore (model and photo render proposals without parcels; checked in the browser).
- **Copy** (en/hr/es/sr): globe popup tiers source/none/unknown now say you can draw a site and propose,
  executing only through an authority's verdict; "Explore anyway" → "Open the map here"; explore status
  line "No parcel data here: click the map to draw a site and propose."; search placeholder without a
  cadastre `mapSearch.placeholderNoParcels` "Search places, proposals…". `globe.js`/`world-entry.js`
  fallbacks match. On phones the explore banner starts right of the mode strip.
- **Road "Build through".** Root cause: nothing implemented the promise. The road's apply rematerialises
  the closure in formation order; the older park replays first, saw the newer road already flagged
  applied and refused (`_appliedRoadOverlappedByTaking`), and on cadastral ground the arrangement had
  already cut the road out of the park's parcel, so the park's coverage gate failed at 80 %. Explicit
  "Apply to map" of the road instead parked the whole park as a rival (`proposal-supersession.js`).
  Now: `apply/road.js _structureGroundAfterLaterCorridors(record, geometry)` carves the footprints of
  applied corridors LATER in the formation order out of a park/square/lake (same geometry the corridor
  cut consumes, the arrangement's snapped clipper, crumbs < 0.25 m² dropped); `apply/structures.js`
  forms, measures (resolver gets a carved view of the record) and draws that body, a split body becomes
  one piece per part through the contiguity funnel; the record keeps its authored geometry; stored
  decorations are filtered to the carved ground for display only (`decorationsOnGround`), lake graphics
  regenerated. A road no longer counts as an applied alternative to a structure it crosses (buildings
  still do). An OLDER road still refuses a newer structure over it (unchanged rule). Plan stats count
  open space as it stands (`plan-yield` `openSpaceAreaOf`, fed from the applied bodies).

**Decisions**
- The carve is a function of the plan (records + formation order), recomputed on every replay, so
  unapplying the road gives the park back whole; no record is rewritten.
- The order-aware guard I first added to `_appliedRoadOverlappedByTaking` was redundant once the carve
  existed (red-check: no test needed it) and was removed; one mechanism.

**Tests** (backend vitest): open-ground-apply +4 (bare park split by a later road, area = park − road, no
overlap, record unchanged, unapply restores one whole piece; cadastral park: road piece + 2 park pieces +
remainder partition the parcel exactly, via the road tool's create path; an older road still refuses a
newer park; `decorationsOnGround`), proposal-supersession +2, plan-yield +1, frontend-world-entry +1/
changed (explore and Šibenik keep road drawing, Zagreb too); the old "refuses a road across a bare park"
test is replaced. Red-checked: without the carve 2 fail; without the supersession exemption 2 fail;
restoring the `roads → roadTools` mapping 2 fail. Chain/audit (sub-agent): open-ground-audit layout tests
(ignoring the layout turns 4 red), decoders' `layoutVersion` in frontend-acceptance-client,
frontend-lens-chain-parser, lifecycle-actions, proposal-lifecycle-oracle, proposal-market-layout,
hackathon-proof-audit. Full backend suite: **6162 passed, 6 skipped, 0 failed** (442 files). Anchor
localnet, each file on a fresh validator (temporary ports 18899/18001/19900, Anchor.toml restored and
diffed): proposal_nft 54, parcel_nft 6, proposal_market 28, proposal_pledge 70 = 158 passing, including
`layoutVersion === 3` on fresh mints and 0 on the v2 fixture before and after a v3 rewrite.

**Verified in a headed browser** (local backend → docker DB; session closed, servers stopped; no page
errors at any step). Globe → Tokyo: popup "Open the map here" → explore, status and placeholder as above.
Ground menu (Draw a site, Road, Track, 4 stations) → drawn site → park; Road from the ground menu across
the park → "Build through" → road built, park now a 2-part MultiPolygon (9,160 → 8,230 m²) with the road
between, decorations off the road; block on a drawn triangle; detached (7 plots) on a drawn site; bus
station beside the road ("Bus station placed"); 3D and photo modes render in explore; Plan stats: No
parcels here, 8 buildings / 41,509 m² GFA, open space 8,230 m² (was 9,180 before the stats fix), open-
ground note; published park and road (rows 1349/1350: `[]`, coverage none) → reload replays 5 applied,
carved park identical. Subdivision (phase 4) in explore: drawn site → Subdivide → Plots along a street,
12 plots + street, Open ground (no owner), applied 13 rootless pieces. Zagreb: park on HR-339270-4201;
road across it through the road tool (surface-level prompt, then Build through) → park split into 2
pieces (228 + 223 m²), 7 corridor pieces, no double cover; block on a parcel (1 building, 964 m²);
park published (row 1351, `["HR-339270-4201"]`, complete); a parcel used as a site and dragged ~1 m into
its neighbour → binding 2 parcels → square → publish (row 1352, HR-339270-4184 intrusion 0.78 m, so no
small-intrusion confirmation). Šibenik (hr): ground menu offers Cesta/Pruga/stations (roads now on);
mixed site over HR-330264-488/2 and the hole ("Katastar: djelomična", hatched open ground) → Trg applied
(2,866 m²). Phone 375×740: explore banner, ground menu as a bottom sheet, mode strip clear.

**Open (found in the walk, not fixed here)**
- *Road across subdivision plots on open ground double-covers them*: the ribbon on open ground takes
  nothing from formed ground pieces (phase 3 corridor rule), so 12 plots + street keep their full area
  under a new road. Cadastral readjustment plots are amended by §15b; open-ground plots need the same
  (proposal-manager / apply/parcels — phase 4 files). The road tool also counts those ownerless plots as
  "Parcel count 3 · Individual owners 3".
- No "Build through" prompt exists for subdivision plots or buildings; only parks/squares/lakes.
- The "Tolerance" create-dialog option was not re-walked this phase (verified in phase 2).
- Status line "Odabran prijedlog … (sadrži 1 parcelu)" uses "parcela" where the rest of hr says "čestica"
  (pre-existing string).
- `run-job status po-6` kept reporting `running` after `run-job stop` although both ports were free and
  no process remained.

**Deploy order for the whole branch** (nothing executed)
1. DB DDL on prod: `routes/proposal-site-ddl.sql` (site, binding, CHECK NOT VALID, GiST) via the deploy
   DDL list — before any code that writes `site`/`binding`.
2. Backend (phases 1–6): binding route, create path, serializer, oracle decoders with `layoutVersion`,
   audit without `--v3-since`. Restart with the ecosystem file; verify the running process.
3. Migration: `backend/scripts/migrate-proposal-sites.mjs` dry run on prod, read the report
   (recomputed-binding differences), back up, `--apply`, re-run to prove a no-op.
4. Frontend (phases 2–6) — but it mints with v3 args, so it ships in the same window as step 5 (or keep
   minting disabled until then).
5. Programs (devnet): `proposal_market` lens v2 upgrade first if not yet on devnet; then `proposal_nft` v3
   with `layout_version` (`anchor deploy --program-name proposal_nft`, never `anchor keys sync`), upload
   its IDL; `proposal_pledge` and `proposal_market` need no redeploy for v3 (prefix readers). Ship
   frontend + backend minters in the same window (old clients' mints fail against v3).
6. After: move the hackathon-proof pins to the deployed binary/IDL, mint one empty-binding proposal and
   read it back (`layoutVersion` 3, `siteHash` = the record's site hash), run
   `hackathon-proof-audit.mjs --open-ground` once.

### Phase 6b — road over open-ground plots (2026-10-01, built, not committed, not deployed)

**Built**
- **One carve for every formed piece a later road crosses.** `apply/road.js`
  `_structureGroundAfterLaterCorridors` became `_groundAfterLaterCorridors(record, geometries)`: the
  applied corridors LATER in the formation order are clipped (arrangement's snapped clipper, crumbs
  < 0.25 m² dropped, bbox prefilter) out of a list of geometries. Structures pass `[body]` (unchanged
  behaviour); `apply/parcels.js` passes every plot of a readjustment/subdivision, so a later road takes
  its ribbon out of the plots it crosses (split plots become one piece per part through the contiguity
  funnel; a plot taken whole is not formed; all taken → `readjustment-taken-by-corridors`). The resolver
  measures the carved plan; the record keeps its authored plots, so unapplying the road gives them back.
  This also fixes cadastral readjustments: a road across readjusted plots was refused before (the
  arrangement had cut the parcels under the road and the replay failed its coverage gate at 83 %).
- **An earlier road still refuses a newer subdivision**: on open ground (no arrangement) the plots are
  tested against standing roads like a park is (`_appliedRoadOverlappedByTaking`, code
  `readjustment-over-road`); on cadastral ground the coverage gate already refuses it.
- **Buildings** behave as on cadastral ground: a road through a building standing on a plot is refused
  (rolled back, fabric unchanged); a road beside it across the same plot cuts the plot and the house keeps
  its parcel.
- **Road tool stats**: `liveRoadDrawingParcelsIntersecting` returns cadastral parcels only (the one query
  every stats path uses: lock, preview, whole road, declaration); pieces formed on open ground are
  collected apart (`open-ground.splitCrossedPieces`) and shown in a new **Open ground** metric
  (`{{count}} · {{area}}`, hidden on a purely cadastral road; `panel.road.openGroundLabel/Value`
  en/hr/es/sr). The old per-path `isGroundPiece` skip in `findAndHighlightAffectedParcels` is gone.
- **Plan stats**: overlapping bare sites (a road through a subdivision) no longer count their shared
  ground twice in the open-ground note (`site-stats.planGround` subtracts the geometric overlap; a bare
  record without an authored site, e.g. a road, uses the site site-binding derives).
- **Croatian**: "parcela" → "čestica" in every user-facing hr string (340 inflected forms; keys,
  placeholders, "reparcelacija/parcelacija", "superparcela" untouched), incl. "Odabran prijedlog … (sadrži
  1 česticu)"; "Parcel Builder" → "graditelj čestica".

**Decisions**
- One mechanism, not a subdivision special case: the carve is "formed ground after later corridors",
  applied to every formation that holds ground (structure bodies, readjustment plots), on cadastral and
  open ground alike.

**Tests** (backend vitest): road-over-plots 5 (bare subdivision cut, partition = site, authored plan
untouched, boot replay identical, unapply byte-identical; earlier road refuses a newer subdivision; road
through a house refused / beside it cuts the plot; mixed site; cadastral readjustment), road-open-ground-
stats 7 (real road-drawing functions lifted: 3 ownerless plots → 0 parcels, 0 owners, "3 · 3000 m²";
mixed; hidden on cadastral; locales; `splitCrossedPieces`; hr "česticu" and no inflected "parcela"
left), stats-open-ground +1. Red-checked: without the plot carve 4 of 5 fail, without the guard 1, without
the road-tool split 2, without the overlap subtraction 1. Full suite: **6175 passed, 6 skipped, 0 failed**.

**Verified in a headed browser** (local backend → docker DB; session closed, servers stopped; no page
errors). Explore Tokyo: drew a 13,458 m² site → Subdivide → 12 plots + street (13 pieces) → road from the
ground menu across it: road panel "Parcel count 0 · Individual owners — · Open ground 3 · 3,293 m²" →
built: 16 pieces, 12,659 m² + 800 m² of road inside the site = the site, 0 m² of plot on the road; reload
replays the same 16 ids/geometries; plan stats open ground 13,593 m² (was 14,393, double counted);
Unapply the road → the 13 original pieces, ids and geometry identical; reload keeps them. Zagreb: park on
HR-335266-3159/1 → road across it (surface level, Build through) → park in 2 pieces (2,064 + 3,087 m²),
3 corridor pieces, no overlap; road panel showed parcels/owners and no open-ground metric.

**Open**
- Still no "Build through" prompt for subdivision plots (the road just builds through them, as now
  agreed); the prompt names only parks/squares/lakes.

### Phase 7a — snapping to buildings, frontage from streets (2026-10-01, built, not committed, not deployed)

**Built**
- **Site corners snap to building outlines.** `site-draft.js` gained `snapToGround(coordinate,
  { parcels, buildings }, { radiusM })` (any corner of either kind beats any edge; the result carries
  `kind: 'parcel'|'building'`) and `snapTargetsInBox(geometries, box, { cap })` (bbox-indexed entries).
  `site-drawing.js` collects the features of the building layers currently on the map
  (`window.buildingLayer` = GDI or the city's provider, `dguBuildingLayer`, `osmBuildingLayer`; in
  memory, nothing fetched; buildings the plan destroyed skipped), bounded to the viewport and capped at
  5,000, rebuilt lazily after `moveend`, `buildingsLayerUpdated` or a GeoJSON layer being added/removed.
  Same 12 px radius, Alt still disables. The snap marker is pink on a building, blue on a parcel, with a
  label ("Building corner", "Parcel edge", …).
- **Frontage faces a street.** Pure `site-plots.js frontageScores` / `frontageFromStreets(site, streets)`:
  for each edge, the best street segment within 30 m of the edge midpoint, within 30° of parallel and not
  inside the site (> 2 m inward); score = parallel × (1 − d/30) × (edge / longest edge); none → the longest
  edge (`basis: 'longest'`). Street names from `name` / `street_name`, kind from `highway_type` / `highway`.
- **Street data**: `GET /streets/near?bbox=w,s,e,n` (WGS84; `backend/streets/near.js`, registered in
  `routes/streets.js`). Inside osm_road's extent (`ST_EstimatedExtent`, i.e. Croatia) it reads osm_road
  (index on `geom`, frontage highway types, named service roads); elsewhere (explore cities) it asks
  Overpass through the cell-cached proxy the OSM buildings layer already used — `osm-reference.js` now
  exposes `createOverpassCellSource` (per-source cache, shared throttle), `fetchOsmBuildings` is built
  from it unchanged. `/streets` (the Zagreb street register, 5,413 lines, EPSG:3765) was not used: osm_road
  covers all of Croatia with names and highway types.
- **UI** (`js/street-frontage.js`, `window.StreetFrontage.find/basisText`): detached/row plots on a site
  start on the longest edge while the lookup runs ("Looking for the street…"), then move to the street
  edge — "Frontage facing Gotalovečka ulica (7 m away)." / "Frontage: the longest edge (no street within
  30 m)." / "… (street data is unavailable here)." (Overpass throttled or a cell missing) / "the edge you
  chose" after a click. (The subdivision editor's "Plots along a street" used it too until that mode
  was removed.) i18n en/hr/es/sr (`siteTool.snap.*`,
  `siteTool.frontage.*`, updated `siteTool.hint.drawing/plots`).

**Tests**: site-draft +7 (building corner/edge kind, corner-beats-edge across kinds, box entries, viewport
filter and cap), site-plots +8 (street side vs longest, corner site, parallel beats perpendicular, too far /
perpendicular / through the site → longest, clockwise ring, unnamed and register names, plots cut on the
street edge), streets-near 9 (Overpass converter and query, osm_road vs Overpass by extent, extent cached,
bbox refusals, route). Red-checked (kind forced to parcel → 4 fail; no inside check / no length factor →
2 fail). Full suite: 6228 passed, 6 skipped, 5 failed — all 5 in `i18n-locale-coverage` for
`panel.proposal.bindingDrift.*` keys of the concurrent re-binding work (`binding-drift-panel.js`), not this
phase.

**Verified in a headed browser** (local backend → docker DB; session closed, servers stopped; no page
errors). Zagreb (Trešnjevka, GDI buildings on): cursor 4 px off a GDI corner 50 px from any parcel vertex
→ marker "Building corner", the clicked vertex equals the building vertex exactly. A 36 × 40 m site 7 m
north of Gotalovečka ulica → Detached: frontage on the 36 m street edge (longest is 40 m), "Frontage facing
Gotalovečka ulica (7 m away)"; clicking another edge → "the edge you chose". (A 50 m deep site reaching
Grebengradska picked Grebengradska at 2.5 m over Gotalovečka at 7 m — both face it.) Explore Tokyo:
Overpass first throttled → "the longest edge (street data is unavailable here)"; after the cool-off a site on
the Shibuya tracks → "no street within 30 m"; a 40 × 50 m site beside 宮益坂 → "Frontage facing 宮益坂 (8 m
away)" on the 40 m edge; Subdivide on it → Plots along a street with "Frontage facing 宮益坂 (8 m away)."
in the status, Cancel closed without an unsaved-changes prompt.

**Open**
- Public Overpass is slow/throttled at times; the explore frontage then honestly falls back to the longest
  edge. An `OVERPASS_URL` mirror (already read by the proxy) would help.
- The subdivision's inner street runs parallel to the frontage edge (phase 4 layout); facing the real
  street does not yet mean plots front it directly when the street goes through the middle.

### Phase 7b — re-binding on cadastre drift, Build through for plots (2026-10-01, built, not committed, not deployed)

**Built**
- **Drift (rule 5).** Shared pure module `frontend/js/proposals/binding-drift.js` (UMD,
  `window.__bindingDrift`): `bindingDrift(stored, current)` → `{ added, removed, coverageChanged,
  coverage, openGroundM2 }` or null (open ground moving < 1 m² is not drift), `driftNotice`,
  `deriveReboundRecord` (deep copy minus identity/consent/chain/local state, binding + declaration =
  current, lineage, `rebind { sourceProposalId, sourceServerId, storedComputedAt, currentComputedAt,
  added, removed, bindingKey }`), `findRebound`. Server `backend/proposals/binding-drift.js`
  `computeBindingDrift` reads the row (`site` column, else `proposal_data.site`; `binding` column, else
  `proposal_data.binding`), recomputes with `computeBinding` at the stored `toleranceM` and city;
  parcel acts (`subject: 'declared-parcels'`) are re-checked with `parcelActBinding` (gone parcels are
  `removed`). Uncheckable: `no-binding`, `no-site`, `unknown-coverage`. Route
  `GET /proposals/:id/binding-drift` in `routes/proposal-binding.js`, rate-limited with the binding
  reads (`BINDING_DRIFT_PATH` in index.js); nothing is written.
- **Details panel** (`binding-drift-panel.js`, mounted from `details-panel.js` runPostRender): for a
  record with a serial server id, the check runs after render, cached per record for the page session;
  the notice ("The cadastre changed since this was published: +2 parcels, −1", parcel lists, coverage
  change) offers **Re-bind** (confirm → derive → `proposalStorage.addProposal` → `uploadProposalToServer`;
  on failure the derived local record is removed) or, once re-bound, "Re-bound as <record>".
  `sharing.js` content fingerprint includes `rebind.bindingKey`, so the upload is not deduplicated onto
  the source (same site and design) — re-binding twice against the same cadastre publishes once.
- **Build through for plots.** Pure `frontend/js/proposals/plot-crossings.js` (`window.__plotCrossings`):
  `detectPlotCrossings(edge, { pieces, buildings, lookupProposal, plotRecords, approvedIds })` → plots
  per subdivision/readjustment (count, m² taken, kind) and `blocked` = proposal buildings the edge
  crosses that stand on an applied plot record's ground; `plotCrossingPrompt` → message + choices
  (Build through / Choose another route; only the latter when blocked). Glue in `corridor-structures.js`
  (`detectPlotCrossings`/`resolvePlotCrossings`, approvals per drawing session, cleared by
  `resetApprovedStructureCrossings`); `road-drawing.js` asks it per edge before the building prompt.
- i18n en/hr/es/sr: `modal.corridorPlots.*`, `panel.proposal.bindingDrift.*`; CSS in proposals.css.

**Decisions**
- The derived record uses the existing replacement lineage (`sourceProposalId`/`replacementOfProposalId`)
  plus a `rebind` block; it is added parked (not applied), so the source keeps its place on the map
  until the user applies the re-bound record.
- The drift check is per page session (cache); a later cadastre change is seen after a reload.
- A house on a plot is a refusal, not a choice: the prompt names it and offers only rerouting (the
  building prompt's surface/tunnel choice is not reached for that edge). Houses not on any plot keep the
  building prompt. Plots count is per piece crossed (a subdivision's street piece counts as a plot).

**Tests** (backend vitest): binding-drift 17 (pure drift/notice/derive/findRebound; server recompute at
the stored tolerance with the stored site, proposal_data fallback, parcel act, uncheckable cases; route
200/404/500, writes nothing), plot-crossings 10 (detection per proposal, readjustment vs subdivision,
kerf and approvals, house on/off plot, prompt choices, translator, corridor-structures glue incl.
"build" never passing a refusal, i18n keys in 4 locales), i18n-locale-coverage allowlists
`panel.proposal.bindingDrift.coverageKinds.`. Red-checked: dropping the on-plot test, the blocked-only
choices, the glue's refusal guard, the stored tolerance, or the open-ground drift each turn a test red.
Full suite: **6246 passed, 6 skipped, 0 failed**.

**Verified in a headed browser** (local backend → docker DB; session closed, job stopped, no page
errors). Zagreb: park on HR-339164-2972 → Share → Upload (row 1353). Cadastre change simulated in the
LOCAL db only: parcel `cestica_id 41085223` set `current=false` and two halves inserted
(`HR-339164-2972/901`, `/902`, `cestica_id -990001/-990002`, `data_source 'po9-drift-test'`). Reload →
details: "The cadastre changed since this was published: +2 parcels, −1" with both lists → Re-bind →
confirm → "Re-bound: published as record 1354"; row 1354 declares `/901,/902` with a fresh server
binding, same site (`ST_Equals`), `sourceProposalId` and `rebind.sourceServerId = 1353`; row 1353
unchanged (binding, `computedAt`, `updated_at`); its notice now says "Re-bound as …". Restored: test rows
deleted, `current=true` back; the parcel row's md5 equals the pre-test value, table count and min id
unchanged, drift of 1353 back to none. Rows 1353/1354 stay in the local DB as test records. Explore
Tokyo: 16,000 m² site → Subdivide (plots along a street) → road across: prompt "“Subdivide …”: 5 plots,
727 m²" → Build through → built, 18 pieces; Detached houses on one plot → road through a house: prompt
lists 3 plots and "“Detached-houses …” on “Subdivide …”", "it would be refused", only "Choose another
route" → nothing added.

**Open**
- After the cadastre change (and a reload) the source record still showed as applied locally on the
  retired parcel id; nothing tells a locally applied record that its parcel was retired (not investigated).
- The existing building prompt still says a surface crossing "takes their ground" for building
  proposals off plots, although such a road is refused at apply (`building-over-road`).
- No docs-agents.md / OpenAPI entry for `GET /proposals/:id/binding-drift` yet.

### Phase 7c — street and plot widths in the subdivision editor (2026-10-01, REMOVED with the street layout)

Superseded: the whole "plots along a street" mode, with these width controls, was removed (see "Street
layout removed" below). Kept as the record of what was built.

**Built**
- **Pure** (`frontend/js/proposals/subdivision.js`): `STREET_WIDTH_LIMITS_M` {4, 30} and
  `PLOT_WIDTH_LIMITS_M` {6, 60}; `streetPlotsWidths(input)` (missing → default 10 m / 20 m, numeric
  strings accepted, blank/NaN/out-of-range → `errors[{field, reason: 'not-a-number'|'range', min, max}]`);
  `streetPlotsPlanFields` / `streetPlotsSettingsOf(plan)` (saved fields ↔ editor settings; an old plan or
  an out-of-range saved value reads as the default). `streetPlotsLayout` now REFUSES instead of silently
  defaulting: a `RangeError` with `code: 'invalid-width'` (widths outside the limits) or
  `'no-whole-plot'` (the site's extent along the frontage is shorter than one plot; `details.frontageM`),
  and returns `streetWidthM`, `plotWidthM`, `frontageM` with the layout.
- **No plot depth control**: plots run from the street to the site edge, so their depth is the site's.
  `MIN_PLOT_DEPTH_M` (15 m) stays an internal threshold deciding middle / frontage / no street.
- **Remainder rule (unchanged, now documented on `streetPlotsLayout`)**: the frontage extent is split into
  `round(extent / plotWidth)` equal strips, so the remainder is spread over every plot (0.75–1.5 × the
  chosen width on a rectangle), never left as an odd last plot; a piece of an irregular site narrower
  than half a plot joins its neighbour.
- **Editor** (`reparcellization.js`, site pools only): a row under the tools — **Street width** and
  **Plot width (frontage)**, number inputs with the limits, enabled only for "Plots along a street",
  stood down in assign mode. A change (Enter / blur / spinner, not each keystroke) re-lays the plots;
  while the plots differ from the last automatic layout (hand edits, owner reassignments) it first asks
  "Re-lay the plots with the new widths? … discarded" (Re-lay plots / Keep my plots; keep reverts the
  inputs). A reopened saved plan counts as untouched only if its saved settings re-lay exactly its
  saved plots. Invalid input marks the field (`aria-invalid`) and says the range; a refused layout says
  why ("A 50 m plot does not fit: the site is only 40 m along the street…"); a street too wide for the
  site's depth says the site became all plots. Undo snapshots carry the widths. Saved plan:
  `streetWidthM`, `plotWidthM` next to `streetFrontageIndex`; restored on reopen (create dialog Edit and
  the draft adapter both pass the whole plan). Apply/replay read only the polygons, so they are unchanged.
- i18n en/hr/es/sr: `reparcellization.modal.streetSettings.{streetWidth, plotWidth, unit,
  streetWidthTitle, plotWidthTitle}`, `…modal.relayConfirm{,Ok,Cancel}`,
  `…modal.status.{noWholePlot, streetWidthInvalid, plotWidthInvalid, streetDropped}`. CSS in modals.css.

**Tests** (backend vitest, subdivision +6): chosen widths respected (street area / frontage ≈ 16 m,
18 plots of 108 m / 12 m) and tiling exact; remainder spread evenly; a 25 m street on a 33 m deep site
drops the street and still tiles; out-of-range / NaN / zero widths and a 50 m plot on a 40 m frontage
refused with their codes; input-string parsing; plan-field round trip incl. old plans and identical
re-layout from saved settings. Red-checked: disabling the range check, the no-whole-plot refusal or the
street width pass-through fails 4 tests. Full suite: **6266 passed, 6 skipped, 0 failed**.

**Verified in a headed browser** (explore Tokyo, local backend; session closed, job stopped, no page
errors): 7,691 m² site → Subdivide → controls show 10 / 20; street 16 → 16 m street through the middle;
plot 12 → 6 plots per side on the 70 m frontage; street 3 and plot 61 → field marked, range message,
layout kept; back to a valid value clears it. A plot reassigned to Public land, then plot 15 → confirm;
Keep my plots reverted the input to 12 with the reassignment intact; again → Re-lay plots → 5 per side,
reassignment gone; Undo restored 12 and the reassignment. Done → stored plan `streetWidthM 16,
plotWidthM 15, streetFrontageIndex 3`, 11 polygons; reload replays the same plots; Unapply → Fork → Edit
reopens with 16 / 15 and the saved plots; plot 20 then re-lays without asking (untouched). 375 px:
the two fields wrap under each other, no horizontal scroll.

**Open**
- "Turn the street" still re-lays without asking even after hand edits (7a behaviour, left as is).
- Fork → Edit of a still-applied subdivision refuses with `siteGroundTaken` (its own ground); unapply first
  (phase 4 rule, not changed here).
- Saving the fork logged `[captureViaTileStitch] Final bbox looks invalid` (lng/lat swapped in the bbox) —
  thumbnail capture on explore, pre-existing, not investigated.

### Phase 7d — publish author, site-only subdivision forks, explore chip (2026-10-01, built, not committed, not deployed)

**Fixed**
- **Stale author on publish.** A record created as a guest went out under its guest alias after the profile
  had chosen a name (local row 1355 "Guest 4232"; reproduced as row 1356 before the fix). Choosing a name
  renames the same agent in place, but the record only carried the old name string. Now `addProposal`
  stamps `authorAgentId` when the record's author is the current profile's name
  (`GuestPolicy.claimAuthorAgentId`), and every outgoing path stamps the profile's CURRENT name onto this
  profile's never-published record (`GuestPolicy.outgoingAuthor` via `stampCurrentAuthor` in
  `proposals/storage.js`; local draft updated with `proposalStorage.setProposalAuthor`): the publish
  projection `buildUploadReadyProposal` (the share dialog projects before it uploads, so the stamp must
  sit there, before the device-local `authorAgentId` is dropped), `uploadProposalToServer`, the share-plan
  payload and the share dialog's mint metadata. Published/minted records (`isProposalImmutable`), other
  agents' records and records without `authorAgentId` keep their author.
- **Forking a site-only subdivision** failed with "Reparcellization plan is missing": `createProposal`
  required `pendingReparcellizationPlan.parcelIds`, which a site-pooled plan (`poolSource 'site'`, record
  1348's shape) does not have, and it compared the plan's parcels with the (empty) selection — a Zagreb
  subdivision binding parcels would have failed "selected parcels changed" the same way. Now
  `__subdivision.planCreateVerdict(plan, { selectedParcelIds, site })`: a site plan needs the dialog's
  site and a pool equal to it (`site-missing` / `site-changed`, new `alerts.messages.subdivision_site_*`
  en/hr/es/sr); a parcel readjustment keeps the selection check.
- **Explore chip showed a stale place** ("Explore · Libya" in Tokyo). Cause: the chip was named once, from
  the boot map centre; the default explore view (no `?at=`, nothing stored) is 30N 15E — Libya — and no
  later pan or search jump renamed it. `?at=` vs `cb_explore_at` was not the cause (`?at=` wins in both
  city-config and map-core). Now `WorldCoverage.nameAt(lat, lon, zoom)` (local data only): nearest
  configured/registry city within 25 km (tighter than the 40/60 km coverage radii: Yokohama reads
  "Japan", not "Tokyo"), else the country, '' on open water or below zoom 5; renamed on every `moveend`
  (debounced 250 ms). A "request noted" banner state resets when the place changes.

**Decisions**
- Author lineage: the author of a record is the profile that created it on this device, proven by
  `authorAgentId`, and it leaves the device under that profile's name at the time it leaves. A fork or an
  edit is a NEW record created by whoever forks it (claimed by the current profile); the source keeps its
  own author, reached through `sourceProposalId`. Author names are never inherited along a fork.
- `authorAgentId` is device-local and never published (stripped in `buildUploadReadyProposal` and the share
  payload). Records created before this change carry no `authorAgentId` and keep their author (no
  name-guessing fallback).

**Tests**: guest-author-stamp 12 (pure claim/outgoing rules; the real store + `stampCurrentAuthor`: guest
park → name → publish restamps record and local draft, published / AI-agent records untouched, a fork made
as a guest; wiring incl. the stamp before the agent id is dropped), subdivision-fork-create 6 (fixture
`test/fixtures/subdivision-site-only-1348.json` through the reparcellization adapter's fork draft → verdict
ok; bound-parcel subdivision ok; site missing/moved; readjustment selection; create.js wiring),
frontend-world-coverage +5 (`nameAt`: Tokyo, Zagreb, Yokohama → Japan, open sea, world zoom, wiring).
Red-checked: dropping the claim or the upload stamp (3 fail), ignoring poolSource (3 fail), the 40 km
radius (1 fail). Full suite: **6330 passed, 6 skipped, 0 failed**.

**Verified in a headed browser** (local backend → docker DB; session closed, job stopped, no page errors).
Explore `?at=35.68,139.76,14`: chip "Explore · Tokyo" on first load; pan to Yokohama → "Explore · Japan";
open sea → "Explore"; back → "Explore · Tokyo"; `?city=explore` with nothing stored → world view at 30N 15E,
chip "Explore" (was "Libya"). Guest 3737 drew a park → Share as guest showed the name dialog → name
"Tester Po14b" → Share → Upload: row 1357 author "Tester Po14b", no `authorAgentId` in `proposal_data`; the
local draft shows the new name. (Row 1356 "Guest 5983" is the same flow before the projection stamp —
left in the local DB as a test record.) Subdivision on a 15,811 m² Tokyo site → Unapply → Fork → Edit (plot
25 m) → Create replacement → 11 plots, applied; then Unapply → Fork with no edit (pending plan without
`parcelIds`, the failing shape) → created → Share → Upload: row 1358, `poolSource site`, 11 plots, author
"Tester Po14b".

### Street layout removed (2026-10-01, not committed, not deployed)

A subdivision takes land as input and outputs only plots. The "plots along a street" mode (phase 4,
widths in 7c) was never asked for and is gone; a public road strip is one freeform plot assigned to public
land (Manual → draw plot → assign to Public land), which already worked.

- `subdivision.js`: removed `streetPlotsLayout`, `streetPlotsWidths`, `streetPlotsPlanFields`,
  `streetPlotsSettingsOf`, `STREET_WIDTH_M`, `PLOT_WIDTH_M`, `MIN_PLOT_DEPTH_M`, the width limits and the
  site-plots dependency. `site-plots.js`: removed `frontageExtent`, `bandOf` and the `vFromM`/`vToM` band
  of `cutPlots` (only the street layout used them).
- Editor (`reparcellization.js`): modes are Sweep line (default, also on a site) and Manual; the Turn the
  street button, the street/plot width row, the re-lay confirm and the street frontage lookup are gone.
  Saved plans no longer carry `streetWidthM`/`plotWidthM`/`streetFrontageIndex`, and plots no longer carry
  `use: 'street'` (parcel-compare's "street (public)" label went with it). A stored plan whose algorithm is
  `street-plots` opens its saved plots in Manual (the existing unknown-algorithm rule).
- `street-frontage.js` stays: the site tool's detached/row plots use it.
- i18n en/hr/es/sr: removed `reparcellization.modal.{turnStreet, turnStreetTitle, streetSettings.*,
  relayConfirm*}`, `…algorithms.streetPlots`, `…status.{streetPlotsHint, streetPlotsFailed, noWholePlot,
  streetWidthInvalid, plotWidthInvalid, streetDropped}`, `parcelCompare.plots.street`. CSS in modals.css.
