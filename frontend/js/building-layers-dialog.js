// The building-layers picker behind the B key: which of the three surveys are drawn on the map.
// They are independent references, not alternatives — any combination can be on, so the picker is
// three checkboxes rather than a choice of one. It opens every time, prefilled with what is
// currently on, so B is "change what I am looking at" rather than a one-off setup question.
//
// Enter takes the dialog's answer (Show is focused), Escape leaves the map as it was.
(function (global) {
    'use strict';

    // A faint survey fill with a contrasting outline; the palette lives in tokens.css.
    function buildingLayerStyle() {
        const palette = global.getComputedStyle(global.document.documentElement);
        const token = name => palette.getPropertyValue(`--cb-observed-building-${name}`).trim();
        return { color: token('stroke'), opacity: Number(token('stroke-opacity')), weight: Number(token('stroke-width')),
            fillColor: token('fill'), fillOpacity: Number(token('fill-opacity')) };
    }

    const SURVEYS = [
        { key: 'gdi', box: 'showBuildings', label: 'modal.buildingLayers.gdi', hint: 'modal.buildingLayers.gdiHint' },
        { key: 'dgu', box: 'showBuildingsDgu', label: 'modal.buildingLayers.dgu', hint: 'modal.buildingLayers.dguHint' },
        { key: 'osm', box: 'showBuildingsOsm', label: 'modal.buildingLayers.osm', hint: 'modal.buildingLayers.osmHint' }
    ];

    function translate(key, fallback) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key);
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        return fallback;
    }

    // What is on the map right now — the dialog's starting state, so it never contradicts it.
    function currentBuildingLayerState() {
        const state = {};
        SURVEYS.forEach(survey => {
            state[survey.key] = !!(global.document && document.getElementById(survey.box)?.checked);
        });
        return state;
    }

    // The last choice the user made. It outlives the layers being switched off — the road profiler
    // turns them off again on the way out, and the answer to "which survey do you work in" should
    // not have to be given twice.
    let remembered = null;
    const rememberBuildingLayers = choice => {
        if (choice) remembered = { gdi: !!choice.gdi, dgu: !!choice.dgu, osm: !!choice.osm };
    };
    const rememberedBuildingLayers = () => (remembered ? { ...remembered } : null);

    // The shared dialog (js/ui/dialogs.js) with `building-layers-dialog` as its identity class;
    // resolves the picked surveys, or null when cancelled (Cancel, Escape, the backdrop).
    function open() {
        const showing = currentBuildingLayerState();
        const anyShowing = SURVEYS.some(survey => showing[survey.key]);
        // Prefill from the map when something is on it, otherwise from the last answer.
        const start = anyShowing ? showing : (rememberedBuildingLayers() || { gdi: false, dgu: false, osm: false });

        const list = document.createElement('div');
        list.className = 'building-layers-options';
        const inputs = {};
        SURVEYS.forEach(survey => {
            const row = document.createElement('label');
            row.className = 'building-layers-option';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = start[survey.key];
            inputs[survey.key] = input;
            const text = document.createElement('span');
            const name = document.createElement('strong');
            name.textContent = translate(survey.label, survey.key.toUpperCase());
            const hint = document.createElement('small');
            hint.textContent = translate(survey.hint, '');
            text.appendChild(name);
            text.appendChild(hint);
            row.appendChild(input);
            row.appendChild(text);
            list.appendChild(row);
        });

        const answer = () => {
            const picked = {};
            SURVEYS.forEach(survey => { picked[survey.key] = !!inputs[survey.key].checked; });
            rememberBuildingLayers(picked);
            return picked;
        };

        let dialogApi = null;
        function onKeydown(event) {
            if (event.key === 'Enter') {
                // Enter means Show wherever the focus sits — including on a checkbox, where
                // Enter would otherwise do nothing at all.
                event.preventDefault();
                dialogApi.close(answer());
            }
            // Nothing else may leak to the page behind: B, R and the drawing hotkeys all listen on
            // document too. (Escape is the modal router's, which runs first and closes the dialog.)
            event.stopPropagation();
        }
        dialogApi = global.CbDialog.open({
            title: translate('modal.buildingLayers.title', 'Which buildings to show?'),
            size: 'sm',
            className: 'building-layers-dialog',
            body: list,
            actions: [
                { id: 'cancel', value: null, label: translate('modal.buildingLayers.cancel', 'Cancel'), role: 'secondary' },
                { id: 'show', label: translate('modal.buildingLayers.show', 'Show'), role: 'primary', autofocus: true,
                    keepOpen: true, onClick: api => api.close(answer()) }
            ]
        });
        if (!dialogApi) return Promise.resolve(null);
        document.addEventListener('keydown', onKeydown, true);
        return dialogApi.closed.then(result => {
            document.removeEventListener('keydown', onKeydown, true);
            return result && typeof result === 'object' ? result : null;
        });
    }

    global.BuildingLayersDialog = {
        get style() { return buildingLayerStyle(); },
        open,
        currentBuildingLayerState,
        remember: rememberBuildingLayers,
        remembered: rememberedBuildingLayers
    };
})(typeof window !== 'undefined' ? window : globalThis);
