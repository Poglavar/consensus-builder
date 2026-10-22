/**
 * Parcel-based Urban Rule functionality.
 *
 * This file contains the functionality for parcel-based urban rules - generating
 * individual buildings per parcel with setback from borders and varying floor counts.
 *
 * Unlike block or row typology which work with superparcels, parcel-based typology
 * generates one building per parcel using configurable rules:
 * - min_distance: setback from parcel borders
 * - max_floors: the permitted ceiling; a build-out varies from 1 up to it
 *
 * What the proposal SAVES is the permitted massing — one maximum envelope per parcel — because
 * that is what the rule asserts and what the stats and the € gain must read. The varied houses
 * shown here are one example build-out of that rule, derived from (rule, seed) by
 * urban-rule-variation.js, so the same design always redraws the same street. See
 * urban-rule-massing.md.
 */

(function () {
    const Variation = (typeof window !== 'undefined' && window.UrbanRuleVariation) ? window.UrbanRuleVariation : null;

    // Modal state
    let parcelBasedModal = null;
    let parcelBasedMap = null;
    let parcelBasedGenerationTimer = null;
    let parcelBasedBoundary = null;
    let parcelBasedParcelLayer = null;
    let parcelBasedBuildingLayers = [];
    let parcelBasedEnvelopeLayers = [];
    let parcelBasedExcludedLayers = [];
    // The permitted massing (saved with the proposal) and the example build-out drawn from it.
    let generatedParcelBasedFeatures = [];
    let parcelBasedBuildOut = [];
    let parcelBasedBlockNameOverride = null;
    let parcelBasedBlock = null;
    let parcelBasedDragState = null;
    let pendingParcelBasedProposalContext = null;

    // Default parameter values
    const DEFAULT_MAX_FLOORS = 5;
    const DEFAULT_MIN_DISTANCE = 3; // meters from parcel borders
    const DEFAULT_FLOOR_HEIGHT = 3; // meters per floor
    const DEFAULT_RULE_KIND = 'max'; // A: permits up to the envelope; nobody is compelled to build
    const DEFAULT_MIN_FLOORS = 1;
    const DEFAULT_MIN_FOOTPRINT_M2 = 0;
    // GUP's najmanja površina građevne čestice. Small by default — buildings are possible on very
    // small plots — but non-zero, because a sliver of a plot is not a building site.
    const DEFAULT_MIN_PLOT_AREA_M2 = 50;
    let currentMaxFloors = DEFAULT_MAX_FLOORS;
    let currentMinDistance = DEFAULT_MIN_DISTANCE;
    let currentRuleKind = DEFAULT_RULE_KIND;
    let currentMinFloors = DEFAULT_MIN_FLOORS;
    let currentMinFootprintM2 = DEFAULT_MIN_FOOTPRINT_M2;
    let currentMinPlotAreaM2 = DEFAULT_MIN_PLOT_AREA_M2;

    // The variation seed for this design. Every house is derived from it, so the same seed always
    // redraws the same street — on reload, in a shared link, and in a server-rendered thumbnail.
    // Only Regenerate advances it; moving a slider re-derives from the same seed, so an edit
    // disturbs only what it touches instead of reshuffling the whole block.
    let currentVariationSeed = newVariationSeed();

    // Parameters to restore when the modal next opens, instead of the defaults. Set by
    // openParcelBasedForParcels({ initialParameters }); consumed once by showParcelBasedModal().
    let parcelBasedSeedParameters = null;

    // Random colors for buildings
    const BUILDING_COLORS = [
        '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b',
        '#2980b9', '#27ae60', '#d35400', '#8e44ad', '#f1c40f'
    ];

    // Helper functions
    function formatParcelBasedText(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            if (!Object.prototype.hasOwnProperty.call(params, key)) return match;
            const value = params[key];
            // An i18n plural reference ({ key, count }) without i18n loaded: its count is the best fallback.
            return value && typeof value === 'object' && 'count' in value ? value.count : value;
        });
    }

    function translateParcelBasedText(key, fallback, params = {}) {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            { const translated = api.t(key, params); if (translated !== key) return translated; }
        }
        return formatParcelBasedText(fallback, params);
    }

    function showParcelBasedAlert(key, fallback, params = {}) {
        const message = key
            ? translateParcelBasedText(`alerts.messages.${key}`, fallback, params)
            : translateParcelBasedText('', fallback, params);
        window.CbDialog.alert(message);
        return message;
    }

    function setParcelBasedInfo(key, fallback, params = {}) {
        const infoElement = document.getElementById('parcelbased-info');
        if (!infoElement) return;
        if (key) {
            infoElement.setAttribute('data-i18n-key', key);
            infoElement.setAttribute('data-i18n-attr', 'text');
        } else {
            infoElement.removeAttribute('data-i18n-key');
        }
        if (params && Object.keys(params).length > 0) {
            try {
                infoElement.setAttribute('data-i18n-params', JSON.stringify(params));
            } catch (_) {
                infoElement.removeAttribute('data-i18n-params');
            }
        } else {
            infoElement.removeAttribute('data-i18n-params');
        }
        infoElement.textContent = translateParcelBasedText(key, fallback, params);
    }

    function setPendingParcelBasedProposalContext(ctx) {
        pendingParcelBasedProposalContext = ctx || null;
        if (typeof window !== 'undefined') {
            window.pendingParcelBasedProposalContext = pendingParcelBasedProposalContext;
        }
    }

    function getParcelBasedDisplayName() {
        if (parcelBasedBlockNameOverride) return parcelBasedBlockNameOverride;
        return translateParcelBasedText('parcelBased.modal.messages.selectedParcels', 'Selected Parcels');
    }

    function getActiveParcelBasedBlock() {
        if (parcelBasedBlock && Array.isArray(parcelBasedBlock.parcels) && parcelBasedBlock.parcels.length > 0) {
            return parcelBasedBlock;
        }
        return null;
    }

    function describeParcelBasedParcelSelection(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return translateParcelBasedText('parcelBased.modal.messages.selectedParcels', 'Selected Parcels');
        if (ids.length === 1) return translateParcelBasedText('parcelBased.modal.messages.singleParcelLabel', 'Parcel {{id}}', { id: ids[0] });
        // The shared plural key: Croatian and Serbian need a different form for 2–4 parcels.
        return translateParcelBasedText('proposals.autoName.parcels', '{{count}} parcels', { count: ids.length });
    }

    function parcelBasedParcelsForIds(parcelIds) {
        const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
        return ids.map(id => {
            // Live parcels, or the synthetic design parcels of a site on bare ground
            // (js/site-drawing.js: the site as one superparcel, or plots cut along a frontage).
            const feature = (typeof window.resolveDesignParcelFeature === 'function'
                ? window.resolveDesignParcelFeature(id)
                : window.LiveParcelFabric?.get?.(id)) || null;
            return feature ? { id, feature } : null;
        }).filter(Boolean);
    }

    // A parcel keeps its shade whatever order the parcels arrive in. An index-based colour
    // recoloured the whole street the moment one parcel joined or left the selection.
    function colorForParcel(parcelId, index = 0) {
        if (!Variation || parcelId === undefined || parcelId === null || parcelId === '') {
            return BUILDING_COLORS[index % BUILDING_COLORS.length];
        }
        return BUILDING_COLORS[Variation.hashIndex(parcelId, BUILDING_COLORS.length)];
    }

    // A fresh seed for a fresh design. Random once, then stored and replayed forever after.
    function newVariationSeed() {
        return (Math.floor(Math.random() * 0xffffffff) >>> 0);
    }

    // The rule the sliders currently describe. This is the proposal's actual content — the
    // geometry below is derived from it.
    function currentParcelRule() {
        const params = {
            typology: 'parcelBased',
            kind: currentRuleKind,
            minDistance: currentMinDistance,
            maxFloors: currentMaxFloors,
            minFloors: currentMinFloors,
            minFootprintAreaM2: currentMinFootprintM2,
            minPlotAreaM2: currentMinPlotAreaM2,
            floorHeightM: DEFAULT_FLOOR_HEIGHT
        };
        return Variation ? Variation.normalizeParcelRule(params) : params;
    }

    // Under "exactly this" every plot builds its full envelope, so there is no variation to roll —
    // hide the button rather than leave a control that provably does nothing. The minimums only
    // exist for the between-a-minimum-and-this rule.
    function syncRuleKindControls() {
        const minimums = document.getElementById('parcelbased-minimums');
        if (minimums) minimums.style.display = currentRuleKind === 'range' ? '' : 'none';

        const regenerate = document.getElementById('btn-parcelbased-regenerate');
        if (regenerate) regenerate.style.display = currentRuleKind === 'exact' ? 'none' : '';

        // Min floors can never exceed the ceiling it sits under.
        const minFloorsSlider = document.getElementById('parcelbased-minfloors-slider');
        if (minFloorsSlider) {
            minFloorsSlider.max = String(currentMaxFloors);
            if (currentMinFloors > currentMaxFloors) currentMinFloors = currentMaxFloors;
            minFloorsSlider.value = String(currentMinFloors);
            const label = document.getElementById('parcelbased-minfloors-value');
            if (label) label.textContent = String(currentMinFloors);
        }
    }

    // turf plus the app's own polygon sanitizers, which know the cadastre's quirks.
    function variationDeps() {
        return {
            turf,
            sanitize: (typeof sanitizePolygonFeature === 'function') ? sanitizePolygonFeature : null,
            largestPolygon: toSingleLargestPolygonLocal
        };
    }

    // --- Geometry utilities ---

    // Sanitize and convert polygon to single largest polygon
    function toSingleLargestPolygonLocal(feature) {
        if (typeof toSingleLargestPolygon === 'function') {
            return toSingleLargestPolygon(feature);
        }
        if (!feature || !feature.geometry) return feature;
        const geom = feature.geometry;
        if (geom.type === 'Polygon') return feature;
        if (geom.type === 'MultiPolygon') {
            let maxArea = -Infinity;
            let largestCoords = null;
            geom.coordinates.forEach(poly => {
                try {
                    const tempFeature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: poly } };
                    const area = turf.area(tempFeature);
                    if (area > maxArea) {
                        maxArea = area;
                        largestCoords = poly;
                    }
                } catch (_) { }
            });
            if (largestCoords) {
                return {
                    type: 'Feature',
                    properties: feature.properties || {},
                    geometry: { type: 'Polygon', coordinates: largestCoords }
                };
            }
        }
        return feature;
    }

    // The permitted massing for one parcel: the parcel set back by the rule, extruded to the
    // maximum floors, stamped with the rule and this parcel's variation seed so any consumer can
    // derive the same example build-out from it. Returns null for a parcel the rule leaves nothing
    // buildable on.
    function generateBuildingForParcel(parcel, index, rule, designSeed) {
        const feature = parcel.feature;
        if (!feature || !Variation) return { envelope: null, status: 'invalid', feature, parcelId: null };

        const props = feature.properties || {};
        const parcelId = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId || props.parcel_id || props.id || `parcel-${index}`);

        const { envelope, status } = Variation.evaluateParcel(feature, rule, variationDeps());
        if (!envelope) {
            return { envelope: null, status, feature, parcelId };
        }

        envelope.properties = {
            ...envelope.properties,
            type: 'proposedParcelBasedBuilding',
            parcelId: parcelId,
            urbanRule: rule,
            variationSeed: Variation.hashSeed(designSeed, parcelId),
            color: colorForParcel(parcelId, index),
            buildingIndex: index
        };

        return { envelope, status, feature, parcelId };
    }

    // The permitted massing for every parcel in the block, plus the parcels the rule leaves out.
    // Excluded parcels are returned rather than dropped: an empty plot in the middle of a street
    // reads as a bug unless the editor can say which rule excluded it.
    function generateBuildingsForBlock(block, rule, designSeed) {
        const buildings = [];
        const excluded = [];
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return { buildings, excluded };
        }

        block.parcels.forEach((parcel, index) => {
            const outcome = generateBuildingForParcel(parcel, index, rule, designSeed);
            if (outcome.envelope) buildings.push(outcome.envelope);
            else excluded.push(outcome);
        });

        return { buildings, excluded };
    }

    // One example build-out of the massing: what a street built under this rule could look like.
    // Presentation only — the envelopes above are what the proposal stores and the stats read.
    function buildOutFor(envelopes) {
        if (!Variation || !Array.isArray(envelopes)) return [];
        const deps = variationDeps();
        return envelopes.map(envelope => Variation.realizeFeature(envelope, deps));
    }

    function excludedParcelReason(status) {
        if (status === 'below-min-plot') {
            return translateParcelBasedText('parcelBased.modal.messages.excludedBelowMinPlot',
                'Smaller than the minimum plot size — it has to be merged with a neighbour before anything can be built here.');
        }
        if (status === 'cannot-meet-minimum') {
            return translateParcelBasedText('parcelBased.modal.messages.excludedCannotMeet',
                'Too small to meet the minimum this rule compels — the rule contradicts itself here.');
        }
        return translateParcelBasedText('parcelBased.modal.messages.excludedNoRoom',
            'The setback leaves no room to build on this plot.');
    }

    function parcelBasedSiteFeature(features, authoredSite = null) {
        if (authoredSite?.geometry) {
            return {
                type: 'Feature',
                properties: { ...(authoredSite.properties || {}) },
                geometry: JSON.parse(JSON.stringify(authoredSite.geometry))
            };
        }
        const valid = (Array.isArray(features) ? features : []).filter(feature => feature?.geometry);
        if (!valid.length) return null;
        // A union the clipper cannot do refuses the site. The old fallback stacked the parcels into
        // one MultiPolygon whose parts share edges — not a union, and not valid ground to build on.
        let site = valid[0];
        for (const feature of valid.slice(1)) {
            let merged = null;
            try { merged = turf.union(site, feature); } catch (error) {
                throw parcelBasedClipFailure('union', error, 'parcel-based.siteFeature', [site, feature]);
            }
            if (!merged) throw parcelBasedClipFailure('union', new Error('union came back empty'), 'parcel-based.siteFeature', [site, feature]);
            site = merged;
        }
        // Hairline gaps between parcels that do not quite meet are nobody's ground, not holes.
        const siteClip = (typeof window !== 'undefined' && window.__siteClip)
            || (typeof require === 'function' ? require('./proposals/site-clip.js') : null);
        return siteClip.fillMicroHoles(site, { turf });
    }

    // A polygon clip that cannot be done, typed and counted (parcel-arrangement.js ClipFailure).
    function parcelBasedClipFailure(operation, error, site, operands) {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        return api ? api.clipFailure(operation, error, { site }, operands) : error;
    }

    // Draw the example build-out solid, inside the permitted envelope drawn as a dashed outline —
    // the classic planning drawing, so the rule and a sample of it read in one picture. Parcels the
    // rule excludes are drawn hatched with the reason on hover, never left silently empty.
    function displayBuildingsInModal(envelopes, buildOut, excluded) {
        if (!parcelBasedMap) return;

        [parcelBasedEnvelopeLayers, parcelBasedBuildingLayers, parcelBasedExcludedLayers].forEach(layers => {
            layers.forEach(layer => {
                if (parcelBasedMap && layer) parcelBasedMap.removeLayer(layer);
            });
        });
        parcelBasedEnvelopeLayers = [];
        parcelBasedBuildingLayers = [];
        parcelBasedExcludedLayers = [];

        (Array.isArray(excluded) ? excluded : []).forEach(entry => {
            if (!entry || !entry.feature || !entry.feature.geometry) return;
            const layer = L.geoJSON(entry.feature, {
                pane: parcelBasedModal?.pane,
                style: { fillColor: '#b0453a', fillOpacity: 0.16, color: '#b0453a', weight: 1.5, dashArray: '2, 5' }
            }).addTo(parcelBasedMap);
            layer.bindTooltip(excludedParcelReason(entry.status), { permanent: false, direction: 'center' });
            parcelBasedExcludedLayers.push(layer);
        });

        const permittedEnvelopes = Array.isArray(envelopes) ? envelopes : [];
        const houses = Array.isArray(buildOut) ? buildOut : [];

        permittedEnvelopes.forEach((envelope, index) => {
            if (!envelope || !envelope.geometry) return;
            const color = envelope.properties?.color || colorForParcel(envelope.properties?.parcelId, index);

            const envelopeLayer = L.geoJSON(envelope, {
                pane: parcelBasedModal?.pane,
                style: { fillColor: color, fillOpacity: 0.08, color, weight: 1, dashArray: '4, 4' }
            }).addTo(parcelBasedMap);
            envelopeLayer.on('mousedown touchstart', startParcelBasedDrag);
            parcelBasedEnvelopeLayers.push(envelopeLayer);

            const house = houses[index];
            if (!house || !house.geometry) return;
            const layer = L.geoJSON(house, {
                pane: parcelBasedModal?.pane,
                style: { fillColor: color, fillOpacity: 0.6, color, weight: 2 }
            }).addTo(parcelBasedMap);
            layer.on('mousedown touchstart', startParcelBasedDrag);

            const floors = house.properties?.floors || 1;
            const permitted = envelope.properties?.floors || floors;
            const parcelId = house.properties?.parcelId || 'Unknown';
            layer.bindTooltip(`Parcel ${parcelId}: ${floors} of ${permitted} permitted floor${permitted > 1 ? 's' : ''}`, {
                permanent: false,
                direction: 'center'
            });

            parcelBasedBuildingLayers.push(layer);
        });

        updateBuildingMetrics(envelopes, houses);

        parcelBasedModal?.setPreview({
            draftPreview: { kind: 'buildings', features: houses },
            boundary: parcelBasedBoundary,
            envelopes: currentRuleKind === 'exact' ? [] : envelopes,
            excluded: (Array.isArray(excluded) ? excluded : []).filter(entry => entry?.feature?.geometry).map(entry => entry.feature)
        });
    }

    // Footprint and volume are the PERMITTED figures, read off the envelopes — they are what the
    // rule asserts and what the € gain uses, so re-rolling the build-out must never move them. Only
    // the average floor count describes the example, and it is labelled as such.
    function updateBuildingMetrics(envelopes, buildOut) {
        const buildingCountEl = document.getElementById('parcelbased-building-count-value');
        const totalAreaEl = document.getElementById('parcelbased-total-area-value');
        const totalVolumeEl = document.getElementById('parcelbased-total-volume-value');
        const avgFloorsEl = document.getElementById('parcelbased-avg-floors-value');

        if (!buildingCountEl || !totalAreaEl || !totalVolumeEl || !avgFloorsEl) return;

        const blank = () => {
            buildingCountEl.textContent = '0';
            totalAreaEl.textContent = '0';
            totalVolumeEl.textContent = '0';
            avgFloorsEl.textContent = '0';
        };

        if (!Array.isArray(envelopes) || envelopes.length === 0) { blank(); return; }

        try {
            let permittedArea = 0;
            let permittedVolume = 0;

            envelopes.forEach(envelope => {
                if (!envelope || !envelope.geometry) return;
                const area = turf.area(envelope);
                permittedArea += area;
                permittedVolume += area * (envelope.properties?.height || DEFAULT_FLOOR_HEIGHT);
            });

            const houses = Array.isArray(buildOut) ? buildOut.filter(house => house && house.geometry) : [];
            const totalFloors = houses.reduce((sum, house) => sum + (house.properties?.floors || 1), 0);
            const avgFloors = houses.length > 0 ? totalFloors / houses.length : 0;

            buildingCountEl.textContent = envelopes.length.toString();
            totalAreaEl.textContent = CbFormat.formatNumber(permittedArea, { maxFractionDigits: 1, minFractionDigits: 1 });
            totalVolumeEl.textContent = CbFormat.formatNumber(permittedVolume, { maxFractionDigits: 1, minFractionDigits: 1 });
            avgFloorsEl.textContent = CbFormat.formatNumber(avgFloors, { maxFractionDigits: 1, minFractionDigits: 1 });
        } catch (e) {
            console.warn('[ParcelBased] Error calculating metrics:', e);
            blank();
        }
    }

    // Autosave each regenerated layout into the active universal draft without closing the tool.
    function autosaveParcelBasedDraft() {
        const activeDraft = window.getActiveProposalDesignDraft?.();
        const block = getActiveParcelBasedBlock();
        if (!activeDraft || !['buildings', 'row', 'parcelBased', 'single'].includes(activeDraft.adapterKey || activeDraft.goal)
            || !generatedParcelBasedFeatures?.length || !block?.parcels?.length
            || typeof window.syncActiveProposalDraftFromEditor !== 'function') return;
        const parentDetails = [];
        const parcelIds = [];
        block.parcels.forEach(parcel => {
            const props = parcel?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(parcel?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id);
            if (!parcelId) return;
            const id = String(parcelId);
            parcelIds.push(id);
            parentDetails.push({ id, number: String(props?.BROJ_CESTICE || id) });
        });
        const buildings = JSON.parse(JSON.stringify(generatedParcelBasedFeatures));
        window.syncActiveProposalDraftFromEditor('building', {
            parcelIds,
            parentDetails,
            blockName: getParcelBasedDisplayName(),
            parameters: parcelBasedDesignParameters(),
            buildings,
            buildingFeature: buildings[0] || null
        }, { coalesceKey: 'parcel-based-live' });
    }

    // Everything needed to reproduce this design exactly: the rule it asserts and the seed its
    // example build-out came from. maxFloors/minDistance stay alongside for the slider restore.
    function parcelBasedDesignParameters() {
        return {
            typology: 'parcelBased',
            rule: currentParcelRule(),
            seed: currentVariationSeed,
            maxFloors: Number(currentMaxFloors) || DEFAULT_MAX_FLOORS,
            minDistance: Number(currentMinDistance) || DEFAULT_MIN_DISTANCE
        };
    }

    // Roll a new example build-out. Only this changes the seed — a slider re-derives from the same
    // one, so raising the height limit does not also reshuffle every footprint on the street.
    function rerollParcelBasedBuildOut() {
        currentVariationSeed = newVariationSeed();
        generateBuildingsInModal();
    }

    // Generate buildings in modal
    function generateBuildingsInModal() {
        const block = getActiveParcelBasedBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return;
        }

        setParcelBasedInfo('parcelBased.modal.generating', 'Generating buildings...');

        try {
            const { buildings, excluded } = generateBuildingsForBlock(block, currentParcelRule(), currentVariationSeed);

            if (!buildings || buildings.length === 0) {
                throw new Error('Failed to generate any buildings');
            }

            generatedParcelBasedFeatures = buildings;
            parcelBasedBuildOut = buildOutFor(buildings);
            displayBuildingsInModal(buildings, parcelBasedBuildOut, excluded);
            autosaveParcelBasedDraft();
            const freeformButton = document.getElementById('btn-parcelbased-freeform');
            if (freeformButton) freeformButton.hidden = !parcelBasedConvertsToFreeform();

            const doneButton = document.getElementById('btn-parcelbased-done');
            if (doneButton) doneButton.disabled = false;

            // The footer says only what needs attention: the parcels left out (hatched on the map),
            // not a count of what was built. Empty when every parcel builds.
            if (excluded.length) setParcelBasedInfo('blockify.modal.messages.parcelsLeftOut', '{{count}} parcels left out', { count: excluded.length });
            else setParcelBasedInfo('', '');

        } catch (error) {
            console.error('[ParcelBased] Generation error:', error);
            setParcelBasedInfo(
                'parcelBased.modal.messages.creationFailed',
                'Building generation failed. Try adjusting parameters.',
                {}
            );
            const doneButton = document.getElementById('btn-parcelbased-done');
            if (doneButton) doneButton.disabled = true;
        }
    }

    // ---- Dragging: a Detached rule stays on its parcels ----
    // Grabbing any house drags the whole design; the drop asks (proposal-editor-shell.js
    // chooseRuleDrop): run the same rule on the parcels mostly inside the dropped outline, convert to
    // Freeform buildings (one Freeform proposal per house, since a Freeform stays one building), or
    // put it back. The houses keep their stored massing and relative positions, moved by the drag.

    function parcelBasedLatLng(event) {
        const nativeEvent = event?.originalEvent || event;
        const touch = nativeEvent?.changedTouches?.[0] || nativeEvent?.touches?.[0];
        const pointer = touch ? { clientX: touch.clientX, clientY: touch.clientY } : nativeEvent;
        return event?.latlng || parcelBasedMap.containerPointToLatLng(parcelBasedMap.mouseEventToContainerPoint(pointer));
    }

    function movedParcelBasedFeature(feature, from, to) {
        if (!feature?.geometry || !from || !to) return feature;
        const geometry = window.SingleBuildingGeometry?.moveGeometry?.(feature.geometry, from, to);
        return geometry ? { ...feature, geometry } : feature;
    }

    function startParcelBasedDrag(event) {
        if (!parcelBasedMap || parcelBasedDragState || !generatedParcelBasedFeatures?.length) return;
        L.DomEvent?.stopPropagation?.(event);
        event?.originalEvent?.preventDefault?.();
        parcelBasedDragState = {
            start: event.latlng,
            end: event.latlng,
            mapWasDraggable: parcelBasedMap.dragging?.enabled?.() !== false
        };
        parcelBasedMap.dragging?.disable?.();
        document.addEventListener('mousemove', moveParcelBasedDrag);
        document.addEventListener('mouseup', finishParcelBasedDrag);
        document.addEventListener('touchmove', moveParcelBasedDrag, { passive: false });
        document.addEventListener('touchend', finishParcelBasedDrag);
        document.addEventListener('touchcancel', finishParcelBasedDrag);
    }

    function moveParcelBasedDrag(event) {
        if (!parcelBasedDragState || !parcelBasedMap) return;
        if (event?.cancelable) event.preventDefault();
        const drag = parcelBasedDragState;
        drag.end = parcelBasedLatLng(event);
        displayBuildingsInModal(
            generatedParcelBasedFeatures.map(feature => movedParcelBasedFeature(feature, drag.start, drag.end)),
            parcelBasedBuildOut.map(feature => movedParcelBasedFeature(feature, drag.start, drag.end)),
            []
        );
    }

    function parcelBasedParcelsUnderOutline(outline) {
        const fabric = window.LiveParcelFabric;
        const conversion = window.__freeformConversion;
        const order = window.__planOrder;
        if (!outline?.geometry || !fabric?.queryBounds || !conversion || !order?.intersectionArea) return [];
        const candidates = fabric.queryBounds(turf.bbox(outline), { includeCorridors: false })
            .filter(feature => !(typeof window.isRoadParcel === 'function' && window.isRoadParcel(fabric.featureId(feature))))
            .map(feature => ({ id: fabric.featureId(feature), feature }));
        return conversion.parcelsMostlyInside(outline, candidates, {
            intersectionArea: order.intersectionArea,
            area: feature => turf.area(feature)
        });
    }

    // Run the Detached rule, with its current parameters, on the parcels under the dropped outline.
    function parcelBasedRuleAtOutline(outline) {
        const ids = parcelBasedParcelsUnderOutline(outline);
        if (!ids.length) {
            return { ok: false, reason: translateParcelBasedText('proposalDrafts.freeform.noParcelsHere', 'No parcel lies mostly inside the dropped outline.') };
        }
        const parcels = parcelBasedParcelsForIds(ids);
        const nextBlock = { parcels, parcelIds: ids, site: null, valid: true, polygon: null };
        const generated = parcels.length === ids.length
            ? generateBuildingsForBlock(nextBlock, currentParcelRule(), currentVariationSeed)
            : { buildings: [] };
        if (!generated.buildings.length) {
            return { ok: false, reason: translateParcelBasedText('proposalDrafts.freeform.ruleFailedHere', 'The {{rule}} rule cannot build a building on the parcels here.', { rule: window.ruleDropLabel?.('parcelBased') || 'Detached' }) };
        }
        parcelBasedBlock = nextBlock;
        parcelBasedBlockNameOverride = describeParcelBasedParcelSelection(ids);
        // The design's land moves with the rule (proposal-editor-shell.js moveActiveDesignToParcels).
        window.moveActiveDesignToParcels?.(ids);
        displayParcelsOnMap(nextBlock);
        generateBuildingsInModal();
        return { ok: true };
    }

    // The footer's conversion (no drag) is offered only on one parcel: one house. A Detached record on
    // several parcels cannot be rebuilt from its merged outline after a cadastre swap, so without a
    // drag it gets the rule re-run, not a conversion.
    function parcelBasedConvertsToFreeform() {
        return (getActiveParcelBasedBlock()?.parcels?.length || 0) === 1 && (generatedParcelBasedFeatures?.length || 0) === 1;
    }

    // Each house as it would stand converted: its stored massing (the envelope the record saves)
    // and its own parcel as its ground, both moved by the drag offset (none without a drag).
    function parcelBasedHouses(from = null, to = null) {
        const parcels = getActiveParcelBasedBlock()?.parcels || [];
        return (generatedParcelBasedFeatures || []).filter(feature => feature?.geometry).map(envelope => {
            const parcelId = String(envelope.properties?.parcelId || '');
            const parcel = parcels.find(candidate => String(candidate?.id || '') === parcelId
                || (typeof ensureParcelId === 'function' && candidate?.feature && String(ensureParcelId(candidate.feature)) === parcelId));
            const feature = movedParcelBasedFeature(envelope, from, to);
            const ground = parcel?.feature?.geometry ? movedParcelBasedFeature(parcel.feature, from, to) : feature;
            return { feature, site: window.__siteDraft?.siteFromFeatures?.([ground]) || ground.geometry };
        });
    }

    async function convertParcelBasedToFreeform(houses, confirm) {
        const result = await window.convertActiveDesignToFreeformBuildings?.({ houses, typology: 'parcelBased', confirm });
        if (result?.ok) closeParcelBasedModal({ preservePending: true });
        return result || { ok: false };
    }

    async function finishParcelBasedDrag() {
        if (!parcelBasedDragState) return;
        const drag = parcelBasedDragState;
        parcelBasedDragState = null;
        if (drag.mapWasDraggable) parcelBasedMap?.dragging?.enable?.();
        document.removeEventListener('mousemove', moveParcelBasedDrag);
        document.removeEventListener('mouseup', finishParcelBasedDrag);
        document.removeEventListener('touchmove', moveParcelBasedDrag);
        document.removeEventListener('touchend', finishParcelBasedDrag);
        document.removeEventListener('touchcancel', finishParcelBasedDrag);
        const putBack = () => generateBuildingsInModal();
        if (!drag.end || (drag.end.lat === drag.start.lat && drag.end.lng === drag.start.lng)) {
            putBack();
            return;
        }
        const outline = parcelBasedBoundary?.geometry ? movedParcelBasedFeature(parcelBasedBoundary, drag.start, drag.end) : null;
        const houses = parcelBasedHouses(drag.start, drag.end);
        const answer = typeof window.chooseRuleDrop === 'function'
            ? await window.chooseRuleDrop({
                typology: 'parcelBased',
                buildings: houses.length,
                tryConvert: async () => convertParcelBasedToFreeform(houses, false),
                tryRule: async () => parcelBasedRuleAtOutline(outline)
            })
            : 'cancel';
        if (answer === 'cancel' && parcelBasedModal) putBack();
    }

    // --- Modal management ---

    function showParcelBasedModal() {
        const block = getActiveParcelBasedBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus(translateParcelBasedText('proposalDrafts.noParcels', 'No parcels selected'));
            }
            return false;
        }

        parcelBasedBlock = block;
        const blockLabel = getParcelBasedDisplayName();
        console.log('[ParcelBased] showParcelBasedModal called for block:', blockLabel, 'with', block.parcels.length, 'parcels');

        if (!parcelBasedModal) {
            const container = document.createElement('div');
            container.innerHTML = `
                <div id="parcelbased-sidebar">
                    <div class="parameter-group">
                        <label for="parcelbased-ruletype-select" data-i18n-key="parcelBased.modal.labels.ruleType" data-i18n-attr="text">What the rule compels:</label>
                        <select id="parcelbased-ruletype-select">
                            <option value="max" data-i18n-key="parcelBased.modal.labels.ruleTypeMax" data-i18n-attr="text">At most this</option>
                            <option value="range" data-i18n-key="parcelBased.modal.labels.ruleTypeRange" data-i18n-attr="text">Between a minimum and this</option>
                            <option value="exact" data-i18n-key="parcelBased.modal.labels.ruleTypeExact" data-i18n-attr="text">Exactly this</option>
                        </select>
                    </div>
                    <div class="parameter-group">
                        <label for="parcelbased-maxfloors-slider">
                            <span data-i18n-key="parcelBased.modal.labels.maxFloors" data-i18n-attr="text">Max Floors:</span>
                            <span id="parcelbased-maxfloors-value">${DEFAULT_MAX_FLOORS}</span>
                        </label>
                        <input type="range" id="parcelbased-maxfloors-slider" min="1" max="20" value="${DEFAULT_MAX_FLOORS}" step="1">
                    </div>
                    <div class="parameter-group">
                        <label for="parcelbased-mindistance-slider">
                            <span data-i18n-key="parcelBased.modal.labels.minDistance" data-i18n-attr="text">Min Distance from Borders (m):</span>
                            <span id="parcelbased-mindistance-value">${CbFormat.formatNumber(DEFAULT_MIN_DISTANCE, { maxFractionDigits: 1, minFractionDigits: 1 })}</span>
                        </label>
                        <input type="range" id="parcelbased-mindistance-slider" min="0.5" max="20" value="${DEFAULT_MIN_DISTANCE}" step="0.5">
                    </div>
                    <div id="parcelbased-minimums" style="display: none;">
                        <div class="parameter-group">
                            <label for="parcelbased-minfloors-slider">
                                <span data-i18n-key="parcelBased.modal.labels.minFloors" data-i18n-attr="text">Min Floors:</span>
                                <span id="parcelbased-minfloors-value">${DEFAULT_MIN_FLOORS}</span>
                            </label>
                            <input type="range" id="parcelbased-minfloors-slider" min="1" max="${DEFAULT_MAX_FLOORS}" value="${DEFAULT_MIN_FLOORS}" step="1">
                        </div>
                        <div class="parameter-group">
                            <label for="parcelbased-minfootprint-slider">
                                <span data-i18n-key="parcelBased.modal.labels.minFootprint" data-i18n-attr="text">Min Ground Floor (m²):</span>
                                <span id="parcelbased-minfootprint-value">${DEFAULT_MIN_FOOTPRINT_M2}</span>
                            </label>
                            <input type="range" id="parcelbased-minfootprint-slider" min="0" max="500" value="${DEFAULT_MIN_FOOTPRINT_M2}" step="5">
                        </div>
                    </div>
                    <div class="parameter-group">
                        <label for="parcelbased-minplot-slider">
                            <span data-i18n-key="parcelBased.modal.labels.minPlotArea" data-i18n-attr="text">Min Plot Size (m²):</span>
                            <span id="parcelbased-minplot-value">${DEFAULT_MIN_PLOT_AREA_M2}</span>
                        </label>
                        <input type="range" id="parcelbased-minplot-slider" min="0" max="10000" value="${DEFAULT_MIN_PLOT_AREA_M2}" step="10">
                    </div>
                    <details class="on-map-editor__more-options">
                        <summary data-i18n-key="onMapEditor.moreOptions">${translateParcelBasedText('onMapEditor.moreOptions', 'More options')}</summary>
                        <div class="parameter-metrics">
                            <div class="metric-row">
                                <span data-i18n-key="parcelBased.modal.labels.buildingCount" data-i18n-attr="text">Buildings:</span>
                                <span id="parcelbased-building-count-value">0</span>
                            </div>
                            <div class="metric-row">
                                <span data-i18n-key="parcelBased.modal.labels.totalArea" data-i18n-attr="text">Permitted Footprint (m²):</span>
                                <span id="parcelbased-total-area-value">0</span>
                            </div>
                            <div class="metric-row">
                                <span data-i18n-key="parcelBased.modal.labels.totalVolume" data-i18n-attr="text">Permitted Volume (m³):</span>
                                <span id="parcelbased-total-volume-value">0</span>
                            </div>
                            <div class="metric-row">
                                <span data-i18n-key="parcelBased.modal.labels.avgFloors" data-i18n-attr="text">Example Floors (avg):</span>
                                <span id="parcelbased-avg-floors-value">0</span>
                            </div>
                        </div>
                        <div class="parameter-info">
                            <p>
                                <span data-i18n-key="parcelBased.modal.helper.ruleType">What the rule compels: at most this (nobody has to build), between a minimum and this, or exactly this (everyone builds the full envelope).</span>
                                <span data-i18n-key="parcelBased.modal.helper.minPlotArea">Min Plot Size: plots smaller than this cannot be built on under this rule, and are shown hatched. They have to be merged first.</span>
                            </p>
                        </div>
                    </details>
                </div>
                <div id="parcelbased-controls" class="cb-dialog__footer">
                    <div id="parcelbased-info" data-i18n-attr="text" role="status" aria-live="polite"></div>
                    <div id="parcelbased-buttons">
                        <button type="button" class="btn" id="btn-parcelbased-regenerate" data-i18n-key="parcelBased.modal.regenerate" data-i18n-attr="text">Regenerate</button>
                        <button type="button" class="btn" id="btn-parcelbased-freeform" hidden data-i18n-key="proposalDrafts.freeform.title" data-i18n-attr="text">Convert to freeform building</button>
                        <button type="button" class="btn btn-primary" id="btn-parcelbased-done" data-i18n-key="parcelBased.modal.done" data-i18n-attr="text">Done</button>
                    </div>
                </div>
            `;

            const content = container.querySelector('#parcelbased-sidebar');
            const footer = container.querySelector('#parcelbased-controls');
            footer?.classList.remove('cb-dialog__footer');
            parcelBasedModal = window.OnMapEditor?.open({
                owner: 'parcel-based',
                id: 'parcelbased',
                title: translateParcelBasedText('parcelBased.modal.title', 'Detached houses'),
                content,
                footer,
                modes: ['2d', 'model'],
                wide: false,
                onCancel: requestCloseParcelBasedModal
            });
            if (!parcelBasedModal) return false;
            parcelBasedMap = parcelBasedModal.map;
            setParcelBasedInfo('parcelBased.modal.generating', 'Generating buildings...');

            // Apply translations
            try {
                if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                    window.i18n.applyTranslations(parcelBasedModal.content);
                }
            } catch (_) { }

            parcelBasedDesignChanges().start(document);
            document.dispatchEvent(new CustomEvent('parcelBasedModalOpened'));
            document.dispatchEvent(new CustomEvent('urbanRuleModalOpened'));

            // Add event listeners
            const doneButton = document.getElementById('btn-parcelbased-done');
            if (doneButton) {
                doneButton.addEventListener('click', saveParcelBasedDesignForProposal);
                doneButton.disabled = true;
            }


            const regenerateButton = document.getElementById('btn-parcelbased-regenerate');
            if (regenerateButton) {
                regenerateButton.addEventListener('click', rerollParcelBasedBuildOut);
            }
            // One house on one parcel converts like a Freeform building (proposal-editor-shell.js).
            document.getElementById('btn-parcelbased-freeform')?.addEventListener('click', async () => {
                if (!parcelBasedConvertsToFreeform()) return;
                const result = await convertParcelBasedToFreeform(parcelBasedHouses(), true);
                if (!result.ok && !result.cancelled) setParcelBasedInfo('', result.reason || '');
            });

            const ruleTypeSelect = document.getElementById('parcelbased-ruletype-select');
            if (ruleTypeSelect) {
                ruleTypeSelect.addEventListener('change', function (e) {
                    currentRuleKind = e.target.value;
                    syncRuleKindControls();
                    generateBuildingsInModal();
                });
            }

            // Slider event listeners
            document.getElementById('parcelbased-maxfloors-slider').addEventListener('input', function (e) {
                currentMaxFloors = parseInt(e.target.value, 10);
                document.getElementById('parcelbased-maxfloors-value').textContent = currentMaxFloors.toString();
                syncRuleKindControls(); // the minimum rides on the ceiling
                generateBuildingsInModal();
            });

            document.getElementById('parcelbased-mindistance-slider').addEventListener('input', function (e) {
                currentMinDistance = parseFloat(e.target.value);
                document.getElementById('parcelbased-mindistance-value').textContent = CbFormat.formatNumber(currentMinDistance, { maxFractionDigits: 1, minFractionDigits: 1 });
                generateBuildingsInModal();
            });

            document.getElementById('parcelbased-minfloors-slider').addEventListener('input', function (e) {
                currentMinFloors = Math.min(parseInt(e.target.value, 10), currentMaxFloors);
                document.getElementById('parcelbased-minfloors-value').textContent = currentMinFloors.toString();
                generateBuildingsInModal();
            });

            document.getElementById('parcelbased-minfootprint-slider').addEventListener('input', function (e) {
                currentMinFootprintM2 = parseFloat(e.target.value);
                document.getElementById('parcelbased-minfootprint-value').textContent = currentMinFootprintM2.toString();
                generateBuildingsInModal();
            });

            document.getElementById('parcelbased-minplot-slider').addEventListener('input', function (e) {
                currentMinPlotAreaM2 = parseFloat(e.target.value);
                document.getElementById('parcelbased-minplot-value').textContent = currentMinPlotAreaM2.toString();
                generateBuildingsInModal();
            });

            // No outside-click close: a stray click on the backdrop would throw the design away.
            // The editor is left only via the X (discard, after confirming) or Done (save).

        }

        // Display the parcels on the map
        displayParcelsOnMap(block);

        // Reset parameters
        currentMaxFloors = DEFAULT_MAX_FLOORS;
        currentMinDistance = DEFAULT_MIN_DISTANCE;
        currentRuleKind = DEFAULT_RULE_KIND;
        currentMinFloors = DEFAULT_MIN_FLOORS;
        currentMinFootprintM2 = DEFAULT_MIN_FOOTPRINT_M2;
        currentMinPlotAreaM2 = DEFAULT_MIN_PLOT_AREA_M2;

        // Restore a saved design over the defaults (e.g. a copied proposal). Geometry here is a
        // pure function of (rule, seed), so restoring both reproduces the design exactly — houses
        // and all. A design saved without a seed has no build-out to reproduce, so it gets a fresh
        // one rather than silently redrawing a different street under the same name.
        const saved = parcelBasedSeedParameters;
        parcelBasedSeedParameters = null;
        currentVariationSeed = newVariationSeed();
        if (saved) {
            const rule = saved.rule || {};
            const restore = (value, apply) => {
                if (typeof value === 'number' && Number.isFinite(value)) apply(value);
            };
            restore(saved.maxFloors ?? rule.maxFloors, v => { currentMaxFloors = v; });
            restore(saved.minDistance ?? rule.minDistance, v => { currentMinDistance = v; });
            restore(rule.minFloors, v => { currentMinFloors = Math.max(1, v); });
            restore(rule.minFootprintAreaM2, v => { currentMinFootprintM2 = v; });
            restore(rule.minPlotAreaM2, v => { currentMinPlotAreaM2 = v; });
            if (Variation && Variation.RULE_KINDS.includes(rule.kind)) currentRuleKind = rule.kind;
            restore(saved.seed, v => { currentVariationSeed = v >>> 0; });
        }

        // Update sliders
        const setSlider = (id, value, text) => {
            const slider = document.getElementById(id + '-slider');
            const label = document.getElementById(id + '-value');
            if (slider) slider.value = value;
            if (label) label.textContent = text;
        };
        setSlider('parcelbased-maxfloors', currentMaxFloors, currentMaxFloors.toString());
        setSlider('parcelbased-mindistance', currentMinDistance, CbFormat.formatNumber(currentMinDistance, { maxFractionDigits: 1, minFractionDigits: 1 }));
        setSlider('parcelbased-minfloors', currentMinFloors, currentMinFloors.toString());
        setSlider('parcelbased-minfootprint', currentMinFootprintM2, currentMinFootprintM2.toString());
        setSlider('parcelbased-minplot', currentMinPlotAreaM2, currentMinPlotAreaM2.toString());
        const ruleTypeSelect = document.getElementById('parcelbased-ruletype-select');
        if (ruleTypeSelect) ruleTypeSelect.value = currentRuleKind;
        syncRuleKindControls();

        // Generate buildings immediately
        parcelBasedGenerationTimer = setTimeout(() => {
            parcelBasedGenerationTimer = null;
            if (!parcelBasedModal || parcelBasedBlock !== block) return;
            generateBuildingsInModal();
        }, 500);
        return true;
    }

    function displayParcelsOnMap(block) {
        // Clear existing layers
        if (parcelBasedParcelLayer) {
            parcelBasedMap.removeLayer(parcelBasedParcelLayer);
            parcelBasedParcelLayer = null;
        }

        // Create a feature collection for all parcels in the block
        const features = block.parcels.map(parcel => parcel.feature);
        const featureCollection = {
            type: 'FeatureCollection',
            features: features
        };
        try {
            parcelBasedBoundary = parcelBasedSiteFeature(features, block.site);
        } catch (error) {
            if (error && error.code === 'clip-failed' && typeof updateStatus === 'function') {
                console.error(`[${new Date().toISOString()}] [parcel-based] the selected parcels could not be merged into one site`, error);
                updateStatus(translateParcelBasedText('status.messages.parcels_could_not_be_merged',
                    'Could not merge the selected parcels into one site: {{reason}}', { reason: error.message }));
            }
            throw error;
        }

        // Add the parcels to the map with distinct styling to show borders
        parcelBasedParcelLayer = L.geoJSON(featureCollection, {
            pane: parcelBasedModal?.pane,
            style: {
                fillColor: '#f0f0f0',
                fillOpacity: 0.3,
                color: '#333',
                weight: 2,
                dashArray: '5, 5'
            }
        }).addTo(parcelBasedMap);

        parcelBasedModal?.fitFeature(parcelBasedBoundary || featureCollection, { maxZoom: 21 });
    }

    // The X / Esc path. Closing NEVER saves — only "Done" (saveParcelBasedDesignForProposal) does.
    // When the editor is running a commit-on-confirm session (a geometry edit, or a Build-palette
    // creation) the design would be lost, so ask first; declining keeps the editor open.
    // Did the user change the design since the editor opened? As in the Block editor
    // (building-blocks.js blockifyDesignChanges): the generated first design is not a change, and
    // a drop put back where it was leaves the design as it was, so closing then asks nothing.
    let parcelBasedDesignChangeTracker = null;
    function parcelBasedDesignChanges() {
        if (!parcelBasedDesignChangeTracker) {
            parcelBasedDesignChangeTracker = window.DesignChangeTracker.createDesignChangeTracker({
                signature: () => window.DesignChangeTracker.featuresSignature(generatedParcelBasedFeatures || [])
            });
        }
        return parcelBasedDesignChangeTracker;
    }

    async function requestCloseParcelBasedModal() {
        if (typeof window !== 'undefined' && typeof window.confirmDiscardProposalDesignSession === 'function') {
            const proceed = await window.confirmDiscardProposalDesignSession({
                hasDesign: Array.isArray(generatedParcelBasedFeatures) && generatedParcelBasedFeatures.length > 0
                    && parcelBasedDesignChanges().changed()
            });
            if (!proceed) return;
        }
        closeParcelBasedModal();
    }

    function closeParcelBasedModal(options = {}) {
        const { preservePending = false } = options;
        if (parcelBasedGenerationTimer !== null) {
            clearTimeout(parcelBasedGenerationTimer);
            parcelBasedGenerationTimer = null;
        }

        if (parcelBasedMap) {
            [parcelBasedParcelLayer].forEach(layer => {
                if (layer) { try { parcelBasedMap.removeLayer(layer); } catch (_) { } }
            });
            [parcelBasedEnvelopeLayers, parcelBasedBuildingLayers, parcelBasedExcludedLayers].forEach(layers => {
                layers.forEach(layer => { if (layer) { try { parcelBasedMap.removeLayer(layer); } catch (_) { } } });
            });
        }
        parcelBasedParcelLayer = null;
        parcelBasedEnvelopeLayers = [];
        parcelBasedBuildingLayers = [];
        parcelBasedExcludedLayers = [];
        parcelBasedBoundary = null;
        parcelBasedMap = null;
        if (parcelBasedDesignChangeTracker) parcelBasedDesignChangeTracker.stop();
        const editorSession = parcelBasedModal;
        parcelBasedModal = null;
        editorSession?.close();

        // Clear state
        generatedParcelBasedFeatures = [];
        parcelBasedBuildOut = [];
        parcelBasedBlock = null;
        parcelBasedBlockNameOverride = null;

        document.dispatchEvent(new CustomEvent('parcelBasedModalClosed'));
        document.dispatchEvent(new CustomEvent('urbanRuleModalClosed'));

        // Reset parameters to defaults
        currentMaxFloors = DEFAULT_MAX_FLOORS;
        currentMinDistance = DEFAULT_MIN_DISTANCE;
        currentRuleKind = DEFAULT_RULE_KIND;
        currentMinFloors = DEFAULT_MIN_FLOORS;
        currentMinFootprintM2 = DEFAULT_MIN_FOOTPRINT_M2;
        currentMinPlotAreaM2 = DEFAULT_MIN_PLOT_AREA_M2;

        if (!preservePending) {
            setPendingParcelBasedProposalContext(null);
            if (typeof window !== 'undefined') {
                window.pendingParcelBasedFromModal = null;
            }
        }
        if (typeof window !== 'undefined') {
            // Only "Done" commits — it tears down with preservePending after saving. Every other
            // close abandons the design session, leaving the edited object exactly as it was.
            if (!preservePending) window.discardProposalDraftDesignSession?.();
            window.finishProposalDraftDesignSession?.();
        }
    }

    // Save design for proposal
    function saveParcelBasedDesignForProposal() {
        if (!generatedParcelBasedFeatures || generatedParcelBasedFeatures.length === 0) {
            setParcelBasedInfo('parcelBased.modal.messages.generateBeforeFinishing', 'Generate buildings before finishing.');
            return;
        }

        const block = getActiveParcelBasedBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            setParcelBasedInfo('parcelBased.modal.messages.blockHasNoParcels', 'Block has no parcels.');
            return;
        }

        const parentDetails = [];
        const normalizedParcelIds = [];

        // Clear multi-selection if available
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
        }

        block.parcels.forEach(parcel => {
            const props = parcel?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(parcel?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id);
            if (!parcelId) return;
            const idStr = parcelId.toString();
            let number = idStr;
            try {
                if (parcel.feature?.properties?.BROJ_CESTICE) {
                    number = String(parcel.feature.properties.BROJ_CESTICE);
                }
            } catch (_) { }
            normalizedParcelIds.push(idStr);
            parentDetails.push({ id: idStr, number });
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection?.selectedParcels) {
                multiParcelSelection.selectedParcels.add(idStr);
            }
        });

        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.updateUI === 'function') {
            multiParcelSelection.updateUI();
        }

        if (!normalizedParcelIds.length) {
            setParcelBasedInfo('parcelBased.modal.messages.unableToMapParcels', 'Unable to map parcels for this block.');
            return;
        }

        const clonedFeatures = JSON.parse(JSON.stringify(generatedParcelBasedFeatures));
        const context = {
            parcelIds: normalizedParcelIds.slice(),
            parentDetails: parentDetails.slice(),
            blockName: getParcelBasedDisplayName(),
            parameters: parcelBasedDesignParameters(),
            buildings: clonedFeatures,
            buildingFeature: clonedFeatures[0] || null
        };

        window.pendingParcelBasedFromModal = clonedFeatures;
        window.pendingBuildingFromBlockify = clonedFeatures; // For compatibility with proposal creation
        setPendingParcelBasedProposalContext(context);

        // Also set the building context for existing proposal creation flow
        if (typeof setPendingBuildingProposalContext === 'function') {
            setPendingBuildingProposalContext(context);
        } else if (typeof window !== 'undefined') {
            window.pendingBuildingProposalContext = context;
        }

        closeParcelBasedModal({ preservePending: true });

        if (typeof updateStatus === 'function') {
            updateStatus('Parcel-based buildings saved. Add proposal details to submit.');
        }

        const description = document.getElementById('proposalDescription');
        if (description) {
            if (!description.value.trim()) {
                description.value = translateParcelBasedText(
                    'parcelBased.modal.messages.defaultProposalDescription',
                    'Parcel-based proposal for {{blockName}}',
                    { blockName: context.blockName || 'selected parcels' }
                );
            }
            description.focus();
        }
    }

    // Entry point for opening parcel-based modal from parcels. `initialParameters` (optional)
    // reopens the editor on a previously-saved design — used by "Copy into new proposal".
    function openParcelBasedForParcels({ blockName, parcelIds, initialParameters = null, site = null }) {
        parcelBasedSeedParameters = initialParameters || null;
        const ids = Array.from(new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean)));
        if (!ids.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Select parcels before launching the parcel-based tool.');
            }
            return false;
        }

        const liveParcels = parcelBasedParcelsForIds(ids);
        if (liveParcels.length !== ids.length) {
            if (typeof updateStatus === 'function') {
                updateStatus(translateParcelBasedText('status.messages.could_not_resolve_parcel_data_for_the_selected_parcels', 'Could not resolve parcel data for the selected parcels.'));
            }
            return false;
        }

        parcelBasedBlock = {
            parcels: liveParcels,
            parcelIds: ids,
            site: site?.geometry ? {
                type: 'Feature',
                properties: { ...(site.properties || {}) },
                geometry: JSON.parse(JSON.stringify(site.geometry))
            } : null,
            valid: true,
            polygon: null
        };
        parcelBasedBlockNameOverride = blockName || describeParcelBasedParcelSelection(ids);
        return showParcelBasedModal() === true;
    }

    // Export to window
    if (typeof window !== 'undefined') {
        window.openParcelBasedForParcels = openParcelBasedForParcels;
        window.closeParcelBasedModal = closeParcelBasedModal;
    }

})();
