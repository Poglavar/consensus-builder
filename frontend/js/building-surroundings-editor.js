// Shared surroundings control and live ground preview for parcel-bound building rule editors.
(function (global) {
    'use strict';

    function edit({ session, surface, onSave, onOpen, onClose }) {
        if (!surface) return false;
        const kind = surface.treatment === 'green' ? 'park' : 'square';
        const opened = global.openStructureGeometryEditor({
            id: `${session.root.id}:surroundings`, adapterKey: kind,
            editorPayload: { structureProposal: {
                kind, geometry: surface.polygon,
                decorationDesign: surface.decorationDesign || { version: kind === 'park' ? 3 : 2 }
            } }
        }, { parentSession: session, onSave, onClose });
        if (opened) onOpen?.();
        return opened;
    }

    function mount({ session, id, initialTreatment, initialDecorationDesign = null, boundary, buildings, onChange }) {
        const ground = global.BuildingGround;
        let treatment = ground.normalizeTreatment(initialTreatment);
        let decorationDesign = initialDecorationDesign;
        let layer = null;
        const group = document.createElement('div');
        group.className = 'parameter-group';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.dataset.i18nKey = 'modal.singleBuilding.surroundingsLabel';
        label.textContent = 'Surroundings';
        const select = document.createElement('select');
        select.id = id;
        for (const [value, key, text] of [
            ['none', 'surroundingsNone', 'Leave as they are'],
            ['paved', 'surroundingsPaved', 'Paved'],
            ['green', 'surroundingsGreen', 'Green']
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.dataset.i18nKey = `modal.singleBuilding.${key}`;
            option.textContent = text;
            select.appendChild(option);
        }
        select.value = treatment;
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'btn btn-sm';
        editButton.dataset.i18nKey = 'modal.singleBuilding.editSurroundings';
        editButton.textContent = 'Edit surroundings';
        editButton.id = `${id}-edit`;
        group.append(label, select, editButton);
        const moreSummary = session.content.querySelector('.on-map-editor__more-options > summary');
        if (moreSummary) moreSummary.after(group);
        else session.content.prepend(group);
        global.i18n?.applyTranslations?.(group);

        function surface() { return ground.buildSurface(treatment, boundary(), buildings(), decorationDesign); }
        function clear() {
            if (layer) session.map.removeLayer(layer);
            layer = null;
        }
        function refresh() {
            clear();
            editButton.disabled = treatment === 'none';
            let value;
            try { value = surface(); } catch (error) {
                if (error?.code !== 'clip-failed') throw error;
                global.__parcelArrangement?.reportClipFailure('difference', error, { site: 'building-surroundings.preview' }, []);
                return null;
            }
            if (value) {
                layer = global.L.featureGroup().addTo(session.map);
                global.drawBuildingGroundSurface(layer, value, session.pane);
                layer.bringToBack();
            }
            editButton.disabled = !value;
            return value;
        }
        editButton.disabled = treatment === 'none';
        editButton.addEventListener('click', () => edit({ session, surface: surface(), onOpen: clear, onClose: refresh, onSave: design => {
            decorationDesign = design;
            session.setPreview({ ...(session.preview || {}), groundSurface: refresh() });
            onChange();
        } }));
        select.addEventListener('change', () => {
            treatment = ground.normalizeTreatment(select.value);
            decorationDesign = null;
            session.setPreview({ ...(session.preview || {}), groundSurface: refresh() });
            onChange();
        });
        return { surface, refresh, destroy: clear, get treatment() { return treatment; }, get signature() { return JSON.stringify([treatment, decorationDesign]); } };
    }

    global.BuildingSurroundingsEditor = { mount, edit };
})(window);
