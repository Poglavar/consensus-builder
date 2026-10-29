// Presentation-only descriptions of accepted shared-plan changes.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SharedPlanMotion = api;
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const earth = 111319.49079327358;
    const point = value => Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
    function coordinates(value, out = []) {
        if (point(value)) out.push(value);
        else if (Array.isArray(value)) {
            const closed = value.length > 1 && value.every(point) && equal(value[0], value[value.length - 1]);
            (closed ? value.slice(0, -1) : value).forEach(item => coordinates(item, out));
        }
        return out;
    }
    function topology(value) {
        if (point(value)) return 'p';
        return Array.isArray(value) ? value.map(topology) : null;
    }
    function rigid(before, after) {
        if (!before || !after || before.type !== after.type || !equal(topology(before.coordinates), topology(after.coordinates))) return null;
        const a = coordinates(before.coordinates), b = coordinates(after.coordinates);
        if (a.length < 2 || a.length !== b.length) return null;
        const lat = a.reduce((s, p) => s + p[1], 0) / a.length;
        const scaleX = earth * Math.cos(lat * Math.PI / 180);
        if (Math.abs(scaleX) < 1) return null;
        const project = p => [p[0] * scaleX, p[1] * earth];
        const aa = a.map(project), bb = b.map(project);
        const center = points => points.reduce((s, p) => [s[0] + p[0] / points.length, s[1] + p[1] / points.length], [0, 0]);
        const ca = center(aa), cb = center(bb);
        let dot = 0, cross = 0, spread = 0;
        aa.forEach((p, i) => {
            const x = p[0] - ca[0], y = p[1] - ca[1];
            const u = bb[i][0] - cb[0], v = bb[i][1] - cb[1];
            dot += x * u + y * v; cross += x * v - y * u; spread += x * x + y * y;
        });
        if (spread < 0.01) return null;
        const angle = Math.atan2(cross, dot), c = Math.cos(angle), s = Math.sin(angle);
        if (aa.some((p, i) => {
            const x = p[0] - ca[0], y = p[1] - ca[1];
            return Math.hypot(c * x - s * y + cb[0] - bb[i][0], s * x + c * y + cb[1] - bb[i][1]) > 0.1;
        })) return null;
        const eastM = cb[0] - ca[0], northM = cb[1] - ca[1];
        return { eastM, northM, distanceM: Math.hypot(eastM, northM), degrees: angle * 180 / Math.PI };
    }
    const without = (object, keys) => Object.fromEntries(Object.entries(object || {}).filter(([key]) => !keys.includes(key)));
    function objects(row) {
        const content = row?.content || {};
        const buildings = (content.geometry?.buildings || []).map((value, index) => ({ type: 'building', index, value }));
        const benches = (content.structureProposal?.decorationDesign?.benches || []).map((value, index) => ({ type: 'bench', index, value }));
        return [...buildings, ...benches];
    }
    function reference(row, object) { return { cid: row.cid, type: object.type, index: object.index }; }
    function record(kind, row, object, extra = {}) {
        return { kind, label: row.content?.title || '', type: object.type, ...extra };
    }
    function transform(a, b) {
        if (a.type !== b.type) return null;
        if (a.type === 'building') {
            // The shared rotate/move editor removes placement hints once geometry is authoritative.
            const placement = ['_corners', '_sideMidpoints', 'rotation', 'offsetX', 'offsetY'];
            if (!equal(without(a.value, ['geometry', 'properties']), without(b.value, ['geometry', 'properties']))
                || !equal(without(a.value.properties, placement), without(b.value.properties, placement))) return null;
            return rigid(a.value.geometry, b.value.geometry);
        }
        const p = a.value.coordinate || a.value.coord, q = b.value.coordinate || b.value.coord;
        if (!point(p) || !point(q) || !equal(without(a.value, ['coordinate', 'coord', 'bearing']), without(b.value, ['coordinate', 'coord', 'bearing']))) return null;
        const eastM = (q[0] - p[0]) * earth * Math.cos((p[1] + q[1]) * Math.PI / 360);
        const northM = (q[1] - p[1]) * earth;
        const degrees = (((Number(b.value.bearing || 0) - Number(a.value.bearing || 0)) + 540) % 360) - 180;
        if (!Number.isFinite(degrees)) return null;
        return { eastM, northM, distanceM: Math.hypot(eastM, northM), degrees };
    }
    function paired(before, after) {
        const old = objects(before), current = objects(after), result = [];
        for (const type of ['building', 'bench']) {
            const a = old.filter(x => x.type === type), b = current.filter(x => x.type === type);
            // An unchanged element is safe to recognize only when its value is unique on both sides.
            const remainingA = a.filter(x => a.filter(y => equal(x.value, y.value)).length !== 1 || b.filter(y => equal(x.value, y.value)).length !== 1);
            const remainingB = b.filter(x => b.filter(y => equal(x.value, y.value)).length !== 1 || a.filter(y => equal(x.value, y.value)).length !== 1);
            if (remainingA.length === 1 && remainingB.length === 1) {
                const x = remainingA[0], y = remainingB[0], motion = transform(x, y);
                const kind = motion && motion.distanceM > 0.05 ? 'move' : motion && Math.abs(motion.degrees) > 0.1 ? 'rotate' : 'change';
                result.push(record(kind, after, y, { before: reference(before, x), after: reference(after, y), ...(motion || {}) }));
            } else {
                remainingA.forEach(x => result.push(record('remove', before, x, { before: reference(before, x) })));
                remainingB.forEach(x => result.push(record('add', after, x, { after: reference(after, x) })));
            }
        }
        if (!result.length && !equal(before.content, after.content)) result.push({ kind: 'change', label: after.content?.title || '', before: { cid: before.cid }, after: { cid: after.cid } });
        return result;
    }
    function describe({ previous, next, change } = {}) {
        const old = previous?.designs || [], current = next?.designs || [];
        const oldByCid = new Map(old.map(row => [row.cid, row])), newByCid = new Map(current.map(row => [row.cid, row]));
        const usedOld = new Set(), usedNew = new Set(), result = [];
        for (const row of old) if (newByCid.has(row.cid)) { usedOld.add(row.cid); usedNew.add(row.cid); }
        const trusted = change && previous?.cid === change.fromCid && next?.cid === change.toCid;
        if (trusted) for (const member of change.members || []) {
            const a = oldByCid.get(member.beforeCid), b = newByCid.get(member.afterCid);
            if (!a || !b || usedOld.has(a.cid) || usedNew.has(b.cid)) continue;
            // Receipt must unambiguously identify this pair.
            if (change.members.filter(x => x.beforeCid === a.cid || x.afterCid === b.cid).length !== 1) continue;
            usedOld.add(a.cid); usedNew.add(b.cid); result.push(...paired(a, b));
        }
        for (const row of old) if (!usedOld.has(row.cid)) {
            const list = objects(row);
            if (!list.length) result.push({ kind: 'remove', label: row.content?.title || '', before: { cid: row.cid } });
            else list.forEach(x => result.push(record('remove', row, x, { before: reference(row, x) })));
        }
        for (const row of current) if (!usedNew.has(row.cid)) {
            const list = objects(row);
            if (!list.length) result.push({ kind: 'add', label: row.content?.title || '', after: { cid: row.cid } });
            else list.forEach(x => result.push(record('add', row, x, { after: reference(row, x) })));
        }
        return result;
    }
    function browser(root) {
        let active = null;
        function prepare({ previous, next, change, changedBeforeIds = [], changedAfterIds = [] } = {}) {
            active?.cancel();
            const changes = describe({ previous, next, change });
            const beforeIds = new Set(changedBeforeIds.map(String));
            const retainedIds = (previous?.designs || []).flatMap((row, index) =>
                (next?.designs || []).some(member => member.cid === row.cid) && previous.memberIds?.[index] != null
                    ? [String(previous.memberIds[index])] : []);
            const three = root.SharedPlanMotion3D?.capture?.({ previous, next, changes, beforeIds: [...beforeIds], retainedIds });
            const releaseRetained = root.SharedPlanMotionBuildings?.begin?.(retainedIds) || (() => {});
            const releaseStructures = root.SharedPlanMotionStructures?.begin?.() || (() => {});
            let cancelled = false, done = false, frame = null, timer = null, cleanup = () => {}, resolveFinish = null;
            const controller = {
                cancel() {
                    if (done) return;
                    cancelled = true; done = true;
                    if (frame != null) root.cancelAnimationFrame(frame);
                    if (timer != null) root.clearTimeout(timer);
                    cleanup(); three?.cancel?.(); releaseRetained(); releaseStructures();
                    root.document?.removeEventListener?.('visibilitychange', visibility);
                    media?.removeEventListener?.('change', motionChanged);
                    if (active === controller) active = null;
                    resolveFinish?.();
                },
                async finish({ next: finalRow = next, memberIds } = {}) {
                    if (done || cancelled) return;
                    const idByCid = new Map((finalRow?.designs || []).map((row, index) => [row.cid, String((memberIds || finalRow.memberIds || [])[index] ?? '')]));
                    const reduce = root.__reducedMotion || root.matchMedia?.('(prefers-reduced-motion: reduce)').matches || root.document?.hidden;
                    if (reduce || !changes.length) { controller.cancel(); return; }
                    const afterIds = changedAfterIds.length ? changedAfterIds : [...new Set(changes.map(item => idByCid.get(item.after?.cid)).filter(Boolean))];
                    const overlay = createMapOverlay(root, previous, finalRow, changes, idByCid, afterIds);
                    cleanup = () => overlay?.cleanup();
                    overlay?.frame(0);
                    // Readiness and animation have separate deadlines: a slow build must not consume the animation.
                    timer = root.setTimeout(() => controller.cancel(), 2000);
                    try { await Promise.race([Promise.resolve(three?.finish?.({ next: finalRow, memberIds, afterIds })), new Promise(resolve => { resolveFinish = resolve; })]); }
                    catch (error) { controller.cancel(); throw error; }
                    if (done) return;
                    root.clearTimeout(timer);
                    timer = root.setTimeout(() => controller.cancel(), 900);
                    await new Promise(resolve => {
                        resolveFinish = resolve;
                        const started = root.performance.now();
                        const tick = now => {
                            if (done) return;
                            const t = Math.min(1, Math.max(0, (now - started) / 550));
                            const eased = t * t * (3 - 2 * t);
                            overlay?.frame(eased); three?.frame?.(eased);
                            if (t === 1) { controller.cancel(); return; }
                            frame = root.requestAnimationFrame(tick);
                        };
                        frame = root.requestAnimationFrame(tick);
                    });
                }
            };
            const media = root.matchMedia?.('(prefers-reduced-motion: reduce)');
            const visibility = () => { if (root.document.hidden) controller.cancel(); };
            const motionChanged = () => { if (media.matches) controller.cancel(); };
            root.document?.addEventListener?.('visibilitychange', visibility);
            media?.addEventListener?.('change', motionChanged);
            active = controller;
            return controller;
        }
        return { prepare };
    }
    function createMapOverlay(root, previous, next, changes, idByCid, afterIds) {
        const map = root.map, L = root.L;
        if (!map || !L || root.SharedPlanMotion3D?.isActive?.()) return null;
        const get = (row, ref) => {
            const member = row?.designs?.find(value => value.cid === ref?.cid);
            return member && objects(member).find(value => value.type === ref.type && value.index === ref.index)?.value;
        };
        const layer = L.layerGroup().addTo(map), entries = [];
        const hide = root.SharedPlanMotionBuildings?.hide?.(afterIds, changes, idByCid, next) || (() => {});
        const hideBench = root.SharedPlanMotionBenches?.hide?.(changes, idByCid, next) || (() => {});
        const material = { color: '#2563eb', fillColor: '#3b82f6', weight: 3, fillOpacity: 0.6, opacity: 0.9, interactive: false };
        function geo(value, opacity) {
            if (!value?.geometry) return null;
            return L.geoJSON(value, { style: { ...material, opacity, fillOpacity: opacity * 0.6 }, interactive: false }).addTo(layer);
        }
        function bench(value, opacity) {
            const coord = value?.coordinate || value?.coord;
            if (!point(coord)) return null;
            return L.marker([coord[1], coord[0]], { interactive: false, opacity,
                icon: L.divIcon({ className: 'park-bench-glyph', html: '<span style="display:block;color:#7c4a12;font-size:12px">▰</span>', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(layer);
        }
        for (const item of changes) {
            const a = get(previous, item.before), b = get(next, item.after);
            if (item.type === 'building') {
                const shape = item.kind === 'move' || item.kind === 'rotate' || item.kind === 'remove' ? a : b;
                const draw = geo(shape, item.kind === 'add' ? 0 : 0.9);
                if (draw) entries.push({ item, a, b, draw });
            } else if (item.type === 'bench') {
                const draw = bench(item.kind === 'add' || item.kind === 'change' ? b : a, item.kind === 'add' ? 0 : 1);
                if (draw) entries.push({ item, a, b, draw });
            }
        }
        function style(group, alpha) { group.setStyle({ ...material, opacity: alpha, fillOpacity: alpha * 0.6 }); }
        function rotateCoordinates(coords, centerA, centerB, angle, t) {
            if (point(coords)) {
                const sx = Math.cos(centerA[1] * Math.PI / 180), x = (coords[0] - centerA[0]) * sx, y = coords[1] - centerA[1];
                const c = Math.cos(angle * t), s = Math.sin(angle * t);
                return [centerA[0] + (centerB[0] - centerA[0]) * t + (c * x - s * y) / sx,
                    centerA[1] + (centerB[1] - centerA[1]) * t + s * x + c * y];
            }
            return coords.map(x => rotateCoordinates(x, centerA, centerB, angle, t));
        }
        const center = geometry => { const points = coordinates(geometry.coordinates); return points.reduce((sum, p) => [sum[0] + p[0] / points.length, sum[1] + p[1] / points.length], [0, 0]); };
        return {
            frame(t) {
                entries.forEach(({ item, a, b, draw }) => {
                    const alpha = item.kind === 'add' ? t : item.kind === 'remove' ? 1 - t : item.kind === 'change' ? 0.9 * (1 - t) : 0.9;
                    if (item.type === 'building') {
                        if ((item.kind === 'move' || item.kind === 'rotate') && a?.geometry && b?.geometry) {
                            const geometry = { ...a.geometry, coordinates: rotateCoordinates(a.geometry.coordinates, center(a.geometry), center(b.geometry), item.degrees * Math.PI / 180, t) };
                            draw.clearLayers(); draw.addData({ ...a, geometry });
                        }
                        style(draw, alpha);
                    } else {
                        draw.setOpacity(alpha);
                        if ((item.kind === 'move' || item.kind === 'rotate') && a && b) {
                            const p = a.coordinate || a.coord, q = b.coordinate || b.coord;
                            draw.setLatLng([p[1] + (q[1] - p[1]) * t, p[0] + (q[0] - p[0]) * t]);
                            const span = draw.getElement()?.firstElementChild;
                            if (span) span.style.transform = `rotate(${Number(a.bearing || 0) + item.degrees * t}deg)`;
                        }
                    }
                });
            },
            cleanup() { hide(); hideBench(); map.removeLayer(layer); }
        };
    }
    return { describe, rigid, browser, ...(typeof window === 'undefined' ? {} : browser(window)) };
});
