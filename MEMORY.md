# Memory

Decisions only: user decisions, architecture choices and library/provider selections, newest first
within each section. Contracts live in `docs/` (index `docs/README.md`); implementation history lives
in commits.

## Working rules and process

- 2026-10-26: Every Consensus Builder localhost link explicitly carries its verified `backend`, city and location; copy the complete tested URL (missing-backend links caused building-data failures). See docs/development.md.
- 2026-10-26: Every change to human editing needs an MCP parity check; use shared authoring code and granular tools and record the evidence even when no MCP change is needed.
- 2026-10-26: No study/concept, illustrative, not-adopted or planning-permission disclaimers in authored plans or UI copy; use plain titles and descriptions.
- 2026-10-28: Every repo document lives in `docs/`; only `readme.md`, `AGENTS.md`, `MEMORY.md` and `tables-used.md` stay in the root because tooling reads them there.
- 2026-10-27: Preview links keep normal motion; add `reduceMotion` only when asked (it also hides 3D people and traffic).
- 2026-10-23: `docs/vocabulary.md` is the canonical glossary of current concepts; history, research and open findings live in separate linked docs.
- 2026-10-20: Conceptual coherence before more features: one current contract (qualified origins, explicit source descriptors, currency-qualified quantities), changed in small verified steps; experimental records are recreated, never served by compatibility readers; it wins during branch integration.
- 2026-10-19: Keep all omitted-gems work in the `omitted-gems-fixes` branch/worktree; merge Colosseum work into it with Colosseum semantic contracts authoritative (2026-10-20).
- 2026-10-18: Validate proposals for correctness only, never plausibility; agent and human proposers are treated the same.
- 2026-10-18: No backwards compatibility for local storage: old `cadastre_proposals` envelope blobs are abandoned untouched, not migrated.
- 2026-10-15: Integration path `on-map-editing` → `colosseum-worlds-fair` → `main` (main merge later).
- 2026-10-12: Real headed behaviour tests for every clickable button; `e2e/` source/action contract requires trusted clicks (`npm --prefix e2e run test:controls`).
- 2026-10-11: Browser tests stay headed but must not take focus; announce runs where app popups may still activate Chrome. Do not switch to headless to avoid interruptions.
- 2026-10-02: Headed browser coverage for every app function; keep the UI command/workflow index in `e2e/feature-inventory.json`, with external HTTP/RPC mocked at protocol boundaries.
- 2026-10-02: Release work stays on `colosseum-worlds-fair` in its matching worktree; World's Fair scope = everything after baseline `3ee1855` (docs/HACKATHON.md).
- 2026-08-08: Prefer a clear error to opaque fixing: no silent retries that quantize or reshape geometry; errors are logged and refused loudly.
- 2026-08-05: Bad stored data gets a one-off migration, never ever-growing patches and branches in apply code ("errors over healing").
- 2026-08-03: Borovje (and other imports) may contain invalid elements; never bend the system to make them valid, reject or fix the invalid parts.
- 2026-07-14: Browser suites fail on any uncaught page error; one copy of each shared global helper, enforced by `frontend-duplicate-globals.test.js` (allowlist only shrinks); new shared modules are UMD-wrapped namespaces.
- 2026-08-02: `LOCAL_BASE`/`UGT_BASE` appear only inside `getBackendBase()` so `?backend=` overrides always apply (guarded by test).
- 2026-08-08: Read map geometry at full precision (`layer.toGeoJSON(false)`); Leaflet's 6-decimal rounding produced cut slivers (guarded by `geometry-precision-contract.test.js`).
- 2026-10-18: Editor characterization tests run real classic scripts in a small fake DOM (chosen over adding jsdom/happy-dom); classic scripts expose one namespace export (`window.__x` / `module.exports`).
- 2026-09-16: Never run `anchor keys sync` in `blockchain/solana`: the original deploy keypairs are not in the repo and it rewrites `declare_id` to throwaway keys.

## Product, branding and UI

- 2026-10-31: Phone sheets about a map object cover the nav bar and rest at half or full height; inspection uses object-icon tabs with Actions first and open (docs/click-stack.md).
- 2026-10-31: Decorative 3D animation and city sound pause when the page loses focus, not after idle time.
- 2026-10-30: Object lists outline on hover, keep it on click and navigate only via the item's open button; unpublished/published/on-chain are stages of one object (local copies are caches), so Lists has one list per kind filtered by stage (docs/design-language.md).
- 2026-10-29: The address always names the selection (`?parcel=`/`?design=`/`?plan=`/`?agreement=`, with `?at=` keeping the camera); `?focusProposal=` is gone; in Lists a row only previews (docs/location-first.md).
- 2026-10-28: The click stack is built from the selected object outward; clicks never cycle and select the topmost object; the camera moves only on request (Focus).
- 2026-10-28: Model view compares two states side by side (Built today, Permitted, Proposed, one design or one plan per side); photo mode parked.
- 2026-10-28: 3D immersion: real sky, night windows and headlights yes; no seasons; street lamps are placed furniture only. Walk/fly cameras approved with guards (camera-fixed shadow box, movement bounded to the loaded disc, batched building meshes first).
- 2026-10-27: Desktop navigation/messaging keep their viewport anchors; right-side panels share the click stack's 400px column; wider content goes in a centred or full-screen surface.
- 2026-10-27: Settings shows the running build and offers Reload/Later on updates (blocked while editing); sections Appearance, Data & assumptions, Help & about, collapsed Advanced.
- 2026-10-27: Arabic, French and Portuguese UI dictionaries added (Arabic RTL, Gregorian formatting); saved-plan/MCP validation accepts the same language set.
- 2026-10-26: Design sections identify their authored type with a coloured icon pill; peer selectors name the object and explain why several designs appear.
- 2026-10-26: Model and Google 3D share selection/inspection; the separate photo cadastral picker is retired.
- 2026-10-25: Model 3D selections keep the camera; volume outlines mark buildings, hatched ground marks designs, unfilled boundaries mark parcels.
- 2026-10-25: One saved map workspace per browser profile with one editable tab; extra tabs wait (supersedes per-tab workspaces). See docs/saved-workspace.md.
- 2026-10-24: Buildings and massing settings apply to the whole view, independent of selection; Permitted and Proposed each have their own dice and example roll; comparison choices are Max envelope and Illustration.
- 2026-10-24: One Designs button and one right panel with Designs and Share tabs (one resizable sheet on phones).
- 2026-10-24: Settings has one level of sections; providers are chosen per dataset (no global selector, no source-switch wipe).
- 2026-10-24: One mobile top-handle pattern for sheets and panels (drag to resize or close; no second X).
- 2026-10-23: While a design is edited, controls that start another task are greyed out, never hidden; Layers, Buildings and massing and Measure stay live.
- 2026-10-23: UI themes use one token palette and shared translucent surface; Built/GDI survey overlays start Off and use faint fill with contrasting border.
- 2026-10-23: Activity is one dock panel (Events, Actors, Watched areas), defaulting to All cities; Simulation and Technical status live under Settings → Diagnostics.
- 2026-10-22: One click stack replaces the parcel popover, ground menu and drill (docs/click-stack.md); in the model view every click is also a parcel click, isolation needs a second click.
- 2026-10-20: World navigation offers cities and exact map points only; regions are context, never destinations; a globe click opens the exact point at street level. Buildings and massing starts collapsed behind a cubes icon by the city/search control.
- 2026-10-12: Proposals, Bets and Activity sheets share one look: a 560px bottom-centred dock on desktop, full-screen translucent on phones.
- 2026-10-12: The radius slider lives in Layers and previews its circle on the map while hovered/focused/dragged.
- 2026-10-12: Shift+drag box-selects every touched parcel into the multi-selection (plain drag keeps panning).
- 2026-10-12: The parcel panel separates creation (Propose) from what already stands there (Proposals, with a count that includes server-published records).
- 2026-10-11: The intro carousel is optional (`?intro=1`) and never interrupts shared links; the compact map card stays distinct from the Details reader.
- 2026-10-08: The globe stays centred regardless of the activity feed and has no close action (Back to map from a local map).
- 2026-10-15: Switching between 2D and model views replaces simultaneous previews; the parcel View in 3D shortcut is removed. 2026-10-14: geometry editors use the global view buttons.
- 2026-10-05: Blocking dialogs register real dismiss callbacks with `ModalEscape`; nested confirmations take precedence.
- 2026-10-02: Selected is temporary UI state, separate from applied/unapplied.
- 2026-10-03: One design dialect (the map shell): `frontend/css/tokens.css`, `primitives.css`, rules in docs/design-language.md; ratchet tests only let literal counts shrink.
- 2026-10-02: Branding: Consensus Builder is the primary visible product name; Urban Game Theory is the project; naming hierarchy Urban Game Theory → Consensus Builder → Bet on cities (2026-10-12).
- 2026-10-02: Never mention other vendors in visible UI, intro, About or planning-page copy ("ArcGIS alternative" only in non-visible metadata); never promise search rankings.
- 2026-07-20: Mode names are "model" (abstract 3D) and "photo" (Google photorealistic); canonical `?model`/`?photo` URL params; internal identifiers were deliberately not renamed.
- 2026-07-18: Directions are given as compass words, never left/right (users cannot know the drawing direction).
- 2026-07-12: One term per concept ("Unapply"); palette groups Urban rules (Block/Row/Detached) and Structures (Freeform Building/Park/Square/Lake); `parcelBased` = Detached, `single` = Freeform Building; Row needs ≥2 parcels.

## Designs, plans and agreements

- 2026-10-30: Shared plan collaboration: immediate authenticated state, one undo of the latest agent change; prioritize MCP/conversational human–AI editing; simultaneous human editing deferred.
- 2026-10-31: Access and ordinary publication stay anonymous (no mandatory sign-in); shared-plan publication uses browser-owner approval of an exact saved revision; optional accounts later.
- 2026-10-30: An immutable published record (plan) is checked against its CID, never rebuilt in today's normalized form.
- 2026-10-29: A new agreement is a non-binding vote by default (editor and MCP `owner-vote`); binding owners needs explicit action; switching electorate clears Binding.
- 2026-10-29: Build-out dates belong to the plan (`plan/v1` `schedule`, optional per member); per-design `epochYear` is retired; simulated build-outs are never stored (docs/buildout-timeline.md).
- 2026-10-29: Designs compare like plans (each design as a one-member plan); a published design is fetched for comparison, never stored.
- 2026-10-29: After creating an agreement from a Plan section, the stack shows the new agreement in its expanded Agreements section; close/cancel return to the plan.
- 2026-10-29: Shared student/agent work uses a private server session over ordinary revisions: one editor at a time, explicit save and handover, server-only storage.
- 2026-10-29: Bogotá agreements keep parcel-owner allocation groups and resolve people/shares through committed rights; tenant and horizontal-property units wait for concrete requirements.
- 2026-10-28: Agreement schemes are enforced, not described: one shared `AgreementRecord.settlementIssues` for dialog, HTTP and MCP; settlement by value joins settlement by area; scheme rule changes add a new dated version.
- 2026-10-28: Plans compare against a Present state column; public land = roads + OSM parks/squares + design spaces. Urban rooster scores applied plans; Plan stats measures unapplied ones.
- 2026-10-27: Agreements select an existing exact plan and never compose designs; output parcels have one recipient each (proposer acquisition allowed); compensation is funded by the balancing sponsor.
- 2026-10-27: Plan creation is local composition; Share publishes exact revisions; agreements start from a saved plan and sit above Plans in the click stacks.
- 2026-10-27: Agreement authoring blocks the map until Create/Cancel; the Lens button edits the same persistent preference as agent details, agreements keep their own lens snapshots.
- 2026-10-27: Community voting uses random codes from a trusted organiser; verifiers fixed per agreement; holders may change votes.
- 2026-10-27: Existing buildings are baseline context, never Plan members.
- 2026-10-26: Public vocabulary is Plans, Designs and Agreements: each Agreement references one immutable Plan revision; Plans own membership and may have many or no Agreements; bets attach to eligible Agreements.
- 2026-10-24: Named plans are immutable selections of published designs plus a map view ("Name this plan"); only agreements carry terms.
- 2026-10-24: Design geometry never travels in URLs; previews reference stored objects and plans contain design CIDs plus a view.
- 2026-10-24: Applying a shared plan warns about conflicts and offers unapply-existing, skip-incoming or cancel; never silently replaces the working composition.
- 2026-10-23: Duplicate (click-to-place) replaces Fork design for movable material designs; copies never carry agreement state or source binding. Upload .glb sits beside Upload GeoJSON in Freeform.
- 2026-10-23: Surroundings belong to their building design (authored `decorationDesign` publishes with it; generated decorations stay runtime-only so a CID never changes on apply).
- 2026-10-22: The agreement is the on-chain unit (Solana `agreement` program: create/fund/attest/execute/cancel/expire; lens attests satisfied only; non-binding agreements never mint and have no markets); EVM and Canton proposal readers removed.
- 2026-10-21: **Design** (geometry, no terms) and **Agreement** (designs + decision rule + optional allocations/money; the unit signed, minted, bet on, executed); the decision rule replaces proposal kinds; both publish as CIDv1 objects via `POST /pins` (docs/plan-design-agreement.md).
- 2026-10-21: Land readjustment editor became the geometry-only "Lay out parcels" design (`parcel-layout`: Equal / Schelling / Keep existing borders / Draw freely); apply carries ownership over; a layout publishes only with its agreement.
- 2026-10-21: Proposals never depend on other proposals; they need only the ground they affect to be available.
- 2026-10-21: The agreement model covers ownership, rules, allocation and money only; construction timing and time-triggered obligations are out of scope.
- 2026-10-21: Urban-rule designs are spatially exclusive (no stacking) but may coexist with a parcel-border change; several designs may share one allocation agreement.
- 2026-10-19: Direct named-plan bets show a whole-plan before/after image pair.
- 2026-10-17: Local unpublished designs are edited in place (same id); published/minted ones fork counterproposals; supersession is removed; dependents of an edit are found geometrically and confirmed.
- 2026-10-17: Proposals are geometry and parcels are derived: on a ground-change apply failure a local draft re-derives quietly; a published record refuses and offers "New proposal with same geometry"; forking onto stand-in ground is allowed.
- 2026-10-17: Plans are first-class in the app (parcel menu "Proposals (N)", "Part of plan"/"In N plans", Plans view, hatched preview; a plan link previews instead of applying).
- 2026-10-17: NGOs identify through did:web (their site lists their wallets), no home-made protocol (docs/community-consultations.md).
- 2026-10-11: Proposals may exist without ownership knowledge; acceptance needs complete abstract owners and exact shares; a co-owned parcel's area counts only when all its owners approve (docs/land-readjustmend.md §15–16).
- 2026-10-11: Chain minting is independent of server publication: the browser pins the portable record and mints it; the server only verifies `{chainRef}`.
- 2026-10-11: Outgoing records carry the profile's current name (2026-10-01): ownership of a local record is `authorAgentId`; publish/share/mint restamp the name; forks belong to whoever forks.
- 2026-10-01: Guest rule (one table, `guest-policy.js`): device-local acts are open to guests; a profile name is needed only when something leaves the device; Offer my land needs a wallet with a lens ownership attestation.
- 2026-07-23: Consent unit is the owner's slice of a plan, bound to its content hash; triage per owner/proposal = acceptance / offer / vote / disclosure (docs/rethink-proposals.md).
- 2026-07-12: SimCity lifecycle: what is on the map is the draft; created objects apply at once; the formal proposal step is later and optional; no Drafts UI.
- 2026-07-16: Lifecycle status and map `applied` state are independent axes; breaking schema changes deploy in two phases.

## Land readjustment

- 2026-10-16: Layouts are editable with handles from the start; each owner's deal is readable by anyone; a fork of a published record is a counterproposal.
- 2026-10-16: Agreement schemes: land in, land and cash out; one approval engine, schemes differ by who votes and how; templates pinned by id+version (docs/land-readjustmend.md §23).
- 2026-10-12: LR money is one balanced schedule (owners receive or pay, the sponsor line sums to zero, only the sponsor's net pay-in needs funding).
- 2026-10-12: Owner authority is lens-backed: lens-signed rights and wallet-for-owner facts plus the wallet's own decision, all verified by every client (vendored @noble/curves); a re-verifying receipt relay shares decisions; chain: anchor now, contract later (§18–20).
- 2026-10-12: Shared authored-plan validation across editor, publication, apply and consent: validate the declared pool, keep unresolved rights separate, require explicit funding for positive cash (§17).
- 2026-10-11: One versioned SHA-256 deal commitment for approvals, publication and plan members; changed receipts need fresh approval. Rights snapshot and geometry are separate fields; rights/lens/policy changes fork and clear approvals (§14–16).
- 2026-10-11: Continue LR from docs/land-readjustmend.md; application is separate from binding consent, cash settlement and legal registration; the roadmap there is proposed, not approved policy.
- 2026-10-18: Deferred (low value): keeping proposals standing on a readjustment when its plots are edited underneath.
- 2026-08-15: A land readjustment is one contiguous authored pool (`poolGeometry`).
- 2026-08-15: Members of one coordinated plan coexist on shared parents by non-overlapping geometry.
- 2026-08-04: Decided editing model (not fully built): area is conserved and the pool outline changes only by re-selecting inputs; interior nodes move freely, cut endpoints slide along the outline, outline corners are locked.
- 2026-08-03: A readjustment is a geometrical fact (reopens from its own polygons); only Done saves, X/Cancel/Esc discard; editing displaces only proposals on changed plots; vertices are "nodes" (čvor/nodo).
- 2026-08-07: Readjustments stand on the cadastre (derived ground refuses with an ask-to-unapply flow) and must tessellate every input parcel; stored plans that fail must be redesigned (accepted).
- 2026-07-13: One-owner readjustment is allowed with the PUBLIC-LAND pseudo-owner as second recipient (opening 50/50).
- 2026-10-01: Subdivision outputs only plots; a public road strip is drawn as a freeform parcel owned by the city.

## Parcels, ground and formation

- 2026-11-02: Detect block bounds blocks by all OSM roads, paths, tracks, railways, waterways and coasts; any parcel a ground-level road touches is border ground; over-limit results highlight the first 100 parcels (docs/vocabulary.md#detected-parcel-block).
- 2026-10-30: Demolitions are derived from applied designs' land against the buildings shown, never stored on designs (tunnel records keep only their span); applied roads raze and cut again; no display-only guards.
- 2026-10-29: One function per geometric question shared by browser, server and MCP; one 9-decimal coordinate grid; the server binds with the browser's `site-binding.js`; the one measured noise value is 1 mm; old designs may error, no legacy fallbacks (docs/geometry-tolerances.md).
- 2026-10-29: A Block or Row left applied when its ground changes is re-cut by today's parcels when applied again (one building per parcel); the saved record keeps its pieces (docs/urban-rule-massing.md).
- 2026-10-22: A building design clears the ground it takes: rules on existing parcels clear every existing building there; a footprint-formed Freeform clears only its footprint (whole hosts with `takeWholeParcels`); blockify 'existing' clears only what it redraws.
- 2026-10-23: Freeform land take is reviewed per touched parcel (footprint cut or whole parcel) and stored separately from massing; changed consequences need renewed acceptance; drags move only the active footprint (2026-10-26).
- 2026-10-18: Rules (Block, Row, Detached) stay on their parcels; only park, square, lake, station and Freeform place freely. Dropping a rule off its parcels offers: convert to Freeform (envelope frozen at the rule's maximum height; Detached = one per house), re-apply to parcels mostly inside, or put back; conversions use the ordinary apply/conflict step.
- 2026-10-18 (direction): On a cadastre source swap, geometry designs re-cut the new ground; rules re-run on parcels mostly inside the old area when outlines match closely, else stay unapplied offering re-run or conversion; no centre-point anchoring; published records keep their parcel set.
- 2026-10-15: Physical design geometry moves freely with parcel snapping, warnings and optional site lock; saving recomputes binding; ownership and readjustment stay fixed to their land.
- 2026-10-14: On-map editing for every geometry family (2D handles, live draft in model 3D, compact phone panel); reopening uses the authored site; photo editing deferred.
- 2026-10-19: Parcel-source failures have a bounded wait and an explicit Continue without parcels; linked designs can apply from their own geometry with published binding unchanged.
- 2026-10-01: A proposal's subject is its site; cadastral parcels are a derived binding (may be absent); intrusion tolerance is linear and defaults to 0 (a design needing a neighbour's land must include it); the server binds only the cadastre it holds; open ground is hosted, never minted from gaps; a later road carves formed pieces it crosses.
- 2026-09-02: Parcel state has three owners: `CadastralParcelRepository` (only transport consumer), `LiveParcelFabric` (committed partition, one connected polygon per id) and `ParcelPresenter` (only mutator of the Leaflet group); apply/unapply/edit are one serialized transaction; full replay is boot/recovery only (docs/rethink-proposals.md §0).
- 2026-09-03: Ground arrives per grid cell; reads are not writes (copy-on-read drafts); one IndexedDB row per proposal; corridor strips are a keyed render, z-ordered by panes.
- 2026-08-07: Contiguity everywhere: every footprint is one connected piece; road×road is a junction, never a taking; severing a road is impossible (structure/building takes that would disconnect it refuse); an authored road disconnect splits into one proposal per component.
- 2026-08-07: Unapplied readjustments render only when applied or selected, like any proposal.
- 2026-08-06: One partition, latest wins: applied formations always tessellate; a taker amends the taken record's plan permanently; rebuilds tessellate from the cadastre, never restore; identity flows with the ground; tunnels take the surface.
- 2026-08-08: A parcel cut by a road even a little must be properly registered (the noise floor sits at measured noise, now 1 mm per 2026-10-29).
- 2026-08-05: Land readjustment ≡ reparcellation = a bundle of formations (atom: one output parcel formed against current fabric). Structures adopt one matching parcel or merge-take whole parcels (partial coverage refuses); Freeform buildings form a footprint parcel (`takeWholeParcels` optional). Derived record data is stripped at publish and import.
- 2026-08-03: Fabric rules: at most cadastre → one formation → content, flattened at draw/mint with publish as the gate; roles are behavioural (does it mint?); formation is adoptive; proposed fabric is never cut; a parcel is one connected piece; use-restriction parks belong to urban rules (deferred).
- 2026-08-02: Parks/squares/lakes form their parcel and transfer to public; remainders are disclosed to owners, never reshaped automatically; land assumed fixed; no dependent cascade after a road recut.
- 2026-07-23: Claims model: everything clickable is a claim (content > fabric piece > bare parcel); cross-plan conflicts at apply go through the conflict tour (Replace/Keep).
- 2026-07-21: A proposal that becomes a parcel shows that parcel; one road = one corridor parcel plus remainders.
- 2026-07-13: Two city variants are first-class: full-coverage cadastres where roads are owned parcels (never erase them) and US-style fabrics without road parcels; never assume a point lies in a parcel. Curated road sources replace detection where configured.
- 2026-07-13: Road parcels show no name tooltips (only where and how big).
- 2026-07-12: Structures (park/square/lake) clear existing buildings by default; 2026-07-20: parks full-cut like squares/lakes ("flatten all existing stuff").
- 2026-07-15: Proposals a road meets are set aside or tunnelled, never cut or split; only surveyed buildings are cut (docs/impact-resolver.md). Immutable = minted or published.

## Roads and corridors

- 2026-10-29: "Road in parcel": a road can be placed into ground left for it (`definition.bound.site`, lanes fit the narrowest part, pavements to 3 m then verges); a parcel layout never places roads (docs/road-in-parcel.md).
- 2026-10-28: Any edit of a published road, including a junction another road makes with it, is a new version; unpublished roads edit in place.
- 2026-10-28: Rails sharing a street with traffic follow the street's curves (tram turns across lanes not modelled); only rail-only corridors are held to a radius target.
- 2026-10-18: A road has two edit actions, Edit geometry and Edit cross-section, both saving directly (local in place, published as counterproposal); no reopen-as-drawing fallback.
- 2026-10-17: Draw/Apply government road plan reads GUP widening reservations and new GUP streets; `planned_road` is retired everywhere.
- 2026-10-15: A junction is a node-owned object drawn once from one junction set; width changes are derived transition zones; `definition.junctions` stores cross-record arms (docs/road-editor.md).
- 2026-08-02: A road may demand only what happens on its corridor: cut or tunnel surveyed buildings, never destroy them (demolition is a separate proposal). Road operations auto-show the GDI building layer without a dialog, restoring afterwards unless the user changed it.
- 2026-07-13: Per-segment network model: one proposal = one connected network; the cross-section is a per-segment property (`definition.segmentProfiles`); click-time prompts per segment are the decision point.
- 2026-07-14: One corridor engine for roads and tracks (a track is a corridor with a rail lane); cross-section width is derived from the lane list (no width slider); seam-drag is the only gesture that holds the total.
- 2026-07-20: Photo-mode roads follow an obstacle-filtered Google mesh profile, with DGU EVRF2000 shape fitted by one additive offset; closure is one neutral curtain, never source-textured seam caps.

## Buildings, structures and 3D

- 2026-11-06: Floor plans are never bulk-loaded: cells carry a `floorPlansAvailable` marker; X-ray fetches one building's model within 200 m and drops it beyond 300 m or when X-ray is off.
- 2026-11-06: Suggested layouts use a double-loaded corridor at plate depth ≥15 m, else point access (building Access and X-ray `?access=` override); mix 25/40/30/5 % studio/1/2/3-bed; north-only flats flagged red.
- 2026-11-05: Floor plans of existing buildings live only in the shared `buildings.floor_plan` (cadastre-data publication API), read per city through `floorModels.published` adapters, never copied; an authored registry model wins.
- 2026-10-30: Our internal model and file formats stay; CityGML/CityJSON are converted only at the boundary (import where the world exchanges them, export as an extra option) (docs/citygml.md).
- 2026-10-29: Parks take fenced enclosures inside the park (four fence styles, uses none/dog/play, gates required); swings, seesaws and slides are park furniture; never a second overlapping park.
- 2026-10-28: Parks/squares may carry an uploaded GLB stretched to the site; one GLB per furniture kind; placed lamps glow at night (faked); market stalls; furniture instanced per structure. Realistic trees proposed, not decided.
- 2026-10-22: The model view lights the scene with the local sun and shadows by default; a sun button sets time/date in the place's local time.
- 2026-10-21: Model-mode OSM streets are sunk 0.15 m rather than raising sidewalks; holes via stencil, never polygon booleans; paving is a shader patch, never a texture.
- 2026-10-24: 3D capture readiness requires complete building evidence, finished mesh work and a later rendered frame; failed/partial data never passes as an empty scene.
- 2026-10-07: Proposed buildings get suggested default floor plans (`building-floor-plans.v2`, `suggested: true`), shown only behind the X-ray "Suggested layouts" toggle and never persisted.
- 2026-10-07: Optional interiors live in the versioned `consensus.building_floor_model` registry keyed by city and stable building identity; whole-floor drawings are modelled only at documented levels.
- 2026-09-05: Illustrative facade skins are remembered per city + live parcel id (separate volumes on one parcel share a design); shaded detail before physical relief.
- 2026-07-21: Freeform surroundings: one choice for the merged parcel area (unchanged default, paved, green), Freeform only, polygon computed once at design time and persisted.
- 2026-07-15: Pre-commit nudges: blocks with walk-around over 15 minutes and row houses on dissimilar parcels ask for confirmation (user-chosen thresholds).
- 2026-07-13: Benches are first-class placeable objects in park and square editors (no bench-angle slider); squares get one auto-placed statue; demolished buildings show as red "condemned ghosts"; the Built control has a "Surviving" state.
- 2026-07-13: Freeform generation randomizes footprint size and position inside the setback envelope; setbacks are minimums, not the form.
- 2026-08-11: Plan arithmetic has one home (`plan-yield.js`) for screen and reports; a building with no height has `gfaM2: null`, never an invented storey count.
- 2026-08-11: Block names derive from the block's own outline, never a parcel id.
- 2026-07-14: Thumbnails render server-side (node-canvas tile stitch) at upload; failures never fail the upload.

## Data sources and providers

- 2026-10-31: OpenStreetMap through our backend's shared Overpass chain is the default for everything OSM-derived in every city; per-city caches (osm_road, osm_decor) only answer faster and the live read is their fallback.
- 2026-10-30: Source loading (docs/source-loading-plan.md): the screen sets the building budget on the parcel cell grid; sources load and fail independently; fallbacks are one ordered list per concept in city config; URL sources are read in the browser, never relayed; 3D free panning deferred.
- 2026-10-28: City configs: `frontend/data/city-configs.js` is the source of truth; `scripts/build-city-files.mjs --run` generates `data/city-index.js` plus one file per city. `overture-tiles` building source is retired; cities use `'osm'`.
- 2026-10-28: Public spaces come from our server's Overpass chain (`/osm-public-spaces`) first, public Overpass from the browser as fallback (user-approved server dependency).
- 2026-10-25: Descriptive city labels never gate design import or rendering; authored geography and real cadastral dependencies decide ground context.
- 2026-10-24: Data readers share abstraction → adapter → default/custom source registration, exposed in Settings.
- ~2026-10-23: Source configuration belongs to the frontend for every pluggable dataset; backends accept explicit source ids. Economic sources keep land, floor-area sale and construction rates separate with currency, units, date and provenance.
- 2026-10-23: Default to official live cadastral sources for Belgrade and Buenos Aires (RGZ failure outside Serbia → no-parcels flow); cities without a building source use backend OSM; parcel recovery is one dialog with diagnostics and in-place retry.
- 2026-10-22: Money belongs to the place: amounts in the city's currency, never converted; the viewer's locale only formats; UK land uses per-city MHCLG appraisal rates.
- 2026-10-22: Parcel loads have no total clock, only silence limits restarted by progress (UK councils take minutes).
- 2026-10-20: Configurable imagery uses the same area-specific source setup (starting with DGU 2022/2024 orthophotos); imagery is visual context only.
- 2026-10-20: Imagery-generated illustrative plots (OSM + browser image processing, rectangle-first, no LLM) are saved in localStorage as usable parcels with estimated provenance.
- 2026-10-17: Our database first, the live source as fallback: Croatian parcels fall back to DGU's public WFS in the browser (no ownership then).
- 2026-10-17: Buildings on demand from sources rather than imports; Bogotá defaults to its cadastre buildings.
- 2026-10-14: India reads ramSeraph/indian_cadastrals vector tiles browser-direct (credit ramSeraph and Datameet); overlapping village outlines resolve larger-wins only where overlaps were found.
- 2026-10-13: Routing a data source through our server needs the user's explicit OK each time, as a last resort (accepted: GUGiK EGiB, HMLR ZIPs, Nairobi, Gujarat fallbacks).
- 2026-10-13: Synthetic, clearly labelled parcel references (versioned geometry hashes) are accepted where a source has no ids (2026-10-08); Settings shows the exact map source.
- 2026-10-12: Provider quirks are fixed in that adapter, never globally; known provider limits are named in the no-register dialog.
- 2026-10-12: Polish ULDK cities moved to GUGiK's EGiB WFS (same TERYT ids) via `admit-qualified-cities.mjs --switch`.
- 2026-10-11: Parcel adapters fetch in the browser (Web Worker) wherever possible; Postgres imports only as demonstrated necessity; HMLR uses council ZIP/GML with GEOS WebAssembly.
- 2026-10-11: HMLR overlaps resolve deterministically (larger area, then lower INSPIRE id) into a derived source; HMLR supersedes old UK city sources after qualification.
- 2026-10-11: Keep the parcel visibility cutoff at zoom 17; fetch the padded viewport rectangle and reuse provider-expansion outcomes.
- 2026-10-08: Certificate validation stays default; one adapter may use a narrowly scoped exception (an expired certificate alone does not make data unusable).
- 2026-10-08: Globe land never depends on ISO joins; Tbilisi and Istanbul load parcels on click only; BEV parcels come from max-resolution vector tiles.
- 2026-10-04: OSM is the default building source for any city without its own (estimated heights tagged `height_source`); people may plug in their own parcel and building sources; building load failures are always shown, never silent.
- 2026-10-03: Parcel integration policy: terms, licences and reuse restrictions never prevent integration; keep accurate notices and attribution; only technical failures may hold a source. New live sources are passthrough without parcel-table imports.
- 2026-10-03: Shared providers keep one canonical prefix and native identity (a prefix does not identify a city); bulk-only sources use pinned snapshots (ETag + expected count).
- 2026-10-02: Live parcel providers are descriptors + adapters behind one WGS84 bounds/ids/footprint contract; native identity stays stable (US: GlobalID, not display numbers).
- 2026-10-02: Bogotá uses the user-approved 2021 CAR mirror of IDECA lots (vintage shown); permitted massing reads POT 555 from the IDEC copy (2026-10-29, docs/bogota-pot-source.md).
- 2026-08-02: One ingestion, one set of tables shared with zagreb-isochrone: buildings from `public.overture_building_footprint`, trees from `public.osm_decor` (cadastre-data owns both); cities read a region, not their own id.
- 2026-08-02: Deep-linked Croatian parcels resolve their city from data (nearest `oss-wfs` city), never a hardcoded KO table.
- 2026-08-02: Trees are planted from OSM greenery polygons per request on a lattice anchored to absolute EPSG:3857 metres; derived presentation, never written back.
- 2026-08-03: Invalid cadastral geometry is repaired once in the data (cadastre-data `db/fix-invalid-parcel-geom.sql`, re-run after ingest), never guarded in queries.
- 2026-07-15: `osm_road` is owned by cadastre-data; prod schema is canonical (do not convert prod to 3765).
- 2026-07-14: Buildings are GDI, not DGU: detection reads the data pool (`gdi_building_footprint` object ids), the cadastre is a reference overlay; unknown `?source=` → 400.
- 2026-07-08: Building footprints are an optional per-city provider capability (`footprints(geometry)`), no Zagreb fallback.

## Permitted, GUP and restatements

- 2026-10-26: Permitted for US cities starts from public Atlas releases, built up incrementally from simple setbacks region by region; research LADM/INSPIRE before a common rule model.
- 2026-10-23: The experimental Atlas parcel-study editor is removed; Permitted envelope inspection stays.
- 2026-10-21: Permitted shows supported massing across the viewport (zoning areas a separate overlay); envelopes carry an outer bound plus `configurations[]`; the server states what is permitted, the browser (`PlanningEnvelopes`) decides display; lot minimums flag, never omit.
- 2026-10-20: Atlas plugs into Permitted through URLs keeping source identity, edition and evidence; build a parcel-backed Atlas demonstration with explicit unresolved rules.
- 2026-10-19: Existing regulations, permitted massing and permits are restated as obligatory proposals by scripts; binding applicability is separate from voting/deal kind; an obligatory maximum does not oblige building to it. Audit the National Zoning Atlas before outreach.
- 2026-10-19: Shared city-neutral geometry for existing, permitted and proposed buildings, with the Zagreb solver as first provider adapter; local rules behind adapters.
- 2026-10-19: Restate Zagreb GUP 2025 as close native proposals (branch `gup-2025-proposals`); flag unexpressible locations; approximate massing with original limits as notes; native apartment estimates are not regulatory caps.
- 2026-10-19: Resume NYC envelopes with an R6A interior-lot pilot in Brooklyn CD3; capacity needs cited site evidence.
- 2026-10-19: Keep the last saved envelope until a newer one is accepted; bulk invalidations need cohort-wide recovery; empty parcels show only explanations already cached.
- 2026-10-19: `restatements/` holds existing situations and published plans expressed with the app's tools, with dates and provenance; each reconstruction keeps provenance, GeoJSON and reproducible scripts together.
- 2026-09-14: Compare Built / Currently permitted / Proposed; GUP translates to spatial, never back to text; GUP amendments live in Urbana pravila's editor; the solver uses existing parcels only and amended plans inherit unaffected solutions.
- 2026-08-13: Pionir/Paron reconstructions: exact company roles, current DGU footprints for completed projects (permits as dated evidence), survey years only as latest-safe bounds, project totals never split without a source.
- 2026-08-12: Transit imports carry both relative levels and absolute EVRF2000 `elevationM`, and a stored rail profile (`trackCount` tracks); prod re-imports are a deliberate act on the server.

## Chain, markets and agents

- 2026-10-25: Betting: dated LMSR with no-wallet points books and devnet-USDC books; YES needs on-chain execution by the deadline, cancel = VOID; never call devnet-USDC trading live until verified after deployment; labelled simulated visitors until outside participants exist (user recruits offline); San Francisco: one bet per agreement.
- 2026-10-12: Streamline (docs/streamline.md, plan of record): deadline per market (reverses "no deadline"), LMSR instead of parimutuel, no-wallet points path, duplicate persona proposals deleted; keep "Bet on cities" in both senses.
- 2026-10-12: San Francisco leads the pitch (Candlestick Point first; lead market the DBI grading permit issued by 2026-12-31); Borovje adoption second. Streamline work runs on the laptop.
- 2026-10-12: Bets list and GET /markets share one comparator; superseded plan versions fold under the current one; market subjects hash the parcel ids; permit markets get ≥14 days grace.
- 2026-10-09: Product copy is "Bet on cities" (bet, pool, chance, pays, settle); hyperstition stays campaign-only; contests group markets sharing parcels.
- 2026-10-11: Keep three pitch decks (`deck.html`, `deck2.html` Bet on cities, `deck3.html` community proposals); Africa examples are future pilots; funding demo labelled devnet.
- 2026-10-11: Scheduled proposers pin and read back complete metadata before minting; bots use bounded retries and rebroadcast identical signed transactions; one devnet SOL funding address tops up actor and lens wallets.
- 2026-10-11: The transaction explorer reads the database mirror only; the scheduled importer owns RPC sync.
- 2026-10-01: Parcels are ownerless anchors; the lens is a passive attester list; acceptance is every attested owner's own signature (no majority shortcut, no acceptance attestation) (docs/lens-model.md).
- 2026-09-22: Prospective resolution is an hourly idempotent operator job; the judge proof is a public contract (`/hackathon/proof.json`, `/oracle/markets/prospective/status`) keeping recipes, wallets and config private.
- 2026-09-21: External markets verify SAS court attestations directly (recipe-hash-derived `ExternalMarket`, deployed `Market` accounts unchanged); V2 enforces close ≤ source time ≤ resolution; the scraper keeps official publication timestamps.
- 2026-09-20: One agent runtime (`AgentActionEngine`) for all actors; the scheduled persona is opt-in and capped per day (one proposal, three actions, $0.25 model, 0.35 USDC).
- 2026-09-20: Product thesis: a market for real-world land change resolved by public records; court-derived data stays aggregate-only without a privacy review; donations go to refundable escrow.
- 2026-09-20: Hackathon markets use a hashed `proposal-lifecycle-v1` oracle recipe; the on-chain market is the final verifier.
- 2026-09-16: Paid agent writes are new `/agent/*` routes (x402 upfront flow, devnet USDC, prices in config); free `/proposals` routes untouched. Mint precedes the paid post.
- 2026-07-14: `PUBLIC_API_BASE_URL` is pinned; stored file URLs never come from the request Host (otherwise store paths resolved by the client).
- 2026-06-13: EVM ParcelNFT is soulbound (a registry custodian; ownership is attested); current addresses live in frontend `contracts/*.json`.

## MCP and chat agent

- 2026-11-01: In-app chat agent (docs/chat-agent.md): runs in the API process and edits through public MCP tools over loopback (MCP improved for all agents where chat needs it); changes land at once with Undo; drafting/editing only; caps $5/day and 100 turns per IP per day; provider Anthropic or OpenAI; paid evals need a yes per run; cost displays debug-only (`CHAT_DEBUG_COSTS`).
- ~2026-11-01: Mechaurbanista offers a real random starting parcel for unspecified sites and asks before continuing; landmark requests resolve real mapped geometry; it may prepare private agreements and record requested feedback, never publish or sign.
- 2026-10-28: Student AI assistance starts with one real agent operating the existing browser tab; hosted MCP stays for independent authoring; shared-draft sync deferred.
- 2026-10-28: Accessible map editing: labelled native controls, searchable object lists, coordinate/metre moves, focus retention, announcements.
- 2026-10-25: MCP named-plan tools operate on `plan/v1` independently of agreement ground and terms; private drafts persist with explicit expiry and export; reference publication checks the reviewed CID.
- 2026-10-24: MCP exposes every human-editable field through granular inspect/patch/geometry operations; unforeseen requests compose from primitives; plan changes create private revisions with re-derived ground.
- 2026-10-24: MCP directory promotion is free only (identity `xyz.urbangametheory/urban-game-theory`); OpenAI submission deferred.
- 2026-10-23: Hosted MCP is a public, credential-free, stateless HTTP process; unsigned publication needs confirmation; devnet signing stays in the local package; agreement ground runs the app's formation handlers in an isolated node host.
- 2026-10-22: Hosted MCP at urbangametheory.xyz/mcp never signs for users (no custody, no delegated keys); signatures come from the agent's own key or the person's wallet via an approval link (docs/mcp.md).
- 2026-10-28: MCP import tools take `kind` so spaces can be created from models and polygons.
- 2026-10-23: Paid evals run only under an explicit per-run budget (e.g. US$3 for 20 batch cases), never publishing permanently or signing.

## Storage, ops and infrastructure

- 2026-11-05: The planning funnel uses Clarity plus the AppDiagnostics → `consensus.planning_diagnostic` pipeline, opt-in (asked on the first error); Clarity recording stays ungated.
- 2026-10-26: Publish through Filebase by default, Pinata as selectable reserve, read gateway configured independently; back up and verify the oldest 250 Pinata files before unpinning that set.
- 2026-10-23: Incoming feedback notifies Telegram through the private activity destination, with delivery state in the private inbox.
- 2026-10-20: Image generation resumes unfinished work on its next run from missing results; no separate recovery scheduler.
- 2026-10-18: Boot replay runs in clock-checked slices via `scheduler.postTask` background priority (never `scheduler.yield`) with a no-progress deadline, not a total one.
- 2026-10-15: Keep the small production packaging step; ordered script lists in `frontend/index.html` are the shared loader/build inventory.
- 2026-10-24: Affordabot tries another configured city when its priority city has no eligible candidates and never reports a clean no-picks result after errors.
- 2026-10-19: zagreb.lol key-protected review tools share one owner-selected access key kept only in private env files; semantic vocabulary ids use the project domain's `/vocabulary/` path with versioned definitions.
- 2026-09-04: Production data policy: Šibenik proposals/plans are disposable and replaced wholesale from finished laptop data; one deterministic migration for every other unambiguous record; ambiguous records stay unusable, no plan-specific fixers.
- 2026-04-14: Frontend deploys stamp a build token and version every local script URL (Cloudflare cached plain paths).
- 2026-03-28: Backend deploys smoke-test `/health` and `/parcels?bbox=` after the PM2 restart.
- 2026-03-27: Backend boots through `backend/server.js` in PM2 fork mode via `pm2 startOrRestart ecosystem.config.cjs --update-env`.
- 2026-03-31: Area monitors persist a canonical `city_id` and block cross-city loads.
- 2026-06-09: Local DB is the docker `db` container; host-port psql can hit an SSH tunnel to prod. Prod proposal tables live in the `consensus` schema.

## World parcel research and qualification

- 2026-10-21: Qualification owns each city end to end (source verification, config, adapter, integration, real-app test); fixable failures go back to the worker; genuine blockers are fine after a real attempt.
- 2026-10-19: Continuous learning across discovery, review and qualification: independent stage queues share the latest tested code and findings; per-job checkpoints; adapter changes publish only after validated admission.
- 2026-10-19: Only per-city failed URL lists, working settings and shared adapter code are permanent; stage evidence and worktrees are disposable. 2026-10-25: source checks download bounded inputs on demand and delete raw data after each stage.
- 2026-10-19: Qualification prioritizes availability (a real source returning usable polygons through repeatable reads); projection, completeness and binding findings are second-pass follow-ups; never claim uncertain checks passed.
- 2026-10-19: Valhalla runs four parallel admission workers (serial app-data writes) plus extra researchers outside Africa beside the Africa queue.
- 2026-10-18: Resume research and qualification on Valhalla toward 1,000 supported cities (lifts the 2026-10-12 pause).
- 2026-10-12: Qualification is the gate: promotion is `scripts/admit-qualified-cities.mjs` from evidence plus a deploy, no extra live re-check.
- 2026-10-12: Laptop and Valhalla never duplicate work: shared state in `world-parcels/research`, synced both ways; the queue skips cities with a verdict unless `--recheck`.
- 2026-10-12: Discovery runs jurisdiction-first (admin polygons, not metadata bboxes) before municipal reuse. Coverage colour `mostly` when live + qualified cities outnumber held ones in a reviewed region.
- 2026-10-11: Qualify known providers directly from descriptors (LLM workers for exceptions); publish completed passes while the rest continues; run provider reuse beside web search.
- 2026-10-11: Missing formats or provider profiles mean building adapters, never evidence that a city lacks parcels.
- 2026-10-10: Batch qualification at roughly 50 candidates; record and skip city-specific failures after bounded retries; failed cities stay unresolved, never "no public parcels".
- 2026-10-09: Research runs in an isolated Valhalla checkout with per-city checkpoints; inspect viewer config and network endpoints, separating UI failures from missing geometry.
- 2026-10-06: Research all 50 US state capitals plus D.C.; discovery is separate from adapter readiness.
- 2026-10-04: Repeat every failed search in the place's native language/script and save the exact queries and links.
- 2026-10-03: Keep dated source-linked integration attempts (including failures) in registry `integrationAttempts`.
- 2026-09-28: A source is verified only by HTTP 200 plus a nonempty parcel list; city gazetteer and sequential registry (docs/world-parcels.md, `world-parcels/FINDINGS.md`); Brazil's SICAR is `ruralRegistryOnly`, never cadastre.
- 2026-10-11: Outreach history and the central contact ledger live in the private sibling `ugt-outreach` directory; 2026-10-08: approved the 47-candidate developed-country batch with slow individual sends and prior-contact suppression.

## ParcelBench (parcel recognition)

- 2026-10-19: Prioritize suburban and village communities and their growth edges; the ultimate target is high-growth Africa/Asia (training on existing data authorized). The fallback product is plausible imagery-derived plots; false merges cost far more than extra subdivisions.
- 2026-10-13: Code stays local; training on rented GPUs only; living plan `world-parcels/parcel-bench/PLAN.md`; Google Maps imagery only with written permission on file; Croatian government imagery is cleared for training.
- 2026-10-12: Benchmark first (`world-parcels/parcel-bench`, frozen sets, one scorer, OSM baseline); the learned model layers on the OSM baseline; donor cities by practice region (country → Köppen class → distance).
- 2026-10-02/03: SAM 3 experiments approved stepwise; select by whole-parcel precision/recall, not boundary proximity; weights and data stay gitignored.

## Floor plans and Novogradnje

- 2026-10-19: Location-required policy reversed: keep source-backed plans with **Nepoznata lokacija** until evidence places them; the shared geodata API owns published plans (Novogradnje and the CB archive consume). Pionir whole-floor layouts are floor plans, never fabricated apartments.
- 2026-10-19: Manual AI processing uses subscription Codex CLI chunks (≤30 tasks per pass); paid API worker and recurring scheduling stay disabled until approved; cap $10 per UTC day.
- 2026-10-19: **Novogradnje /novogradnje** with plural detail URLs (zgrade/stanovi/tlocrti, no aliases); context viewers never pan, 100 m radius.
- 2026-10-19/20: Stanovanje.plus: private trial approved, then full local processing; public incorporation waits on the permission outreach.
- 2026-10-14: `zagreb.lol/novogradnje/` is the public catalogue (agencies, studios and developers; public apartments must have floor plans); keep plan originals and structured results, tombstone raw sources.
- 2026-10-12: Locate postings like a human (weighted soft signals, LLM for close calls), targeting the site; placement reconstructs the envelope from all posted evidence, then fits plans; addressless new builds locate via eDozvola permits, never pin proximity.
- 2026-10-12: Source HTML/images/PDFs live as gitignored content-addressed files; Postgres keeps URLs, hashes, paths and processing/cost records.
- 2026-10-11: Crawl one complete site at a time; classify images before extraction; keep URL/hash decisions so refreshes do not re-download rejects. Development and collection stay local; production collection stopped and unscheduled.
- 2026-10-07: Only reviewed, registered architecture enters `consensus.building_floor_model`; site failures never imply removal; plans are assigned only to their evidenced listing owner.

## Traffic simulator and other apps

- 2026-10-15: Traffic simulation and junction recognition move to private domain repos with public reads in the shared API and canonical tables in shared geodata.
- 2026-10-14: `/traffic/` grows into a road-change simulator (zagreb.lol/promet/simulator/); saved permitted movements are authoritative; gridlock is accepted; slow standstill lane changes in junctions allowed.
- 2026-10-19: Autokatastar (mobile annotation for transit trips) publishes at `zagreb.lol/autokatastar/pregled`; imagery and reviews stay outside code releases.
- 2026-10-16: Schelling is a configurable map layer in every city (strict meridian/parallel grid with fixed arterial lattice; a free rotatable grid is a separate tool; interventions are painted blocks) (docs/schelling-parcels.md).
- 2026-10-07: Urban-block subdivision stays a read-only playground; shared links carry the chosen split geometry.
