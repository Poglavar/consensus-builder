// Parks and Squares (structures) management

(function () {
    // In-memory and persisted storage for parks
    const STORAGE_KEY = 'cb_parks';
    const STORAGE_KEY_SQUARES = 'cb_squares';
    const STORAGE_KEY_LAKES = 'cb_lakes';
    const DECORATION_VERSION = 2; // bump when changing decoration generation rules
    const LAKE_GRAPHICS_VERSION = 3;
    const LAKE_SHORE_TARGET_RATIO = 0.2;
    window.parks = Array.isArray(window.parks) ? window.parks : [];
    window.squares = Array.isArray(window.squares) ? window.squares : [];
    window.lakes = Array.isArray(window.lakes) ? window.lakes : [];
    let parksLayer = null;
    let squaresLayer = null;
    let lakesLayer = null;
    // Dedicated Canvas renderer for dense square textures (faster than SVG)
    let squareTextureRenderer = null;
    const SQUARES_PANE = 'squaresPane';
    const SQUARES_ICON_PANE = 'squaresIconPane';
    const PARKS_PANE = 'parksPane';
    const LAKES_PANE = 'lakesPane';

    function ensureSquaresPane() {
        if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
        let pane = map.getPane(SQUARES_PANE);
        if (!pane && typeof map.createPane === 'function') {
            pane = map.createPane(SQUARES_PANE);
            if (pane && pane.style) {
                pane.style.zIndex = '630'; // Above parcels/buildings
                pane.style.pointerEvents = 'none'; // Let clicks reach underlying parcels
            }
        }
        return pane;
    }

    function ensureSquaresIconPane() {
        if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
        let pane = map.getPane(SQUARES_ICON_PANE);
        if (!pane && typeof map.createPane === 'function') {
            pane = map.createPane(SQUARES_ICON_PANE);
            if (pane && pane.style) {
                pane.style.zIndex = '632'; // Above square surfaces/texture
                pane.style.pointerEvents = 'none';
            }
        }
        return pane;
    }

    function ensureParksPane() {
        if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
        let pane = map.getPane(PARKS_PANE);
        if (!pane && typeof map.createPane === 'function') {
            pane = map.createPane(PARKS_PANE);
            if (pane && pane.style) {
                pane.style.zIndex = '625'; // Above parcels
                pane.style.pointerEvents = 'none';
            }
        }
        return pane;
    }

    function ensureLakesPane() {
        if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
        let pane = map.getPane(LAKES_PANE);
        if (!pane && typeof map.createPane === 'function') {
            pane = map.createPane(LAKES_PANE);
            if (pane && pane.style) {
                pane.style.zIndex = '627';
                pane.style.pointerEvents = 'none';
            }
        }
        return pane;
    }

    // Provide a safe stub so UI handlers never break even if initialization fails early
    if (!window.toggleSquaresVisibility) {
        window.toggleSquaresVisibility = function () {
            try {
                const el = document.getElementById('showSquaresCheckbox');
                const shouldShow = !el || el.checked;
                const layer = squaresLayer || window.squaresLayerRef;
                if (!layer || !map) return;
                const onMap = map.hasLayer(layer);
                if (shouldShow && !onMap) {
                    layer.addTo(map);
                    try { updateSquaresLayer && updateSquaresLayer(); } catch (_) { }
                } else if (!shouldShow && onMap) {
                    try { map.removeLayer(layer); } catch (_) { }
                }
            } catch (_) { /* swallow to avoid handler breakage */ }
        };
    }

    function saveParks() {
        try {
            PersistentStorage.setItem(STORAGE_KEY, JSON.stringify(window.parks));
        } catch (e) { console.warn('Failed to save parks', e); }
    }

    function loadParks() {
        try {
            const raw = PersistentStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                window.parks = arr.filter(f => f && f.type === 'Feature' && f.geometry);
            }
        } catch (e) { console.warn('Failed to load parks', e); }
    }

    function saveSquares() {
        try { PersistentStorage.setItem(STORAGE_KEY_SQUARES, JSON.stringify(window.squares)); } catch (e) { console.warn('Failed to save squares', e); }
    }
    function loadSquares() {
        try {
            const raw = PersistentStorage.getItem(STORAGE_KEY_SQUARES);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) window.squares = arr.filter(f => f && f.type === 'Feature' && f.geometry);
        } catch (e) { console.warn('Failed to load squares', e); }
    }

    function saveLakes() {
        try { PersistentStorage.setItem(STORAGE_KEY_LAKES, JSON.stringify(window.lakes)); } catch (e) { console.warn('Failed to save lakes', e); }
    }
    function loadLakes() {
        try {
            const raw = PersistentStorage.getItem(STORAGE_KEY_LAKES);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) window.lakes = arr.filter(f => f && f.type === 'Feature' && f.geometry);
        } catch (e) { console.warn('Failed to load lakes', e); }
    }

    function featureBbox(feature) {
        try { return turf.bbox(feature); } catch (_) { return null; }
    }

    function pointInFeature(pt, feature) {
        try { return turf.booleanPointInPolygon(pt, feature); } catch (_) { return false; }
    }

    // A road/track built through a structure cuts through it: rendering subtracts every applied
    // corridor footprint at draw time. Stored geometry is never mutated, so the structure stays
    // ONE proposal (its visible geometry a multipolygon around the corridor) and unapplying or
    // moving the road heals the park/square/lake automatically.
    function appliedCorridorCutters() {
        const cutters = [];
        try {
            const storage = window.proposalStorage;
            if (!storage || typeof storage.getAllProposals !== 'function') return cutters;
            storage.getAllProposals().forEach(p => {
                const rp = p && p.roadProposal;
                const polygon = rp && rp.definition && rp.definition.polygon;
                if (!polygon || !polygon.type) return;
                if (!isApplied(p, rp)) return;
                cutters.push({ type: 'Feature', properties: {}, geometry: polygon });
            });
        } catch (_) { }
        return cutters;
    }

    // Geometry minus the given corridor cutters; null when nothing visible remains.
    function subtractCorridorsFromGeometry(geometry, cutters) {
        if (!geometry || !Array.isArray(cutters) || !cutters.length || typeof turf === 'undefined') return geometry;
        let current = { type: 'Feature', properties: {}, geometry };
        for (const cutter of cutters) {
            try {
                if (!turf.booleanIntersects(current, cutter)) continue;
                const diff = turf.difference(current, cutter);
                if (!diff || !diff.geometry) return null;
                current = diff;
            } catch (_) { }
        }
        return current.geometry;
    }

    // Cut clone sharing the original's properties (decorations stay persisted on the original).
    function cutStructureFeature(feature, cutters) {
        const geometry = subtractCorridorsFromGeometry(feature && feature.geometry, cutters);
        if (!geometry) return null;
        if (geometry === feature.geometry) return feature;
        return { type: 'Feature', properties: feature.properties, geometry };
    }

    function randomPointsInside(feature, count) {
        const out = [];
        const bbox = featureBbox(feature) || [0, 0, 0, 0];
        let attempts = 0;
        while (out.length < count && attempts < count * 20) {
            attempts++;
            const p = turf.randomPoint(1, { bbox }).features[0];
            if (pointInFeature(p, feature)) out.push(p);
        }
        return out;
    }

    function createEllipse(centerLngLat, rxDeg, ryDeg, segments = 48, rotRad = 0) {
        const [lng0, lat0] = centerLngLat;
        const pts = [];
        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const x = Math.cos(t) * rxDeg;
            const y = Math.sin(t) * ryDeg;
            const xr = x * Math.cos(rotRad) - y * Math.sin(rotRad);
            const yr = x * Math.sin(rotRad) + y * Math.cos(rotRad);
            pts.push([lng0 + xr, lat0 + yr]);
        }
        return pts;
    }

    function drawParkDecorations(group, parkFeature) {
        if (!parkFeature || !parkFeature.geometry) return;
        // While the geometry editor is editing THIS structure, it renders the live editable
        // copy — the static one would duplicate every object underneath it.
        if (window.structureGeometryEditorEditingProposalId
            && String(parkFeature?.properties?.proposalId || '') === String(window.structureGeometryEditorEditingProposalId)) {
            return;
        }
        // Ensure deterministic decorations are present and persisted
        ensureParkDecorations(parkFeature);
        const decorations = (parkFeature.properties && parkFeature.properties.decorations) ? parkFeature.properties.decorations : null;
        if (!decorations) return;
        const ponds = Array.isArray(decorations.ponds) ? decorations.ponds : [];
        const flowerbeds = Array.isArray(decorations.flowerbeds) ? decorations.flowerbeds : [];
        const paths = Array.isArray(decorations.paths) ? decorations.paths : [];
        const treePoints = Array.isArray(decorations.trees) ? decorations.trees : [];
        const benches = Array.isArray(decorations.benches) ? decorations.benches : [];

        // Winding paths: two or three dashed polylines across bbox, clipped by keeping only inside points
        // Draw stored paths
        paths.forEach(coords => {
            try {
                const latlngs = coords.map(c => [c[1], c[0]]);
                if (latlngs.length > 1) {
                    const pl = L.polyline(latlngs, { color: '#dfe8d6', weight: 2, opacity: 0.85, dashArray: '6,6', interactive: false, pane: PARKS_PANE }).addTo(group);
                    try { pl.bringToFront && pl.bringToFront(); } catch (_) { }
                }
            } catch (_) { }
        });

        // Render ponds after paths so they appear above paths
        ponds.forEach(ringCoords => {
            try {
                const latlngs = ringCoords.map(p => [p[1], p[0]]);
                L.polygon(latlngs, {
                    color: '#1e63b0', weight: 1.5, opacity: 0.95,
                    fillColor: '#2b6cb0', fillOpacity: 0.88, interactive: false, pane: PARKS_PANE
                }).addTo(group);
            } catch (_) { }
        });

        flowerbeds.forEach(ringCoords => {
            try {
                const latlngs = ringCoords.map(point => [point[1], point[0]]);
                L.polygon(latlngs, {
                    color: '#be185d', weight: 1.5, opacity: 0.95,
                    fillColor: '#f472b6', fillOpacity: 0.82, interactive: false, pane: PARKS_PANE
                }).addTo(group);
            } catch (_) { }
        });

        // Sprinkle tree emojis; avoid placing trees in ponds
        try {
            // Skip trees that fall outside the rendered geometry (e.g. on a road cut through the park)
            const trees = treePoints.filter(coord => {
                try { return pointInFeature(turf.point(coord), parkFeature); } catch (_) { return true; }
            });
            trees.forEach(coord => {
                const [lng, lat] = coord;
                // Skip if inside any pond
                // Decorations already avoid ponds during generation
                L.marker([lat, lng], {
                    icon: L.divIcon({
                        className: 'park-tree-emoji',
                        html: '🌳',
                        iconSize: [20, 20],
                        iconAnchor: [10, 10]
                    }),
                    pane: PARKS_PANE,
                    interactive: false
                }).addTo(group);
            });
        } catch (_) { }

        // Benches (placed in the geometry editor): draggable only inside the editor —
        // here they render as static glyphs, like the trees.
        try {
            benches.forEach(bench => {
                const coord = Array.isArray(bench?.coordinate) ? bench.coordinate : bench;
                if (!Array.isArray(coord) || coord.length < 2) return;
                try { if (!pointInFeature(turf.point(coord), parkFeature)) return; } catch (_) { }
                const [lng, lat] = coord;
                L.marker([lat, lng], {
                    icon: L.divIcon({
                        className: 'park-bench-glyph',
                        html: `<span style="display:inline-block;transform:rotate(${Math.round(Number(bench?.bearing) || 0)}deg);color:#7c4a12;font-size:12px;">▰</span>`,
                        iconSize: [14, 14],
                        iconAnchor: [7, 7]
                    }),
                    pane: PARKS_PANE,
                    interactive: false
                }).addTo(group);
            });
        } catch (_) { }
    }

    function ensureParkDecorations(parkFeature) {
        try {
            if (!parkFeature || !parkFeature.geometry) return;
            const props = parkFeature.properties = parkFeature.properties || {};
            // If decorations exist, verify and upgrade if needed (e.g., ensure paths avoid ponds)
            if (props.decorations && typeof props.decorations === 'object') {
                const dec = props.decorations;
                // Ensure structure of decorations object
                dec.ponds = Array.isArray(dec.ponds) ? dec.ponds : [];
                dec.flowerbeds = Array.isArray(dec.flowerbeds) ? dec.flowerbeds : [];
                dec.paths = Array.isArray(dec.paths) ? dec.paths : [];
                dec.trees = Array.isArray(dec.trees) ? dec.trees : [];

                // Helper to check if any path point lies within any pond
                const pathCrossesPonds = () => {
                    if (!dec.ponds.length || !dec.paths.length) return false;
                    try {
                        const pondPolys = dec.ponds.map(r => turf.polygon([r]));
                        for (let pi = 0; pi < dec.paths.length; pi++) {
                            const coords = dec.paths[pi];
                            for (let ci = 0; ci < coords.length; ci++) {
                                const pt = turf.point(coords[ci]);
                                for (let k = 0; k < pondPolys.length; k++) {
                                    if (turf.booleanPointInPolygon(pt, pondPolys[k])) return true;
                                }
                            }
                        }
                    } catch (_) { /* conservative: regenerate below */ }
                    return false;
                };

                // Conditions to regenerate paths: missing, empty, or crossing ponds
                const needsPathFix = (!dec.paths || dec.paths.length === 0) || pathCrossesPonds();
                const storedVer = typeof dec.version === 'number' ? dec.version : 0;
                if (needsPathFix || storedVer < DECORATION_VERSION) {
                    // Rebuild paths while preserving existing ponds and trees
                    const existingPonds = dec.ponds.slice();
                    // Generate boundary helpers once
                    const getBoundaryLines = () => {
                        let line = null; try { line = turf.polygonToLine(parkFeature); } catch (_) { }
                        const lines = [];
                        if (!line || !line.geometry) return lines;
                        if (line.geometry.type === 'LineString') lines.push(line);
                        else if (line.geometry.type === 'MultiLineString') (line.geometry.coordinates || []).forEach(coords => lines.push(turf.lineString(coords)));
                        return lines;
                    };
                    const boundaryLines = getBoundaryLines();
                    const lineLens = boundaryLines.map(l => { try { return turf.length(l, { units: 'kilometers' }); } catch (_) { return 0; } });
                    const totalLen = lineLens.reduce((a, b) => a + b, 0);
                    let b = null; try { b = turf.bbox(parkFeature); } catch (_) { }
                    const [minLng, minLat, maxLng, maxLat] = b || [0, 0, 0, 0];
                    const w = Math.max(1e-8, maxLng - minLng), h = Math.max(1e-8, maxLat - minLat);
                    const minDim = Math.min(w, h);
                    const classifySide = (lng, lat) => {
                        const dLeft = Math.abs(lng - minLng);
                        const dRight = Math.abs(maxLng - lng);
                        const dBottom = Math.abs(lat - minLat);
                        const dTop = Math.abs(lat - maxLat);
                        const m = Math.min(dLeft, dRight, dBottom, dTop);
                        if (m === dLeft) return 'left';
                        if (m === dRight) return 'right';
                        if (m === dTop) return 'top';
                        return 'bottom';
                    };
                    const randomBoundaryPointOnSide = (desiredSide) => {
                        if (!boundaryLines.length || totalLen <= 0) return null;
                        for (let attempt = 0; attempt < 60; attempt++) {
                            let r = Math.random() * totalLen;
                            let idx = 0;
                            while (idx < boundaryLines.length - 1 && r > lineLens[idx]) { r -= lineLens[idx]; idx++; }
                            const chosen = boundaryLines[idx];
                            const dKm = Math.random() * (lineLens[idx] || 0);
                            let pt = null; try { pt = turf.along(chosen, dKm, { units: 'kilometers' }); } catch (_) { pt = null; }
                            if (!pt || !pt.geometry) continue;
                            const [lng, lat] = pt.geometry.coordinates;
                            const side = classifySide(lng, lat);
                            if (!desiredSide || side === desiredSide) return pt;
                        }
                        try {
                            const i = Math.floor(Math.random() * boundaryLines.length);
                            const dKm = Math.random() * (lineLens[i] || 0);
                            return turf.along(boundaryLines[i], dKm, { units: 'kilometers' });
                        } catch (_) { return null; }
                    };

                    const sides = ['left', 'right', 'top', 'bottom'];
                    const pathCount = 2 + Math.round(Math.random());
                    const newPaths = [];
                    for (let p = 0; p < pathCount; p++) {
                        const s1 = sides[Math.floor(Math.random() * sides.length)];
                        let s2 = sides[Math.floor(Math.random() * sides.length)];
                        if (s2 === s1) s2 = sides[(sides.indexOf(s1) + 1 + Math.floor(Math.random() * 3)) % 4];
                        const start = randomBoundaryPointOnSide(s1) || randomBoundaryPointOnSide(null);
                        const end = randomBoundaryPointOnSide(s2) || randomBoundaryPointOnSide(null);
                        if (!start || !end) continue;
                        const [sx, sy] = start.geometry.coordinates;
                        const [ex, ey] = end.geometry.coordinates;
                        const vx = ex - sx, vy = ey - sy; const vLen = Math.hypot(vx, vy) || 1e-9;
                        const ux = -vy / vLen, uy = vx / vLen;
                        const amp = minDim * (0.05 + Math.random() * 0.05);
                        const freq = 0.5 + Math.random() * 1.5;
                        const phase = Math.random() * Math.PI * 2;
                        const steps = 90;
                        const pts = [];
                        for (let i = 0; i <= steps; i++) {
                            const t = i / steps;
                            const baseLng = sx + vx * t;
                            const baseLat = sy + vy * t;
                            const off = Math.sin(t * Math.PI * 2 * freq + phase) * amp;
                            const lng = baseLng + ux * off;
                            const lat = baseLat + uy * off;
                            const pt = turf.point([lng, lat]);
                            let ok = pointInFeature(pt, parkFeature);
                            if (ok && existingPonds.length) {
                                try { ok = !existingPonds.some(ring => turf.booleanPointInPolygon(pt, turf.polygon([ring]))); } catch (_) { }
                            }
                            if (ok) pts.push([lng, lat]);
                        }
                        if (pts.length > 1) newPaths.push(pts);
                    }

                    // Fallback interior wiggle paths if boundary-based failed
                    if (newPaths.length === 0 && b) {
                        const extraCount = 2 + Math.round(Math.random());
                        for (let pi = 0; pi < extraCount; pi++) {
                            const cy = minLat + (0.2 + 0.6 * Math.random()) * h;
                            const amp = h * (0.08 + Math.random() * 0.06);
                            const freq = 1 + Math.random();
                            const phase = Math.random() * Math.PI * 2;
                            const steps = 96;
                            const pts = [];
                            for (let i = 0; i <= steps; i++) {
                                const t = i / steps;
                                const lng = minLng + t * w;
                                const lat = cy + Math.sin(t * Math.PI * 2 * freq + phase) * amp;
                                const pt = turf.point([lng, lat]);
                                let ok = pointInFeature(pt, parkFeature);
                                if (ok && existingPonds.length) {
                                    try { ok = !existingPonds.some(ring => turf.booleanPointInPolygon(pt, turf.polygon([ring]))); } catch (_) { }
                                }
                                if (ok) pts.push([lng, lat]);
                            }
                            if (pts.length > 1) newPaths.push(pts);
                        }
                    }

                    dec.paths = newPaths;
                    dec.version = DECORATION_VERSION;
                    saveParks();
                }
                return; // existing decorations verified/upgraded
            }

            // Compute bbox
            let bbox = null; try { bbox = turf.bbox(parkFeature); } catch (_) { }
            const ponds = [];
            if (bbox) {
                const [minLng, minLat, maxLng, maxLat] = bbox;
                const w = Math.max(1e-8, Math.abs(maxLng - minLng));
                const h = Math.max(1e-8, Math.abs(maxLat - minLat));
                const pondCount = 1 + Math.floor(Math.random() * 3); // 1..3
                let safety = 0;
                while (ponds.length < pondCount && safety < pondCount * 60) {
                    safety++;
                    const marginLng = w * 0.05;
                    const marginLat = h * 0.05;
                    const cx = minLng + marginLng + Math.random() * Math.max(1e-8, (w - 2 * marginLng));
                    const cy = minLat + marginLat + Math.random() * Math.max(1e-8, (h - 2 * marginLat));
                    const rLng = (Math.min(w, h) * (0.03 + 0.06 * Math.random()));
                    const rLat = rLng * (0.9 + Math.random() * 0.2);
                    const rot = Math.random() * Math.PI * 2;
                    const ring = createEllipse([cx, cy], rLng, rLat, 64, rot);
                    const ringClosed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
                        ? ring
                        : ring.concat([ring[0]]);
                    const poly = turf.polygon([ringClosed]);
                    try { if (turf.booleanWithin(poly, parkFeature)) ponds.push(ringClosed); } catch (_) { }
                }
            }

            // Boundary helpers for paths
            const getBoundaryLines = () => {
                let line = null; try { line = turf.polygonToLine(parkFeature); } catch (_) { }
                const lines = [];
                if (!line || !line.geometry) return lines;
                if (line.geometry.type === 'LineString') lines.push(line);
                else if (line.geometry.type === 'MultiLineString') (line.geometry.coordinates || []).forEach(coords => lines.push(turf.lineString(coords)));
                return lines;
            };
            const boundaryLines = getBoundaryLines();
            const lineLens = boundaryLines.map(l => { try { return turf.length(l, { units: 'kilometers' }); } catch (_) { return 0; } });
            const totalLen = lineLens.reduce((a, b) => a + b, 0);

            // BBox sides classifier for selecting different sides
            let b = null; try { b = turf.bbox(parkFeature); } catch (_) { }
            const [minLng, minLat, maxLng, maxLat] = b || [0, 0, 0, 0];
            const w = Math.max(1e-8, maxLng - minLng), h = Math.max(1e-8, maxLat - minLat);
            const minDim = Math.min(w, h);
            const classifySide = (lng, lat) => {
                const dLeft = Math.abs(lng - minLng);
                const dRight = Math.abs(maxLng - lng);
                const dBottom = Math.abs(lat - minLat);
                const dTop = Math.abs(lat - maxLat);
                const m = Math.min(dLeft, dRight, dBottom, dTop);
                if (m === dLeft) return 'left';
                if (m === dRight) return 'right';
                if (m === dTop) return 'top';
                return 'bottom';
            };
            const randomBoundaryPointOnSide = (desiredSide) => {
                if (!boundaryLines.length || totalLen <= 0) return null;
                for (let attempt = 0; attempt < 60; attempt++) {
                    let r = Math.random() * totalLen;
                    let idx = 0;
                    while (idx < boundaryLines.length - 1 && r > lineLens[idx]) { r -= lineLens[idx]; idx++; }
                    const chosen = boundaryLines[idx];
                    const dKm = Math.random() * (lineLens[idx] || 0);
                    let pt = null; try { pt = turf.along(chosen, dKm, { units: 'kilometers' }); } catch (_) { pt = null; }
                    if (!pt || !pt.geometry) continue;
                    const [lng, lat] = pt.geometry.coordinates;
                    const side = classifySide(lng, lat);
                    if (!desiredSide || side === desiredSide) return pt;
                }
                try {
                    const i = Math.floor(Math.random() * boundaryLines.length);
                    const dKm = Math.random() * (lineLens[i] || 0);
                    return turf.along(boundaryLines[i], dKm, { units: 'kilometers' });
                } catch (_) { return null; }
            };

            const sides = ['left', 'right', 'top', 'bottom'];
            const pathCount = 2 + Math.round(Math.random());
            const paths = [];
            for (let p = 0; p < pathCount; p++) {
                const s1 = sides[Math.floor(Math.random() * sides.length)];
                let s2 = sides[Math.floor(Math.random() * sides.length)];
                if (s2 === s1) s2 = sides[(sides.indexOf(s1) + 1 + Math.floor(Math.random() * 3)) % 4];
                const start = randomBoundaryPointOnSide(s1) || randomBoundaryPointOnSide(null);
                const end = randomBoundaryPointOnSide(s2) || randomBoundaryPointOnSide(null);
                if (!start || !end) continue;
                const [sx, sy] = start.geometry.coordinates;
                const [ex, ey] = end.geometry.coordinates;
                const vx = ex - sx, vy = ey - sy; const vLen = Math.hypot(vx, vy) || 1e-9;
                const ux = -vy / vLen, uy = vx / vLen;
                const amp = minDim * (0.05 + Math.random() * 0.05);
                const freq = 0.5 + Math.random() * 1.5;
                const phase = Math.random() * Math.PI * 2;
                const steps = 90;
                let seg = [];
                for (let i = 0; i <= steps; i++) {
                    const t = i / steps;
                    const baseLng = sx + vx * t;
                    const baseLat = sy + vy * t;
                    const off = Math.sin(t * Math.PI * 2 * freq + phase) * amp;
                    const lng = baseLng + ux * off;
                    const lat = baseLat + uy * off;
                    const pt = turf.point([lng, lat]);
                    let ok = pointInFeature(pt, parkFeature);
                    if (ok && ponds.length) {
                        try { ok = !ponds.some(ring => turf.booleanPointInPolygon(pt, turf.polygon([ring]))); } catch (_) { }
                    }
                    if (ok) {
                        seg.push([lng, lat]);
                    } else {
                        if (seg.length > 1) { paths.push(seg); }
                        seg = [];
                    }
                }
                if (seg.length > 1) paths.push(seg);
            }

            // Tree points (avoid ponds)
            let areaM2 = 0; try { areaM2 = turf.area(parkFeature); } catch (_) { }
            const treeCount = Math.max(5, Math.min(40, Math.round(areaM2 / 1500)));
            const trees = [];
            const candidates = randomPointsInside(parkFeature, treeCount * 2);
            for (let i = 0; i < candidates.length && trees.length < treeCount; i++) {
                const c = candidates[i];
                let inPond = false;
                if (ponds.length) {
                    try { inPond = ponds.some(ring => turf.booleanPointInPolygon(c, turf.polygon([ring]))); } catch (_) { inPond = false; }
                }
                if (!inPond) trees.push(c.geometry.coordinates);
            }

            // Fallback: if no paths created (complex shapes), create 2-3 interior wiggle paths across bbox
            if (paths.length === 0 && b) {
                const extraCount = 2 + Math.round(Math.random());
                for (let pi = 0; pi < extraCount; pi++) {
                    const cy = minLat + (0.2 + 0.6 * Math.random()) * h; // random band inside height
                    const amp = h * (0.08 + Math.random() * 0.06);
                    const freq = 1 + Math.random();
                    const phase = Math.random() * Math.PI * 2;
                    const steps = 96;
                    let seg = [];
                    for (let i = 0; i <= steps; i++) {
                        const t = i / steps;
                        const lng = minLng + t * w;
                        const lat = cy + Math.sin(t * Math.PI * 2 * freq + phase) * amp;
                        const pt = turf.point([lng, lat]);
                        let ok = pointInFeature(pt, parkFeature);
                        if (ok && ponds.length) {
                            try { ok = !ponds.some(ring => turf.booleanPointInPolygon(pt, turf.polygon([ring]))); } catch (_) { }
                        }
                        if (ok) {
                            seg.push([lng, lat]);
                        } else {
                            if (seg.length > 1) { paths.push(seg); }
                            seg = [];
                        }
                    }
                    if (seg.length > 1) paths.push(seg);
                }
            }

            props.decorations = { ponds, flowerbeds: [], paths, trees, version: DECORATION_VERSION };
            saveParks();
        } catch (_) { }
    }

    function ensureParksLayer() {
        ensureParksPane();
        if (parksLayer && map && map.hasLayer(parksLayer)) return parksLayer;
        if (parksLayer && map) { try { map.removeLayer(parksLayer); } catch (_) { } }
        parksLayer = L.layerGroup();
        // Respect parks visibility checkbox if present
        const showParksEl = document.getElementById('showParksCheckbox');
        const shouldShow = !showParksEl || showParksEl.checked;
        if (shouldShow) parksLayer.addTo(map);
        return parksLayer;
    }

    function ensureSquaresLayer() {
        ensureSquaresPane();
        ensureSquaresIconPane();
        if (squaresLayer && map && map.hasLayer(squaresLayer)) return squaresLayer;
        if (squaresLayer && map) { try { map.removeLayer(squaresLayer); } catch (_) { } }
        squaresLayer = L.layerGroup();
        window.squaresLayerRef = squaresLayer;
        const showSquaresEl = document.getElementById('showSquaresCheckbox');
        const shouldShow = !showSquaresEl || showSquaresEl.checked;
        if (shouldShow) squaresLayer.addTo(map);
        return squaresLayer;
    }

    function ensureLakesLayer() {
        ensureLakesPane();
        if (lakesLayer && map && map.hasLayer(lakesLayer)) return lakesLayer;
        if (lakesLayer && map) { try { map.removeLayer(lakesLayer); } catch (_) { } }
        lakesLayer = L.layerGroup();
        if (typeof map !== 'undefined' && map) lakesLayer.addTo(map);
        return lakesLayer;
    }

    function updateParksLayer() {
        // Structures demolish buildings by default: any structure change can raze or restore.
        try { if (typeof window !== 'undefined' && typeof window.rebuildBuildingLayerFromPool === 'function' && window.buildingFeaturePool?.length) window.rebuildBuildingLayerFromPool(); } catch (error) { console.error('[structures] building demolition refresh failed', error); }
        if (typeof map === 'undefined') return;
        ensureParksPane();
        const group = ensureParksLayer();

        // Force complete removal: remove from map, clear all layers, then re-add to map
        const wasOnMap = map && map.hasLayer(group);
        if (wasOnMap) {
            try { map.removeLayer(group); } catch (_) { }
        }
        try {
            // Collect all layers first to avoid iteration issues
            const layersToRemove = [];
            group.eachLayer(layer => {
                layersToRemove.push(layer);
            });
            // Remove each layer explicitly
            layersToRemove.forEach(layer => {
                try { group.removeLayer(layer); } catch (_) { }
            });
            // Also call clearLayers as a safety measure
            group.clearLayers();
        } catch (_) { }

        if (wasOnMap) {
            try { group.addTo(map); } catch (_) { }
        }

        const parkCutters = appliedCorridorCutters();
        (window.parks || []).forEach(parkFeature => {
            try {
                const renderFeature = cutStructureFeature(parkFeature, parkCutters);
                if (!renderFeature) return; // fully paved over by applied roads
                // Base grass polygon
                const base = L.geoJSON(renderFeature, {
                    style: {
                        color: '#0d3b1f', weight: 2, opacity: 1,
                        fillColor: '#1b5e20', fillOpacity: 0.65, pane: PARKS_PANE
                    },
                    interactive: false,
                    pane: PARKS_PANE
                });
                base.addTo(group);
                // Decorations
                drawParkDecorations(group, renderFeature);
            } catch (e) { console.warn('Failed to render a park', e); }
        });

        try { group.bringToFront && group.bringToFront(); } catch (_) { }

        // Notify 3D to rebuild if needed
        try { window.dispatchEvent(new Event('parksUpdated')); } catch (_) { }
    }

    function drawSquareTexture(group, squareFeature) {
        // Subtle cobblestone-like texture: small random dots sprinkled inside the polygon
        try {
            if (!squareTextureRenderer && typeof L !== 'undefined' && L.canvas) {
                squareTextureRenderer = L.canvas({ padding: 0.5, pane: SQUARES_PANE });
            }
            const areaM2 = (() => { try { return turf.area(squareFeature); } catch (_) { return 0; } })();
            // Base density, then 10x multiplier as requested; cap to keep performance reasonable
            const base = Math.max(80, Math.min(360, Math.round(areaM2 / 110)));
            const count = Math.min(3000, base * 10);
            const pts = randomPointsInside(squareFeature, Math.floor(count * 1.5));
            let placed = 0;
            for (let i = 0; i < pts.length && placed < count; i++) {
                const c = pts[i] && pts[i].geometry && pts[i].geometry.coordinates;
                if (!c) continue;
                const [lng, lat] = c;
                const r = 1.6 + Math.random() * 1.2; // 1.6–2.8 px
                const opacity = 0.35 + Math.random() * 0.20; // 0.35–0.55
                // Mixed stones: darker grey and very light grey
                const useLight = Math.random() < 0.3; // 30% light stones
                const fill = useLight ? '#d2d2d2' : '#8a8a8a';
                L.circleMarker([lat, lng], {
                    radius: r,
                    color: fill,
                    weight: 0,
                    fillColor: fill,
                    fillOpacity: opacity,
                    renderer: squareTextureRenderer || undefined,
                    pane: SQUARES_PANE,
                    interactive: false
                }).addTo(group);
                placed++;
            }
        } catch (_) { }
    }

    function drawSquareDecorations(group, squareFeature) {
        if (!squareFeature || !squareFeature.geometry) return;
        // While the geometry editor is editing THIS structure, it renders the live editable
        // copy — the static one would duplicate every object underneath it.
        if (window.structureGeometryEditorEditingProposalId
            && String(squareFeature?.properties?.proposalId || '') === String(window.structureGeometryEditorEditingProposalId)) {
            return;
        }
        // Ensure decorations exist for legacy squares
        try { ensureSquareDecorations(squareFeature); } catch (_) { }
        const dec = squareFeature.properties && squareFeature.properties.decorations;
        if (!dec) return;
        // Subtle cobblestone texture first (under icons)
        drawSquareTexture(group, squareFeature);

        // Fountains (legacy squares store one `fountain`, edited squares store `fountains`).
        const fountains = Array.isArray(dec.fountains) ? dec.fountains : (Array.isArray(dec.fountain) ? [dec.fountain] : []);
        fountains.filter(coord => pointInFeature(turf.point(coord), squareFeature)).forEach(([lng, lat]) => {
            L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'square-fountain-emoji',
                    html: '<div style="font-size:28px;line-height:28px;">⛲️</div>',
                    iconSize: [28, 28],
                    iconAnchor: [14, 14]
                }),
                pane: SQUARES_ICON_PANE,
                zIndexOffset: 1000,
                interactive: false
            }).addTo(group);
        });
        (Array.isArray(dec.trees) ? dec.trees : [])
            .filter(coord => pointInFeature(turf.point(coord), squareFeature))
            .forEach(([lng, lat]) => {
                L.marker([lat, lng], {
                    icon: L.divIcon({ className: 'square-tree-emoji', html: '🌳', iconSize: [20, 20], iconAnchor: [10, 10] }),
                    pane: SQUARES_ICON_PANE,
                    zIndexOffset: 1000,
                    interactive: false
                }).addTo(group);
            });
        (Array.isArray(dec.benches) ? dec.benches : []).forEach(bench => {
            const coord = Array.isArray(bench) ? bench : (bench && (bench.coordinate || bench.position));
            if (!Array.isArray(coord) || !pointInFeature(turf.point(coord), squareFeature)) return;
            const bearing = Number(bench && bench.bearing) || 0;
            const [lng, lat] = coord;
            L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'square-bench-icon',
                    html: `<span style="display:block;transform:rotate(${bearing}deg);">▰</span>`,
                    iconSize: [22, 22],
                    iconAnchor: [11, 11]
                }),
                pane: SQUARES_ICON_PANE,
                zIndexOffset: 1000,
                interactive: false
            }).addTo(group);
        });
        // Stalls / terraces (skipped when they fall on a road cut through the square)
        const stalls = (Array.isArray(dec.stalls) ? dec.stalls : [])
            .filter(coord => pointInFeature(turf.point(coord), squareFeature));
        stalls.forEach(([lng, lat]) => {
            L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'square-stall-emoji',
                    html: '<div style="font-size:18px;line-height:18px;">🍽️</div>',
                    iconSize: [18, 18],
                    iconAnchor: [9, 9]
                }),
                pane: SQUARES_ICON_PANE,
                zIndexOffset: 1000,
                interactive: false
            }).addTo(group);
        });
        // Statues (one auto-placed per square; more placeable in the geometry editor)
        (Array.isArray(dec.statues) ? dec.statues : [])
            .filter(coord => Array.isArray(coord) && pointInFeature(turf.point(coord), squareFeature))
            .forEach(([lng, lat]) => {
                L.marker([lat, lng], {
                    icon: L.divIcon({
                        className: 'square-statue-emoji',
                        html: '<div style="font-size:20px;line-height:20px;">🗿</div>',
                        iconSize: [20, 20],
                        iconAnchor: [10, 10]
                    }),
                    pane: SQUARES_ICON_PANE,
                    zIndexOffset: 1000,
                    interactive: false
                }).addTo(group);
            });
    }

    // One statue per square by default: offset from the centre toward a corner, first
    // candidate inside the polygon wins (fountain owns the centre).
    function autoStatuePoint(squareFeature) {
        try {
            const bbox = featureBbox(squareFeature);
            if (!bbox) return null;
            const [minLng, minLat, maxLng, maxLat] = bbox;
            const cLng = (minLng + maxLng) / 2;
            const cLat = (minLat + maxLat) / 2;
            const dLng = (maxLng - minLng) * 0.28;
            const dLat = (maxLat - minLat) * 0.28;
            const candidates = [
                [cLng + dLng, cLat + dLat],
                [cLng - dLng, cLat - dLat],
                [cLng + dLng, cLat - dLat],
                [cLng - dLng, cLat + dLat]
            ];
            for (const candidate of candidates) {
                if (pointInFeature(turf.point(candidate), squareFeature)) return candidate;
            }
            const random = randomPointsInside(squareFeature, 5);
            const fallback = random && random[0] && random[0].geometry && random[0].geometry.coordinates;
            return Array.isArray(fallback) ? fallback : null;
        } catch (_) {
            return null;
        }
    }

    function ensureSquareDecorations(squareFeature) {
        try {
            if (!squareFeature || !squareFeature.geometry) return;
            const props = squareFeature.properties = squareFeature.properties || {};
            if (props.decorations && typeof props.decorations === 'object') {
                // Upgrade: squares predating statues get their one auto-placed statue.
                if (!Array.isArray(props.decorations.statues)) {
                    const statue = autoStatuePoint(squareFeature);
                    props.decorations.statues = statue ? [statue] : [];
                    saveSquares();
                }
                return;
            }
            // Fountain at centroid; ensure inside polygon by fallback random sampling
            let ctr = null;
            try { ctr = turf.centroid(squareFeature); } catch (_) { ctr = null; }
            let fountain = null;
            if (ctr && ctr.geometry && pointInFeature(ctr, squareFeature)) {
                fountain = ctr.geometry.coordinates; // [lng,lat]
            } else {
                const pts = randomPointsInside(squareFeature, 10);
                fountain = pts && pts[0] && pts[0].geometry && pts[0].geometry.coordinates;
                if (!Array.isArray(fountain)) {
                    // fallback to bbox center
                    const b = featureBbox(squareFeature) || [0, 0, 0, 0];
                    fountain = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
                }
            }
            // A few stalls near periphery but inside
            const stalls = [];
            const count = 2 + Math.round(Math.random() * 2); // 2..4
            const bbox = featureBbox(squareFeature) || [0, 0, 0, 0];
            const [minLng, minLat, maxLng, maxLat] = bbox;
            const w = Math.max(1e-8, maxLng - minLng), h = Math.max(1e-8, maxLat - minLat);
            let tries = 0;
            while (stalls.length < count && tries < 100) {
                tries++;
                const edge = Math.floor(Math.random() * 4);
                let lng = minLng + Math.random() * w;
                let lat = minLat + Math.random() * h;
                const margin = 0.06; // relative to minDim
                if (edge === 0) lat = minLat + h * margin;
                else if (edge === 1) lat = maxLat - h * margin;
                else if (edge === 2) lng = minLng + w * margin;
                else lng = maxLng - w * margin;
                const pt = turf.point([lng, lat]);
                if (pointInFeature(pt, squareFeature)) stalls.push([lng, lat]);
            }
            const statue = autoStatuePoint(squareFeature);
            props.decorations = { fountain, fountains: fountain ? [fountain] : [], trees: [], benches: [], stalls, statues: statue ? [statue] : [], version: 2 };
            saveSquares();
        } catch (_) { }
    }

    function computeLakeZones(baseFeature, options = {}) {
        const targetRatio = typeof options.targetShoreRatio === 'number'
            ? Math.max(0.05, Math.min(0.45, options.targetShoreRatio))
            : LAKE_SHORE_TARGET_RATIO;
        const baseArea = Math.max(0, turf.area(baseFeature) || 0);
        if (!baseArea) return null;

        let bbox = null;
        try { bbox = featureBbox(baseFeature); } catch (_) { bbox = null; }
        const [minLng, minLat, maxLng, maxLat] = Array.isArray(bbox) && bbox.length === 4 ? bbox : [0, 0, 0, 0];
        let widthMeters = 0;
        let heightMeters = 0;
        try { widthMeters = turf.distance([minLng, minLat], [maxLng, minLat], { units: 'meters' }); } catch (_) { widthMeters = 0; }
        try { heightMeters = turf.distance([minLng, minLat], [minLng, maxLat], { units: 'meters' }); } catch (_) { heightMeters = 0; }
        const minDim = Math.max(1, Math.min(Math.max(widthMeters, 0), Math.max(heightMeters, 0)));
        const minWidth = 0.5;
        const maxWidth = Math.max(minWidth, minDim * 0.45);
        const areaGuess = Math.sqrt(baseArea / Math.PI) * 0.105; // ~20% shore for circular shapes
        const widthHint = Math.max(minWidth, Math.min(maxWidth, typeof options.widthHintMeters === 'number' ? options.widthHintMeters : areaGuess));
        let low = minWidth;
        let high = maxWidth;
        let best = null;
        let bestBelow = null;

        for (let i = 0; i < 7; i++) {
            const width = (i === 0) ? widthHint : (low + high) / 2;
            let water = null;
            try { water = turf.buffer(baseFeature, -width, { units: 'meters', steps: 32 }); } catch (_) { water = null; }
            if (!water || !water.geometry || !water.geometry.coordinates || !water.geometry.coordinates.length) {
                high = Math.max(minWidth, width * 0.8);
                continue;
            }
            const waterArea = Math.max(0, turf.area(water) || 0);
            if (!waterArea) {
                high = Math.max(minWidth, width * 0.8);
                continue;
            }
            let shore = null;
            try { shore = turf.difference(baseFeature, water); } catch (_) { shore = null; }
            if (!shore) shore = baseFeature;
            const ratio = Math.max(0, Math.min(1, (baseArea - waterArea) / baseArea));
            const delta = Math.abs(ratio - targetRatio);
            const current = { water, shore, width, ratio, delta };
            if (ratio <= targetRatio && (!bestBelow || ratio > bestBelow.ratio)) bestBelow = current;
            if (!best || delta < best.delta) best = current;
            if (ratio > targetRatio) {
                high = width;
            } else {
                low = width;
            }
        }

        const chosen = bestBelow || best;
        if (!chosen) return null;

        let transition = null;
        try {
            const outerWidth = Math.max(minWidth, chosen.width * 0.55);
            const outer = turf.buffer(baseFeature, -outerWidth, { units: 'meters', steps: 32 });
            if (outer && outer.geometry && chosen.water && chosen.water.geometry) {
                try { transition = turf.difference(outer, chosen.water); } catch (_) { transition = null; }
            }
        } catch (_) { transition = null; }

        return {
            water: chosen.water,
            shore: chosen.shore,
            transition,
            width: chosen.width,
            ratio: chosen.ratio
        };
    }

    function ensureLakeGraphics(lakeFeature) {
        try {
            if (!lakeFeature || !lakeFeature.geometry) return;
            const props = lakeFeature.properties = lakeFeature.properties || {};
            const graphics = props.lakeGraphics;
            if (graphics && graphics.version === LAKE_GRAPHICS_VERSION && graphics.shore && (graphics.water || graphics.shore)) return;

            const geom = lakeFeature.geometry;
            const polygons = [];
            if (geom.type === 'Polygon') {
                polygons.push(turf.polygon(geom.coordinates));
            } else if (geom.type === 'MultiPolygon') {
                geom.coordinates.forEach(rings => polygons.push(turf.polygon(rings)));
            }
            if (!polygons.length) return;

            let merged = polygons[0];
            for (let i = 1; i < polygons.length; i++) {
                try {
                    const u = turf.union(merged, polygons[i]);
                    if (u && u.geometry) merged = u;
                } catch (_) { /* ignore */ }
            }
            const base = merged && merged.geometry ? merged : polygons[0];

            const zones = computeLakeZones(base, { targetShoreRatio: LAKE_SHORE_TARGET_RATIO });
            const shore = zones && zones.shore ? zones.shore : base;
            const water = zones && zones.water ? zones.water : null;
            const transitionRing = zones && zones.transition ? zones.transition : null;
            const shoreWidth = zones && zones.width ? zones.width : 6;

            const fish = [];
            const fishArea = water && water.geometry ? water : base;
            try {
                const bbox = featureBbox(fishArea) || [0, 0, 0, 0];
                const area = turf.area(fishArea) || 0;
                const desired = Math.max(4, Math.min(14, Math.round(area / 5000)));
                const candidates = turf.randomPoint(desired * 4, { bbox });
                candidates.features.forEach(pt => {
                    try {
                        if (turf.booleanPointInPolygon(pt, fishArea) && fish.length < desired) {
                            fish.push(pt.geometry.coordinates);
                        }
                    } catch (_) { }
                });
            } catch (_) { }

            props.lakeGraphics = {
                shore: shore && shore.geometry ? shore.geometry : shore,
                water: water && water.geometry ? water.geometry : null,
                transition: transitionRing && transitionRing.geometry ? transitionRing.geometry : null,
                fish,
                version: LAKE_GRAPHICS_VERSION,
                shoreWidthMeters: shoreWidth,
                shoreRatio: zones && typeof zones.ratio === 'number' ? zones.ratio : null
            };
            saveLakes();
        } catch (_) { }
    }

    function drawLakeDecorations(group, lakeFeature, corridorCutters = null) {
        if (!lakeFeature || !lakeFeature.geometry) return;
        try { ensureLakeGraphics(lakeFeature); } catch (_) { }
        const graphics = lakeFeature.properties && lakeFeature.properties.lakeGraphics;
        // Applied roads cut through every rendered zone (a causeway across the lake).
        const cutters = Array.isArray(corridorCutters) ? corridorCutters : [];
        const shoreGeom = subtractCorridorsFromGeometry(graphics && graphics.shore ? graphics.shore : lakeFeature.geometry, cutters);
        const waterGeom = subtractCorridorsFromGeometry(graphics && graphics.water ? graphics.water : null, cutters);
        const transitionGeom = subtractCorridorsFromGeometry(graphics && graphics.transition ? graphics.transition : null, cutters);

        if (shoreGeom) {
            L.geoJSON(shoreGeom, {
                style: { color: '#c48b4a', weight: 2, opacity: 0.9, fillColor: '#f3d7a0', fillOpacity: 0.9, pane: LAKES_PANE },
                interactive: false,
                pane: LAKES_PANE
            }).addTo(group);
        }
        if (transitionGeom) {
            L.geoJSON(transitionGeom, {
                style: { color: '#2c7abf', weight: 1.2, opacity: 0.55, fillColor: '#3c92d6', fillOpacity: 0.45, pane: LAKES_PANE },
                interactive: false,
                pane: LAKES_PANE
            }).addTo(group);
        }
        if (waterGeom) {
            L.geoJSON(waterGeom, {
                style: { color: '#1b6fa8', weight: 1.2, opacity: 0.95, fillColor: '#3fa7f5', fillOpacity: 0.88, pane: LAKES_PANE },
                interactive: false,
                pane: LAKES_PANE
            }).addTo(group);
        }

        const fishHome = waterGeom || shoreGeom;
        const fishCoords = ((graphics && Array.isArray(graphics.fish)) ? graphics.fish : [])
            .filter(coord => {
                if (!fishHome) return false;
                try { return pointInFeature(turf.point(coord), { type: 'Feature', properties: {}, geometry: fishHome }); } catch (_) { return true; }
            });
        fishCoords.forEach(([lng, lat]) => {
            L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'lake-fish-emoji',
                    html: '<div style="font-size:18px;line-height:18px;">🐟</div>',
                    iconSize: [18, 18],
                    iconAnchor: [9, 9]
                }),
                pane: LAKES_PANE,
                interactive: false
            }).addTo(group);
        });
    }

    function updateSquaresLayer() {
        // Structures demolish buildings by default: any structure change can raze or restore.
        try { if (typeof window !== 'undefined' && typeof window.rebuildBuildingLayerFromPool === 'function' && window.buildingFeaturePool?.length) window.rebuildBuildingLayerFromPool(); } catch (error) { console.error('[structures] building demolition refresh failed', error); }
        if (typeof map === 'undefined') return;
        ensureSquaresPane();
        const group = ensureSquaresLayer();

        // Force complete removal: remove from map, clear all layers, then re-add to map
        const wasOnMap = map && map.hasLayer(group);
        if (wasOnMap) {
            try { map.removeLayer(group); } catch (_) { }
        }
        try {
            // Collect all layers first to avoid iteration issues
            const layersToRemove = [];
            group.eachLayer(layer => {
                layersToRemove.push(layer);
            });
            // Remove each layer explicitly
            layersToRemove.forEach(layer => {
                try { group.removeLayer(layer); } catch (_) { }
            });
            // Also call clearLayers as a safety measure
            group.clearLayers();
        } catch (_) { }

        if (wasOnMap) {
            try { group.addTo(map); } catch (_) { }
        }

        // Auto-enable squares layer if there are squares to show
        const showSquaresEl = document.getElementById('showSquaresCheckbox');
        if (Array.isArray(window.squares) && window.squares.length > 0) {
            if (showSquaresEl && showSquaresEl.checked === false) {
                showSquaresEl.checked = true;
            }
            if (map && !map.hasLayer(group)) {
                try { group.addTo(map); } catch (_) { }
            }
        }

        const squareCutters = appliedCorridorCutters();
        (window.squares || []).forEach(squareFeature => {
            try {
                const renderFeature = cutStructureFeature(squareFeature, squareCutters);
                if (!renderFeature) return; // fully paved over by applied roads
                // Base cobblestone polygon (plain grey fill)
                const base = L.geoJSON(renderFeature, {
                    style: { color: '#666666', weight: 2, opacity: 1, fillColor: '#bdbdbd', fillOpacity: 0.7, pane: SQUARES_PANE },
                    // Keep squares non-interactive so parcel clicks continue to hit underlying parcels
                    interactive: false,
                    pane: SQUARES_PANE
                });
                base.addTo(group);
                // Decorations
                drawSquareDecorations(group, renderFeature);
            } catch (e) { console.warn('Failed to render a square', e); }
        });
        try { group.bringToFront && group.bringToFront(); } catch (_) { }
        try { window.dispatchEvent(new Event('squaresUpdated')); } catch (_) { }
    }

    function updateLakesLayer() {
        // Structures demolish buildings by default: any structure change can raze or restore.
        try { if (typeof window !== 'undefined' && typeof window.rebuildBuildingLayerFromPool === 'function' && window.buildingFeaturePool?.length) window.rebuildBuildingLayerFromPool(); } catch (error) { console.error('[structures] building demolition refresh failed', error); }
        if (typeof map === 'undefined') return;
        ensureLakesPane();
        const group = ensureLakesLayer();

        // Force complete removal: remove from map, clear all layers, then re-add to map
        const wasOnMap = map && map.hasLayer(group);
        if (wasOnMap) {
            try { map.removeLayer(group); } catch (_) { }
        }
        try {
            // Collect all layers first to avoid iteration issues
            const layersToRemove = [];
            group.eachLayer(layer => {
                layersToRemove.push(layer);
            });
            // Remove each layer explicitly
            layersToRemove.forEach(layer => {
                try { group.removeLayer(layer); } catch (_) { }
            });
            // Also call clearLayers as a safety measure
            group.clearLayers();
        } catch (_) { }

        if (wasOnMap) {
            try { group.addTo(map); } catch (_) { }
        }

        const lakeCutters = appliedCorridorCutters();
        (window.lakes || []).forEach(lakeFeature => {
            try { drawLakeDecorations(group, lakeFeature, lakeCutters); } catch (e) { console.warn('Failed to render a lake', e); }
        });

        try { group.bringToFront && group.bringToFront(); } catch (_) { }
        try { window.dispatchEvent(new Event('lakesUpdated')); } catch (_) { }
    }

    // Toggle handler wired from checkbox in index.html
    function toggleSquaresVisibility() {
        const showSquaresEl = document.getElementById('showSquaresCheckbox');
        const shouldShow = !showSquaresEl || showSquaresEl.checked;
        if (!squaresLayer) ensureSquaresLayer();
        if (!squaresLayer) return;
        const onMap = map && map.hasLayer(squaresLayer);
        if (shouldShow && !onMap) {
            squaresLayer.addTo(map);
            updateSquaresLayer();
        } else if (!shouldShow && onMap) {
            try { map.removeLayer(squaresLayer); } catch (_) { }
        }
    }

    // Toggle handler wired from checkbox in index.html
    function toggleParksVisibility() {
        const showParksEl = document.getElementById('showParksCheckbox');
        const shouldShow = !showParksEl || showParksEl.checked;
        if (!parksLayer) ensureParksLayer();
        if (!parksLayer) return;
        const onMap = map && map.hasLayer(parksLayer);
        if (shouldShow && !onMap) {
            parksLayer.addTo(map);
            updateParksLayer();
        } else if (!shouldShow && onMap) {
            try { map.removeLayer(parksLayer); } catch (_) { }
        }
    }

    function unionPolygonForSelectedBlock() {
        try {
            const name = (typeof window.selectedBlockName !== 'undefined') ? window.selectedBlockName : null;
            if (!name || !window.blockStorage || !window.blockStorage.blocks || !window.blockStorage.blocks.has(name)) return null;
            const block = window.blockStorage.blocks.get(name);
            if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) return null;

            // 1) Try the app's cached/standard union if available
            if (typeof getUnionedPolygonForBlock === 'function') {
                const cached = getUnionedPolygonForBlock(name, block);
                if (cached && cached.geometry) return cached;
            }

            const features = block.parcels.map(p => p.feature).filter(f => f && f.geometry);

            // 2) Simple sequential union (no shape change intent)
            try {
                let seq = features[0] || null;
                for (let i = 1; i < features.length; i++) {
                    try {
                        const merged = turf.union(seq, features[i]);
                        if (merged && merged.geometry) seq = merged; // keep merging as-is
                    } catch (_) { /* fall through to robust */ }
                }
                if (seq && seq.geometry) return seq;
            } catch (_) { /* try robust next */ }

            // 3) Robust union: clean + tiny-buffer dissolve to heal topology, then unbuffer
            const robust = (() => {
                try {
                    // sanitize and buffer-dissolve
                    const epsilon = 0.1; // meters
                    let acc = null;
                    for (const raw of features) {
                        let f = raw;
                        try { f = turf.rewind(f, { reverse: false }); } catch (_) { }
                        try { f = turf.cleanCoords(f, { mutate: false }); } catch (_) { }
                        try {
                            const fb = turf.buffer(f, epsilon, { units: 'meters', steps: 16 });
                            acc = acc ? (turf.union(acc, fb) || acc) : fb;
                        } catch (_) { /* skip this piece */ }
                    }
                    if (!acc || !acc.geometry) return null;
                    try {
                        const unbuf = turf.buffer(acc, -epsilon, { units: 'meters', steps: 16 });
                        if (unbuf && unbuf.geometry) return unbuf;
                    } catch (_) { }
                    return acc;
                } catch (_) { return null; }
            })();
            if (robust && robust.geometry) return robust;

            // 4) Fallback to convex hull of all parcel coordinates so a park always forms
            try {
                const fc = turf.featureCollection(features);
                const hull = turf.convex(fc);
                if (hull && hull.geometry) return hull;
            } catch (_) { }

            // 5) Last resort: bbox polygon
            try {
                const bb = turf.bbox(turf.featureCollection(features));
                const box = turf.bboxPolygon(bb);
                if (box && box.geometry) return box;
            } catch (_) { }

            return null;
        } catch (e) { console.warn('Failed to compute block union', e); return null; }
    }

    function collectBlockParcelIdsAndGeometry(blockName) {
        const parcelIds = [];
        const multiCoords = [];
        if (typeof parcelLayer !== 'undefined' && parcelLayer) {
            try {
                parcelLayer.getLayers().forEach(layer => {
                    try {
                        const f = layer && layer.feature;
                        const props = f && f.properties;
                        if (!f || !f.geometry || !props) return;
                        if (props.block !== blockName) return;
                        const parcelId = typeof ensureParcelId === 'function'
                            ? ensureParcelId(f)
                            : (props.parcelId ?? props.parcel_id ?? props.id);
                        if (!parcelId) return;
                        try { if (typeof isRoad === 'function' && isRoad(parcelId)) return; } catch (_) { }
                        parcelIds.push(String(parcelId));
                        const geom = f.geometry;
                        if (geom.type === 'Polygon') multiCoords.push(geom.coordinates);
                        else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(rings => multiCoords.push(rings));
                    } catch (_) { }
                });
            } catch (_) { }
        }
        if (multiCoords.length === 0) {
            const block = window.blockStorage?.blocks?.get?.(blockName);
            if (block && Array.isArray(block.parcels) && block.parcels.length > 0) {
                for (const layer of block.parcels) {
                    const geom = layer?.feature?.geometry;
                    const props = layer?.feature?.properties;
                    if (!geom || !geom.type || !geom.coordinates || !props) continue;
                    const parcelId = typeof ensureParcelId === 'function'
                        ? ensureParcelId({ properties: props })
                        : (props.parcelId ?? props.parcel_id ?? props.id);
                    if (!parcelId) continue;
                    try { if (typeof isRoad === 'function' && isRoad(parcelId)) continue; } catch (_) { }
                    parcelIds.push(String(parcelId));
                    if (geom.type === 'Polygon') multiCoords.push(geom.coordinates);
                    else if (geom.type === 'MultiPolygon') for (const rings of geom.coordinates) multiCoords.push(rings);
                }
            }
        }
        return { parcelIds: Array.from(new Set(parcelIds)), geometry: multiCoords.length ? { type: 'MultiPolygon', coordinates: multiCoords } : null };
    }

    function redirectStructureToCreateProposal(toolKey) {
        if (typeof showProposalDialog === 'function') {
            showProposalDialog();
            setTimeout(() => {
                try {
                    if (typeof handleProposalToolButton === 'function') handleProposalToolButton(toolKey);
                } catch (_) { }
            }, 0);
            return;
        }
        if (typeof updateStatus === 'function') updateStatus('Use the Create Proposal modal.');
    }

    function parkOnSelectedBlock() {
        redirectStructureToCreateProposal('park');
    }

    function squareOnSelectedBlock() {
        redirectStructureToCreateProposal('square');
    }

    // Public API
    window.parkOnSelectedBlock = parkOnSelectedBlock;
    window.updateParksLayer = updateParksLayer;
    window.toggleParksVisibility = toggleParksVisibility;
    window.squareOnSelectedBlock = squareOnSelectedBlock;
    window.updateSquaresLayer = updateSquaresLayer;
    window.toggleSquaresVisibility = toggleSquaresVisibility;
    window.updateLakesLayer = updateLakesLayer;
    window.ensureLakeGraphics = ensureLakeGraphics;
    window.lakesLayerRef = () => lakesLayer;
    // Expose decoration helpers for ProposalManager
    window.ensureParkDecorations = ensureParkDecorations;
    window.ensureSquareDecorations = ensureSquareDecorations;

    function initialiseStructures() {
        loadParks();
        loadSquares();
        loadLakes();
        if (typeof window !== 'undefined') {
            const runUpdates = () => {
                try { updateParksLayer(); } catch (_) { }
                try { updateSquaresLayer(); } catch (_) { }
                try { updateLakesLayer(); } catch (_) { }
            };
            if (document.readyState === 'loading') {
                window.addEventListener('DOMContentLoaded', runUpdates, { once: true });
            } else {
                runUpdates();
            }
        }
    }

    if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
        PersistentStorage.ensureReady(initialiseStructures);
    } else {
        initialiseStructures();
    }
})();
