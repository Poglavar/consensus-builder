// Optional parcel guides for physical proposal editors: free placement, explicit site locking and
// bounded edge snapping. The editor owns geometry/history; the save path resolves destination land.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OnMapPlacement = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function featureOf(value) {
        const geometry = value?.type === 'Feature' ? value.geometry : value;
        return geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type)
            ? { type: 'Feature', properties: {}, geometry } : null;
    }

    function verticesOf(geometry) {
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
        const vertices = polygons.flatMap(polygon => (polygon[0] || []).slice(0, -1));
        // Manual outlines can have thousands of vertices. Snapping samples a bounded set; it never
        // changes their shape, and holding Alt gives the exact unsnapped pointer placement.
        const stride = Math.max(1, Math.ceil(vertices.length / 96));
        return vertices.filter((_, index) => index % stride === 0);
    }

    function snapMoveTarget(geometry, from, to, targets, options) {
        const { geometryApi, siteApi, radiusM } = options;
        const moved = geometryApi.moveGeometry(geometry, from, to);
        let nearest = null;
        for (const coordinate of verticesOf(moved)) {
            const hit = siteApi.snapToGround(coordinate, targets, { radiusM });
            const prefersVertex = hit.snapped === 'vertex' && nearest?.snapped !== 'vertex';
            const nearerSameKind = hit.snapped === nearest?.snapped && hit.distanceM < nearest.distanceM;
            if (hit.snapped && (!nearest || prefersVertex || nearerSameKind)) nearest = { ...hit, source: coordinate };
        }
        if (!nearest) return { lat: to.lat, lng: to.lng };
        const [lng, lat] = geometryApi.moveCoordinateCollection([to.lng, to.lat],
            { lng: nearest.source[0], lat: nearest.source[1] },
            { lng: nearest.coordinate[0], lat: nearest.coordinate[1] });
        return { lat, lng };
    }

    function create(options, env = window) {
        const { session } = options;
        const doc = env.document;
        const map = session.map;
        const site = featureOf(options.site);
        const geometryApi = env.SingleBuildingGeometry;
        const siteApi = env.__siteDraft;
        if (!geometryApi || !siteApi) throw new Error('Placement geometry helpers are unavailable.');
        let locked = options.initiallyLocked === true && !!site;
        let snapping = true;
        let current = site;
        let buildingTargets = null;
        let closed = false;

        function text(key, fallback) {
            const translated = env.i18n?.t?.(`onMapEditor.placement.${key}`);
            return translated && translated !== `onMapEditor.placement.${key}` ? translated : fallback;
        }
        function element(tag, className, parent) {
            const node = doc.createElement(tag);
            node.className = className;
            parent?.appendChild(node);
            return node;
        }
        const controls = element('div', 'on-map-editor__placement');
        session.body.insertBefore(controls, session.body.firstChild);
        function checkbox(key, fallback, checked) {
            const label = element('label', 'on-map-editor__placement-option', controls);
            const input = element('input', '', label);
            input.type = 'checkbox';
            input.checked = checked;
            input.dataset.placement = key;
            const caption = element('span', '', label);
            caption.textContent = text(key, fallback);
            return input;
        }
        const snapInput = checkbox('snap', 'Snap to edges', true);
        const lockInput = checkbox('lock', 'Lock to starting site', locked);
        lockInput.disabled = !site;
        const warning = element('p', 'on-map-editor__placement-warning');
        warning.setAttribute('role', 'status');
        warning.hidden = true;
        // Consequences remain visible when the parameter controls are folded away.
        session.content.insertBefore(warning, session.body);

        function inside(feature) {
            return !site || geometryApi.footprintWithinBoundary(featureOf(feature), site, env.turf);
        }
        function update(value) {
            if (closed) return;
            current = featureOf(value);
            // Free placement is the default. Only show a message when the user explicitly
            // attempts to enable a lock that the current geometry cannot satisfy.
            warning.textContent = '';
            warning.hidden = true;
        }
        function setLocked(value) {
            const next = value === true && !!site;
            // Enabling a guide must never move or crop an existing design as a side effect.
            if (next && current && !inside(current)) {
                locked = false;
                lockInput.checked = false;
                warning.textContent = text('lockOutside', 'Move the design inside the starting site before locking it.');
                warning.hidden = false;
                return false;
            }
            locked = next;
            lockInput.checked = next;
            options.onLockChange?.(next);
            update(current);
            return true;
        }
        function setSnapping(value) {
            snapping = value === true;
            snapInput.checked = snapping;
        }
        lockInput.addEventListener('change', () => setLocked(lockInput.checked));
        snapInput.addEventListener('change', () => setSnapping(snapInput.checked));

        function invalidateBuildings(event) {
            if (event?.type === 'layeradd' || event?.type === 'layerremove') {
                const groups = [env.buildingLayer, env.outlineBuildingLayer].filter(Boolean);
                if (!groups.some(layer => layer === event.layer || layer.hasLayer?.(event.layer))) return;
            }
            buildingTargets = null;
        }
        function shownBuildings() {
            if (buildingTargets) return buildingTargets;
            const features = [];
            const layers = [env.buildingLayer, env.outlineBuildingLayer];
            layers.filter((layer, index) => layer && layers.indexOf(layer) === index && map.hasLayer?.(layer))
                .forEach(layer => layer.eachLayer(item => {
                    if (item.feature?.geometry && item.feature.properties?.__outcome !== 'destroyed') features.push(item.feature);
                }));
            const bounds = map.getBounds();
            buildingTargets = siteApi.snapTargetsInBox(features,
                [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], { cap: 500 });
            return buildingTargets;
        }
        function radiusAt(point) {
            return 10 * 40075016.686 * Math.cos(point.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
        }
        function targetsNear(geometry, point, radiusM) {
            const box = siteApi.boxOf(geometry) || [point.lng, point.lat, point.lng, point.lat];
            const dy = radiusM / 111320;
            const dx = dy / Math.cos(point.lat * Math.PI / 180);
            const expanded = [box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy];
            const nearby = env.LiveParcelFabric?.queryBounds?.(expanded, { includeCorridors: true }) || [];
            return {
                parcels: siteApi.snapTargetsInBox([...(site ? [site] : []), ...nearby], expanded, { cap: 200 }),
                buildings: shownBuildings()
            };
        }
        const bypassSnap = event => !snapping || event?.altKey || event?.originalEvent?.altKey;
        function moveTarget(geometry, from, to, event) {
            if (bypassSnap(event)) return { lat: to.lat, lng: to.lng };
            const moved = geometryApi.moveGeometry(geometry, from, to);
            const radiusM = radiusAt(to);
            return snapMoveTarget(geometry, from, to, targetsNear(moved, to, radiusM), { geometryApi, siteApi, radiusM });
        }
        function snapCoordinate(coordinate, event) {
            if (bypassSnap(event)) return coordinate;
            const point = { lng: coordinate[0], lat: coordinate[1] };
            const radiusM = radiusAt(point);
            return siteApi.snapToGround(coordinate, targetsNear(null, point, radiusM), { radiusM }).coordinate;
        }
        map.on('moveend zoomend layeradd layerremove', invalidateBuildings);
        return {
            get locked() { return locked; },
            get snapping() { return snapping; },
            accepts: value => !locked || inside(value),
            update,
            setLocked,
            setSnapping,
            moveTarget,
            moveGeometry: (geometry, from, to, event) => geometryApi.moveGeometry(geometry, from, moveTarget(geometry, from, to, event)),
            snapCoordinate,
            destroy() {
                closed = true;
                map.off('moveend zoomend layeradd layerremove', invalidateBuildings);
                controls.remove();
                warning.remove();
            }
        };
    }

    return { create, snapMoveTarget, featureOf };
});
