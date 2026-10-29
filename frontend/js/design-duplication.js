// Duplicate movable design geometry at a new site without carrying its identity or agreements.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DesignDuplication = api;
    if (root?.document) root.startDesignDuplication = id => api.start(id, root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function templateOf(source, env) {
        if (!env.ProposalDesignGoals.canDuplicate(source)) throw new Error('This design is tied to its site.');
        const material = env.DesignRecord.published(source);
        material.origin = null;
        material.author = null;
        const adapter = env.getProposalEditorAdapter(source.goal);
        const template = adapter.draftFromProposal(material);
        const site = env.__siteDraft.toMultiPolygon(material.site || template.editorPayload?.geometry);
        if (!site) throw new Error('The design has no movable site.');
        return {
            cityId: source.city, goal: source.goal, adapterKey: source.goal,
            proposalType: template.proposalType,
            fields: { name: source.title || source.name || '', description: source.description || '',
                titleOrigin: 'user', site, selectedParcelIds: [], cadastreParcelIds: [], binding: null,
                toleranceM: typeof source.toleranceM === 'number' && Number.isFinite(source.toleranceM) ? source.toleranceM : 0 },
            editorPayload: clone(template.editorPayload), previewGeometry: clone(template.previewGeometry)
        };
    }

    function movedTemplate(template, to, geometry) {
        const from = geometry.geometryCenter(template.fields.site);
        if (!from || !Number.isFinite(to?.lat) || !Number.isFinite(to?.lng)) throw new Error('Invalid placement point.');
        const move = value => geometry.moveCoordinateCollection(value, from, to);
        // Only geographic geometry and authored decoration coordinates move. Dimensions, local mesh
        // vertices, colors, angles and other parameter arrays retain their own units and meaning.
        function visit(value) {
            if (value == null || typeof value !== 'object') return value;
            if (Array.isArray(value)) return value.map(item => visit(item));
            const output = {};
            for (const [name, item] of Object.entries(value)) {
                if (name === 'coordinates' && ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(value.type)) output[name] = move(item);
                else if (name === 'decorationDesign') {
                    output[name] = Object.fromEntries(Object.entries(item || {}).map(([kind, records]) => [kind,
                        ['trees', 'benches', 'lamps', 'stalls', 'swings', 'seesaws', 'slides'].includes(kind) ? records.map(record => (Array.isArray(record) ? move(record) : { ...clone(record), coordinate: move(record.coordinate) }))
                            : kind === 'enclosures' ? records.map(record => ({ ...clone(record), gates: (record.gates || []).map(gate => move(gate)), ...(record.ring ? { ring: move(record.ring) } : {}) }))
                                : move(clone(records))]));
                } else output[name] = visit(item);
            }
            return output;
        }
        const result = visit(template);
        delete result.editorPayload.facets;
        if (result.editorPayload.context) {
            result.editorPayload.context.parcelIds = [];
            result.editorPayload.context.blockName = null;
        }
        result.fields.selectedParcelIds = [];
        result.fields.cadastreParcelIds = [];
        result.fields.binding = null;
        result.editorPayload.placement = { free: true, site: clone(result.fields.site), bindingStatus: 'pending' };
        return result;
    }

    function pointerLatLng(event, env) {
        if (!env.isThreeModeActive?.()) return env.map.mouseEventToLatLng(event);
        const view = env.getThreeModeInternals?.();
        if (!view || event.target !== view.renderer.domElement) return null;
        const rect = view.renderer.domElement.getBoundingClientRect();
        const ray = new env.THREE.Raycaster();
        ray.setFromCamera(new env.THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
            -(event.clientY - rect.top) / rect.height * 2 + 1), view.camera);
        const point = new env.THREE.Vector3();
        if (!ray.ray.intersectPlane(new env.THREE.Plane(new env.THREE.Vector3(0, 0, 1), 0), point)) return null;
        return view.xyToLatLng(point.x, point.y);
    }

    function start(id, env) {
        if (env.OnMapEditor?.isActive?.()) return false;
        const source = env.proposalStorage.getProposal(id);
        if (!source || source.city && source.city !== env.CityConfigManager.getCurrentCityId()) return false;
        const template = templateOf(source, env);
        const tr = (key, fallback) => {
            const value = env.i18n?.t?.(`designDuplicate.${key}`);
            return value && value !== `designDuplicate.${key}` ? value : fallback;
        };
        let layer = null, frame = null, pending = null, current = null, closed = false, down = null;
        const session = env.OnMapEditor.open({ owner: 'design-duplicate', id: 'design-duplicate-editor',
            title: tr('title', 'Duplicate design'), modes: ['2d', 'model'],
            hints: { '2d': tr('hint', 'Move the copy, then click to place it. Escape cancels.'),
                model: tr('hint', 'Move the copy, then click to place it. Escape cancels.') },
            onCancel: close });
        if (!session) return false;
        function close() {
            if (closed) return;
            closed = true;
            if (frame != null) env.cancelAnimationFrame(frame);
            layer?.remove();
            env.document.removeEventListener('pointermove', onMove, true);
            env.document.removeEventListener('pointerdown', onDown, true);
            env.document.removeEventListener('click', onClick, true);
            env.document.removeEventListener('keydown', onKey, true);
            env.removeEventListener('cityChanged', close);
            session.close();
        }
        function onMap(event) {
            return !event.target.closest?.('.on-map-editor, .leaflet-control, .leaflet-popup, .map-sheet, [role="dialog"]')
                && (env.map.getContainer().contains(event.target)
                    || event.target === env.getThreeModeInternals?.()?.renderer.domElement);
        }
        function update(point) {
            if (!point || closed) return;
            current = movedTemplate(template, point, env.SingleBuildingGeometry);
            const descriptor = env.getProposalEditorAdapter(current.goal).renderPreview(current, '2d');
            const features = descriptor.features || descriptor.geometry;
            layer?.remove();
            layer = env.L.geoJSON(Array.isArray(features) ? { type: 'FeatureCollection', features } : features,
                { pane: session.pane, interactive: false, className: 'design-duplicate-preview' }).addTo(env.map);
            session.setPreview({ draftPreview: descriptor, groundSurface: current.editorPayload.context?.groundSurface });
        }
        function onMove(event) {
            if (!onMap(event)) return;
            pending = pointerLatLng(event, env);
            if (frame != null) return;
            frame = env.requestAnimationFrame(() => { frame = null; update(pending); });
        }
        function onDown(event) { down = { x: event.clientX, y: event.clientY }; }
        function onKey(event) {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault(); event.stopImmediatePropagation(); close();
        }
        function onClick(event) {
            if (event.button !== 0 || !onMap(event) || !down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
            event.preventDefault(); event.stopImmediatePropagation();
            const point = pointerLatLng(event, env);
            if (!point) return;
            update(point);
            const draft = env.proposalDraftStore.createDraft(current);
            close();
            Promise.resolve(env.instantCreateProposalFromDraft(draft.id)).catch(env.reportProposalDesignSaveFailure);
        }
        env.document.addEventListener('pointermove', onMove, true);
        env.document.addEventListener('pointerdown', onDown, true);
        env.document.addEventListener('click', onClick, true);
        env.document.addEventListener('keydown', onKey, true);
        env.addEventListener('cityChanged', close);
        update(env.map.getCenter());
        return true;
    }
    return { templateOf, movedTemplate, pointerLatLng, start };
});
