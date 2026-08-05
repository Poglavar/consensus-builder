// The drill panel: on any map click the vertical stack at that point (content proposals →
// slices → the formation that minted them → base parcels) is computed via __drillStack and
// shown as a button column docked under the proposal card, top of the stack first, with
// derivation arrows between rows. The topmost object is what the click selects; the rows let
// the user hop to any other level without hunting. Hover highlights the topmost object.
(function (global) {
    'use strict';

    const PANEL_ID = 'drill-stack-panel';

    function t(key, fallback, params = {}) {
        try {
            const helper = (typeof getProposalI18nHelper === 'function') ? getProposalI18nHelper() : null;
            if (helper) return helper(key, fallback, params);
        } catch (_) { }
        return Object.keys(params).reduce(
            (out, name) => out.replace(new RegExp(`{{${name}}}`, 'g'), String(params[name])),
            String(fallback || ''));
    }

    // ── candidate collection ─────────────────────────────────────────────────────────────────

    // footprint cache: proposalKey → { stamp, footprint, bbox }. The stamp moves whenever the
    // proposal is edited, re-applied or recut (fresh childParcelIds), so a mutated road
    // definition cannot serve a stale corridor polygon.
    const footprintCache = new Map();

    function stampOf(proposal) {
        const children = Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds.length : 0;
        return `${proposal.updatedAt || ''}|${proposal.appliedAt || ''}|${children}`;
    }

    function footprintFor(proposal, key) {
        const planOrder = global.__planOrder;
        if (!planOrder || typeof planOrder.footprintOf !== 'function') return null;
        const stamp = stampOf(proposal);
        const cached = footprintCache.get(key);
        if (cached && cached.stamp === stamp) return cached;
        let footprint = null;
        let bbox = null;
        try {
            footprint = planOrder.footprintOf(proposal) || null;
            if (footprint && global.turf && typeof global.turf.bbox === 'function') {
                bbox = global.turf.bbox(footprint);
            }
        } catch (_) { footprint = null; }
        const entry = { stamp, footprint, bbox };
        footprintCache.set(key, entry);
        return entry;
    }

    function bboxContains(bbox, lng, lat) {
        if (!Array.isArray(bbox) || bbox.length < 4) return true; // no bbox — let the exact test decide
        return lng >= bbox[0] && lat >= bbox[1] && lng <= bbox[2] && lat <= bbox[3];
    }

    function collectCandidates(latlng) {
        const parcels = [];
        const index = (global.parcelLayerById instanceof Map) ? global.parcelLayerById : null;
        const leafletMap = global.map;
        if (index && leafletMap) {
            index.forEach((layer, id) => {
                if (!layer || !layer.feature || typeof layer.getBounds !== 'function') return;
                try {
                    const bounds = layer.getBounds();
                    if (!bounds || !bounds.isValid || !bounds.isValid() || !bounds.contains(latlng)) return;
                    parcels.push({ id: String(id), feature: layer.feature, live: leafletMap.hasLayer(layer) });
                } catch (_) { }
            });
        }

        const proposals = [];
        const storage = global.proposalStorage;
        const all = (storage && typeof storage.getAllProposals === 'function') ? storage.getAllProposals() : [];
        all.forEach(proposal => {
            if (typeof global.isProposalApplied === 'function' && !global.isProposalApplied(proposal)) return;
            const key = (typeof global.getProposalKey === 'function' && global.getProposalKey(proposal)) || proposal.proposalId;
            if (!key) return;
            const cached = footprintFor(proposal, String(key));
            if (!cached || !cached.footprint) return;
            if (!bboxContains(cached.bbox, latlng.lng, latlng.lat)) return;
            proposals.push({ key: String(key), proposal, footprint: cached.footprint });
        });

        return { parcels, proposals };
    }

    function stackAt(latlng) {
        const drill = global.__drillStack;
        if (!drill || !latlng || !global.turf || typeof global.turf.booleanPointInPolygon !== 'function') return [];
        const { parcels, proposals } = collectCandidates(latlng);
        if (!parcels.length && !proposals.length) return [];
        return drill.buildDrillStack([latlng.lng, latlng.lat], {
            parcels,
            proposals,
            pointInPolygon: (pt, poly) => global.turf.booleanPointInPolygon(pt, poly)
        });
    }

    // ── selection dispatch ───────────────────────────────────────────────────────────────────

    function selectProposalEntry(entry, contextParcelId) {
        if (typeof global.selectAndHighlightProposal !== 'function') return;
        global.__openProposalDetailsCollapsed = true;
        global.selectAndHighlightProposal(entry.key, contextParcelId || null, false, true);
    }

    function selectParcelEntry(entry) {
        // openBaseParcel handles both live parcels (normal selection) and consumed ones
        // (panel straight from the registry) — exactly the two states a drill row can hold.
        if (global.__claimsUi && typeof global.__claimsUi.openBaseParcel === 'function') {
            global.__claimsUi.openBaseParcel(entry.id);
        } else if (typeof global.selectParcel === 'function') {
            global.selectParcel(entry.id, true);
        }
    }

    function boundsOfEntry(entry) {
        try {
            let feature = null;
            if (entry.kind === 'proposal') {
                const cached = footprintCache.get(entry.key);
                feature = cached ? cached.footprint : null;
            } else {
                feature = entry.feature;
            }
            if (!feature || typeof L === 'undefined') return null;
            const bounds = L.geoJSON(feature).getBounds();
            return bounds && bounds.isValid && bounds.isValid() ? bounds : null;
        } catch (_) { return null; }
    }

    // Bring the chosen level into view — but only when it is not already fully visible; a
    // visible-but-off-centre object stays where it is instead of yanking the map around.
    function ensureEntryVisible(entry) {
        const leafletMap = global.map;
        if (!leafletMap || typeof leafletMap.getBounds !== 'function') return;
        const bounds = boundsOfEntry(entry);
        if (!bounds) return;
        try {
            if (leafletMap.getBounds().contains(bounds)) return;
            leafletMap.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
        } catch (_) { }
    }

    function selectEntry(entry, contextParcelId) {
        if (!entry) return;
        ensureEntryVisible(entry);
        if (entry.kind === 'proposal') selectProposalEntry(entry, contextParcelId);
        else selectParcelEntry(entry);
        markSelected(entry);
    }

    // ── the panel ────────────────────────────────────────────────────────────────────────────

    let panelEl = null;
    let currentStack = [];
    let repositionWired = false;

    function ensurePanel() {
        if (panelEl && document.body.contains(panelEl)) return panelEl;
        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        panelEl.className = 'right-dock-panel';
        panelEl.setAttribute('role', 'group');
        document.body.appendChild(panelEl);
        if (!repositionWired) {
            repositionWired = true;
            window.addEventListener('resize', positionPanel);
            // The drill sits BETWEEN the proposal card and the parcel panel in the right dock —
            // any size or visibility change of either neighbour moves and re-caps it.
            ['proposal-details-panel', 'parcel-info-panel'].forEach(id => {
                const neighbour = document.getElementById(id);
                if (!neighbour) return;
                if (typeof ResizeObserver === 'function') new ResizeObserver(positionPanel).observe(neighbour);
                if (typeof MutationObserver === 'function') {
                    new MutationObserver(positionPanel).observe(neighbour, { attributes: true, attributeFilter: ['class'] });
                }
            });
        }
        return panelEl;
    }

    // Middle slot of the right dock: below the proposal card, above the parcel panel, one
    // --right-dock-gap from each. A fully expanded card owns the whole column (it is opaque-ish
    // and above us), and a slot too small to be usable hides the drill rather than squeezing it.
    function positionPanel() {
        if (!panelEl) return;
        const gap = 10;
        let top = gap;
        let bottomLimit = window.innerHeight - gap;
        try {
            const details = document.getElementById('proposal-details-panel');
            if (details && details.classList.contains('visible')) {
                const rect = details.getBoundingClientRect();
                if (rect.height > 0 && rect.top < window.innerHeight / 2) top = rect.bottom + gap;
            }
            const parcelPanel = document.getElementById('parcel-info-panel');
            if (parcelPanel && parcelPanel.classList.contains('visible')) {
                const rect = parcelPanel.getBoundingClientRect();
                if (rect.height > 0 && rect.top > top) bottomLimit = rect.top - gap;
            }
        } catch (_) { }
        const room = bottomLimit - top;
        panelEl.classList.toggle('no-room', room < 64);
        panelEl.style.top = `${top}px`;
        panelEl.style.maxHeight = `${Math.max(room, 0)}px`;
    }

    function entryRef(entry) {
        return entry.kind === 'proposal' ? `p:${entry.key}` : `c:${entry.id}`;
    }

    function chipFor(entry) {
        if (entry.kind === 'proposal') {
            const goal = String(entry.proposal.goal || '').trim() || 'other';
            return { text: t(`modal.roadWidth.proposalList.goalLabels.${goal}`, goal), cls: `drill-chip-goal-${goal}` };
        }
        if (entry.depth > 0) return { text: t('panel.drill.slice', 'Formed parcel'), cls: 'drill-chip-slice' };
        return { text: t('panel.drill.baseParcel', 'Cadastral parcel'), cls: 'drill-chip-base' };
    }

    function labelFor(entry) {
        if (entry.kind === 'proposal') {
            return String(entry.proposal.title || entry.proposal.name || entry.key);
        }
        const props = (entry.feature && entry.feature.properties) || {};
        // A slice's raw id embeds the minting token — show its root number and ordinal instead.
        if (entry.depth > 0 && props.rootParcelNumber) {
            const ordinal = props.syntheticIndex !== undefined && props.syntheticIndex !== null
                ? ` #${props.syntheticIndex}` : '';
            return `${props.rootParcelNumber}${ordinal}`;
        }
        try {
            if (typeof global.getParcelDisplayNumberFromFeature === 'function') {
                const broj = global.getParcelDisplayNumberFromFeature(entry.feature, '');
                if (broj && broj.indexOf('#') === -1) return String(broj);
            }
        } catch (_) { }
        return String(entry.id);
    }

    // ── multi-parcel base row ────────────────────────────────────────────────────────────────

    // A formed parcel minted from SEVERAL base parcels (a merged park, a corridor) anchors them
    // all in properties.baseParcelIds (§15a). The base row then shows the whole set — count first,
    // every id clickable, horizontally scrollable — instead of only the one under the click.
    // When no formed level carries the anchor (an adopted structure, pre-§15a fabric), the
    // PROPOSAL above still knows what it took: its formation record / parent lists.
    function parcelSetOfProposal(proposal) {
        const lists = [
            proposal?.structureProposal?.formation?.parcelIds,
            proposal?.buildingProposal?.formation?.parcelIds,
            proposal?.parentParcelIds,
            proposal?.structureProposal?.parentParcelIds,
            proposal?.buildingProposal?.parentParcelIds,
            proposal?.roadProposal?.parentParcelIds,
            proposal?.cadastreParcelIds
        ];
        for (const list of lists) {
            if (Array.isArray(list) && list.length > 1) return list.map(String).filter(Boolean);
        }
        return null;
    }

    function baseGroupIdsFor(stack, index, entry) {
        if (!entry || entry.kind !== 'parcel' || entry.depth > 0) return null;
        let groupIds = null;
        for (let i = index - 1; i >= 0 && !groupIds; i -= 1) {
            const above = stack[i];
            if (!above) continue;
            if (above.kind === 'parcel' && above.depth > 0) {
                const baseIds = above.feature && above.feature.properties && Array.isArray(above.feature.properties.baseParcelIds)
                    ? above.feature.properties.baseParcelIds.map(String).filter(Boolean)
                    : [];
                if (baseIds.length > 1) groupIds = baseIds;
            } else if (above.kind === 'proposal') {
                groupIds = parcelSetOfProposal(above.proposal);
            }
        }
        if (!groupIds || groupIds.length < 2) return null;
        // The clicked base parcel leads the list so it is never scrolled out of sight.
        const ordered = [String(entry.id), ...groupIds.filter(id => id !== String(entry.id))];
        return Array.from(new Set(ordered));
    }

    function baseFeatureById(id) {
        try {
            const layer = (global.parcelLayerById instanceof Map) ? global.parcelLayerById.get(String(id)) : null;
            return layer && layer.feature ? layer.feature : null;
        } catch (_) { return null; }
    }

    function baseParcelButtonLabel(id, feature) {
        try {
            if (feature && typeof global.getParcelDisplayNumberFromFeature === 'function') {
                const broj = global.getParcelDisplayNumberFromFeature(feature, '');
                if (broj && broj.indexOf('#') === -1) return String(broj);
            }
        } catch (_) { }
        return String(id).replace(/^HR-\d+-/, '');
    }

    function renderBaseGroupRow(groupIds, currentEntry, selectedRef) {
        const row = document.createElement('div');
        row.className = 'drill-stack-row drill-stack-row--multi';
        const chipEl = document.createElement('span');
        chipEl.className = 'drill-stack-chip drill-chip-base';
        chipEl.textContent = t('panel.drill.baseParcelCount', 'Cadastral parcel ({{count}})', { count: groupIds.length });
        row.appendChild(chipEl);
        const strip = document.createElement('div');
        strip.className = 'drill-stack-parcel-strip';
        groupIds.forEach(id => {
            const feature = String(id) === String(currentEntry.id) ? (currentEntry.feature || baseFeatureById(id)) : baseFeatureById(id);
            const parcelEntry = { kind: 'parcel', id: String(id), feature, depth: 0 };
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'drill-stack-parcel-btn';
            btn.dataset.ref = entryRef(parcelEntry);
            btn.textContent = baseParcelButtonLabel(id, feature);
            if (selectedRef && entryRef(parcelEntry) === selectedRef) btn.classList.add('selected');
            btn.addEventListener('click', () => selectEntry(parcelEntry));
            if (feature) {
                btn.addEventListener('mouseenter', () => hoverEntry(parcelEntry));
                btn.addEventListener('mouseleave', clearHoverOutline);
            }
            strip.appendChild(btn);
        });
        row.appendChild(strip);
        return row;
    }

    function renderPanel(stack, selectedRef) {
        const el = ensurePanel();
        el.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'drill-stack-header';
        const title = document.createElement('span');
        title.textContent = t('panel.drill.title', 'At this spot');
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'close-circle-btn close-circle-btn--lg';
        close.setAttribute('aria-label', t('panel.drill.close', 'Close'));
        close.title = t('panel.drill.close', 'Close');
        close.textContent = '×';
        close.addEventListener('click', hidePanel);
        header.appendChild(title);
        header.appendChild(close);
        el.appendChild(header);

        stack.forEach((entry, i) => {
            if (i > 0) {
                // The derivation arrow: the lower row is the ground the upper one stands on.
                const link = document.createElement('div');
                link.className = 'drill-stack-link';
                link.textContent = '↑';
                el.appendChild(link);
            }
            const groupIds = baseGroupIdsFor(stack, i, entry);
            if (groupIds && groupIds.length > 1) {
                el.appendChild(renderBaseGroupRow(groupIds, entry, selectedRef));
                return;
            }
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'drill-stack-row';
            row.dataset.ref = entryRef(entry);
            if (selectedRef && entryRef(entry) === selectedRef) row.classList.add('selected');
            const chip = chipFor(entry);
            const chipEl = document.createElement('span');
            chipEl.className = `drill-stack-chip ${chip.cls}`;
            chipEl.textContent = chip.text;
            const labelEl = document.createElement('span');
            labelEl.className = 'drill-stack-label';
            labelEl.textContent = labelFor(entry);
            row.appendChild(chipEl);
            row.appendChild(labelEl);
            row.addEventListener('click', () => selectEntry(entry));
            row.addEventListener('mouseenter', () => hoverEntry(entry));
            row.addEventListener('mouseleave', clearHoverOutline);
            el.appendChild(row);
        });

        el.classList.add('visible');
        currentStack = stack;
        positionPanel();
    }

    function markSelected(entry) {
        if (!panelEl) return;
        const ref = entryRef(entry);
        panelEl.querySelectorAll('.drill-stack-row, .drill-stack-parcel-btn').forEach(row => {
            row.classList.toggle('selected', row.dataset.ref === ref);
        });
    }

    function hidePanel() {
        if (panelEl) panelEl.classList.remove('visible');
        currentStack = [];
    }

    // The panel describes what is selected at a spot, so it has no business outliving the
    // selection: closing the parcel or proposal card used to leave the stack standing over an
    // empty map, offering rows for a thing nothing was pointing at any more.
    //
    // A proposal counts as selected only while its card is on screen. ProposalSelection is NOT the
    // test: closing that panel deliberately leaves the selection object behind (see
    // hideProposalDetailsPanel), so asking it would keep the stack alive for a proposal the user
    // just dismissed.
    function hideIfNothingSelected() {
        try {
            if (global.selectedParcelId) return;
            const proposalPanel = global.document && global.document.getElementById('proposal-details-panel');
            if (proposalPanel && proposalPanel.classList.contains('visible')) return;
        } catch (_) { /* cannot tell — closing is the safe answer */ }
        hidePanel();
    }

    // ── hover ────────────────────────────────────────────────────────────────────────────────

    let lastHoverRef = null;

    function hoverOutlineFor(entry) {
        if (!entry) return null;
        if (entry.kind === 'proposal') {
            const cached = footprintCache.get(entry.key);
            return cached ? cached.footprint : null;
        }
        return entry.feature || null;
    }

    function showHoverOutline(entry) {
        const ref = entryRef(entry);
        if (ref === lastHoverRef) return;
        const feature = hoverOutlineFor(entry);
        if (!feature || typeof global.highlightFeaturesForHover !== 'function') return;
        lastHoverRef = ref;
        // Base parcels get their number label; slice ids would render their synthetic token.
        const showLabels = entry.kind === 'parcel' && entry.depth === 0;
        global.highlightFeaturesForHover([feature], { showLabels });
    }

    function clearHoverOutline() {
        if (lastHoverRef === null) return;
        lastHoverRef = null;
        if (typeof global.highlightFeaturesForHover === 'function') global.highlightFeaturesForHover([]);
    }

    // Hovering a row previews that level on the map, same outline as map hover.
    function hoverEntry(entry) {
        if (interactionBlocked()) return;
        showHoverOutline(entry);
    }

    // The full list — an editor holding the map, plus every mode that already meant "do not select
    // anything" — lives in map-edit-lock.js so the several places that ask this question cannot
    // drift apart. The local list stays only as the fallback if that script failed to load.
    function interactionBlocked() {
        try {
            if (global.__mapEditLock) return global.__mapEditLock.blocksSelection();
            if (global.measureMode) return true;
            if (global.roadDrawingMode === true) return true;
            if (global.cadastreViewActive === true) return true;
            if (global.proposalListBrowseMode) return true;
            if (typeof global.isParcelDrawingModeActive === 'function' && global.isParcelDrawingModeActive()) return true;
            if (typeof global.isStructureGeometryEditorActive === 'function' && global.isStructureGeometryEditorActive()) return true;
            if (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive()) return true;
        } catch (_) { }
        return false;
    }

    let hoverPending = null;
    let lastHoverPoint = null;

    function onMapMouseMove(e) {
        if (!e || !e.latlng) return;
        if (interactionBlocked()) { clearHoverOutline(); return; }
        if (lastHoverPoint && e.containerPoint
            && Math.abs(e.containerPoint.x - lastHoverPoint.x) < 4
            && Math.abs(e.containerPoint.y - lastHoverPoint.y) < 4) return;
        lastHoverPoint = e.containerPoint;
        if (hoverPending) return;
        hoverPending = requestAnimationFrame(() => {
            hoverPending = null;
            const stack = stackAt(e.latlng);
            const top = stack.length ? stack[0] : null;
            // The drill is the single hover authority (the parcels' own mouseover styling defers
            // to it): whatever claim is topmost — proposal, slice, or bare parcel — gets the
            // outline, so hover and click always agree on what the cursor is over.
            if (top) showHoverOutline(top);
            else clearHoverOutline();
        });
    }

    function onMapMouseOut() {
        clearHoverOutline();
    }

    // ── click entry points ───────────────────────────────────────────────────────────────────

    // From onParcelClick: the parcel itself is already selected; the drill decides which
    // proposal (if any) stands on top of it and shows the whole chain.
    function handleParcelClick(latlng, parcelId) {
        const stack = stackAt(latlng);
        if (!stack.length) { hidePanel(); return false; }
        const top = stack[0];
        let selectedRef = null;
        if (top.kind === 'proposal') {
            selectProposalEntry(top, parcelId);
            selectedRef = entryRef(top);
        } else {
            selectedRef = `c:${parcelId}`;
        }
        renderPanel(stack, selectedRef);
        return true;
    }

    // From structure fills and corridor hit targets: nothing is selected yet; the drill both
    // selects the topmost object and shows the chain.
    function handleSurfaceClick(latlng) {
        const stack = stackAt(latlng);
        if (!stack.length) { hidePanel(); return false; }
        const top = stack[0];
        if (top.kind === 'proposal') selectProposalEntry(top, null);
        else selectParcelEntry(top);
        renderPanel(stack, entryRef(top));
        return true;
    }

    // Background map clicks (no interactive layer took it): a consumed parcel or a proposal
    // over unloaded ground can still be under the cursor — drill anyway; empty just closes.
    function onMapClick(e) {
        if (!e || !e.latlng || interactionBlocked()) return;
        const stack = stackAt(e.latlng);
        if (!stack.length) { hidePanel(); return; }
        const top = stack[0];
        if (top.kind === 'proposal') selectProposalEntry(top, null);
        else selectParcelEntry(top);
        renderPanel(stack, entryRef(top));
    }

    // ── wiring ───────────────────────────────────────────────────────────────────────────────

    let mapWired = false;
    function wireMap() {
        if (mapWired) return true;
        const leafletMap = global.map;
        if (!leafletMap || typeof leafletMap.on !== 'function') return false;
        leafletMap.on('mousemove', onMapMouseMove);
        leafletMap.on('mouseout', onMapMouseOut);
        leafletMap.on('click', onMapClick);
        // Selection flows wipe the shared hover group (clearProposalHoverLayers); dropping the
        // memoised ref makes the next mousemove redraw instead of skipping as "already shown".
        if (global.ProposalSelection && typeof global.ProposalSelection.subscribe === 'function') {
            global.ProposalSelection.subscribe(() => { lastHoverRef = null; });
        }
        mapWired = true;
        return true;
    }

    // Whether the drill currently owns map hover — the parcels' own mouseover styling and the
    // corridor hover defer to it exactly when this is true.
    function ownsHover() {
        return mapWired && !interactionBlocked();
    }
    if (!wireMap() && typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', wireMap);
    }

    // notifyHover: for layers that keep bubblingMouseEvents off (corridor hit targets) and so
    // starve the map of mousemove — they forward their own moves here instead.
    const api = { stackAt, handleParcelClick, handleSurfaceClick, hidePanel, hideIfNothingSelected, selectEntry, notifyHover: onMapMouseMove, ownsHover };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__drillUi = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
