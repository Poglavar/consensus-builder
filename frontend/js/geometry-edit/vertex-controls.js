// Keyboard and single-click alternatives to the shared polygon editor's map handles.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PolygonVertexControls = api;
})(typeof window !== 'undefined' ? window : globalThis, function (env) {
    'use strict';
    const containers = new WeakMap();

    function create(initialEditor) {
        let editor = initialEditor;
        const ui = env.GeometryCoordinateControls;
        const doc = editor.document;
        const container = editor.options.controlsContainer || env.OnMapEditor?.getControlsContainer?.() || editor.map.getContainer?.();
        if (!ui || !doc?.createElement || !container) return null;
        const key = editor.options.controlsKey || 'polygon';
        let controls = containers.get(container);
        if (!controls) { controls = new Map(); containers.set(container, controls); }
        // Hosts redraw their polygon controller on commit. Retain the native controls so typing,
        // disclosure state and focus survive that redraw; closing the editor releases them.
        const previous = controls.get(key);
        if (previous?.owner.destroyed) { previous.attach(editor); return previous; }
        const root = ui.node(doc, 'details', 'geometry-controls', container);
        root.classList.toggle('geometry-controls--floating', container === editor.map.getContainer?.());
        const summary = ui.node(doc, 'summary', '', root, editor.options.controlsLabel || ui.text('editVertices', 'Edit vertices'));
        const select = ui.select(doc, root, ui.text('vertex', 'Vertex'));
        editor.L.DomEvent?.disableClickPropagation?.(root);
        editor.L.DomEvent?.disableScrollPropagation?.(root);
        const position = ui.create({ document: doc, parent: root,
            onChange(point) {
                const index = Number(select.value);
                return editor.moveVertex(index, point) ? editor.ring[editor.selectedVertexIndex ?? index] : null;
            }
        });
        const actions = ui.node(doc, 'div', 'geometry-controls__actions', root);
        const insert = ui.button(doc, actions, ui.text('insertVertex', 'Add point after'), () => {
            const index = Number(select.value);
            const start = editor.ring[index];
            const end = editor.ring[(index + 1) % editor.ring.length];
            if (!start || !end) return;
            const point = env.turf.midpoint(start, end).geometry.coordinates;
            if (editor.insertVertex(index, point)) {
                editor.selectVertex(index + 1, { showDeleteAction: false });
                position.announce(ui.text('pointAdded', 'Point added.'));
            }
            else position.announce(ui.text('rejected', 'This change does not fit the allowed boundary or shape.'), true);
        });
        const remove = ui.button(doc, actions, ui.text('removeVertex', 'Remove point'), () => {
            editor.selectVertex(Number(select.value), { showDeleteAction: false });
            if (editor.removeSelectedVertex()) position.announce(ui.text('pointRemoved', 'Point removed.'));
            else position.announce(ui.text('rejected', 'This change does not fit the allowed boundary or shape.'), true);
        });
        select.addEventListener('change', () => editor.selectVertex(Number(select.value), { showDeleteAction: false }));
        function update() {
            const selected = editor.selectedVertexIndex ?? Math.min(Number(select.value) || 0, editor.ring.length - 1);
            if (select.options.length !== editor.ring.length) {
                select.replaceChildren();
                editor.ring.forEach((_, index) => {
                    const option = ui.node(doc, 'option', '', select, ui.text('vertexNumber', 'Vertex {{number}}', { number: index + 1 }));
                    option.value = String(index);
                });
            }
            select.value = String(selected);
            position.setCoordinate(editor.ring[selected]);
            remove.disabled = editor.ring.length <= 3;
            insert.disabled = editor.ring.length < 3;
        }
        update();
        const api = {
            root, update,
            get owner() { return editor; },
            attach(nextEditor) {
                editor = nextEditor;
                summary.textContent = editor.options.controlsLabel || ui.text('editVertices', 'Edit vertices');
                update();
            },
            destroy() {
                const owner = editor;
                queueMicrotask(() => {
                    if (editor !== owner || !owner.destroyed) return;
                    root.remove();
                    if (controls.get(key) === api) controls.delete(key);
                });
            }
        };
        controls.set(key, api);
        return api;
    }

    return { create };
});
