// Resolve agent navigation against exact source parcels and the same road-aware block topology as the map.
import { createRequire } from 'node:module';
import { appTurf as turf } from './mcp-geometry.js';
const require = createRequire(import.meta.url);
const blockModel = require('../../frontend/js/urban-blocks-model.js');
const topology = require('../../frontend/js/parcels/block-topology.js');
const MAX_BLOCK_PARCELS = topology.MAX_BLOCK_PARCELS;
const fail = (code, message, action) => Object.assign(new Error(message), { code, next: { action } });
const idOf = value => typeof value === 'string' && value.trim() ? value.trim() : null;

function centerOf(feature) {
    const coordinates = turf.pointOnFeature(feature).geometry.coordinates;
    return [coordinates[0], coordinates[1]];
}
function metricFeature(feature) {
    const projected = turf.toMercator(feature);
    const id = idOf(String(feature.id ?? feature.properties?.parcelId ?? ''));
    if (!id) throw fail('parcel-id-missing', 'A parcel in the source result has no identity.', 'Retry after the parcel source is repaired.');
    const polygons = projected.geometry.type === 'Polygon' ? [projected.geometry.coordinates]
        : projected.geometry.type === 'MultiPolygon' ? projected.geometry.coordinates : null;
    if (!polygons?.length) throw fail('parcel-geometry-invalid', `Parcel ${id} has unsupported geometry.`, 'Choose a parcel with polygon geometry.');
    return { id, rings: polygons.flatMap(polygon => polygon) };
}
function directionBearing(direction) {
    if (typeof direction === 'number' && Number.isFinite(direction)) return ((direction % 360) + 360) % 360;
    const bearings = { north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315,
        n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315,
        up: 0, 'up-right': 45, right: 90, 'down-right': 135, down: 180, 'down-left': 225, left: 270, 'up-left': 315 };
    const bearing = bearings[String(direction || '').trim().toLowerCase()];
    if (bearing == null) throw fail('invalid-direction', 'Direction must be a compass direction or a bearing in degrees.', 'Supply north, northeast, east, southeast, south, southwest, west, northwest, or degrees.');
    return bearing;
}
function normalizeCenter(center) {
    const coordinates = Array.isArray(center) ? center : center && [center.lng, center.lat];
    if (!coordinates || coordinates.length < 2 || !coordinates.slice(0, 2).every(Number.isFinite)
        || Math.abs(coordinates[1]) > 85.0511 || Math.abs(coordinates[0]) > 180) {
        throw fail('invalid-center', 'Map center must be a WGS84 [longitude, latitude] coordinate.', 'Supply center as [longitude, latitude].');
    }
    return coordinates.slice(0, 2);
}
function parseAt(value) {
    const parts = typeof value === 'string' ? value.split(',') : null;
    const values = parts?.map(part => Number(part.trim()));
    if (!values || (values.length !== 2 && values.length !== 3) || !values.every(Number.isFinite)
        || Math.abs(values[0]) > 85.0511 || Math.abs(values[1]) > 180
        || (values.length === 3 && (values[2] < 0 || values[2] > 22))) {
        throw fail('invalid-map-view', 'Map view at must be latitude,longitude[,zoom].', 'Supply a valid WGS84 map location.');
    }
    return { lat: values[0], lng: values[1], zoom: values[2] ?? null, hadZoom: values.length === 3 };
}
function parcelIdsInBlock(block, parcels) {
    const ids = new Set();
    for (const parcel of parcels || []) {
        if (!['Polygon', 'MultiPolygon'].includes(parcel.geometry?.type)) continue;
        const id = parcel.properties?.parcelId ?? parcel.properties?.parcel_id ?? parcel.properties?.PARCEL_ID
            ?? parcel.properties?.id ?? parcel.id;
        if (id == null || ids.has(String(id))) continue;
        if (turf.booleanPointInPolygon(turf.pointOnFeature(parcel), block, { ignoreBoundary: true })) ids.add(String(id));
    }
    return [...ids];
}

export function createMcpNavigation({ read }) {
    if (!read?.parcels || !read?.request) throw new TypeError('createMcpNavigation needs parcel and request readers');

    function mapView({ view, center, direction, distance, unit = 'm', zoom, zoomDelta } = {}) {
        if (view != null && (typeof view !== 'object' || Array.isArray(view) || !view.at)) throw fail('invalid-map-view', 'An absolute map view needs an at coordinate.', 'Supply view.at as latitude,longitude[,zoom].');
        if (zoom != null && (!Number.isFinite(zoom) || zoom < 0 || zoom > 22)) throw fail('invalid-zoom', 'Zoom must be between 0 and 22.', 'Supply a zoom in the supported range.');
        if (zoomDelta != null && (!Number.isFinite(zoomDelta) || Math.abs(zoomDelta) > 10 || zoom != null)) throw fail('invalid-zoom-delta', 'zoomDelta must be between -10 and 10 and cannot be combined with zoom.', 'Supply zoom or zoomDelta.');
        const nextView = view ? structuredClone(view) : {};
        const original = view ? parseAt(view.at) : { lat: null, lng: null, zoom: null, hadZoom: false };
        let currentCenter = view ? [original.lng, original.lat] : null;
        if (center != null) currentCenter = normalizeCenter(center);
        if (!currentCenter) throw fail('map-center-required', 'Supply a center or an absolute view.', 'Choose a map center.');
        let coords = currentCenter;
        if (direction != null || distance != null) {
            if (direction == null || !Number.isFinite(distance) || distance <= 0 || distance > 100000 || !['m', 'ft'].includes(unit)) throw fail('invalid-distance', 'Directional movement needs a direction, positive distance up to 100,000, and unit m or ft.', 'Supply direction, distance and unit.');
            const meters = distance * (unit === 'ft' ? 0.3048 : 1);
            const moved = turf.destination(turf.point(coords), meters / 1000, directionBearing(direction), { units: 'kilometers' }).geometry.coordinates;
            coords = moved;
        }
        if (!coords.every(Number.isFinite) || Math.abs(coords[1]) > 85.0511 || Math.abs(coords[0]) > 180) throw fail('invalid-center', 'The resulting map center is outside the supported map extent.', 'Choose a closer center or a shorter pan.');
        let nextZoom = zoom ?? original.zoom;
        if (zoomDelta != null) {
            if (original.zoom == null) throw fail('zoom-required', 'Relative zoom needs the current absolute zoom.', 'Supply a view with zoom in its at coordinate.');
            nextZoom = Math.max(0, Math.min(22, original.zoom + zoomDelta));
        }
        const cameraView = view?.mode !== '2d' && view?.camera && typeof view.camera === 'object';
        if (cameraView) {
            nextView.camera.targetLat = coords[1];
            nextView.camera.targetLng = coords[0];
            if (zoomDelta != null) nextView.camera.range *= 2 ** (-(nextZoom - original.zoom));
            else if (zoom != null) {
                if (original.zoom == null) throw fail('zoom-required', 'Absolute 3D zoom needs the current zoom.', 'Supply a view with zoom in its at coordinate.');
                nextView.camera.range *= 2 ** (original.zoom - zoom);
            }
            if (!Number.isFinite(nextView.camera.range) || nextView.camera.range < 1) throw fail('invalid-camera', 'The updated camera range must be at least one metre.', 'Choose a smaller zoom change.');
        }
        const includeZoom = zoom != null || zoomDelta != null || original.hadZoom;
        nextView.at = `${coords[1]},${coords[0]}${includeZoom ? `,${nextZoom}` : ''}`;
        return { view: nextView };
    }

    async function selectParcels({ city, parcelSourceId, selection, action, parcelId, point, direction } = {}) {
        const sourceId = idOf(parcelSourceId);
        if (!sourceId) throw fail('parcel-source-required', 'Supply an explicit parcelSourceId.', 'Use ugt_list_sources to choose a parcel source.');
        if (!idOf(city)) throw fail('city-required', 'Supply a city for parcel navigation.', 'Choose a city.');
        if (!['select', 'step', 'add', 'remove', 'block', 'clear', 'begin', 'finish'].includes(action)) throw fail('invalid-selection-action', 'Unsupported parcel selection action.', 'Use select, step, add, remove, block, clear, begin or finish.');
        const current = selection || {};
        if (current.parcelSourceId != null && idOf(current.parcelSourceId) !== sourceId) throw fail('invalid-selection', 'Selection parcel source does not match the requested source.', 'Reload the map selection and try again.');
        if (current.parcelIds != null && !Array.isArray(current.parcelIds)) throw fail('invalid-selection', 'Selection parcel IDs must be an array.', 'Reload the map selection and try again.');
        if (current.active != null && typeof current.active !== 'boolean') throw fail('invalid-selection', 'Selection active state must be boolean.', 'Reload the map selection and try again.');
        let ids = [...new Set((current.parcelIds || []).map(idOf))];
        if (ids.some(id => !id)) throw fail('invalid-selection', 'Selection contains an invalid parcel ID.', 'Reload the map selection and try again.');
        if (ids.length > MAX_BLOCK_PARCELS) throw fail('parcel-selection-limit', `Selection cannot contain more than ${MAX_BLOCK_PARCELS} parcels.`, 'Clear parcels or keep a smaller selection.');
        let focus = idOf(current.focusParcelId);
        let features = [];
        let selectedParcelId = idOf(parcelId);
        let pointFeature = null;
        if (action === 'select' && point != null) {
            if (selectedParcelId) throw fail('parcel-target-ambiguous', 'Choose a parcelId or a point, not both.', 'Supply exactly one parcel target.');
            const coordinate = normalizeCenter(point);
            const searchGeometry = turf.buffer(turf.point(coordinate), 1, { units: 'meters' }).geometry;
            const found = await read.parcels({ city, parcelSourceId: sourceId, geometry: searchGeometry });
            if (found.complete !== true || found.truncated) throw fail('parcel-coverage-incomplete', 'The point query did not return complete parcel coverage.', 'Retry when the parcel source returns complete coverage.');
            const exactPoint = turf.point(coordinate);
            const candidates = (found.features || []).filter(feature => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
                && turf.booleanPointInPolygon(exactPoint, feature));
            if (candidates.length !== 1) throw fail(candidates.length ? 'parcel-ambiguous' : 'parcel-not-found', candidates.length ? 'The point matches multiple parcels.' : 'The point is outside the available parcels.', 'Choose a parcelId from ugt_find_place.');
            pointFeature = candidates[0];
            selectedParcelId = idOf(String(candidates[0].id ?? candidates[0].properties?.parcelId ?? ''));
            if (!selectedParcelId) throw fail('parcel-id-missing', 'The point matched ground without a parcel identity.', 'Retry after the parcel source is repaired.');
        }
        if (action === 'select' && !selectedParcelId) throw fail('parcel-id-required', 'Select needs a parcelId or point.', 'Supply a parcelId or a point inside one parcel.');
        if (action !== 'clear' && action !== 'begin' && action !== 'finish') {
            if (action === 'step' && !focus) throw fail('parcel-focus-required', 'Step needs a focused parcel.', 'Select a parcel before stepping to a neighbour.');
            if (action === 'step' && direction == null) throw fail('direction-required', 'Step needs a direction.', 'Supply a compass direction or bearing.');
            if (action !== 'step' && action !== 'block' && action !== 'remove' && !selectedParcelId && !(action === 'add' && focus)) throw fail('parcel-id-required', `${action} needs a parcelId.`, 'Supply a parcelId from the active parcel source.');
            if (action === 'block' && !idOf(parcelId || focus)) throw fail('parcel-id-required', 'Block selection needs a seed parcel.', 'Supply a parcelId or focus a parcel.');
            const seed = action === 'step' ? focus : action === 'block' ? idOf(parcelId) || focus : action === 'remove' ? null : action === 'add' ? selectedParcelId || focus : selectedParcelId;
            let seedFeature = null;
            if (seed) {
                const seedRead = pointFeature ? { complete: true, features: [pointFeature] }
                    : await read.parcels({ city, parcelSourceId: sourceId, parcelIds: [seed] });
                seedFeature = seedRead.features?.find(feature => String(feature.id ?? feature.properties?.parcelId) === seed);
                if (seedRead.complete !== true || !seedFeature) throw fail('parcel-coverage-incomplete', `Parcel ${seed} is not available from the selected source.`, 'Retry when the parcel source returns complete coverage.');
                features = [seedFeature];
            }
            let searchGeometry = null;
            if (action === 'step' || action === 'block') {
                searchGeometry = turf.buffer(seedFeature, 250, { units: 'meters' }).geometry;
                const surroundings = await read.parcels({ city, parcelSourceId: sourceId, geometry: searchGeometry });
                if (surroundings.complete !== true || surroundings.truncated) throw fail('parcel-coverage-incomplete', 'Neighbouring parcel coverage is incomplete.', 'Retry with an available parcel source; navigation needs complete local ground.');
                features = surroundings.features || [];
                if (!features.some(feature => String(feature.id ?? feature.properties?.parcelId) === seed)) features.push(seedFeature);
            }
            if (action === 'step') {
                const bearing = directionBearing(direction);
                const origin = turf.toMercator(turf.point(centerOf(seedFeature))).geometry.coordinates;
                const metric = features.map(metricFeature);
                const adjacent = new Set(topology.neighborPairs(metric, []).flatMap(pair => pair.a === seed ? [pair.b] : pair.b === seed ? [pair.a] : []));
                const candidates = features.filter(feature => adjacent.has(String(feature.id ?? feature.properties?.parcelId))).map(feature => {
                    const c = turf.toMercator(turf.point(centerOf(feature))).geometry.coordinates;
                    const bearingTo = (Math.atan2(c[0] - origin[0], c[1] - origin[1]) * 180 / Math.PI + 360) % 360;
                    const delta = Math.abs(((bearingTo - bearing + 540) % 360) - 180);
                    return { id: String(feature.id ?? feature.properties?.parcelId), delta, distance: Math.hypot(c[0] - origin[0], c[1] - origin[1]), feature };
                }).filter(candidate => candidate.delta <= 60).sort((a, b) => a.delta - b.delta || a.distance - b.distance || a.id.localeCompare(b.id));
                if (!candidates.length) throw fail('parcel-neighbour-not-found', `No adjacent parcel lies ${direction} of ${seed}.`, 'Choose a different direction or parcel.');
                focus = candidates[0].id;
                if (!current.active) ids = [focus];
            } else if (action === 'block') {
                const [west, south, east, north] = turf.bbox(turf.feature(searchGeometry));
                const dLat = 250 / 111320, dLng = dLat / Math.max(0.15, Math.cos((south + north) * Math.PI / 360));
                const roadBounds = [west - dLng, south - dLat, east + dLng, north + dLat];
                const roads = await read.request('/blocks/roads', { bbox: roadBounds.join(',') });
                if (roads?.partial || roads?.truncated || !Array.isArray(roads?.features)) throw fail('street-coverage-incomplete', 'Street barrier coverage is incomplete.', 'Retry when complete street data is available.');
                let blocks;
                try { blocks = blockModel.detectBlocks(roads, roadBounds, turf); }
                catch (_) { throw fail('street-enclosure-invalid', 'The ground-level road network could not define complete blocks.', 'Retry after the street source is repaired.'); }
                const seedCenter = turf.point(centerOf(seedFeature));
                const matches = blocks.features.filter(block => turf.booleanPointInPolygon(seedCenter, block, { ignoreBoundary: true }));
                if (matches.length !== 1) throw fail('parcel-block-unproven', 'The focused parcel is not inside one complete ground-level road block.', 'Choose a parcel inside a fully bounded road block.');
                const enclosure = matches[0];
                const sourceGround = await read.parcels({ city, parcelSourceId: sourceId, geometry: enclosure.geometry });
                if (sourceGround.complete !== true || sourceGround.truncated || !Array.isArray(sourceGround.features)) throw fail('parcel-coverage-incomplete', 'Parcel coverage under the road block is incomplete.', 'Retry when the selected parcel source returns complete coverage.');
                features = sourceGround.features;
                ids = parcelIdsInBlock(enclosure, features);
                const sharedCount = blockModel.loadedParcelCount(enclosure, features, turf);
                if (sharedCount !== ids.length) throw fail('parcel-block-invalid', 'Parcel identities disagree with the shared road-block membership rule.', 'Retry after the parcel source is repaired.');
                if (!ids.includes(seed)) throw fail('parcel-block-incomplete', 'The source parcel is not included by the road-block membership rule.', 'Choose a parcel wholly represented inside a fully bounded road block.');
                if (ids.length > MAX_BLOCK_PARCELS) throw fail('parcel-block-limit', `The road block contains more than ${MAX_BLOCK_PARCELS} source parcels.`, 'Choose a smaller block or select parcels individually.');
                focus = seed;
            } else if (action === 'select') {
                focus = selectedParcelId;
                if (!current.active) ids = [focus];
            } else if (action === 'add') {
                focus = selectedParcelId || focus;
            } else if (action === 'remove') {
                const removeId = selectedParcelId || focus;
                ids = ids.filter(id => id !== removeId);
                if (focus === removeId) focus = ids.at(-1) || null;
            }
        }
        if (action === 'begin') {
            if (!focus && ids.length) focus = ids.at(-1);
            if (!ids.length && focus) ids.push(focus);
            return { selection: { parcelSourceId: sourceId, focusParcelId: focus, parcelIds: ids, active: true }, ...(point ? { point } : {}) };
        }
        if (action === 'finish') return { selection: { parcelSourceId: sourceId, focusParcelId: focus, parcelIds: ids, active: false }, ...(point ? { point } : {}) };
        if (action === 'clear') return { selection: { parcelSourceId: sourceId, focusParcelId: null, parcelIds: [], active: false } };
        if (action === 'add') {
            if (!focus) throw fail('parcel-focus-required', 'Add needs a parcelId or focused parcel.', 'Focus a parcel or supply parcelId.');
            if (!ids.includes(focus)) ids.push(focus);
            if (ids.length > MAX_BLOCK_PARCELS) throw fail('parcel-selection-limit', `Selection cannot contain more than ${MAX_BLOCK_PARCELS} parcels.`, 'Clear parcels or keep a smaller selection.');
        }
        const feature = features.find(item => String(item.id ?? item.properties?.parcelId) === focus);
        return { selection: { parcelSourceId: sourceId, focusParcelId: focus, parcelIds: ids, active: current.active === true || action === 'add' || action === 'block' }, ...(feature ? { point: centerOf(feature) } : point ? { point } : {}) };
    }

    return Object.freeze({ mapView, selectParcels });
}
