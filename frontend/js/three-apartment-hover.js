// Pick sourced apartment regions on visible architectural surfaces without changing click selection.
(function (global) {
    'use strict';

    function inRing(point, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[j], b = ring[i];
            const cross = (point.x-a[0])*(b[1]-a[1])-(point.y-a[1])*(b[0]-a[0]);
            if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a[0],b[0])-1e-7 && point.x <= Math.max(a[0],b[0])+1e-7
                && point.y >= Math.min(a[1],b[1])-1e-7 && point.y <= Math.max(a[1],b[1])+1e-7) return true;
            if ((a[1] > point.y) !== (b[1] > point.y)
                && point.x < (b[0]-a[0])*(point.y-a[1])/(b[1]-a[1])+a[0]) inside = !inside;
        }
        return inside;
    }

    function isVisible(object) {
        for (let node = object; node; node = node.parent) if (node.visible === false) return false;
        return true;
    }

    function apartmentAtHit(hit) {
        let floor = hit?.object;
        while (floor && !floor.userData.cbFloorPlanFloor) floor = floor.parent;
        if (!floor || !isVisible(floor)) return null;
        const point = floor.worldToLocal(hit.point.clone());
        const region = floor.userData.apartmentRegions?.find(region => region.polygons.some(polygon =>
            inRing(point, polygon[0]) && !polygon.slice(1).some(hole => inRing(point, hole))));
        return region ? { floor, region } : null;
    }

    function spaceAtHit(hit) {
        const apartment = apartmentAtHit(hit);
        if (apartment) return apartment;
        let floor = hit?.object;
        while (floor && !floor.userData.cbFloorPlanFloor) floor = floor.parent;
        if (!floor || !isVisible(floor)) return null;
        const point = floor.worldToLocal(hit.point.clone());
        let nearest = null, distance = Infinity;
        for (const region of floor.userData.nonApartmentRegions || []) {
            if (!region.polygons.some(polygon => inRing(point, polygon[0]) && !polygon.slice(1).some(hole => inRing(point, hole)))) continue;
            const dz = Math.abs(point.z - region.elevationM);
            if (dz < distance) { nearest = region; distance = dz; }
        }
        return nearest ? { floor, region: nearest } : null;
    }

    function attach(THREE, { canvas, camera, floorPlanGroup, occluders = () => [], onPointerChange = () => {}, onHover = () => {} }) {
        const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), lastCamera = new THREE.Matrix4();
        let pointer = null, dirty = true, highlight = null, current = null;
        const material = new THREE.MeshBasicMaterial({ color: 0x20bfff, transparent: true, opacity: .55,
            side: THREE.DoubleSide, depthTest: true, depthWrite: false, polygonOffset: true,
            polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const sharedMaterial = material.clone();
        sharedMaterial.color.setHex(0xffffff);
        sharedMaterial.onBeforeCompile = shader => {
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
                #include <color_fragment>
                float hatch = smoothstep(0.35, 0.55, fract((gl_FragCoord.x + gl_FragCoord.y) / 14.0));
                diffuseColor.rgb = mix(vec3(0.16), vec3(0.95), hatch);
            `);
        };
        sharedMaterial.customProgramCacheKey = () => 'non-apartment-hover-hatch';
        function removeHighlight() {
            if (highlight) {
                highlight.removeFromParent();
                highlight.geometry.dispose();
            }
            highlight = null;
            current = null;
        }
        function clear() { removeHighlight(); onHover(null); dirty = true; }
        function invalidate() { dirty = true; }
        function move(event) {
            if (event.buttons || event.pointerType === 'touch') { leave(); return; }
            pointer = { x: event.clientX, y: event.clientY };
            dirty = true;
            onPointerChange();
        }
        function leave() { pointer = null; clear(); onPointerChange(); }
        const listeners = { pointermove: move, pointerleave: leave, pointerdown: leave, pointerup: move, pointercancel: leave };
        Object.entries(listeners).forEach(([type, listener]) => canvas.addEventListener(type, listener, { passive: true }));

        function update(enabled) {
            if (!enabled || !pointer) { if (current) clear(); return; }
            camera.updateMatrixWorld();
            if (!dirty && lastCamera.equals(camera.matrixWorld)) return;
            dirty = false;
            lastCamera.copy(camera.matrixWorld);
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) { clear(); return; }
            ndc.set((pointer.x-rect.left)/rect.width*2-1, -(pointer.y-rect.top)/rect.height*2+1);
            raycaster.setFromCamera(ndc, camera);
            floorPlanGroup.updateWorldMatrix(true, false);
            const targets = [];
            for (const group of [floorPlanGroup, ...occluders()].filter(Boolean)) {
                if (!isVisible(group)) continue;
                group.traverseVisible(object => {
                    if (object.isMesh && !object.userData.cbApartmentHover) {
                        object.updateWorldMatrix(true, false);
                        targets.push(object);
                    }
                });
            }
            // The closest visible solid wins. An unmodelled band or another building blocks
            // the unit behind it; hidden upper floors and isolated-away buildings cannot win.
            const hit = raycaster.intersectObjects(targets, false)[0];
            const picked = spaceAtHit(hit);
            onHover(picked, pointer);
            if (picked?.floor === current?.floor && picked?.region === current?.region) return;
            removeHighlight();
            if (!picked) return;
            const shapes = picked.region.polygons.map(polygon => {
                const shape = new THREE.Shape(polygon[0].map(p => new THREE.Vector2(...p)));
                polygon.slice(1).forEach(ring => shape.holes.push(new THREE.Path(ring.map(p => new THREE.Vector2(...p)))));
                return shape;
            });
            const shared = picked.region.kind === 'non-apartment';
            highlight = new THREE.Mesh(new THREE.ShapeGeometry(shapes), shared ? sharedMaterial : material);
            highlight.name = `FloorSpaceHover:${picked.floor.userData.id}:${picked.region.id}`;
            highlight.userData = { cbApartmentHover: true, apartmentId: shared ? null : picked.region.id,
                regionKind: shared ? 'non-apartment' : 'apartment', floorId: picked.floor.userData.id };
            // Warning patches end at .07 m. A slope offset alone cannot lift a .035 m
            // highlight above them when the camera looks straight down.
            highlight.position.z = (picked.region.elevationM || 0) + .08;
            highlight.renderOrder = 5;
            highlight.raycast = () => {};
            picked.floor.add(highlight);
            current = picked;
        }
        function dispose() {
            Object.entries(listeners).forEach(([type, listener]) => canvas.removeEventListener(type, listener));
            leave();
            material.dispose();
            sharedMaterial.dispose();
        }
        return { update, clear, invalidate, dispose };
    }

    const api = { inRing, apartmentAtHit, spaceAtHit, attach };
    global.__threeApartmentHover = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
