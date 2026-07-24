// Placeable transit stations and their applied 2D presentation.
(function (root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TransitStations = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const STORAGE_KEY = 'cb_transit_stations';
    const PANE = 'transitStationsPane';
    const HIT_PANE = 'transitStationHitPane';
    const ICON_PANE = 'transitStationIconsPane';
    const ALIGNMENT_PANE = 'transitStationAlignmentsPane';
    const SNAP_RADIUS_M = 24;
    const VALID_PREVIEW_COLOR = '#16a34a';
    const INVALID_PREVIEW_COLOR = '#dc2626';
    const COLORS = Object.freeze({
        bus: '#2563eb',
        tram: '#0f766e',
        underground: '#1d4ed8',
        elevated: '#b45309'
    });

    let stationLayer = null;
    let placement = null;
    let stationEditor = null;

    global.transitStations = Array.isArray(global.transitStations) ? global.transitStations : [];
    global.transitStationPlacementMode = false;
    global.transitStationGeometryEditorActive = false;

    function isTransitStationPlacementActive() {
        return !!placement;
    }

    function models() {
        return global.TransitStationModels || null;
    }

    function normalizeType(value) {
        const library = models();
        if (library && typeof library.normalizeType === 'function') return library.normalizeType(value);
        const key = String(value || '').trim().toLowerCase();
        return ['bus', 'tram', 'underground', 'elevated'].includes(key) ? key : null;
    }

    function specFor(type) {
        const key = normalizeType(type);
        const library = models();
        if (library && typeof library.specFor === 'function') return library.specFor(key);
        const fallback = {
            bus: { key: 'bus', label: 'Bus station', icon: 'B', footprintWidthM: 5, footprintLengthM: 18, level: 0 },
            tram: { key: 'tram', label: 'Tram station', icon: 'T', footprintWidthM: 5, footprintLengthM: 18, level: 0 },
            underground: { key: 'underground', label: 'Underground station', icon: 'M', footprintWidthM: 32, footprintLengthM: 68, level: -1 },
            elevated: {
                key: 'elevated', label: 'Elevated train station', icon: 'E', footprintWidthM: 24,
                footprintLengthM: 30, level: 1, defaultPlatformHeightM: 10,
                minPlatformHeightM: 3, maxPlatformHeightM: 40
            }
        };
        return fallback[key] || null;
    }

    function clone(value) {
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function coordinate(value) {
        if (Array.isArray(value) && value.length >= 2) {
            const lng = Number(value[0]);
            const lat = Number(value[1]);
            return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
        }
        const lat = Number(value?.lat);
        const lng = Number(value?.lng ?? value?.lon);
        return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }

    function destination(api, origin, distanceM, bearing) {
        if (Math.abs(distanceM) < 1e-9) return origin.slice();
        const direction = distanceM < 0 ? bearing + 180 : bearing;
        return api.destination(api.point(origin), Math.abs(distanceM) / 1000, direction, { units: 'kilometers' }).geometry.coordinates;
    }

    function offsetCoordinate(api, center, forwardM, rightM, bearing) {
        const forward = destination(api, center, forwardM, bearing);
        return destination(api, forward, rightM, bearing + 90);
    }

    function createOrientedRectangle(center, bearing, widthM, lengthM, forwardM, rightM, api) {
        const rectangleCenter = offsetCoordinate(api, center, forwardM || 0, rightM || 0, bearing);
        const halfLength = lengthM * 0.5;
        const halfWidth = widthM * 0.5;
        const ring = [
            offsetCoordinate(api, rectangleCenter, halfLength, -halfWidth, bearing),
            offsetCoordinate(api, rectangleCenter, halfLength, halfWidth, bearing),
            offsetCoordinate(api, rectangleCenter, -halfLength, halfWidth, bearing),
            offsetCoordinate(api, rectangleCenter, -halfLength, -halfWidth, bearing)
        ];
        ring.push(ring[0].slice());
        return { type: 'Polygon', coordinates: [ring] };
    }

    function createStationFootprint(centerValue, bearingValue, typeValue, turfApi) {
        const api = turfApi || global.turf;
        const center = coordinate(centerValue);
        const spec = specFor(typeValue);
        if (!api || !center || !spec) return null;
        const bearing = Number.isFinite(Number(bearingValue)) ? Number(bearingValue) : 0;
        return createOrientedRectangle(center, bearing, spec.footprintWidthM, spec.footprintLengthM, 0, 0, api);
    }

    function stationFeature(station) {
        if (!station || !station.geometry) return null;
        return station.type === 'Feature'
            ? station
            : { type: 'Feature', properties: station.properties || {}, geometry: station.geometry };
    }

    function stationCenter(station) {
        const props = station?.properties || {};
        const stored = coordinate(props.center || props.coordinate || props.location);
        if (stored) return stored;
        try {
            const feature = stationFeature(station);
            return global.turf?.centroid(feature)?.geometry?.coordinates || null;
        } catch (_) { return null; }
    }

    function stationBearing(station) {
        const value = Number(station?.properties?.bearing ?? station?.properties?.orientation);
        return Number.isFinite(value) ? value : 0;
    }

    function stationType(station) {
        return normalizeType(station?.properties?.stationType || station?.properties?.transitStationType);
    }

    // The underground hall stays covered. Only its two stair wells and lift shaft punch through
    // the parcel ground in 3D, mirroring the narrow entrance cut-outs in Zagreb Isochrone.
    function stationSurfaceCutouts(station, turfApi) {
        const api = turfApi || global.turf;
        const center = stationCenter(station);
        if (!api || !center || stationType(station) !== 'underground') return [];
        const bearing = stationBearing(station);
        return [
            // Shared model coordinates use +X to the model's right; the scene adapter mirrors X,
            // hence the opposite geographic-right signs here.
            createOrientedRectangle(center, bearing, 3.5, 9, -17, 11, api),
            createOrientedRectangle(center, bearing, 3.5, 9, 17, -11, api),
            createOrientedRectangle(center, bearing, 2.8, 2.8, 15, -13.8, api)
        ];
    }

    function ensurePane(name, zIndex) {
        if (!global.map?.getPane || !global.map?.createPane) return null;
        let pane = global.map.getPane(name);
        if (!pane) pane = global.map.createPane(name);
        if (pane?.style) pane.style.zIndex = String(zIndex);
        return pane;
    }

    function markerIcon(type, preview, valid) {
        const spec = specFor(type);
        const color = COLORS[type] || '#334155';
        const borderColor = preview
            ? (valid ? VALID_PREVIEW_COLOR : INVALID_PREVIEW_COLOR)
            : '#ffffff';
        return global.L.divIcon({
            className: `transit-station-marker${preview ? ' transit-station-marker--preview' : ''}`,
            html: `<span style="display:flex;width:30px;height:30px;border-radius:50%;align-items:center;justify-content:center;background:${color};color:white;border:4px solid ${borderColor};box-shadow:0 1px 5px rgba(15,23,42,.55);font:700 15px/1 sans-serif;">${spec?.icon || 'S'}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });
    }

    function selectStationProposal(station) {
        const proposalId = station?.properties?.proposalId;
        if (!proposalId) return false;
        try {
            try { global.hideParcelInfoPanel?.(); } catch (_) { }
            if (typeof global.selectAndHighlightProposal === 'function') {
                global.__openProposalDetailsCollapsed = true;
                global.selectAndHighlightProposal(String(proposalId), station?.properties?.parentParcelIds?.[0] || null, false, true);
                return true;
            } else if (typeof global.showProposalDetails === 'function') {
                global.showProposalDetails(String(proposalId));
                return true;
            }
        } catch (_) { }
        return false;
    }

    function stationClickBelongsToActiveMapTool() {
        return global.roadDrawingMode === true
            || global.transitStationPlacementMode === true
            || (typeof global.isTransitStationPlacementActive === 'function' && global.isTransitStationPlacementActive())
            || (typeof global.isStructureGeometryEditorActive === 'function' && global.isStructureGeometryEditorActive())
            || (typeof global.isTransitStationGeometryEditorActive === 'function' && global.isTransitStationGeometryEditorActive())
            || global.areaMonitorDrawingMode === true
            || (typeof global.isAreaMonitorDrawingActive === 'function' && global.isAreaMonitorDrawingActive());
    }

    function stopStationClick(event) {
        const originalEvent = event?.originalEvent || event;
        try { global.L?.DomEvent?.stop?.(originalEvent); } catch (_) { }
        try { global.L?.DomEvent?.stopPropagation?.(originalEvent); } catch (_) { }
        try { originalEvent?.preventDefault?.(); } catch (_) { }
        try { originalEvent?.stopPropagation?.(); } catch (_) { }
        try { originalEvent?.stopImmediatePropagation?.(); } catch (_) { }
        if (event) event._stopped = true;
    }

    function forwardStationClick(station, event) {
        stopStationClick(event);
        // Applied stations sit above corridor and parcel hit surfaces. Drawing/editing tools still
        // own the map while active, so forward the coordinate instead of changing selection.
        if (stationClickBelongsToActiveMapTool()) {
            try {
                if (event?.latlng && global.map?.fire) {
                    global.map.fire('click', {
                        latlng: event.latlng,
                        layerPoint: event.layerPoint,
                        containerPoint: event.containerPoint,
                        originalEvent: event.originalEvent
                    });
                }
            } catch (_) { }
            return false;
        }
        return selectStationProposal(station);
    }

    function updateTransitStationsLayer() {
        if (!global.map || !global.L) return;
        ensurePane(PANE, 634);
        // Above ordinary proposal/corridor hit targets (<= 656), but below active draft tools
        // (674+). This makes the whole applied station reliably clickable without blocking edits.
        ensurePane(HIT_PANE, 664);
        ensurePane(ICON_PANE, 666);
        if (!stationLayer) stationLayer = global.L.featureGroup().addTo(global.map);
        stationLayer.clearLayers();
        for (const station of global.transitStations || []) {
            const editingProposalId = stationEditor?.sourceProposalId;
            if (editingProposalId && String(station?.properties?.proposalId || '') === String(editingProposalId)) continue;
            const feature = stationFeature(station);
            const type = stationType(station);
            const center = stationCenter(station);
            if (!feature?.geometry || !type || !center) continue;
            const color = COLORS[type] || '#334155';
            try {
                global.L.geoJSON(feature, {
                    pane: PANE,
                    interactive: false,
                    style: { color, weight: 2.5, fillColor: color, fillOpacity: 0.16, dashArray: '7 4' }
                }).addTo(stationLayer);
                // The visual outline stays in its normal pane. A separate invisible filled path
                // owns every point inside the footprint, including areas over roads/parcels.
                global.L.geoJSON(feature, {
                    pane: HIT_PANE,
                    interactive: true,
                    bubblingMouseEvents: false,
                    className: 'transit-station-hit-target',
                    style: {
                        color: '#000000',
                        weight: 0,
                        opacity: 0,
                        fill: true,
                        fillColor: '#000000',
                        fillOpacity: 0.001
                    }
                }).on('click', event => forwardStationClick(station, event)).addTo(stationLayer);
                const marker = global.L.marker([center[1], center[0]], {
                    pane: ICON_PANE,
                    icon: markerIcon(type, false),
                    title: station?.properties?.name || specFor(type)?.label || 'Station',
                    interactive: true,
                    keyboard: true,
                    bubblingMouseEvents: false
                });
                marker.on('click', event => forwardStationClick(station, event));
                marker.addTo(stationLayer);
            } catch (error) {
                console.warn('[transit-stations] failed to render station', error);
            }
        }
        global.transitStationsLayerRef = stationLayer;
        try { global.dispatchEvent(new global.Event('stationsUpdated')); } catch (_) { }
    }

    function saveStations() {
        try { global.PersistentStorage?.setItem(STORAGE_KEY, JSON.stringify(global.transitStations || [])); } catch (error) {
            console.warn('[transit-stations] failed to persist stations', error);
        }
    }

    function loadStations() {
        try {
            const raw = global.PersistentStorage?.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                global.transitStations = parsed.filter(entry => stationFeature(entry)?.geometry && stationType(entry));
            }
        } catch (error) {
            console.warn('[transit-stations] failed to load stations', error);
        }
    }

    function upsertStation(station) {
        const feature = stationFeature(station);
        if (!feature) return false;
        const proposalId = feature?.properties?.proposalId;
        if (proposalId !== undefined && proposalId !== null) {
            global.transitStations = (global.transitStations || []).filter(entry => String(entry?.properties?.proposalId || '') !== String(proposalId));
        }
        global.transitStations.push(clone(feature));
        saveStations();
        updateTransitStationsLayer();
        return true;
    }

    function removeStationByProposalId(proposalId) {
        const key = String(proposalId ?? '');
        const before = (global.transitStations || []).length;
        global.transitStations = (global.transitStations || []).filter(entry => String(entry?.properties?.proposalId || '') !== key);
        if (global.transitStations.length === before) return false;
        saveStations();
        updateTransitStationsLayer();
        return true;
    }

    function pointFromDefinition(value) {
        const c = coordinate(value);
        return c ? c : null;
    }

    function normalizeBearing(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 0;
        return ((number % 360) + 360) % 360;
    }

    function centerlineSegments(definition) {
        const raw = definition?.centerline || definition?.points || definition?.segments || [];
        const candidates = Array.isArray(raw?.[0]) ? raw : (raw.length ? [raw] : []);
        return candidates
            .map(segment => (segment || []).map(pointFromDefinition).filter(Boolean))
            .filter(segment => segment.length >= 2);
    }

    function corridorEntryRecords(definition) {
        if (!definition) return [];
        try {
            if (typeof global.corridorSegmentEntries === 'function') {
                const entries = global.corridorSegmentEntries(definition) || [];
                if (entries.length) {
                    return entries.map(entry => ({
                        points: (entry.points || []).map(pointFromDefinition).filter(Boolean),
                        profile: entry.profile || null,
                        width: Number(entry.width) || Number(definition.width) || 10,
                        segmentId: entry.segmentId ?? null
                    })).filter(entry => entry.points.length >= 2);
                }
            }
        } catch (_) { }
        const segments = centerlineSegments(definition);
        const segmentIds = Array.isArray(definition.segmentIds) ? definition.segmentIds : [];
        return segments.map((points, index) => {
            const segmentId = segmentIds[index] === undefined || segmentIds[index] === null
                ? null
                : String(segmentIds[index]);
            const profile = (segmentId && definition.segmentProfiles?.[segmentId]) || definition.profile || null;
            const profileWidth = Array.isArray(profile?.strips)
                ? profile.strips.reduce((sum, strip) => sum + (Number(strip?.width) || 0), 0)
                : 0;
            return {
                points,
                profile,
                width: profileWidth || Number(definition.width) || 10,
                segmentId
            };
        });
    }

    function profileStripTypes(profile) {
        const strips = Array.isArray(profile?.strips) ? profile.strips : (Array.isArray(profile) ? profile : []);
        return strips.map(strip => String(strip?.type || '').trim().toLowerCase()).filter(Boolean);
    }

    function corridorEntrySupportsStation(definition, entry, typeValue) {
        const type = normalizeType(typeValue);
        if (!type) return true;
        const stripTypes = profileStripTypes(entry?.profile);
        const legacyTrack = definition?.metadata?.isTrack === true
            || (!stripTypes.length && typeof global.corridorIsTrack === 'function' && global.corridorIsTrack(definition));
        if (type === 'bus') {
            // A mixed tram street can host both kinds of stop. A rail-only corridor cannot host a bus.
            if (stripTypes.length) return stripTypes.includes('driving') || stripTypes.includes('bus');
            return !legacyTrack;
        }
        return stripTypes.includes('rail') || legacyTrack;
    }

    function isAppliedProposal(proposal) {
        try {
            if (typeof global.isProposalApplied === 'function') return global.isProposalApplied(proposal);
            if (typeof global.isApplied === 'function') return global.isApplied(proposal, proposal?.roadProposal);
        } catch (_) { }
        return proposal?.applied === true || proposal?.roadProposal?.applied === true;
    }

    function referenceEntrySupportsStation(entry, typeValue) {
        const type = normalizeType(typeValue);
        if (!type || type === 'bus') return false;
        const supported = Array.isArray(entry?.stationTypes)
            ? entry.stationTypes.map(value => String(value || '').trim().toLowerCase())
            : [];
        return supported.includes(type);
    }

    function compatibleReferenceAlignments(typeValue, records) {
        return (records || []).filter(entry => referenceEntrySupportsStation(entry, typeValue));
    }

    function compatibleProposalAlignments(typeValue, proposals) {
        const type = normalizeType(typeValue);
        const entries = [];
        for (const proposal of proposals || []) {
            if (!proposal?.roadProposal || !isAppliedProposal(proposal)) continue;
            const definition = proposal.roadProposal.definition || proposal.definition;
            for (const entry of corridorEntryRecords(definition)) {
                if (!corridorEntrySupportsStation(definition, entry, type)) continue;
                entries.push({
                    sourceKind: 'proposal',
                    sourceId: proposal.proposalId || proposal.id || null,
                    featureId: null,
                    mode: type === 'bus' ? 'road' : 'proposal-rail',
                    stationTypes: type ? [type] : [],
                    points: entry.points,
                    segmentId: entry.segmentId
                });
            }
        }
        return entries;
    }

    function nearestCorridorAlignment(latlng, maxDistanceM, turfApi, proposals, stationTypeValue, referenceAlignments) {
        const api = turfApi || global.turf;
        const clicked = coordinate(latlng);
        if (!api || !clicked) return null;
        const type = normalizeType(stationTypeValue);
        let records = proposals;
        if (!Array.isArray(records)) {
            try { records = global.proposalStorage?.getAllProposals?.() || []; } catch (_) { records = []; }
        }
        let best = null;
        for (const proposal of records || []) {
            if (!proposal?.roadProposal || !isAppliedProposal(proposal)) continue;
            const definition = proposal.roadProposal.definition || proposal.definition;
            for (const entry of corridorEntryRecords(definition)) {
                if (!corridorEntrySupportsStation(definition, entry, type)) continue;
                const coordinates = entry.points;
                try {
                    const line = api.lineString(coordinates);
                    const snapped = api.nearestPointOnLine(line, api.point(clicked), { units: 'kilometers' });
                    const distanceM = Number(snapped?.properties?.dist) * 1000;
                    if (!Number.isFinite(distanceM) || distanceM > (maxDistanceM || SNAP_RADIUS_M)) continue;
                    const index = Math.min(coordinates.length - 2, Math.max(0, Number(snapped?.properties?.index) || 0));
                    let bearing = normalizeBearing(api.bearing(api.point(coordinates[index]), api.point(coordinates[index + 1])));
                    const centerlineCenter = snapped.geometry.coordinates.slice();
                    let center = centerlineCenter.slice();
                    let side = null;
                    if (type === 'bus') {
                        const spec = specFor(type);
                        const roadsideOffsetM = Math.max(0, Number(entry.width) || 0) * 0.5
                            + Math.max(0, Number(spec?.footprintWidthM) || 0) * 0.5
                            + 0.5;
                        const right = destination(api, centerlineCenter, roadsideOffsetM, bearing + 90);
                        const left = destination(api, centerlineCenter, roadsideOffsetM, bearing - 90);
                        const rightDistance = api.distance(api.point(clicked), api.point(right), { units: 'meters' });
                        const leftDistance = api.distance(api.point(clicked), api.point(left), { units: 'meters' });
                        if (leftDistance < rightDistance) {
                            center = left;
                            side = 'left';
                            // Croatia drives on the right: the opposite roadside serves the opposite direction.
                            bearing = normalizeBearing(bearing + 180);
                        } else {
                            center = right;
                            side = 'right';
                        }
                    }
                    if (!best || distanceM < best.distanceM) {
                        best = {
                            center,
                            centerlineCenter,
                            bearing,
                            distanceM,
                            sourceKind: 'proposal',
                            sourceId: proposal.proposalId || proposal.id || null,
                            featureId: null,
                            proposalId: proposal.proposalId || proposal.id || null,
                            segmentId: entry.segmentId,
                            lineSegmentIndex: index,
                            measureM: Number.isFinite(Number(snapped?.properties?.location))
                                ? Number(snapped.properties.location) * 1000
                                : null,
                            corridorWidthM: Number(entry.width) || Number(definition?.width) || 10,
                            alignmentKind: type === 'bus' ? 'roadside' : (type ? 'rail' : 'corridor'),
                            side,
                            mode: type === 'bus' ? 'road' : 'proposal-rail',
                            elevationM: null
                        };
                    }
                } catch (_) { }
            }
        }
        let references = referenceAlignments;
        if (!Array.isArray(references)) {
            try {
                references = global.TransitAlignments?.queryNearby?.(clicked, maxDistanceM || SNAP_RADIUS_M)
                    || global.TransitAlignments?.getRecords?.()
                    || [];
            } catch (_) { references = []; }
        }
        for (const entry of references || []) {
            if (!referenceEntrySupportsStation(entry, type)) continue;
            const coordinates = (entry.points || []).map(pointFromDefinition).filter(Boolean);
            if (coordinates.length < 2) continue;
            try {
                const line = api.lineString(coordinates);
                const snapped = api.nearestPointOnLine(line, api.point(clicked), { units: 'kilometers' });
                const distanceM = Number(snapped?.properties?.dist) * 1000;
                if (!Number.isFinite(distanceM) || distanceM > (maxDistanceM || SNAP_RADIUS_M)) continue;
                if (best && distanceM >= best.distanceM) continue;
                const index = Math.min(coordinates.length - 2, Math.max(0, Number(snapped?.properties?.index) || 0));
                best = {
                    center: snapped.geometry.coordinates.slice(),
                    centerlineCenter: snapped.geometry.coordinates.slice(),
                    bearing: normalizeBearing(api.bearing(api.point(coordinates[index]), api.point(coordinates[index + 1]))),
                    distanceM,
                    sourceKind: 'reference',
                    sourceId: entry.sourceId || null,
                    featureId: entry.featureId || null,
                    proposalId: null,
                    segmentId: null,
                    lineSegmentIndex: index,
                    measureM: Number.isFinite(Number(snapped?.properties?.location))
                        ? Number(snapped.properties.location) * 1000
                        : null,
                    corridorWidthM: null,
                    alignmentKind: 'rail',
                    side: null,
                    mode: entry.mode || 'rail',
                    elevationM: Number.isFinite(Number(entry.elevationM)) ? Number(entry.elevationM) : 0
                };
            } catch (_) { }
        }
        return best;
    }

    function placementUpdateFromAlignment(typeValue, snap, currentPlatformHeightM) {
        const type = normalizeType(typeValue);
        if (!type || !snap?.center) return null;
        const referenceElevation = snap.sourceKind === 'reference' && Number.isFinite(Number(snap.elevationM))
            ? Number(snap.elevationM)
            : null;
        return {
            center: snap.center.slice(),
            bearing: normalizeBearing(snap.bearing),
            platformHeightM: type === 'elevated'
                ? normalizePlatformHeight(referenceElevation ?? currentPlatformHeightM, type)
                : undefined,
            alignment: {
                kind: snap.alignmentKind,
                sourceKind: snap.sourceKind || 'proposal',
                sourceId: snap.sourceId || snap.proposalId || null,
                featureId: snap.featureId || null,
                proposalId: snap.proposalId || null,
                segmentId: snap.segmentId,
                lineSegmentIndex: Number.isFinite(Number(snap.lineSegmentIndex)) ? Number(snap.lineSegmentIndex) : null,
                measureM: Number.isFinite(Number(snap.measureM)) ? Number(snap.measureM) : null,
                snapDistanceM: Number.isFinite(Number(snap.distanceM)) ? Number(snap.distanceM) : null,
                side: snap.side,
                mode: snap.mode || null,
                elevationM: referenceElevation,
                corridorWidthM: snap.corridorWidthM,
                centerlineCenter: snap.centerlineCenter
            }
        };
    }

    function resolvePlacementPreview(typeValue, cursorValue, options = {}) {
        const type = normalizeType(typeValue);
        const api = options.turfApi || global.turf;
        const cursor = coordinate(cursorValue);
        if (!type || !api || !cursor) return null;
        const snap = nearestCorridorAlignment(
            cursor,
            Number(options.maxDistanceM) || SNAP_RADIUS_M,
            api,
            options.proposals,
            type,
            options.referenceAlignments
        );
        const aligned = !!snap;
        const update = snap
            ? placementUpdateFromAlignment(type, snap, options.currentPlatformHeightM)
            : null;
        const center = update?.center || cursor.slice();
        const bearing = update?.bearing ?? normalizeBearing(options.currentBearing);
        const geometry = createStationFootprint(center, bearing, type, api);
        // Off-alignment cursor movement is the common case. Do not run parcel intersection
        // checks until there is a compatible snap candidate.
        const parentParcelIds = geometry && aligned
            ? findStationParentParcelIds(geometry, api, options.parcelEntries)
            : [];
        const valid = aligned && parentParcelIds.length > 0;
        return {
            cursor: cursor.slice(),
            center,
            bearing,
            platformHeightM: update?.platformHeightM ?? options.currentPlatformHeightM,
            alignment: update?.alignment || null,
            geometry,
            parentParcelIds,
            aligned,
            valid,
            reason: !aligned ? 'no-alignment' : (parentParcelIds.length ? null : 'no-loaded-parcel')
        };
    }

    function parcelIdForFeature(feature, fallback) {
        try {
            if (typeof global.ensureParcelId === 'function') return String(global.ensureParcelId(feature));
        } catch (_) { }
        const props = feature?.properties || {};
        const value = props.parcelId ?? props.parcel_id ?? props.id ?? fallback;
        return value === undefined || value === null ? null : String(value);
    }

    function collectLoadedParcelEntries() {
        const entries = [];
        const seen = new Set();
        const addEntry = (id, feature) => {
            if (!id || seen.has(id) || !feature?.geometry) return;
            seen.add(id);
            let bounds = null;
            try { bounds = global.turf?.bbox?.(feature) || null; } catch (_) { }
            entries.push({ id, feature, bounds });
        };
        if (global.parcelLayerById instanceof Map) {
            for (const [id, layer] of global.parcelLayerById.entries()) {
                const feature = layer?.feature || layer;
                const key = parcelIdForFeature(feature, id);
                addEntry(key, feature);
            }
        }
        try {
            global.parcelLayer?.getLayers?.().forEach(layer => {
                const feature = layer?.feature;
                const key = parcelIdForFeature(feature);
                addEntry(key, feature);
            });
        } catch (_) { }
        return entries;
    }

    function boundsIntersect(a, b) {
        return Array.isArray(a) && a.length >= 4 && Array.isArray(b) && b.length >= 4
            ? a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3]
            : true;
    }

    function findStationParentParcelIds(geometry, turfApi, entries) {
        const api = turfApi || global.turf;
        if (!api || !geometry) return [];
        const footprint = geometry.type === 'Feature' ? geometry : api.feature(geometry);
        const source = Array.isArray(entries) ? entries : collectLoadedParcelEntries();
        let footprintBounds = null;
        try { footprintBounds = api.bbox(footprint); } catch (_) { }
        return source.filter(entry => {
            let entryBounds = entry?.bounds || null;
            if (!entryBounds) {
                try { entryBounds = api.bbox(entry.feature); } catch (_) { }
            }
            if (!boundsIntersect(footprintBounds, entryBounds)) return false;
            try { return api.booleanIntersects(footprint, entry.feature); } catch (_) { return false; }
        }).map(entry => String(entry.id));
    }

    const STATION_EDITOR_PANE = 'transitStationEditorPane';

    function stationEditorText(key, fallback, params = {}) {
        const fullKey = `stationEditor.${key}`;
        try {
            const translated = global.i18n?.t?.(fullKey, params);
            if (translated && translated !== fullKey) return translated;
        } catch (_) { }
        return fallback;
    }

    function platformHeightBounds(typeValue) {
        const spec = specFor(typeValue) || {};
        return {
            min: Number.isFinite(Number(spec.minPlatformHeightM)) ? Number(spec.minPlatformHeightM) : 3,
            max: Number.isFinite(Number(spec.maxPlatformHeightM)) ? Number(spec.maxPlatformHeightM) : 40,
            defaultValue: Number.isFinite(Number(spec.defaultPlatformHeightM)) ? Number(spec.defaultPlatformHeightM) : 10
        };
    }

    function normalizePlatformHeight(value, typeValue) {
        if (normalizeType(typeValue) !== 'elevated') return undefined;
        const bounds = platformHeightBounds(typeValue);
        const number = Number(value);
        const finite = Number.isFinite(number) ? number : bounds.defaultValue;
        return Math.min(bounds.max, Math.max(bounds.min, finite));
    }

    function buildEditedStationStructure(structureValue, changes = {}, turfApi, parcelEntries) {
        const current = clone(structureValue || {});
        const type = normalizeType(current.stationType);
        const center = coordinate(current.center);
        if (!type || !center) return null;
        const bearing = normalizeBearing(changes.bearing ?? current.bearing);
        const geometry = createStationFootprint(center, bearing, type, turfApi);
        if (!geometry) return null;
        const geometryChanged = JSON.stringify(current.geometry || null) !== JSON.stringify(geometry);
        const next = {
            ...current,
            kind: 'station',
            stationType: type,
            center: center.slice(),
            bearing,
            geometry: clone(geometry),
            modelVersion: models()?.MODEL_VERSION || current.modelVersion || 1
        };
        if (type === 'elevated') {
            next.platformHeightM = normalizePlatformHeight(changes.platformHeightM ?? current.platformHeightM, type);
        } else {
            delete next.platformHeightM;
        }
        if (geometryChanged) {
            // A rotated footprint may hit a different building. Never carry the old impact scan
            // into the replacement proposal as though it still described the new geometry.
            next.demolishedBuildings = null;
            next.demolitionScanned = false;
        }
        const parentParcelIds = findStationParentParcelIds(geometry, turfApi, parcelEntries);
        if (parentParcelIds.length) next.parentParcelIds = parentParcelIds;
        return next;
    }

    function ensureStationEditorPane() {
        if (!global.map?.getPane) return;
        let pane = global.map.getPane(STATION_EDITOR_PANE);
        if (!pane && global.map.createPane) pane = global.map.createPane(STATION_EDITOR_PANE);
        if (pane?.style) pane.style.zIndex = '656';
    }

    function ensureStationEditorPanel() {
        if (stationEditor?.panel || !global.document?.body) return stationEditor?.panel || null;
        const panel = global.document.createElement('section');
        panel.className = 'station-geometry-editor';
        panel.setAttribute('aria-label', stationEditorText('ariaLabel', 'Station geometry editor'));
        global.document.body.appendChild(panel);
        stationEditor.panel = panel;
        return panel;
    }

    function stationEditorMarkup() {
        const type = stationEditor?.type;
        const spec = specFor(type);
        const bounds = platformHeightBounds(type);
        const heightControl = type === 'elevated' ? `
            <label class="station-editor-field">
                <span>${stationEditorText('platformHeight', 'Platform height above ground')}</span>
                <span class="station-editor-input-with-unit"><input type="number" data-station-editor-height min="${bounds.min}" max="${bounds.max}" step="0.5" value="${stationEditor.platformHeightM}"><span>m</span></span>
            </label>` : '';
        return `
            <header>
                <div><strong>${stationEditorText('title', 'Edit station geometry')}</strong><small>${spec?.label || stationEditorText('station', 'Station')}</small></div>
                <button type="button" data-station-editor-action="cancel" aria-label="${stationEditorText('close', 'Close')}">×</button>
            </header>
            <div class="station-editor-body">
                <p>${stationEditorText('fixedPosition', 'The station centre stays fixed. Rotate the station around it.')}</p>
                <label class="station-editor-field station-editor-bearing">
                    <span>${stationEditorText('rotation', 'Rotation')}</span>
                    <input type="range" data-station-editor-bearing-range min="0" max="359" step="1" value="${stationEditor.bearing}">
                    <span class="station-editor-input-with-unit"><input type="number" data-station-editor-bearing min="0" max="359" step="1" value="${stationEditor.bearing}"><span>°</span></span>
                </label>
                ${heightControl}
            </div>
            <footer>
                <span>${stationEditorText('hint', 'The map preview updates while you edit.')}</span>
                <div><button type="button" data-station-editor-action="cancel">${stationEditorText('cancel', 'Cancel')}</button><button type="button" class="is-primary" data-station-editor-action="save">${stationEditorText('save', 'Done')}</button></div>
            </footer>`;
    }

    function renderStationEditorPreview() {
        if (!stationEditor?.layer || !global.map || !global.L) return;
        stationEditor.layer.clearLayers();
        const geometry = createStationFootprint(stationEditor.center, stationEditor.bearing, stationEditor.type);
        if (!geometry) return;
        const color = COLORS[stationEditor.type] || '#334155';
        global.L.geoJSON({ type: 'Feature', properties: {}, geometry }, {
            pane: STATION_EDITOR_PANE,
            interactive: false,
            style: { color, weight: 3, fillColor: color, fillOpacity: 0.25, dashArray: '8 5' }
        }).addTo(stationEditor.layer);
        const directionEnd = offsetCoordinate(
            global.turf,
            stationEditor.center,
            Math.max(6, Number(specFor(stationEditor.type)?.footprintLengthM) * 0.55),
            0,
            stationEditor.bearing
        );
        global.L.polyline([
            [stationEditor.center[1], stationEditor.center[0]],
            [directionEnd[1], directionEnd[0]]
        ], {
            pane: STATION_EDITOR_PANE,
            interactive: false,
            color,
            weight: 4,
            opacity: 0.9
        }).addTo(stationEditor.layer);
        global.L.marker([stationEditor.center[1], stationEditor.center[0]], {
            pane: STATION_EDITOR_PANE,
            icon: markerIcon(stationEditor.type, true),
            interactive: false
        }).addTo(stationEditor.layer);
    }

    function syncStationEditorDraft() {
        if (!stationEditor?.draftId) return null;
        const draft = global.proposalDraftStore?.getDraft?.(stationEditor.draftId);
        const current = draft?.editorPayload?.structureProposal;
        const next = buildEditedStationStructure(current, {
            bearing: stationEditor.bearing,
            platformHeightM: stationEditor.platformHeightM
        });
        if (!draft || !next) return null;
        const updated = typeof global.syncActiveProposalDraftFromEditor === 'function'
            ? global.syncActiveProposalDraftFromEditor('station', { structureProposal: next }, { coalesceKey: 'editor:station' })
            : global.proposalDraftStore.updateDraft(draft.id, {
                fields: { parentParcelIds: clone(next.parentParcelIds || draft.fields?.parentParcelIds || []) },
                editorPayload: { ...draft.editorPayload, geometry: clone(next.geometry), structureProposal: next },
                previewGeometry: clone(next.geometry)
            }, { coalesceKey: 'editor:station' });
        return updated;
    }

    function updateStationEditorInputs(source) {
        if (!stationEditor?.panel) return;
        if (source === 'height') {
            const input = stationEditor.panel.querySelector('[data-station-editor-height]');
            const value = Number(input?.value);
            // Do not clamp each intermediate keystroke (typing 17 necessarily passes through 1).
            // The draft/model payload is clamped by buildEditedStationStructure on every sync.
            if (!Number.isFinite(value)) return;
            stationEditor.platformHeightM = value;
        } else {
            const range = stationEditor.panel.querySelector('[data-station-editor-bearing-range]');
            const number = stationEditor.panel.querySelector('[data-station-editor-bearing]');
            const input = source === 'range' ? range : number;
            stationEditor.bearing = Math.round(normalizeBearing(input?.value));
            if (range) range.value = String(stationEditor.bearing);
            if (number) number.value = String(stationEditor.bearing);
        }
        renderStationEditorPreview();
        syncStationEditorDraft();
    }

    function teardownStationEditor() {
        const previous = stationEditor;
        if (!previous) return null;
        try { global.document?.removeEventListener('keydown', previous.onKey, true); } catch (_) { }
        try { previous.panel?.removeEventListener('click', previous.onClick); } catch (_) { }
        try { previous.panel?.removeEventListener('input', previous.onInput); } catch (_) { }
        try { previous.panel?.classList.remove('is-open'); } catch (_) { }
        try { previous.panel?.remove(); } catch (_) { }
        try { global.map?.removeLayer(previous.layer); } catch (_) { }
        stationEditor = null;
        global.transitStationGeometryEditorActive = false;
        try { updateTransitStationsLayer(); } catch (_) { }
        return previous;
    }

    async function cancelStationGeometryEditor() {
        if (!stationEditor) return false;
        const draftId = stationEditor.draftId;
        const isCommit = global.isProposalDesignCommitSession?.() === true;
        if (isCommit) {
            const proceed = await global.confirmDiscardProposalDesignSession?.({ hasDesign: true });
            if (proceed === false) return false;
            global.discardProposalDraftDesignSession?.();
        }
        const previous = teardownStationEditor();
        if (!isCommit) global.finishProposalDraftDesignSession?.(draftId);
        if (previous?.reselectKey) {
            try { global.selectAndHighlightProposal?.(previous.reselectKey, null, false, true); } catch (_) { }
        }
        return true;
    }

    function saveStationGeometryEditor() {
        if (!stationEditor) return false;
        const draftId = stationEditor.draftId;
        syncStationEditorDraft();
        teardownStationEditor();
        global.finishProposalDraftDesignSession?.(draftId);
        if (typeof global.updateStatus === 'function') {
            global.updateStatus(stationEditorText('saved', 'Station geometry saved.'));
        }
        return true;
    }

    function openStationGeometryEditor(draftOrId) {
        if (!global.map || !global.L || !global.turf) return false;
        const draft = typeof draftOrId === 'string' ? global.proposalDraftStore?.getDraft?.(draftOrId) : draftOrId;
        const structure = draft?.editorPayload?.structureProposal;
        const type = normalizeType(structure?.stationType);
        const center = coordinate(structure?.center);
        if (!draft || (draft.adapterKey || draft.goal) !== 'station' || !type || !center) return false;
        if (stationEditor) teardownStationEditor();
        const sourceProposalId = draft.sourceProposalId || draft.sourceSnapshot?.proposalId || draft.sourceSnapshot?.id || null;
        stationEditor = {
            draftId: draft.id,
            type,
            center: center.slice(),
            bearing: Math.round(normalizeBearing(structure.bearing)),
            platformHeightM: normalizePlatformHeight(structure.platformHeightM, type),
            sourceProposalId,
            reselectKey: global.ProposalSelection?.getKey?.() || null,
            panel: null,
            layer: null,
            onInput: null,
            onClick: null,
            onKey: null
        };
        ensureStationEditorPane();
        stationEditor.layer = global.L.layerGroup().addTo(global.map);
        const panel = ensureStationEditorPanel();
        if (!panel) {
            teardownStationEditor();
            return false;
        }
        panel.innerHTML = stationEditorMarkup();
        stationEditor.onInput = event => {
            if (event.target?.matches?.('[data-station-editor-bearing-range]')) updateStationEditorInputs('range');
            else if (event.target?.matches?.('[data-station-editor-bearing]')) updateStationEditorInputs('number');
            else if (event.target?.matches?.('[data-station-editor-height]')) updateStationEditorInputs('height');
        };
        stationEditor.onClick = event => {
            const action = event.target?.closest?.('[data-station-editor-action]')?.dataset.stationEditorAction;
            if (action === 'cancel') void cancelStationGeometryEditor();
            else if (action === 'save') saveStationGeometryEditor();
        };
        stationEditor.onKey = event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void cancelStationGeometryEditor();
        };
        panel.addEventListener('input', stationEditor.onInput);
        panel.addEventListener('click', stationEditor.onClick);
        global.document?.addEventListener('keydown', stationEditor.onKey, true);
        try { global.hideProposalDetailsPanel?.(true); } catch (_) { }
        try { global.hideParcelInfoPanel?.(); } catch (_) { }
        global.transitStationGeometryEditorActive = true;
        panel.classList.add('is-open');
        updateTransitStationsLayer();
        renderStationEditorPreview();
        return true;
    }

    function placementParcelLayerVersion() {
        const value = global.ParcelsState?.getParcelLayerIndexVersion?.()
            ?? global.parcelLayerIndexVersion;
        return Number.isFinite(Number(value)) ? Number(value) : null;
    }

    function cachedPlacementParcelEntries(active) {
        const version = placementParcelLayerVersion();
        if (!Array.isArray(active?.parcelEntries) || active.parcelLayerVersion !== version) {
            active.parcelEntries = collectLoadedParcelEntries();
            active.parcelLayerVersion = version;
        }
        return active.parcelEntries;
    }

    function renderCompatibleAlignments() {
        if (!placement?.alignmentLayer || !global.L) return;
        try { placement.alignmentLayer.clearLayers(); } catch (_) { }
        const type = placement.type;
        const color = COLORS[type] || '#334155';
        const references = compatibleReferenceAlignments(
            type,
            global.TransitAlignments?.getRecords?.() || []
        );
        const proposals = compatibleProposalAlignments(type, placement.proposals || []);
        for (const entry of [...references, ...proposals]) {
            const latlngs = (entry.points || [])
                .map(pointFromDefinition)
                .filter(Boolean)
                .map(point => [point[1], point[0]]);
            if (latlngs.length < 2 || typeof global.L.polyline !== 'function') continue;
            global.L.polyline(latlngs, {
                pane: ALIGNMENT_PANE,
                color: '#ffffff',
                weight: 10,
                opacity: 0.72,
                lineCap: 'round',
                lineJoin: 'round',
                interactive: false
            }).addTo(placement.alignmentLayer);
            global.L.polyline(latlngs, {
                pane: ALIGNMENT_PANE,
                color,
                weight: 6,
                opacity: 0.92,
                lineCap: 'round',
                lineJoin: 'round',
                interactive: false
            }).addTo(placement.alignmentLayer);
        }
    }

    function clearPreview() {
        if (!placement?.previewLayer) return;
        try { placement.previewLayer.clearLayers(); } catch (_) { }
    }

    function renderPlacementPreview() {
        if (!placement?.center || !global.map || !global.L) return;
        clearPreview();
        const geometry = placement.previewGeometry
            || createStationFootprint(placement.center, placement.bearing, placement.type);
        if (!geometry) return;
        const color = placement.valid ? VALID_PREVIEW_COLOR : INVALID_PREVIEW_COLOR;
        const feature = { type: 'Feature', properties: {}, geometry };
        global.L.geoJSON(feature, {
            pane: PANE,
            interactive: false,
            style: { color, weight: 4, fillColor: color, fillOpacity: 0.18, dashArray: placement.valid ? '' : '8 5' }
        }).addTo(placement.previewLayer);
        if (placement.valid && placement.cursor && typeof global.L.polyline === 'function') {
            const dx = Math.abs(placement.cursor[0] - placement.center[0]);
            const dy = Math.abs(placement.cursor[1] - placement.center[1]);
            if (dx > 1e-8 || dy > 1e-8) {
                global.L.polyline([
                    [placement.cursor[1], placement.cursor[0]],
                    [placement.center[1], placement.center[0]]
                ], {
                    pane: PANE,
                    color: VALID_PREVIEW_COLOR,
                    weight: 2,
                    opacity: 0.9,
                    dashArray: '4 4',
                    interactive: false
                }).addTo(placement.previewLayer);
            }
        }
        global.L.marker([placement.center[1], placement.center[0]], {
            pane: ICON_PANE,
            icon: markerIcon(placement.type, true, placement.valid),
            interactive: false
        }).addTo(placement.previewLayer);
    }

    function previewStatusMessage(active) {
        if (active.valid) {
            return active.type === 'bus'
                ? 'Snapped to a compatible roadside. Click to place; Esc cancels.'
                : 'Snapped to a compatible track. Click to place; Esc cancels.';
        }
        if (active.reason === 'no-loaded-parcel') {
            return 'Track found, but the station footprint is outside loaded parcel geometry.';
        }
        return active.type === 'bus'
            ? 'Move closer to a compatible drivable road.'
            : 'Move closer to a compatible rail track.';
    }

    function updateCarriedPlacementPreview(latlng) {
        if (!placement || !latlng) return null;
        placement.lastLatLng = { lat: Number(latlng.lat), lng: Number(latlng.lng) };
        const state = resolvePlacementPreview(placement.type, [latlng.lng, latlng.lat], {
            proposals: placement.proposals,
            parcelEntries: cachedPlacementParcelEntries(placement),
            currentBearing: placement.bearing,
            currentPlatformHeightM: placement.platformHeightM
        });
        if (!state) return null;
        placement.cursor = state.cursor;
        placement.center = state.center;
        placement.bearing = state.bearing;
        placement.platformHeightM = state.platformHeightM;
        placement.alignment = state.alignment;
        placement.previewGeometry = state.geometry;
        placement.parentParcelIds = state.parentParcelIds;
        placement.aligned = state.aligned;
        placement.valid = state.valid;
        placement.reason = state.reason;
        renderPlacementPreview();
        const statusKey = `${state.valid}:${state.reason || 'ready'}:${state.alignment?.sourceId || ''}:${state.alignment?.featureId || ''}`;
        if (placement.statusKey !== statusKey) {
            placement.statusKey = statusKey;
            updatePlacementStatus(previewStatusMessage(placement));
        }
        return state;
    }

    function updatePlacementStatus(message) {
        if (typeof global.updateStatus === 'function') global.updateStatus(message);
        const el = global.document?.getElementById('station-placement-status');
        if (el) el.textContent = message || '';
    }

    function cleanupPlacement() {
        if (!placement) return;
        const container = global.map?.getContainer?.() || global.map?._container || null;
        try { container?.removeEventListener('pointerdown', placement.onPointerDown, true); } catch (_) { }
        try { container?.removeEventListener('pointermove', placement.onPointerMove, true); } catch (_) { }
        try { container?.removeEventListener('pointercancel', placement.onPointerCancel, true); } catch (_) { }
        try { container?.removeEventListener('click', placement.onContainerClick, true); } catch (_) { }
        try { global.map?.off('mousemove', placement.onMove); } catch (_) { }
        try { global.removeEventListener('keydown', placement.onKey, true); } catch (_) { }
        try { global.map?.removeLayer(placement.previewLayer); } catch (_) { }
        try { global.map?.removeLayer(placement.alignmentLayer); } catch (_) { }
        try { if (global.map?._container) global.map._container.style.cursor = ''; } catch (_) { }
        placement = null;
        global.transitStationPlacementMode = false;
        global.document?.querySelectorAll?.('[data-station-type].is-active').forEach(button => button.classList.remove('is-active'));
    }

    function cancelTransitStationPlacement() {
        if (!placement) return false;
        cleanupPlacement();
        updatePlacementStatus('Station placement cancelled.');
        return true;
    }

    async function commitPlacement() {
        const active = placement;
        if (!active?.valid || !active.center || !active.alignment) return null;
        const geometry = active.previewGeometry
            || createStationFootprint(active.center, active.bearing, active.type);
        const parentParcelIds = findStationParentParcelIds(geometry);
        if (!parentParcelIds.length) {
            active.valid = false;
            active.reason = 'no-loaded-parcel';
            active.parentParcelIds = [];
            renderPlacementPreview();
            updatePlacementStatus('Place the station over loaded parcel geometry.');
            return null;
        }
        const type = active.type;
        const center = active.center.slice();
        const bearing = active.bearing;
        cleanupPlacement();
        const spec = specFor(type);
        const platformHeightM = type === 'elevated'
            ? normalizePlatformHeight(active.platformHeightM, type)
            : undefined;
        const draft = global.proposalDraftStore?.createDraft?.({
            cityId: global.cityConfigManager?.getCurrentCityId?.() || global.currentCityId || null,
            goal: 'station',
            proposalType: spec?.label || 'Transit station',
            adapterKey: 'station',
            fields: {
                name: '',
                description: '',
                parentParcelIds,
                offer: 0,
                offerCurrency: 'USDT'
            },
            editorPayload: {
                geometry: clone(geometry),
                structureProposal: {
                    kind: 'station',
                    stationType: type,
                    center,
                    bearing,
                    platformHeightM,
                    attachment: active.alignment ? clone(active.alignment) : null,
                    modelVersion: models()?.MODEL_VERSION || 1,
                    geometry: clone(geometry),
                    parentParcelIds: parentParcelIds.slice(),
                    blockName: null,
                    demolishedBuildings: null
                }
            },
            previewGeometry: clone(geometry)
        });
        if (!draft) {
            updatePlacementStatus('Could not create the station object.');
            return null;
        }
        updatePlacementStatus(`Placing ${spec?.label?.toLowerCase() || 'station'}…`);
        const proposalId = await global.instantCreateProposalFromDraft?.(draft.id);
        if (proposalId) updatePlacementStatus(`${spec?.label || 'Station'} placed.`);
        return proposalId || null;
    }

    function startTransitStationPlacement(typeValue) {
        const type = normalizeType(typeValue);
        if (!type || !global.map || !global.L) return false;
        if (typeof global.isThreeModeActive === 'function' && global.isThreeModeActive()) {
            updatePlacementStatus('Return to 2D mode to place a station.');
            return false;
        }
        cancelTransitStationPlacement();
        ensurePane(ALIGNMENT_PANE, 632);
        ensurePane(PANE, 634);
        ensurePane(ICON_PANE, 666);
        const alignmentLayer = global.L.featureGroup().addTo(global.map);
        const previewLayer = global.L.featureGroup().addTo(global.map);
        let proposals = [];
        try { proposals = global.proposalStorage?.getAllProposals?.() || []; } catch (_) { }
        placement = {
            type,
            center: null,
            cursor: null,
            bearing: 0,
            platformHeightM: type === 'elevated' ? normalizePlatformHeight(undefined, type) : undefined,
            alignment: null,
            previewGeometry: null,
            parentParcelIds: [],
            aligned: false,
            valid: false,
            reason: 'no-alignment',
            proposals,
            parcelEntries: null,
            parcelLayerVersion: null,
            alignmentLayer,
            previewLayer,
            lastLatLng: null,
            statusKey: null,
            pointerStart: null,
            pointerMoved: false,
            onPointerDown: null,
            onPointerMove: null,
            onPointerCancel: null,
            onContainerClick: null,
            onMove: null,
            onKey: null
        };
        global.transitStationPlacementMode = true;
        try { global.clearParcelHover?.(); } catch (_) { }
        renderCompatibleAlignments();

        const placeAtLatLng = latlng => {
            if (!placement || !latlng) return;
            const state = updateCarriedPlacementPreview(latlng);
            if (!state?.valid) return;
            void commitPlacement();
        };

        // Leaflet feature clicks run before the map's ordinary `click` listener. Parcels, block
        // polygons, and corridor hit targets can also stop bubbling, which previously meant a
        // station click merely selected the object underneath. Own the browser click in capture
        // phase while this tool is active: it reaches us before any Leaflet layer, and consuming it
        // guarantees that one click has exactly one meaning. Controls/popups remain interactive.
        const container = global.map.getContainer?.() || global.map._container;
        placement.onPointerDown = event => {
            if (event.button !== undefined && event.button !== 0) return;
            placement.pointerStart = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
            placement.pointerMoved = false;
        };
        placement.onPointerMove = event => {
            if (!placement?.pointerStart) return;
            const dx = (Number(event.clientX) || 0) - placement.pointerStart.x;
            const dy = (Number(event.clientY) || 0) - placement.pointerStart.y;
            if (Math.hypot(dx, dy) > 6) placement.pointerMoved = true;
        };
        placement.onPointerCancel = () => {
            if (!placement) return;
            placement.pointerStart = null;
            placement.pointerMoved = false;
        };
        placement.onContainerClick = event => {
            if (!placement || (event.button !== undefined && event.button !== 0)) return;
            const target = event.target;
            if (target?.closest?.('.leaflet-control, .leaflet-popup, .leaflet-tooltip')) return;
            const moved = placement.pointerMoved;
            placement.pointerStart = null;
            placement.pointerMoved = false;
            // Do not turn the end of a map pan into a station point.
            if (moved) return;
            event.preventDefault?.();
            event.stopImmediatePropagation?.();
            let latlng = null;
            try {
                latlng = global.map.mouseEventToLatLng?.(event) || null;
            } catch (_) { }
            if (!latlng) return;
            placeAtLatLng(latlng);
        };
        placement.onMove = event => {
            if (!placement || !event?.latlng) return;
            updateCarriedPlacementPreview(event.latlng);
        };
        placement.onKey = event => {
            if (!placement) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                cancelTransitStationPlacement();
            } else if (event.key === 'Enter' && placement.valid) {
                event.preventDefault();
                event.stopImmediatePropagation();
                void commitPlacement();
            }
        };
        container?.addEventListener('pointerdown', placement.onPointerDown, true);
        container?.addEventListener('pointermove', placement.onPointerMove, true);
        container?.addEventListener('pointercancel', placement.onPointerCancel, true);
        container?.addEventListener('click', placement.onContainerClick, true);
        global.map.on('mousemove', placement.onMove);
        global.addEventListener('keydown', placement.onKey, true);
        try { global.map._container.style.cursor = 'crosshair'; } catch (_) { }
        global.document?.querySelectorAll?.(`[data-station-type="${type}"]`)
            .forEach(button => button.classList.add('is-active'));
        if (type !== 'bus') {
            const activePlacement = placement;
            Promise.resolve(global.TransitAlignments?.ensureLoaded?.()).then(() => {
                if (placement !== activePlacement) return;
                renderCompatibleAlignments();
                if (activePlacement.lastLatLng) updateCarriedPlacementPreview(activePlacement.lastLatLng);
            }).catch(error => {
                if (placement === activePlacement) {
                    updatePlacementStatus('Existing rail alignments could not be loaded.');
                }
                console.error('[transit-stations] alignment preload failed', error);
            });
        }
        updatePlacementStatus(type === 'bus'
            ? 'Move beside a compatible road. The carried station turns green when it can be placed.'
            : `Move near a compatible rail track for the ${specFor(type)?.label?.toLowerCase() || 'station'}. The carried station turns green when it can be placed.`);
        return true;
    }

    function initialise() {
        loadStations();
        const render = () => {
            try { updateTransitStationsLayer(); } catch (error) { console.warn('[transit-stations] initial render failed', error); }
        };
        if (global.document?.readyState === 'loading') global.addEventListener('DOMContentLoaded', render, { once: true });
        else render();
    }

    if (global.PersistentStorage?.ensureReady) global.PersistentStorage.ensureReady(initialise);
    else initialise();

    global.startTransitStationPlacement = startTransitStationPlacement;
    global.cancelTransitStationPlacement = cancelTransitStationPlacement;
    global.isTransitStationPlacementActive = isTransitStationPlacementActive;
    global.updateTransitStationsLayer = updateTransitStationsLayer;
    global.upsertTransitStation = upsertStation;
    global.removeTransitStationByProposalId = removeStationByProposalId;
    global.openTransitStationGeometryEditor = openStationGeometryEditor;
    global.closeTransitStationGeometryEditor = cancelStationGeometryEditor;
    global.isTransitStationGeometryEditorActive = () => !!stationEditor;

    return Object.freeze({
        STORAGE_KEY,
        COLORS,
        normalizeType,
        specFor,
        createStationFootprint,
        stationCenter,
        stationBearing,
        stationType,
        stationSurfaceCutouts,
        normalizeBearing,
        normalizePlatformHeight,
        buildEditedStationStructure,
        corridorEntrySupportsStation,
        referenceEntrySupportsStation,
        compatibleReferenceAlignments,
        compatibleProposalAlignments,
        nearestCorridorAlignment,
        placementUpdateFromAlignment,
        resolvePlacementPreview,
        findStationParentParcelIds,
        upsertStation,
        removeStationByProposalId,
        updateTransitStationsLayer,
        startTransitStationPlacement,
        cancelTransitStationPlacement,
        openStationGeometryEditor,
        cancelStationGeometryEditor,
        saveStationGeometryEditor,
        isTransitStationPlacementActive
    });
});
