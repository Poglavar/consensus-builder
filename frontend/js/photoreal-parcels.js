// Draws immutable cadastral boundaries on photo tiles and supplies source geometry to shared 3D selection.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__photorealParcels = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    function projectFeatures(features, project, bounds) {
        const parcels = [];
        for (const feature of features) {
            const geometry = feature?.geometry;
            const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
                : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
            const projected = polygons.map(polygon => polygon.map(ring => ring.map(c => project(c[1], c[0]))));
            if (!projected.length || projected.some(p => p.some(r => r.length < 4
                || r.some(c => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))))) continue;
            const box = [Infinity, Infinity, -Infinity, -Infinity];
            projected.forEach(p => p.forEach(r => r.forEach(([x, y]) => {
                box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
                box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
            })));
            if (box[2] < bounds[0] || box[0] > bounds[2] || box[3] < bounds[1] || box[1] > bounds[3]) continue;
            const id = feature.properties?.parcelId;
            if (id == null) continue;
            parcels.push({ id: String(id), feature, polygons: projected, bounds: box });
        }
        return parcels;
    }

    function ringContains(ring, x, y) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    function parcelsAt(parcels, x, y) {
        return parcels.filter(p => x >= p.bounds[0] && x <= p.bounds[2] && y >= p.bounds[1] && y <= p.bounds[3]
            && p.polygons.some(polygon => ringContains(polygon[0], x, y)
                && !polygon.slice(1).some(hole => ringContains(hole, x, y))));
    }

    // Canvas rows grow southward, whereas texture v and scene Y grow northward (CanvasTexture.flipY).
    function texturePoint(x, y, bounds, size) {
        return [(x - bounds[0]) / (bounds[2] - bounds[0]) * size,
            (bounds[3] - y) / (bounds[3] - bounds[1]) * size];
    }

    // Keep a similar number of texture pixels on screen as the camera zooms. Quantized windows
    // avoid rerasterizing on every orbit frame; the source geometry and its coordinates stay fixed.
    function windowSpan(sceneDistance, k) {
        const level = Math.max(-1, Math.min(3, Math.round(Math.log2(Math.max(1, sceneDistance) / (100 * k)))));
        return 200 * k * Math.pow(2, level);
    }

    function patchShader(shader, uniforms) {
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D uParcelOverlay;
uniform vec2 uParcelMin;
uniform float uParcelInvSpan;
uniform float uParcelOn;`)
            .replace('#include <dithering_fragment>', `#include <dithering_fragment>
if (uParcelOn > 0.5) {
    vec2 puv = (vCorridorWorld.xy - uParcelMin) * uParcelInvSpan;
    if (puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0) {
        vec4 parcelInk = texture2D(uParcelOverlay, puv);
        // A vertical facade can sit along a cadastral edge for its entire height. Keep the
        // projection on ground/roofs instead of painting that whole wall as a wide boundary.
        vec3 parcelSurfaceNormal = normalize(cross(dFdx(vCorridorWorld), dFdy(vCorridorWorld)));
        float parcelFacing = smoothstep(0.1, 0.5, abs(parcelSurfaceNormal.z));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, parcelInk.rgb, parcelInk.a * parcelFacing);
    }
}`);
    }

    function create({ root, internals, uniforms }) {
        const { THREE, document: doc } = root;
        const size = 2048;
        const k = root.__photorealFrame.mercatorScaleFactor(internals.originLatLng().lat);
        let span = null;
        const canvas = doc.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);
        texture.generateMipmaps = false;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        uniforms = uniforms || {
            uParcelOverlay: { value: texture }, uParcelMin: { value: new THREE.Vector2() },
            uParcelInvSpan: { value: 1 }, uParcelOn: { value: 0 }
        };
        uniforms.uParcelOverlay.value = texture;
        uniforms.uParcelInvSpan.value = 1;
        uniforms.uParcelOn.value = 0;
        const toggle = doc.getElementById('photo-parcels-visible');
        const status = doc.getElementById('photo-parcels-status');
        let enabled = toggle?.checked === true;
        let disposed = false, busy = false, dirty = true;
        let bounds = null, parcels = [], request = null;
        let requestedCenter = null, requestedSpan = null, statusSpec = null;
        const t = (key, fallback, params) => {
            const value = root.i18n?.t?.('threeMode.photoParcels.' + key, params);
            return value && value !== 'threeMode.photoParcels.' + key ? value : fallback;
        };
        function setStatus(key, fallback, params) {
            statusSpec = [key, fallback, params];
            if (status) status.textContent = t(key, fallback, params);
        }
        function palette() {
            const style = root.getComputedStyle(doc.documentElement);
            return {
                edge: style.getPropertyValue('--cb-photo-parcel-boundary').trim(),
                halo: style.getPropertyValue('--cb-photo-parcel-halo').trim()
            };
        }
        function path(parcel) {
            context.beginPath();
            parcel.polygons.forEach(p => p.forEach(ring => {
                ring.forEach(([x, y], i) => {
                    const uv = texturePoint(x, y, bounds, size);
                    if (i) context.lineTo(...uv); else context.moveTo(...uv);
                });
                context.closePath();
            }));
        }
        function draw() {
            context.clearRect(0, 0, size, size);
            if (!bounds) return;
            const colors = palette();
            context.lineJoin = 'round';
            // Two passes keep a dark halo beneath shared edges, rather than darkening a neighbour's line.
            for (const [width, color] of [[4.5, colors.halo], [2, colors.edge]]) {
                context.lineWidth = width;
                context.strokeStyle = color;
                parcels.forEach(parcel => { path(parcel); context.stroke(); });
            }
            texture.needsUpdate = true;
            uniforms.uParcelOn.value = enabled && parcels.length ? 1 : 0;
            root.invalidateThreeView?.();
        }
        function rebuild(features) {
            parcels = projectFeatures(features, internals.latLngToXY, bounds);
            draw();
        }
        async function load(x, y, nextSpan) {
            busy = true;
            requestedCenter = [x, y];
            requestedSpan = nextSpan;
            const next = [x - nextSpan / 2, y - nextSpan / 2, x + nextSpan / 2, y + nextSpan / 2];
            const sw = internals.xyToLatLng(next[0], next[1]);
            const ne = internals.xyToLatLng(next[2], next[3]);
            request = new AbortController();
            setStatus('loading', 'Loading source parcel boundaries…');
            try {
                const result = await root.CadastralParcelRepository.ensureBounds(root.L.latLngBounds(sw, ne), { signal: request.signal });
                if (disposed || request.signal.aborted) return;
                bounds = next;
                span = nextSpan;
                uniforms.uParcelMin.value.set(bounds[0], bounds[1]);
                uniforms.uParcelInvSpan.value = 1 / span;
                rebuild(result.features);
                setStatus(parcels.length ? 'ready' : 'empty', parcels.length
                    ? 'Source parcels · click the city to inspect' : 'No source parcels returned for this area.');
            } catch (error) {
                if (disposed || request.signal.aborted) return;
                console.error(`[${new Date().toISOString()}] [photo-parcels] Source boundaries unavailable`, error);
                bounds = null; parcels = []; draw();
                uniforms.uParcelOn.value = 0;
                setStatus('failed', 'Parcel boundaries could not load. Toggle the layer to retry.');
            } finally { busy = false; }
        }
        function update() {
            if (disposed || busy) return;
            const target = internals.controls.target;
            const nextSpan = windowSpan(internals.camera.position.distanceTo(target), k);
            if (dirty || requestedSpan !== nextSpan || !requestedCenter || Math.hypot(target.x - requestedCenter[0], target.y - requestedCenter[1]) > requestedSpan / 4) {
                dirty = false;
                void load(target.x, target.y, nextSpan);
            }
        }
        function onToggle() {
            enabled = toggle.checked;
            uniforms.uParcelOn.value = enabled && parcels.length ? 1 : 0;
            if (status) status.hidden = !enabled;
            if (enabled) { dirty = true; update(); }
            root.invalidateThreeView?.();
        }
        const themeObserver = new root.MutationObserver(() => draw());
        themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        const unsubscribeLanguage = root.i18n?.onChange?.(() => {
            if (statusSpec) setStatus(...statusSpec);
        });
        toggle?.addEventListener('change', onToggle);
        if (status) status.hidden = !enabled;
        update();
        return {
            uniforms, update,
            at: (x, y) => parcelsAt(parcels, x, y),
            dispose() {
                disposed = true;
                parcels = [];
                bounds = null;
                request?.abort();
                themeObserver.disconnect();
                unsubscribeLanguage?.();
                texture.dispose();
                uniforms.uParcelOn.value = 0;
                uniforms.uParcelOverlay.value = null;
                toggle?.removeEventListener('change', onToggle);
            }
        };
    }
    return { projectFeatures, parcelsAt, texturePoint, windowSpan, patchShader, create };
});
