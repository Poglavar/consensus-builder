// Synchronous corridor geometry needed by replay and proposal analysis. Heavy editing remains lazy.
function corridorFootprintModule() {
    const api = (typeof window !== 'undefined' && window.__corridorFootprint) || null;
    if (!api) throw new Error('road-shared: corridor-footprint.js is not loaded');
    return api;
}
function roadPolygonFromGeoJSON(geometry) {
    if (!geometry) return null;
    const toRing = coordinates => coordinates.map(([lng, lat]) => L.latLng(lat, lng));
    if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates.map(toRing);
        return rings.length === 1 ? rings[0] : rings;
    }
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(rings => rings.map(toRing));
    throw new Error(`road-shared: unexpected footprint type ${geometry.type}`);
}
function corridorSurfaceFootprintForDefinition(definition) {
    const footprint = corridorFootprintModule();
    return footprint.footprintIn(definition, footprint.frameForDefinition(definition));
}
function buildCorridorAcquisitionPolygon(definition) {
    return roadPolygonFromGeoJSON(corridorSurfaceFootprintForDefinition(definition));
}
if (typeof window !== 'undefined') {
    window.buildCorridorAcquisitionPolygon = buildCorridorAcquisitionPolygon;
    window.corridorSurfaceFootprintForDefinition = corridorSurfaceFootprintForDefinition;
}

// Road-panel presentation stays available without loading the drawing session.
function formatRoadText(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function translateRoadText(key, fallback, params = {}) {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    const translated = api && typeof api.t === 'function' ? api.t(key, params) : null;
    if (!translated || translated === key) {
        return formatRoadText(fallback, params);
    }
    return formatRoadText(translated, params);
}

// Collapse the drawing panel to a slim strip (title + Cross-section + Undo/Finish) so the map
// stays visible while drawing — essential on phones, where the full panel covers half the screen.
function toggleRoadInfoPanelMinimized() {
    const panel = document.getElementById('road-info-panel');
    if (!panel) return;
    const minimized = panel.classList.toggle('is-minimized');
    const btn = document.getElementById('road-panel-minimize');
    if (btn) {
        const label = minimized
            ? translateRoadText('sidebar.areaMonitor.expand', 'Expand')
            : translateRoadText('sidebar.areaMonitor.minimize', 'Minimize');
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        btn.setAttribute('aria-expanded', minimized ? 'false' : 'true');
        btn.innerHTML = minimized ? '+' : '&#8722;';
    }
}
if (typeof window !== 'undefined') {
    window.toggleRoadInfoPanelMinimized = toggleRoadInfoPanelMinimized;
}

function showAcquiringDifficultyDialog() {
    if (typeof document === 'undefined') return;

    const t = translateRoadText;
    const title = t('panel.road.acquiringDifficultyTitle', 'Modeled acquisition score');
    // The area-model sentence names the road-land rate where the road's parcels are (road-drawing.js
    // roadLandRate); a city without one has none to name. This file loads at startup and road-drawing.js
    // on demand: before it loads there is no road and no road parcels, so the rate is the city's own.
    const roadRate = typeof roadLandRate === 'function' ? roadLandRate() : window.CityMoney.currentLandPriceOptions('road');
    const explanation = t('panel.road.acquiringDifficultyTooltip', 'An illustrative score: each parcel value is multiplied by a category weight. It does not estimate legal rights, acquisition cost or consent.\nGovernment: 0\nInstitution: 0\nCompany: 1\nIndividual or mixed: 2\nMissing ownership categories, unusable prices or mixed currencies leave the score unknown.')
        + (typeof roadRate.areaPricePerSqm === 'number'
            ? '\n' + t('panel.road.acquiringDifficultyAreaModel', 'Area estimates use a {{rate}}/m² model.', { rate: CbFormat.formatMoney(roadRate.areaPricePerSqm, roadRate.currency) })
            : '');
    const closeLabel = t('modal.common.close', 'Close');
    const okLabel = t('panel.road.acquiringDifficultyDialogOk', 'OK');

    // Format explanation: split by newlines and format as paragraphs/list
    const parts = explanation.split('\n');
    const intro = parts[0] || '';
    const coefficients = parts.slice(1).filter(line => line.trim());

    let formattedExplanation = `<p>${intro}</p>`;
    if (coefficients.length > 0) {
        formattedExplanation += '<ul>';
        coefficients.forEach(coeff => {
            formattedExplanation += `<li>${coeff}</li>`;
        });
        formattedExplanation += '</ul>';
    }

    // The app's dialog (js/ui/dialogs.js): its header and close, Escape and the backdrop close it.
    window.CbDialog.open({
        title,
        size: 'sm',
        className: 'road-acquiring-difficulty-dialog',
        body: formattedExplanation,
        closeLabel,
        actions: [{ id: 'ok', label: okLabel, role: 'primary' }]
    });
}

// Expose function globally
if (typeof window !== 'undefined') {
    window.showAcquiringDifficultyDialog = showAcquiringDifficultyDialog;
}

// Hide road info panel
function hideRoadInfoPanel() {
    document.getElementById('road-info-panel').classList.remove('visible');
}

function corridorProtectedSpanRecordsForDefinition(definition) {
    const records = Array.isArray(definition?.tunnels) ? definition.tunnels.filter(Boolean) : [];
    const gradeRecords = (typeof gradeSeparationSpanRecords === 'function')
        ? gradeSeparationSpanRecords(definition?.gradeSeparations || [])
        : [];
    return records.concat(gradeRecords);
}

function corridorProtectedEdgeKeySet(tunnels, gradeSeparations) {
    const keys = (Array.isArray(tunnels) ? tunnels : []).map(record => record?.edgeKey).filter(Boolean);
    if (typeof gradeSeparationEdgeKeys === 'function') {
        keys.push(...gradeSeparationEdgeKeys(gradeSeparations || []));
    }
    return new Set(keys);
}

// The taking geometry and cutting geometry are the same full corridor. Tunnels and grade
// separations are authored road content, but they still take the cadastral surface.
//
// The one exception is a stretch that is fully underground by LEVEL (corridor-elevation.md,
// 2026-07-12): it takes nothing, because nothing on the surface changes. Levels only exist on
// imported corridors so far, and a corridor without them yields one span per segment — byte for
// byte the previous footprint. Edge-keyed `tunnels` metadata is a different concept and still
// acquires; only an explicit -1 level is exempt.
//
// Built by the shared construction in the corridor's own frame (corridor-footprint.js, projections.md
// §3): exactly the land the server prepares and stores. Throws when it cannot be built.
// Every geometry change re-derives the parcels the corridor's land takes from the committed
// fabric. Leaflet is only a projection and never participates in the intersection decision.
// A parcel counts when the land reaches into it (geometry-tolerances.js reachesInto, the rule
// binding declares by): a neighbour that only shares a border gives the road nothing.
// `options.toleranceM` is the record's own allowance.
function collectParcelsIntersectingFootprint(footprintGeometry, options = {}) {
    if (!footprintGeometry || typeof turf === 'undefined') return [];
    const geometry = footprintGeometry.type ? footprintGeometry : { type: 'Polygon', coordinates: footprintGeometry };
    const roadFeature = { type: 'Feature', properties: {}, geometry };
    return liveRoadDrawingParcelsIntersecting(roadFeature, { reaches: true, toleranceM: options.toleranceM })
        .map(getRoadDrawingParcelIdFromFeature)
        .filter(Boolean)
        .map(String);
}

// Geometry edits change the authored road record, then rematerialise the affected flat cadastral
// component. Generated parcels are cache, never a predecessor chain that the editor has to undo.
// The spinner is presentation-only.
function cloneRoadValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function baseRoadParentHints(ids) {
    const fabric = window.LiveParcelFabric;
    if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
        throw new Error('Live parcel fabric provenance is unavailable while saving the corridor.');
    }
    return fabric.cadastreIdsForParcelIds(Array.isArray(ids) ? ids : []);
}

function writeRoadDefinition(record, definition) {
    if (!record || !definition) return;
    const copy = cloneRoadValue(definition);
    record.roadProposal = { ...(record.roadProposal || {}), definition: copy };
    if (copy.polygon) {
        record.site = cloneRoadValue(copy.polygon);
        delete record.binding;
    }
}

function stripRoadDerivedFields(record) {
    if (!record) return record;
    delete record.childParcelIds;
    delete record.descendantParcelIds;
    delete record.parentFeatures;
    delete record.appliedAt;
    delete record.executedAt;
    delete record.localEditAt;
    delete record.editSeq;
    delete record.revertSnapshot;
    delete record.childFeatures;
    const road = record.roadProposal;
    if (road) {
        delete road.childParcelIds;
        delete road.parentFeatures;
        delete road.parentsToRemove;
        delete road.formation;
        delete road.demolishedBuildings;
        delete road.demolitionScanned;
        delete road.childFeatures;
        if (road.definition) {
            delete road.definition.demolishedBuildings;
            delete road.definition.demolitionScanned;
        }
    }
    return record;
}

function makeFreshRoadSnapshot(sourceProposal, definition, options = {}) {
    const clone = cloneRoadValue(sourceProposal);
    // The source's identity stays with the source: its local key, its publication mark (a design's
    // only published identity; designs are not minted, M3), its times and its lineage.
    [
        'proposalId', 'id', 'published',
        'createdAt', 'updatedAt', 'proposalDraftId', 'lens', 'proposalOrigin'
    ].forEach(key => delete clone[key]);

    if (options.sourceLocalProposalId) {
        clone.proposalOrigin = window.ProposalOrigin.fromRecord(sourceProposal, {
            relation: 'revision', localProposalId: String(options.sourceLocalProposalId)
        });
    }
    // A fork of a published design links the design it came from by its CID (plan-design-agreement.md,
    // M2: "Fork design" records origin.cid); the publication mark itself stays with the source.
    const sourcePublication = sourceProposal && sourceProposal.published;
    if (sourcePublication && window.Cid.isCid(sourcePublication.cid)) clone.origin = { cid: sourcePublication.cid };

    const cleanDefinition = cloneRoadValue(definition);
    delete cleanDefinition.demolishedBuildings;
    delete cleanDefinition.demolitionScanned;
    const geometricHints = cleanDefinition.polygon
        ? collectParcelsIntersectingFootprint(cleanDefinition.polygon, { toleranceM: window.GeometryTolerances.designToleranceM(sourceProposal) })
        : [];
    const fallbackHints = sourceProposal?.cadastreParcelIds || [];
    const cadastreParcelIds = baseRoadParentHints(geometricHints.length ? geometricHints : fallbackHints);

    // The replacement keeps the SOURCE's place in the constraint order: the §15c replay
    // applies formations oldest-first, and stamping now() sent every edited road to the END
    // of the queue — structures authored after it then replayed before it, whole-took the
    // bases along its route, and the re-derive refused at 56% coverage ("could not be
    // derived from the cadastre"). An edit changes the record, not when the formation
    // entered the partition.
    clone.createdAt = (sourceProposal && sourceProposal.createdAt)
        ? sourceProposal.createdAt
        : new Date().toISOString();
    clone.cadastreParcelIds = cadastreParcelIds.slice();
    // The stretch reaches less land than its source: claims copied from the source on parcels
    // outside the new anchors would fail the load boundary ("contains live parcel id").
    window.ProposalAuthoredRecord.restrictLandClaimsToAnchors(clone);
    clone.roadProposal = {
        ...(clone.roadProposal || {}),
        definition: cloneRoadValue(cleanDefinition)
    };
    writeRoadDefinition(clone, cleanDefinition);
    stripRoadDerivedFields(clone);
    if (typeof setProposalApplied === 'function') setProposalApplied(clone, false, { stamp: false });
    else clone.applied = false;
    return clone;
}

// Add every loaded parcel the road's land reaches into (`polygon`) to the record's declared
// cadastre parcels (as base parcel ids, like a fresh snapshot). A road placed into a parcel
// (definition.bound) has the parcel's own boundary as its land, so every neighbour touches it, but
// only the parcels it reaches into are declared. Returns the ids that were newly declared.
function declareParcelsUnderRoadLand(record, polygon) {
    if (!record || !polygon) return [];
    const reached = baseRoadParentHints(collectParcelsIntersectingFootprint(polygon,
        { toleranceM: window.GeometryTolerances.designToleranceM(record) }));
    const declared = new Set((Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : []).map(String).filter(Boolean));
    const added = reached.map(String).filter(id => id && !declared.has(id));
    if (!added.length) return [];
    record.cadastreParcelIds = [...declared, ...added];
    return added;
}

// A junction is authored into every road that meets there (proposals/corridor-authoring.js). A
// connected road that is still one's own unpublished design takes the change in place. A published
// one is immutable (proposals/lineage.js), exactly as when it is edited directly: the junction is
// saved as its new version, a revision that names the published design by its CID, and the revision
// takes its place on the map while the published record stays as it was. `definition` has its land
// built. Returns the record that now carries it.
function reviseRoadForJunction(store, source, definition) {
    const sourceKey = String(
        (typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId
    );
    const revision = makeFreshRoadSnapshot(source, definition, { sourceLocalProposalId: sourceKey });
    declareParcelsUnderRoadLand(revision, definition.polygon);
    const id = store.addProposal(revision, { emitEvent: false });
    const stored = id ? store.getProposal(id) : null;
    if (!stored) throw new Error(`Could not save the new version of “${source.title || source.name || sourceKey}”.`);
    setProposalApplied(stored, true);
    store._indexProposal?.(stored);
    setProposalApplied(source, false, { stamp: false });
    store._indexProposal?.(source);
    return stored;
}

function rebuildRoadDefinitionFootprint(definition) {
    // An edited definition is no longer the one its provenance describes: its land is rebuilt in the
    // edited centre line's own frame, and publishing prepares it anew.
    delete definition.constructionFrame;
    const polygon = corridorSurfaceFootprintForDefinition(definition);
    definition.polygon = polygon;
    definition.latLngPairs = convertRoadPolygonToLatLngPairs(roadPolygonFromGeoJSON(polygon));
    delete definition.demolishedBuildings;
    delete definition.demolitionScanned;
    return definition.polygon;
}

function getRoadDrawingParcelIdFromFeature(feature) {
    return feature ? ensureParcelId(feature) : null;
}

function getRoadDrawingFabric() {
    return (typeof window !== 'undefined' && window.LiveParcelFabric)
        ? window.LiveParcelFabric
        : null;
}

function liveRoadDrawingParcelsIntersecting(queryFeature, options = {}) {
    const fabric = getRoadDrawingFabric();
    if (!queryFeature || !queryFeature.geometry || !fabric || typeof fabric.queryBounds !== 'function'
        || typeof turf === 'undefined' || typeof turf.bbox !== 'function'
        || typeof turf.booleanIntersects !== 'function') return [];
    let candidates = [];
    try {
        candidates = fabric.queryBounds(turf.bbox(queryFeature), {
            includeCorridors: options.includeCorridors === true
        });
    } catch (_) {
        return [];
    }
    // `options.reaches`: count only parcels the shape reaches into (geometry-tolerances.js), for
    // declarations; a clip that fails throws a typed ClipFailure. Without it, any touch counts (the
    // drawing previews, which run while the pointer moves).
    const hits = options.reaches
        ? candidates.filter(feature => window.GeometryTolerances.reachesInto(turf, queryFeature, feature, options.toleranceM,
            { site: 'road-drawing.parcelsReached' }))
        : candidates.filter(feature => {
            try { return turf.booleanIntersects(queryFeature, feature); } catch (_) { return false; }
        });
    // Only cadastral parcels are returned: a piece formed on open ground joins no count, owner
    // tally or declaration. `options.groundInto` (a Map) collects those pieces for the open-ground stat.
    const ground = (typeof window !== 'undefined') ? window.__openGround : null;
    if (!ground || typeof ground.splitCrossedPieces !== 'function') return hits;
    const split = ground.splitCrossedPieces(hits, { idOf: getRoadDrawingParcelIdFromFeature });
    if (options.groundInto instanceof Map) {
        split.ground.pieces.forEach(piece => options.groundInto.set(piece.id, piece.areaM2));
    }
    return split.parcels;
}

// The land of one or more polylines at one width, built by the shared construction
// (corridor-footprint.js footprintOfArms: rectangles, bevels at bends) in `frame` — the drawing
// session's, or the frame of the corridor being edited or rendered. Leaflet nesting (LatLng[] for one
// ring); null for an empty input. Throws when the land cannot be built.
function calculateRoadPolygon(points, width, frame) {
    if (!frame) throw new Error('calculateRoadPolygon: a metric frame is required (projections.md §2)');
    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

    // Normalize to an array of centerline segments to support disjoint multi-segment roads
    const segments = [];
    if (Array.isArray(points)) {
        if (points.length && isLatLng(points[0])) {
            segments.push(points);
        } else if (points.length && Array.isArray(points[0])) {
            points.forEach(seg => {
                if (Array.isArray(seg) && seg.length >= 2 && isLatLng(seg[0])) {
                    segments.push(seg);
                }
            });
        }
    }

    if (!segments.length || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: Array.isArray(points) ? points.length : undefined, width });
        return null;
    }
    const arms = segments.map(segment => ({ points: segment, width: Number(width) }));
    return roadPolygonFromGeoJSON(corridorFootprintModule().footprintOfArms(arms, frame));
}

// A non-blocking "working…" spinner, shown while anything slow enough to look like a hang is under
// way — a corridor edit re-applying, a road being built, a proposal being created. Ref-counted so
// overlapping claims keep it up until the last one settles. It never blocks input (pointer-events:none in
// CSS) — road-node-edit suspends its handles until the transaction settles. The CSS animation-delay means a fast
// edit removes it before it ever becomes visible, so only genuinely slow applies flash the spinner.
let corridorApplyIndicatorCount = 0;
let corridorApplyIndicatorTimer = null;
let corridorApplyIndicatorRelease = null;
function beginApplyIndicator(labelText) {
    corridorApplyIndicatorCount += 1;
    if (corridorApplyIndicatorTimer || corridorApplyIndicatorRelease || typeof document === 'undefined') return;
    const label = labelText || ((typeof translateRoadText === 'function')
        ? translateRoadText('panel.road.applyingEdit', 'Applying…')
        : 'Applying…');
    // Only a genuinely slow apply reaches the status line (design-language.md, Messages): a quick edit ends
    // before the delay runs out.
    corridorApplyIndicatorTimer = setTimeout(() => {
        corridorApplyIndicatorTimer = null;
        if (corridorApplyIndicatorCount <= 0) return;
        const scope = (typeof window !== 'undefined') ? window : {};
        if (typeof scope.updateStatus === 'function') scope.updateStatus(label, { transient: true });
        corridorApplyIndicatorRelease = (typeof scope.beginStatusActivity === 'function') ? scope.beginStatusActivity() : () => {};
    }, 150);
    // The pointer is where the user is looking, so it carries the same news: the whole document goes
    // busy, which survives exitRoadDrawingMode() clearing the map container's inline cursor.
    document.body?.classList.add('corridor-busy');
}
function endApplyIndicator() {
    corridorApplyIndicatorCount = Math.max(0, corridorApplyIndicatorCount - 1);
    if (corridorApplyIndicatorCount > 0) return;
    if (corridorApplyIndicatorTimer) { clearTimeout(corridorApplyIndicatorTimer); corridorApplyIndicatorTimer = null; }
    if (corridorApplyIndicatorRelease) { corridorApplyIndicatorRelease(); corridorApplyIndicatorRelease = null; }
    if (typeof document !== 'undefined') document.body?.classList.remove('corridor-busy');
}
if (typeof window !== 'undefined') {
    window.beginApplyIndicator = beginApplyIndicator;
    window.endApplyIndicator = endApplyIndicator;
    window.isCorridorApplyInFlight = isCorridorApplyInFlight;
}

// True while any corridor re-apply is in flight — the exit/deselect paths wait on this.
function isCorridorApplyInFlight() {
    return corridorApplyIndicatorCount > 0;
}

// Mirrors the project's hotkey patterns (e.g. proposals "C", owner counts "O") and avoids triggering while typing or while modals are open.
let roadDrawHotkeyAttached = false;

function isEditableTarget(target) {
    if (!target) return false;
    const tagName = target.tagName;
    return target.isContentEditable
        || tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT'
        || tagName === 'OPTION';
}

function isElementVisiblyRendered(el) {
    if (!el) return false;
    const style = (typeof window !== 'undefined' && window.getComputedStyle)
        ? window.getComputedStyle(el)
        : (el.style || {});
    const display = style.display;
    const visibility = style.visibility;
    const hidden = el.getAttribute && el.getAttribute('aria-hidden') === 'true';
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const hasArea = rect && rect.width > 0 && rect.height > 0;
    return !hidden && display !== 'none' && visibility !== 'hidden' && hasArea;
}

function isAnyModalOpen() {
    if (typeof document === 'undefined') return false;
    if (document.body && document.body.classList && document.body.classList.contains('modal-open')) return true;

    // If any modal overlay is visible, don't hijack keys.
    const modalSelectors = [
        '.create-proposal-modal',
        '.welcome-modal',
        '.parcel-coverage-modal',
        '.proposal-info-modal',
        '.parcel-list-modal',
        '.parcel-selection-modal',
        '.agent-dialog-modal',
        '.lens-modal',
        '.login-modal',
        '.logout-modal',
        '[role="dialog"]',
        '[aria-modal="true"]',
        'dialog[open]'
    ];
    try {
        const nodes = document.querySelectorAll(modalSelectors.join(','));
        for (const el of nodes) {
            // The cross-section editor matches [role="dialog"] but is NOT blocking: it docks beside
            // a live map, and B (which survey am I looking at) is exactly the key you reach for
            // while profiling a road. Its own dialogs still match and still block.
            if (el.closest && el.closest('.corridor-editor-overlay')) continue;
            if (isElementVisiblyRendered(el)) return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

// Any road operation needs the buildings on the map IMMEDIATELY — a corridor decision is a
// decision about buildings. The Buildings layer (the sources detection and cutting run on) switches
// on automatically, no dialog; outlines the user already chose are left alone.
function ensureRoadOperationBuildings(bounds) {
    // This prepares the Leaflet editing viewport, never the model/photo scene. A 3D selection
    // must not reload 2D footprints and trigger another 3D rebuild/selection notification.
    if ((window.__mapModeState?.desired && window.__mapModeState.desired !== '2d')
        || window.__pending3DMode || window.isThreeModeActive?.()) return Promise.resolve();
    try {
        const outlined = window.SourceList?.outlined(window.CityConfigManager?.getBuildingSources?.() || []) || [];
        if (!window.PlanningViews?.isBuiltVisible() && !outlined.length) setBuildingReferenceLayers(true);
        if (typeof window.rebuildBuildingLayerFromPool === 'function') {
            try { window.rebuildBuildingLayerFromPool(); }
            catch (error) { console.warn('[road-shared] Could not redraw the loaded buildings', error); }
        }
        const area = bounds || ((typeof map !== 'undefined' && map && typeof map.getBounds === 'function') ? map.getBounds() : null);
        if (area && typeof window.ensureBuildingFootprintsForBounds === 'function') {
            return window.ensureBuildingFootprintsForBounds(area).catch(error => {
                console.warn('[road-shared] Could not load building footprints', error);
            });
        }
    } catch (error) {
        console.warn('[ensureRoadOperationBuildings] could not prepare buildings', error);
    }
    return Promise.resolve();
}

// The Buildings layer on or off (the sources in use); outlined sources are the source list's.
function setBuildingReferenceLayers(on) {
    window.PlanningViews?.setBuiltVisible(on);
}

// B opens the building source list (BuildingLayersDialog): which sources are in use, in what order,
// and which are outlined. It never changes what a corridor cuts beyond that — cutting reads the
// feature pool — but it does decide what the profiler measures.
async function toggleBuildingReferenceLayers() {
    if (!window.BuildingLayersDialog) return;
    await window.BuildingLayersDialog.open();
}

function handleRoadDrawHotkey(event) {
    if (document.body.classList.contains('three-mode-active')) return;
    if (!event) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    if (isAnyModalOpen()) return;
    if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        toggleBuildingReferenceLayers();
        return;
    }
    if (event.key !== 'r' && event.key !== 'R') return;

    if (typeof window.requestRoadDrawTool !== 'function') return;
    event.preventDefault();
    window.requestRoadDrawTool();
}

function attachRoadDrawHotkey() {
    if (roadDrawHotkeyAttached) return;
    document.addEventListener('keydown', handleRoadDrawHotkey);
    roadDrawHotkeyAttached = true;
}

if (typeof window !== 'undefined') {
    window.toggleBuildingReferenceLayers = toggleBuildingReferenceLayers;
    window.setBuildingReferenceLayers = setBuildingReferenceLayers;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachRoadDrawHotkey, { once: true });
    } else {
        attachRoadDrawHotkey();
    }
}
