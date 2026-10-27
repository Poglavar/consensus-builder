// Searchable native object controls for existing furniture and coordinate-based placement.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StructureObjectControls = api;
})(typeof window !== 'undefined' ? window : globalThis, function (env) {
    'use strict';

    function create(options) {
        const ui = env.GeometryCoordinateControls;
        const doc = env.document;
        if (!ui || !options.parent || !doc) return null;
        const root = ui.node(doc, 'details', 'geometry-controls structure-object-controls', options.parent);
        ui.node(doc, 'summary', '', root, ui.text('objects', 'Objects'));
        const search = ui.field(doc, root, ui.text('searchObjects', 'Search objects'), { type: 'search', required: false });
        const list = ui.select(doc, root, ui.text('selectObject', 'Select object'));
        list.classList.add('geometry-controls__objects');
        list.size = 4;
        const count = ui.node(doc, 'p', 'geometry-controls__message', root);
        count.setAttribute('role', 'status');
        count.setAttribute('aria-live', 'polite');
        count.setAttribute('aria-atomic', 'true');
        let selected = null;
        let all = [];
        let signature = '';
        const position = ui.create({ parent: root, onChange(point) {
            return selected && options.move(selected, point) ? getSelected()?.coordinate : null;
        } });
        const tree = ui.node(doc, 'fieldset', 'geometry-controls__position', root);
        ui.node(doc, 'legend', '', tree, ui.text('treeProperties', 'Tree properties'));
        const kind = ui.select(doc, tree, ui.text('treeKind', 'Tree kind'));
        const kinds = env.__parkPlanting.TREE_KINDS;
        for (const [value, fallback] of [['broadleaf', 'Broadleaf'], ['conifer', 'Conifer'], ['columnar', 'Columnar'], ['ornamental', 'Ornamental']]) {
            const option = ui.node(doc, 'option', '', kind, ui.text(value, fallback));
            option.value = value;
        }
        const height = ui.field(doc, tree, ui.text('treeHeight', 'Height (m)'), { step: '0.1' });
        function heightRange() {
            const range = kinds[kind.value];
            if (!range) return;
            height.min = String(range.minHeightM);
            height.max = String(range.maxHeightM);
        }
        kind.addEventListener('change', () => {
            heightRange();
            if (height.value !== '') height.value = String(Math.max(Number(height.min), Math.min(Number(height.max), Number(height.value))));
        });
        ui.button(doc, tree, ui.text('applyProperties', 'Apply properties'), () => {
            if (!height.reportValidity() || !selected) return;
            if (options.updateTree(selected, { kind: kind.value, heightM: Number(height.value) })) {
                position.announce(ui.text('propertiesUpdated', 'Properties updated.'));
            }
        });
        const remove = ui.button(doc, root, ui.text('removeObject', 'Remove object'), () => {
            if (!selected) return;
            options.remove(selected);
            update();
            count.textContent = ui.text('objectRemoved', 'Object removed.');
            list.focus();
        });
        function getSelected() {
            return env.StructureEditorObjects.entries(options.getState().decorations, env.turf).find(entry => entry.key === selected);
        }
        function updateSelected() {
            const entry = all.find(item => item.key === selected);
            position.root.hidden = !entry;
            remove.disabled = !entry;
            tree.hidden = entry?.type !== 'trees';
            if (!entry) return;
            position.setCoordinate(entry.coordinate);
            if (entry.type === 'trees') {
                const value = options.getState().decorations.trees[entry.index];
                kind.value = value.kind;
                height.value = String(value.heightM);
                heightRange();
            }
        }
        function update() {
            all = env.StructureEditorObjects.entries(options.getState().decorations, env.turf).map(entry => ({ ...entry,
                label: `${options.toolLabel(entry.tool)} ${entry.index + 1}`
            }));
            const filtered = all.filter(entry => entry.label.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
            const nextSignature = JSON.stringify(filtered.map(entry => [entry.key, entry.label]));
            if (nextSignature !== signature) {
                signature = nextSignature;
                list.replaceChildren();
                filtered.forEach(entry => {
                    const option = ui.node(doc, 'option', '', list, entry.label);
                    option.value = entry.key;
                });
            }
            if (!filtered.some(entry => entry.key === selected)) selected = filtered[0]?.key || null;
            list.value = selected || '';
            const message = filtered.length ? ui.text('objectCount', '{{count}} objects', { count: filtered.length }) : ui.text('noObjects', 'No matching objects.');
            if (count.textContent !== message) count.textContent = message;
            updateSelected();
        }
        search.addEventListener('input', update);
        list.addEventListener('change', () => {
            selected = list.value;
            options.select(selected);
            updateSelected();
        });
        update();
        return { root, update, select(key) {
            search.value = '';
            selected = key;
            root.open = true;
            update();
        }, destroy: () => root.remove() };
    }

    return { create };
});
