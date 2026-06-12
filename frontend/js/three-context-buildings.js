// Loads existing 3D building meshes from POST /buildings/near as ghost-style
// reference geometry inside the per-proposal 3D edit views. Mirrors the
// triangulation logic used by three-mode.js's main 3D map mode, but lets each
// edit view supply its own (lng,lat) -> [x,y] projector so the meshes land in
// that view's local coordinate frame.

(function () {
    if (typeof window === 'undefined') return;
    if (typeof THREE === 'undefined') {
        console.warn('[ContextBuildings3D] THREE.js not available; skipping init.');
        return;
    }

    const DEFAULT_BUFFER_METERS = 100;
    const MAX_BUFFER_METERS = 250;

    function makeGhostMaterial(color) {
        return new THREE.MeshPhongMaterial({
            color: color || 0x9aa4ad,
            specular: 0x222222,
            shininess: 12,
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
    }

    function clearGroup(group) {
        if (!group) return;
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            try { if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose(); } catch (_) { }
            try {
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => { if (m && typeof m.dispose === 'function') m.dispose(); });
                    else if (typeof child.material.dispose === 'function') child.material.dispose();
                }
            } catch (_) { }
            try { group.remove(child); } catch (_) { }
        }
    }

    // Coarse bbox cache key (~55m precision at mid-latitudes) so small geometry tweaks
    // during a drag don't trigger refetches.
    function computeCacheKey(geometry, bufferMeters) {
        try {
            if (typeof turf === 'undefined' || !turf || !geometry) return null;
            const bbox = turf.bbox({ type: 'Feature', geometry, properties: {} });
            if (!bbox || bbox.some(v => !isFinite(v))) return null;
            const PREC = 0.0005;
            const snap = (v) => (Math.round(v / PREC) * PREC).toFixed(4);
            return `${snap(bbox[0])},${snap(bbox[1])},${snap(bbox[2])},${snap(bbox[3])}|${Math.round(bufferMeters)}`;
        } catch (_) { return null; }
    }

    // Build a triangulated THREE.Mesh from a single building entry returned by
    // POST /buildings/near. Mirrors three-mode.js's buildMeshFromBuilding3D, but
    // uses the caller-supplied projector so the mesh lands in that scene's
    // local coordinate frame. The mesh sits at local z=0..(z_max-z_min).
    function buildMeshFromBuilding(bld, material, latLngToLocalXY) {
        if (!bld || !Array.isArray(bld.faces) || bld.faces.length === 0) return null;
        const groundZ = Number.isFinite(bld.z_min) ? bld.z_min : 0;
        const positions = [];

        for (let fi = 0; fi < bld.faces.length; fi++) {
            const face = bld.faces[fi];
            if (!face || face.type !== 'Polygon' || !Array.isArray(face.coordinates)) continue;
            const rings = face.coordinates;
            if (rings.length === 0) continue;

            const convertedRings = rings.map(ring => {
                const pts = [];
                for (let i = 0; i < ring.length - 1; i++) {
                    const c = ring[i];
                    if (!c || c.length < 2) continue;
                    const xy = latLngToLocalXY(c[0], c[1]);
                    if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) continue;
                    const z = (Number.isFinite(c[2]) ? c[2] : groundZ) - groundZ;
                    pts.push([xy[0], xy[1], z]);
                }
                return pts;
            }).filter(r => r.length >= 3);

            if (convertedRings.length === 0) continue;
            const outer = convertedRings[0];
            const holes = convertedRings.slice(1);

            // Newell's method for face normal — robust for non-trivial polygons.
            let nx = 0, ny = 0, nz = 0;
            for (let i = 0; i < outer.length; i++) {
                const a = outer[i];
                const b = outer[(i + 1) % outer.length];
                nx += (a[1] - b[1]) * (a[2] + b[2]);
                ny += (a[2] - b[2]) * (a[0] + b[0]);
                nz += (a[0] - b[0]) * (a[1] + b[1]);
            }
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            // Drop the dominant-normal axis to project onto a stable 2D plane for triangulation.
            let dropAxis = 2;
            if (ax >= ay && ax >= az) dropAxis = 0;
            else if (ay >= ax && ay >= az) dropAxis = 1;

            const project2D = (p) => {
                if (dropAxis === 0) return new THREE.Vector2(p[1], p[2]);
                if (dropAxis === 1) return new THREE.Vector2(p[0], p[2]);
                return new THREE.Vector2(p[0], p[1]);
            };

            const contour2D = outer.map(project2D);
            const holes2D = holes.map(h => h.map(project2D));

            let triangles;
            try { triangles = THREE.ShapeUtils.triangulateShape(contour2D, holes2D); }
            catch (_) { continue; }
            if (!triangles || triangles.length === 0) continue;

            const flat3D = outer.slice();
            for (let h = 0; h < holes.length; h++) {
                for (let j = 0; j < holes[h].length; j++) flat3D.push(holes[h][j]);
            }

            for (let t = 0; t < triangles.length; t++) {
                const tri = triangles[t];
                for (let k = 0; k < 3; k++) {
                    const v = flat3D[tri[k]];
                    if (!v) continue;
                    positions.push(v[0], v[1], v[2]);
                }
            }
        }

        if (positions.length === 0) return null;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.isContextBuilding = true;
        mesh.userData.objectId = bld.object_id;
        return mesh;
    }

    function getBackendBase() {
        try { return (typeof window.getBackendBase === 'function') ? window.getBackendBase() : ''; }
        catch (_) { return ''; }
    }

    // Idempotent loader. Repeated calls with the same coarse query bbox are no-ops.
    // - contextGroup: a THREE.Group already attached to the scene.
    // - opts.geometry: GeoJSON Geometry (EPSG:4326) — typically the proposal's outer shape.
    // - opts.bufferMeters: search radius (default 100, capped at 250).
    // - opts.latLngToLocalXY: (lng, lat) -> [x, y] in the scene's local meters.
    // - opts.material: optional THREE.Material override.
    // - opts.force: bypass the bbox cache.
    async function loadInto(contextGroup, opts) {
        if (!contextGroup || !opts || !opts.geometry || typeof opts.latLngToLocalXY !== 'function') return 0;
        const bufferMeters = Math.max(0, Math.min(MAX_BUFFER_METERS, Number(opts.bufferMeters) || DEFAULT_BUFFER_METERS));
        const key = computeCacheKey(opts.geometry, bufferMeters);
        if (key && !opts.force && contextGroup.userData.__contextKey === key) {
            return contextGroup.userData.__contextCount || 0;
        }

        // Mark in-flight key now so concurrent calls during a drag don't pile up.
        contextGroup.userData.__contextKey = key;

        let city;
        try { city = window.CityConfigManager && window.CityConfigManager.getCurrentCityId(); } catch (_) { }
        let payload;
        try {
            const r = await fetch(`${getBackendBase()}/buildings/near`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geometry: opts.geometry, buffer_meters: bufferMeters, city })
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            payload = await r.json();
        } catch (e) {
            console.warn('[ContextBuildings3D] /buildings/near fetch failed:', e);
            // Reset key so a later attempt can retry.
            contextGroup.userData.__contextKey = null;
            return 0;
        }

        // Replace previous context only after a successful fetch — a transient error
        // shouldn't strip whatever context is already on screen.
        clearGroup(contextGroup);

        const buildings = (payload && Array.isArray(payload.buildings)) ? payload.buildings : [];
        const material = opts.material || makeGhostMaterial();
        let added = 0;
        for (let i = 0; i < buildings.length; i++) {
            try {
                const mesh = buildMeshFromBuilding(buildings[i], material, opts.latLngToLocalXY);
                if (mesh) { contextGroup.add(mesh); added++; }
            } catch (e) {
                console.warn('[ContextBuildings3D] mesh build failed for', buildings[i] && buildings[i].object_id, e);
            }
        }
        contextGroup.userData.__contextCount = added;
        return added;
    }

    function clear(contextGroup) {
        if (!contextGroup) return;
        clearGroup(contextGroup);
        contextGroup.userData.__contextKey = null;
        contextGroup.userData.__contextCount = 0;
    }

    window.ContextBuildings3D = { loadInto, clear, makeGhostMaterial };
})();
