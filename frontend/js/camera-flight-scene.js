// Reads what a generated flight needs from the live model scene, in the flight's metric frame: each
// applied design's building boxes and outline, and a top-down height grid of everything drawn.
(function (win) {
    'use strict';
    const PATH = 'CameraFlightPath', MAX_PIXELS = 2048;
    const finite = x => typeof x === 'number' && Number.isFinite(x);

    function appliedDesigns() {
        const all = typeof proposalStorage !== 'undefined' ? proposalStorage.getAllProposals() : [];
        return all.filter(p => win.isApplied?.(p) && p.proposalId != null)
            .map(p => ({ id: String(p.proposalId), title: p.title || p.name || p.proposalName || String(p.proposalId) }));
    }

    function converters(internals, frame) {
        const metric = win.__metricFrame.frameAt([frame.lng, frame.lat]);
        return {
            toMetric(x, y) { const ll = internals.xyToLatLng(x, y); return metric.toMetric([ll.lng, ll.lat]); },
            lngLatToMetric: lngLat => metric.toMetric(lngLat),
            toScene(x, y) { const [lng, lat] = metric.toLngLat([x, y]); return internals.latLngToXY(lat, lng); }
        };
    }

    // Pick proxies and overlays draw nothing a camera could hit.
    function drawsNothing(object) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        return materials.every(m => !m || m.visible === false || m.colorWrite === false || (m.transparent && m.opacity < .05));
    }

    // Overlapping meshes of one design (walls, roof, floors) are one building.
    function cluster(boxes) {
        const out = boxes.map(b => ({ min: b.min.slice(), max: b.max.slice(), top: b.top }));
        for (let merged = true; merged;) {
            merged = false;
            for (let i = 0; i < out.length && !merged; i++) for (let j = i + 1; j < out.length && !merged; j++) {
                const a = out[i], b = out[j];
                if (a.min[0] <= b.max[0] + 1 && b.min[0] <= a.max[0] + 1 && a.min[1] <= b.max[1] + 1 && b.min[1] <= a.max[1] + 1) {
                    out[i] = { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1])],
                        max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1])], top: Math.max(a.top, b.top) };
                    out.splice(j, 1); merged = true;
                }
            }
        }
        return out;
    }

    function lngLats(coordinates, into) {
        if (!Array.isArray(coordinates)) return into;
        if (coordinates.length >= 2 && finite(coordinates[0]) && finite(coordinates[1])) into.push([coordinates[0], coordinates[1]]);
        else coordinates.forEach(c => lngLats(c, into));
        return into;
    }

    // [{ id, buildings: [{ min, max, top }], outline: [[x, y]] }] for the designs that have either.
    function subjects(internals, frame, ids) {
        const THREE = win.THREE, convert = converters(internals, frame), boxes = new Map(ids.map(id => [String(id), []]));
        internals.scene.updateMatrixWorld(true);
        internals.scene.traverseVisible(object => {
            if (!object.isMesh || drawsNothing(object)) return;
            let id = null;
            for (let o = object; o && id === null; o = o.parent) {
                if (o.name === PATH) return;
                if (o.userData?.proposalId != null) id = String(o.userData.proposalId);
            }
            if (id === null || !boxes.has(id)) return;
            const b = new THREE.Box3().setFromObject(object);
            if (!finite(b.max.z) || b.max.z < 2) return;
            const corners = [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.min.x, b.max.y], [b.max.x, b.max.y]].map(([x, y]) => convert.toMetric(x, y));
            boxes.get(id).push({ min: [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1]))],
                max: [Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))], top: b.max.z });
        });
        return ids.map(String).map(id => {
            const ground = internals.proposalGround?.(id) || [];
            const points = lngLats(ground.map(f => f?.geometry?.coordinates), []);
            const step = Math.max(1, Math.ceil(points.length / 2000));
            return { id, buildings: cluster(boxes.get(id)), outline: points.filter((_, i) => i % step === 0).map(convert.lngLatToMetric) };
        }).filter(s => s.buildings.length || s.outline.length);
    }

    // Draw the scene straight down with an orthographic camera, each fragment writing its world
    // height in decimetres over two 8-bit channels, then keep the top height per metric cell.
    function heights(internals, frame, bounds) {
        const THREE = win.THREE, { renderer, scene } = internals, convert = converters(internals, frame), started = performance.now();
        const [x0, y0, x1, y1] = bounds, cell = Math.max(2, Math.max(x1 - x0, y1 - y0) / 1024);
        const cols = Math.ceil((x1 - x0) / cell), rows = Math.ceil((y1 - y0) / cell);
        const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => convert.toScene(x, y));
        const sx0 = Math.min(...corners.map(c => c[0])), sx1 = Math.max(...corners.map(c => c[0]));
        const sy0 = Math.min(...corners.map(c => c[1])), sy1 = Math.max(...corners.map(c => c[1]));
        const width = Math.min(MAX_PIXELS, cols * 2), height = Math.min(MAX_PIXELS, rows * 2);
        const camera = new THREE.OrthographicCamera(-(sx1 - sx0) / 2, (sx1 - sx0) / 2, (sy1 - sy0) / 2, -(sy1 - sy0) / 2, 1, 40000);
        camera.position.set((sx0 + sx1) / 2, (sy0 + sy1) / 2, 20000); camera.up.set(0, 1, 0);
        camera.lookAt((sx0 + sx1) / 2, (sy0 + sy1) / 2, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
        const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
        material.onBeforeCompile = shader => {
            shader.vertexShader = 'varying float vFlightZ;\n' + shader.vertexShader.replace('#include <begin_vertex>',
                '#include <begin_vertex>\n    vec4 flightWorld = vec4(transformed, 1.0);\n#ifdef USE_BATCHING\n    flightWorld = batchingMatrix * flightWorld;\n#endif\n'
                + '#ifdef USE_INSTANCING\n    flightWorld = instanceMatrix * flightWorld;\n#endif\n    vFlightZ = (modelMatrix * flightWorld).z;');
            shader.fragmentShader = 'varying float vFlightZ;\n' + shader.fragmentShader.replace('#include <dithering_fragment>',
                '#include <dithering_fragment>\n    float flightDm = clamp(floor(vFlightZ * 10.0 + 0.5), 0.0, 65535.0);\n'
                + '    gl_FragColor = vec4(floor(flightDm / 256.0) / 255.0, mod(flightDm, 256.0) / 255.0, 0.0, 1.0);');
        };
        const target = new THREE.WebGLRenderTarget(width, height), pixels = new Uint8Array(width * height * 4), hidden = [];
        const saved = { target: renderer.getRenderTarget(), override: scene.overrideMaterial, background: scene.background, fog: scene.fog,
            clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), shadows: renderer.shadowMap.autoUpdate };
        try {
            scene.traverseVisible(o => {
                if (o.name === PATH || o.isLine || o.isPoints || o.isSprite || (o.isMesh && drawsNothing(o))) { hidden.push(o); o.visible = false; }
            });
            scene.overrideMaterial = material; scene.background = new THREE.Color(0); scene.fog = null; renderer.shadowMap.autoUpdate = false;
            renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera);
            renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
        } finally {
            hidden.forEach(o => { o.visible = true; });
            scene.overrideMaterial = saved.override; scene.background = saved.background; scene.fog = saved.fog;
            renderer.shadowMap.autoUpdate = saved.shadows; renderer.setRenderTarget(saved.target); renderer.setClearColor(saved.clear, saved.alpha);
            target.dispose(); material.dispose(); win.invalidateThreeView?.();
        }
        // Scene to metric is affine at this scale (scale varies ~1e-4 across a kilometre).
        const m00 = convert.toMetric(sx0, sy0), m10 = convert.toMetric(sx1, sy0), m01 = convert.toMetric(sx0, sy1);
        const result = new Float32Array(cols * rows);
        let drawn = 0;
        for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
            const p = (j * width + i) * 4, h = (pixels[p] * 256 + pixels[p + 1]) / 10;
            if (!h) continue;
            const u = (i + .5) / width, v = (j + .5) / height;
            const mx = m00[0] + u * (m10[0] - m00[0]) + v * (m01[0] - m00[0]), my = m00[1] + u * (m10[1] - m00[1]) + v * (m01[1] - m00[1]);
            const c = Math.floor((mx - x0) / cell), r = Math.floor((my - y0) / cell);
            if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
            const k = r * cols + c; if (h > result[k]) result[k] = h; drawn++;
        }
        console.log(`[${new Date().toISOString()}] [camera-flight] height grid ${cols}×${rows} at ${cell.toFixed(1)} m from ${width}×${height} px `
            + `(${drawn} drawn) · ${(performance.now() - started).toFixed(0)} ms`);
        return { origin: [x0, y0], cell, cols, rows, heights: result };
    }

    win.CameraFlightScene = { appliedDesigns, subjects, heights };
})(window);
