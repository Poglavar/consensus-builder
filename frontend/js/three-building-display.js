// Defines the Built/Proposed display-state model independently from Three.js rendering and controls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeBuildingDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function resolveBuiltDisplayPolicy(state, selection = 'all') {
        const visible = state !== 'off';
        return { visible, material: state === 'ghost' ? 'ghost' : 'solid',
            showSurviving: visible && selection !== 'removed',
            showDemolished: visible && selection !== 'surviving',
            showExistingRail: visible && selection !== 'removed' };
    }

    function resolveBuildingRenderParts(carve, visibility = {}) {
        const showSurviving = visibility.showSurviving !== false;
        const showDemolished = visibility.showDemolished !== false;
        if (!carve) {
            return { detailed: showSurviving, remainder: false, demolished: false };
        }
        if (carve.remainder) {
            return { detailed: false, remainder: showSurviving, demolished: showDemolished };
        }
        // An extended building is kept: it is nothing the plan removes, and in the after-the-plan
        // state its design's redrawn building stands for it.
        if (carve.extended) return { detailed: showSurviving && showDemolished, remainder: false, demolished: false };
        return { detailed: showDemolished, remainder: false, demolished: false };
    }

    // The clipping planes that open a passage through a building's mesh: one vertical plane per side
    // of the passage's ground rectangle (scene x/y, metres) and its ceiling at `topZ`, every normal
    // pointing out of the box. With `clipIntersection` a fragment is cut only where it lies inside
    // all of them, i.e. inside the box. Returns null for a ring that is not a convex polygon (the
    // planes could then cut more than the passage).
    function passageClipPlanes(ring, topZ) {
        const points = (ring || []).filter(point => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]));
        if (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop();
        if (points.length < 3 || !Number.isFinite(topZ)) return null;
        let doubled = 0;
        for (let i = 0; i < points.length; i++) {
            const [x1, y1] = points[i];
            const [x2, y2] = points[(i + 1) % points.length];
            doubled += x1 * y2 - x2 * y1;
        }
        if (Math.abs(doubled) < 1e-6) return null;
        const ccw = doubled > 0;
        const planes = [];
        for (let i = 0; i < points.length; i++) {
            const [x1, y1] = points[i];
            const [x2, y2] = points[(i + 1) % points.length];
            const length = Math.hypot(x2 - x1, y2 - y1);
            if (length < 1e-6) continue;
            // Outward normal of an edge: right of the direction of travel on a counter-clockwise ring.
            const nx = (ccw ? (y2 - y1) : (y1 - y2)) / length;
            const ny = (ccw ? (x1 - x2) : (x2 - x1)) / length;
            // Convex: every other vertex lies inside this side.
            if (points.some(([x, y]) => nx * (x - x1) + ny * (y - y1) > 1e-6)) return null;
            planes.push({ normal: [nx, ny, 0], constant: -(nx * x1 + ny * y1) });
        }
        if (planes.length < 3) return null;
        planes.push({ normal: [0, 0, 1], constant: -topZ });
        return planes;
    }

    // The stretches of a passage (start → end on the ground, scene x/y) that lie under buildings, as
    // merged [t0, t1] fractions of its length: the liner and its portals stand there and nowhere
    // else, so a passage leaving a building opens into the air. `pieces` are rings of the passage
    // ground under each building; a piece belongs to this passage when every vertex lies within its
    // half-width (plus `tolerance` metres) of the axis. Gaps shorter than `tolerance` close.
    function passageIntervals(start, end, halfWidth, pieces, tolerance = 0.5) {
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const length = Math.hypot(dx, dy);
        if (!(length > 0)) return [];
        const along = ([x, y]) => ((x - start[0]) * dx + (y - start[1]) * dy) / (length * length);
        const across = ([x, y]) => Math.abs((x - start[0]) * dy - (y - start[1]) * dx) / length;
        const slack = tolerance / length;
        const intervals = [];
        (pieces || []).forEach(ring => {
            const points = (ring || []).filter(point => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]));
            if (points.length < 3) return;
            if (points.some(point => across(point) > halfWidth + tolerance)) return;
            const ts = points.map(along);
            const t0 = Math.max(0, Math.min(...ts));
            const t1 = Math.min(1, Math.max(...ts));
            if (Math.min(...ts) < -slack || Math.max(...ts) > 1 + slack || t1 - t0 <= 0) return;
            intervals.push([t0, t1]);
        });
        intervals.sort((a, b) => a[0] - b[0]);
        const merged = [];
        intervals.forEach(([t0, t1]) => {
            const last = merged[merged.length - 1];
            if (last && t0 <= last[1] + slack) last[1] = Math.max(last[1], t1);
            else merged.push([t0, t1]);
        });
        return merged;
    }

    function retainedBaseMaterial(role, opacity, materials) {
        const ghost = Number(opacity) < 1;
        if (role === 'demolishedSolid' || role === 'demolishedGhost') {
            return materials?.[ghost ? 'demolishedGhost' : 'demolishedSolid'];
        }
        if (role === 'solid' || role === 'ghost') return materials?.[ghost ? 'ghost' : 'solid'];
        return null;
    }

    function collectDepthMeshes(mesh, depthFlag) {
        const result = [];
        const visit = object => {
            (object?.children || []).forEach(child => {
                if (child?.userData?.[depthFlag]) result.push(child);
                visit(child);
            });
        };
        visit(mesh);
        return result;
    }

    // Update display materials in place while retaining the existing geometry and object tree.
    // Shared singleton materials are swapped by role; only per-mesh clones receive configuration.
    function updateRetainedBuildingMaterials(group, options = {}) {
        if (!group || typeof group.traverse !== 'function') return 0;
        const materials = options.materials || {};
        const opacity = options.opacity == null ? 1 : options.opacity;
        const demolishedOpacity = options.demolishedOpacity == null ? opacity : options.demolishedOpacity;
        const singletonMaterials = new Set(Object.values(materials).filter(Boolean));
        const renderMeshes = [];
        group.traverse(object => {
            if (object?.isMesh && object.material && !object.userData?.[options.depthFlag]) renderMeshes.push(object);
        });

        let updated = 0;
        renderMeshes.forEach(mesh => {
            const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            let shouldShowDepth = false;
            let changed = false;
            const nextMaterials = sourceMaterials.map(material => {
                const role = material?.userData?.cbBuildingMaterialRole;
                if (!material || !role || role === 'massing' || role === 'flagged') return material;
                const targetOpacity = role === 'demolishedSolid' || role === 'demolishedGhost'
                    ? demolishedOpacity : opacity;
                const base = retainedBaseMaterial(role, targetOpacity, materials);
                if (!base) return material;
                if (Number(targetOpacity) < 1) shouldShowDepth = true;

                if (singletonMaterials.has(material)) {
                    if (material !== base) changed = true;
                    return base;
                }

                if (options.existing && material.color && base.color) {
                    if (typeof material.color.copy === 'function') material.color.copy(base.color);
                    else material.color = base.color;
                }
                if (typeof options.configureMaterial === 'function') {
                    options.configureMaterial(material, targetOpacity);
                }
                changed = true;
                return material;
            });

            if (Array.isArray(mesh.material)) mesh.material = nextMaterials;
            else mesh.material = nextMaterials[0];

            let depthMeshes = collectDepthMeshes(mesh, options.depthFlag);
            if (shouldShowDepth && depthMeshes.length === 0 && typeof options.attachDepthPrepass === 'function') {
                options.attachDepthPrepass(mesh);
                depthMeshes = collectDepthMeshes(mesh, options.depthFlag);
            }
            depthMeshes.forEach(depthMesh => { depthMesh.visible = shouldShowDepth; });
            if (changed || depthMeshes.length) updated++;
        });
        return updated;
    }

    return { resolveBuiltDisplayPolicy, resolveBuildingRenderParts, passageClipPlanes, passageIntervals, updateRetainedBuildingMaterials };
});
