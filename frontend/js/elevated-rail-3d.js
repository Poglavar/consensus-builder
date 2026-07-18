// Existing rail renderers for the 3D view: heavy rail becomes a concrete viaduct, while OSM
// tram alignments become a compact surface trackbed with sleepers and twin rails. The viaduct was
// ported from zagreb-isochrone's tram sim
// (station-3d/world/elevated-rail.js) and remapped to this scene's frame: ground = XY (from
// latLngToXY / Web Mercator), height = +Z. Merge-free on purpose: every part is one
// InstancedMesh, so the three@0.147 script-tag bundle needs no BufferGeometryUtils addon.
(function attachElevatedRail3D(global) {
    'use strict';

    // Dimensions follow the tram sim's viaduct (deck ~7.5 m up, 30 m pillar bays).
    const DECK_TOP_Z = 7.5;
    const DECK_THICK = 1.0;
    const PILLAR_HEIGHT = 6.15;
    const CAP_HEIGHT = 0.35;
    const DECK_WIDTH = 3.4;
    const RAIL_GAUGE = 1.435;
    const RAIL_W = 0.10;
    const RAIL_H = 0.12;
    const PILLAR_SPACING = 30;
    const SURFACE_TRACKBED_Z = 0.33;
    const SURFACE_TRACKBED_H = 0.04;
    const SURFACE_RAIL_Z = 0.43;
    const SURFACE_SLEEPER_Z = 0.375;
    const SURFACE_SLEEPER_SPACING = 1.35;

    const COLOR_CONCRETE = 0xb8b6ad;
    const COLOR_CONCRETE_CAP = 0xa6a49b;
    const COLOR_STEEL = 0x6b7280;
    const COLOR_RAIL = 0x9aa1ab;

    // Resample one projected polyline at uniform arc length. Returns ordered samples
    // [{x, y}] including both endpoints, so girders reach the ends of every way.
    function resampleXY(points, spacing) {
        const samples = [];
        if (!Array.isArray(points) || points.length < 2) return samples;
        samples.push({ x: points[0][0], y: points[0][1] });
        let carried = 0;
        for (let i = 0; i < points.length - 1; i++) {
            const x1 = points[i][0];
            const y1 = points[i][1];
            const x2 = points[i + 1][0];
            const y2 = points[i + 1][1];
            const len = Math.hypot(x2 - x1, y2 - y1);
            if (len < 1e-9) continue;
            let dist = spacing - carried;
            while (dist <= len) {
                samples.push({ x: x1 + ((x2 - x1) * dist) / len, y: y1 + ((y2 - y1) * dist) / len });
                dist += spacing;
            }
            carried = len - (dist - spacing);
        }
        const lastPoint = points[points.length - 1];
        const lastSample = samples[samples.length - 1];
        if (Math.hypot(lastPoint[0] - lastSample.x, lastPoint[1] - lastSample.y) > 1) {
            samples.push({ x: lastPoint[0], y: lastPoint[1] });
        }
        return samples;
    }

    function geometryLineParts(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'LineString') return [geometry.coordinates || []];
        if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
        return [];
    }

    function segmentDistanceToOrigin(ax, ay, bx, by) {
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq > 1e-9 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq)) : 0;
        return Math.hypot(ax + dx * t, ay + dy * t);
    }

    // Converts GeoJSON polylines to the immutable segment snapshot used by the surface renderer.
    // Culling happens here once; moving the 3D camera never fetches or adds more track geometry.
    function projectRailSegments(featureCollection, coordsToXY, maxRadius) {
        if (typeof coordsToXY !== 'function') return [];
        const radius = Number(maxRadius) > 0 ? Number(maxRadius) : Infinity;
        const features = Array.isArray(featureCollection?.features) ? featureCollection.features : [];
        const segments = [];
        for (const feature of features) {
            for (const part of geometryLineParts(feature?.geometry)) {
                const points = (part || []).map(coordsToXY).filter(point => (
                    Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
                ));
                for (let index = 0; index < points.length - 1; index++) {
                    const ax = Number(points[index][0]);
                    const ay = Number(points[index][1]);
                    const bx = Number(points[index + 1][0]);
                    const by = Number(points[index + 1][1]);
                    const length = Math.hypot(bx - ax, by - ay);
                    if (length < 0.2 || segmentDistanceToOrigin(ax, ay, bx, by) > radius) continue;
                    segments.push({
                        ax, ay, bx, by, length,
                        cx: (ax + bx) * 0.5,
                        cy: (ay + by) * 0.5,
                        angle: Math.atan2(by - ay, bx - ax)
                    });
                }
            }
        }
        return segments;
    }

    // Build the viaduct for a GeoJSON FeatureCollection of rail LineStrings.
    // coordsToXY: [lng, lat] -> [x, y] in scene units; maxRadius: scene-unit cull radius
    // around the scene origin (the 3D view is always centred on the origin).
    function buildElevatedRail3D(featureCollection, coordsToXY, options = {}) {
        const THREE = global.THREE;
        if (!THREE) {
            console.error('[elevated-rail] THREE unavailable — existing rail cannot render');
            return null;
        }
        if (typeof coordsToXY !== 'function') {
            console.error('[elevated-rail] coordsToXY projector missing');
            return null;
        }
        const maxRadius = Number(options.maxRadius) > 0 ? Number(options.maxRadius) : 7000;
        const features = (featureCollection && Array.isArray(featureCollection.features))
            ? featureCollection.features
            : [];

        const pillars = [];
        const girders = [];
        features.forEach(feature => {
            const geometry = feature && feature.geometry;
            if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return;
            const projected = geometry.coordinates.map(coordsToXY);
            const samples = resampleXY(projected, PILLAR_SPACING);
            for (let i = 0; i < samples.length - 1; i++) {
                const a = samples[i];
                const b = samples[i + 1];
                const cx = (a.x + b.x) / 2;
                const cy = (a.y + b.y) / 2;
                if (Math.hypot(cx, cy) > maxRadius) continue;
                const chord = Math.hypot(b.x - a.x, b.y - a.y);
                if (chord < 1) continue;
                girders.push({ cx, cy, angle: Math.atan2(b.y - a.y, b.x - a.x), chord });
                pillars.push(a);
                if (i === samples.length - 2) pillars.push(b);
            }
        });
        if (!girders.length) return null;

        const group = new THREE.Group();
        const dummy = new THREE.Object3D();

        const concreteMat = new THREE.MeshLambertMaterial({ color: COLOR_CONCRETE });
        const capMat = new THREE.MeshLambertMaterial({ color: COLOR_CONCRETE_CAP });
        const girderMat = new THREE.MeshLambertMaterial({ color: COLOR_STEEL });
        const railMat = new THREE.MeshPhongMaterial({ color: COLOR_RAIL, specular: 0x555b66, shininess: 60 });

        // Pillars: shaft + cap, both standing on the ground plane.
        const shaftGeo = new THREE.BoxGeometry(0.9, 0.9, PILLAR_HEIGHT);
        shaftGeo.translate(0, 0, PILLAR_HEIGHT / 2);
        const capGeo = new THREE.BoxGeometry(1.8, 1.8, CAP_HEIGHT);
        capGeo.translate(0, 0, PILLAR_HEIGHT + CAP_HEIGHT / 2);
        const shaftMesh = new THREE.InstancedMesh(shaftGeo, concreteMat, pillars.length);
        const capMesh = new THREE.InstancedMesh(capGeo, capMat, pillars.length);
        pillars.forEach((p, index) => {
            dummy.position.set(p.x, p.y, 0);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            shaftMesh.setMatrixAt(index, dummy.matrix);
            capMesh.setMatrixAt(index, dummy.matrix);
        });
        group.add(shaftMesh);
        group.add(capMesh);

        // Girders: one 30 m box per bay, stretched to the actual chord and rotated to the
        // track tangent. Rails ride the same transform, offset half a gauge to each side.
        const girderGeo = new THREE.BoxGeometry(PILLAR_SPACING, DECK_WIDTH, DECK_THICK);
        girderGeo.translate(0, 0, DECK_TOP_Z - DECK_THICK / 2);
        const railGeo = new THREE.BoxGeometry(PILLAR_SPACING, RAIL_W, RAIL_H);
        railGeo.translate(0, 0, DECK_TOP_Z + RAIL_H / 2 + 0.02);
        const girderMesh = new THREE.InstancedMesh(girderGeo, girderMat, girders.length);
        const railMesh = new THREE.InstancedMesh(railGeo, railMat, girders.length * 2);
        girders.forEach((girder, index) => {
            const scaleX = girder.chord / PILLAR_SPACING;
            dummy.position.set(girder.cx, girder.cy, 0);
            dummy.rotation.set(0, 0, girder.angle);
            dummy.scale.set(scaleX, 1, 1);
            dummy.updateMatrix();
            girderMesh.setMatrixAt(index, dummy.matrix);

            const nx = -Math.sin(girder.angle);
            const ny = Math.cos(girder.angle);
            [-1, 1].forEach((side, railIndex) => {
                const offset = (RAIL_GAUGE / 2) * side;
                dummy.position.set(girder.cx + nx * offset, girder.cy + ny * offset, 0);
                dummy.rotation.set(0, 0, girder.angle);
                dummy.scale.set(scaleX, 1, 1);
                dummy.updateMatrix();
                railMesh.setMatrixAt(index * 2 + railIndex, dummy.matrix);
            });
        });
        group.add(girderMesh);
        group.add(railMesh);
        return group;
    }

    // Existing OSM tram alignments: a restrained paved bed, sleepers and two steel rails.
    // The physical z separation keeps them smooth over the existing-road surface without depth bias.
    function buildSurfaceRail3D(featureCollection, coordsToXY, options = {}) {
        const THREE = global.THREE;
        if (!THREE) {
            console.error('[surface-rail] THREE unavailable — existing tram tracks cannot render');
            return null;
        }
        const maxRadius = Number(options.maxRadius) > 0 ? Number(options.maxRadius) : 7000;
        const gauge = Number(options.gaugeM) > 0 ? Number(options.gaugeM) : 1.0;
        const segments = projectRailSegments(featureCollection, coordsToXY, maxRadius);
        if (!segments.length) return null;

        const sleepers = [];
        for (const segment of segments) {
            const count = Math.max(1, Math.floor(segment.length / SURFACE_SLEEPER_SPACING));
            for (let index = 0; index <= count; index++) {
                const t = index / count;
                sleepers.push({
                    x: segment.ax + (segment.bx - segment.ax) * t,
                    y: segment.ay + (segment.by - segment.ay) * t,
                    angle: segment.angle
                });
            }
        }

        const group = new THREE.Group();
        group.name = 'ExistingSurfaceRail';
        group.userData.isExistingTransitAlignment = true;
        group.userData.renderStyle = 'surface';
        const dummy = new THREE.Object3D();
        const bedMat = new THREE.MeshLambertMaterial({ color: 0x9a9488 });
        const sleeperMat = new THREE.MeshLambertMaterial({ color: 0x5f554a });
        const railMat = new THREE.MeshPhongMaterial({ color: COLOR_RAIL, specular: 0x555b66, shininess: 60 });
        const bedGeo = new THREE.BoxGeometry(1, gauge + 1.15, SURFACE_TRACKBED_H);
        const sleeperGeo = new THREE.BoxGeometry(0.16, gauge + 0.72, 0.06);
        const railGeo = new THREE.BoxGeometry(1, RAIL_W, RAIL_H);
        const bedMesh = new THREE.InstancedMesh(bedGeo, bedMat, segments.length);
        const sleeperMesh = new THREE.InstancedMesh(sleeperGeo, sleeperMat, sleepers.length);
        const railMesh = new THREE.InstancedMesh(railGeo, railMat, segments.length * 2);

        segments.forEach((segment, index) => {
            dummy.position.set(segment.cx, segment.cy, SURFACE_TRACKBED_Z);
            dummy.rotation.set(0, 0, segment.angle);
            dummy.scale.set(segment.length, 1, 1);
            dummy.updateMatrix();
            bedMesh.setMatrixAt(index, dummy.matrix);

            const nx = -Math.sin(segment.angle);
            const ny = Math.cos(segment.angle);
            [-1, 1].forEach((side, railIndex) => {
                const offset = side * gauge * 0.5;
                dummy.position.set(segment.cx + nx * offset, segment.cy + ny * offset, SURFACE_RAIL_Z);
                dummy.rotation.set(0, 0, segment.angle);
                dummy.scale.set(segment.length, 1, 1);
                dummy.updateMatrix();
                railMesh.setMatrixAt(index * 2 + railIndex, dummy.matrix);
            });
        });
        sleepers.forEach((sleeper, index) => {
            dummy.position.set(sleeper.x, sleeper.y, SURFACE_SLEEPER_Z);
            dummy.rotation.set(0, 0, sleeper.angle);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            sleeperMesh.setMatrixAt(index, dummy.matrix);
        });
        bedMesh.instanceMatrix.needsUpdate = true;
        sleeperMesh.instanceMatrix.needsUpdate = true;
        railMesh.instanceMatrix.needsUpdate = true;
        group.add(bedMesh, sleeperMesh, railMesh);
        return group;
    }

    global.buildElevatedRail3D = buildElevatedRail3D;
    global.buildSurfaceRail3D = buildSurfaceRail3D;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { resampleXY, segmentDistanceToOrigin, projectRailSegments, buildElevatedRail3D, buildSurfaceRail3D };
    }
})(typeof window !== 'undefined' ? window : globalThis);
