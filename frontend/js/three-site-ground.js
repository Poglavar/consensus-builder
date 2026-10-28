// Derived site scenery and ordinary sidewalk paving for building surroundings.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSiteGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Observed trees belong to the existing context. An applied corridor replaces that context
    // within its authoritative surface footprint, including junctions. Keep the source points
    // intact so unapplying the corridor restores them; crown overhang outside it is natural.
    function contextTreesOutsideCorridors(trees, proposals, { isAppliedCorridor, featureSets, turf }) {
        const footprints = [];
        for (const proposal of proposals) {
            if (!isAppliedCorridor(proposal)) continue;
            for (const feature of featureSets(proposal, { includeBuildingGeometry: false }).primaryFeatures) {
                if (feature.properties?.source !== 'road-definition'
                    || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) continue;
                footprints.push({ feature, bbox: turf.bbox(feature) });
            }
        }
        return trees.filter(point => {
            if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
            return !footprints.some(({ feature, bbox: [west, south, east, north] }) =>
                point[0] >= west && point[0] <= east && point[1] >= south && point[1] <= north
                && turf.booleanPointInPolygon(point, feature));
        });
    }

    function sidewalkMaterial(THREE, ground, metresPerUnit) {
        return ground.paveTexture(new THREE.MeshLambertMaterial({
            color: 0xcdccc8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        }), metresPerUnit);
    }

    // Metric height and post spacing, even when the map's horizontal units are Mercator-scaled.
    // A polygon is fenced around its rings; a (multi)line string, such as the parcel boundaries
    // across a design's open ground, along its lines.
    function fencePositions(geometry, project, metresPerUnit = 1) {
        const positions = [];
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
            : geometry.type === 'MultiLineString' ? [geometry.coordinates]
                : geometry.type === 'LineString' ? [[geometry.coordinates]] : geometry.coordinates;
        const line = (a, b, za, zb = za) => positions.push(a[0], a[1], za, b[0], b[1], zb);
        polygons.forEach(rings => rings.forEach(ring => {
            for (let i = 1; i < ring.length; i++) {
                const a = project(ring[i - 1]), b = project(ring[i]);
                const length = Math.hypot(b[0] - a[0], b[1] - a[1]) * metresPerUnit;
                if (length < 0.05) continue;
                line(a, b, 1.3); line(a, b, 0.55);
                const posts = Math.ceil(length / 3);
                for (let j = 0; j < posts; j++) {
                    const t = j / posts;
                    const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                    line(point, point, 0.08, 1.3);
                }
            }
        }));
        return positions;
    }

    // The wild-grass pattern (three-grass.js): the browser global, or required in node.
    function grassApi() {
        const scope = typeof window !== 'undefined' ? window : globalThis;
        return scope.__threeGrass || require('./three-grass.js');
    }

    function buildVacantPlots({ THREE, features, target, polygonMeshes, project, metresPerUnit, ownMaterial, ownGeometry }) {
        features.forEach(feature => {
            const grass = grassApi().grassTexture(new THREE.MeshLambertMaterial({
                color: grassApi().COLORS.wild, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
            }), metresPerUnit, 'wild');
            polygonMeshes(feature, grass, 0.08, 0).forEach(mesh => {
                ownMaterial(mesh, grass);
                mesh.userData.isVacantPlot = true;
                target.add(mesh);
            });
            const fence = buildFence({ THREE, geometry: feature.geometry, project, metresPerUnit, ownMaterial, ownGeometry });
            fence.userData.isVacantPlotFence = true;
            target.add(fence);
        });
    }

    function buildFence({ THREE, geometry, project, metresPerUnit, ownMaterial, ownGeometry }) {
        const buffer = new THREE.BufferGeometry();
        buffer.setAttribute('position', new THREE.Float32BufferAttribute(fencePositions(geometry, project, metresPerUnit), 3));
        const material = new THREE.LineBasicMaterial({ color: 0x626650 });
        const fence = new THREE.LineSegments(buffer, material);
        ownGeometry(fence, buffer); ownMaterial(fence, material);
        return fence;
    }

    // The occupied ground of the scene's own existing buildings, for the vacant-plot rule. A nearby
    // building is a raw mesh without a footprint field, so each face is projected onto the ground:
    // roof and floor faces give the exact outline, walls collapse to nothing and are dropped.
    // `carveFor(building)` is the demolition verdict the meshes use: null keeps the building, a
    // remainder replaces it, razed removes it.
    function standingBuildingFootprints(buildings, carveFor, turfApi) {
        const features = [];
        for (const building of Array.isArray(buildings) ? buildings : []) {
            const carve = carveFor(building);
            if (carve) {
                if (carve.remainder) features.push({ type: 'Feature', properties: {}, geometry: carve.remainder });
                continue;
            }
            for (const face of Array.isArray(building?.faces) ? building.faces : []) {
                if (!face || face.type !== 'Polygon' || !Array.isArray(face.coordinates)) continue;
                const rings = face.coordinates.map(ring => (Array.isArray(ring) ? ring : []).map(c => [c[0], c[1]]));
                if (!rings.length || rings.some(ring => ring.length < 4)) continue;
                const flat = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } };
                let area = 0;
                try { area = turfApi.area(flat); } catch (_) { continue; }
                if (area > 0.1) features.push(flat);
            }
        }
        return features;
    }

    return { contextTreesOutsideCorridors, sidewalkMaterial, fencePositions, buildFence, buildVacantPlots, standingBuildingFootprints };
});
