// The building-layers picker behind the B key: which of the three surveys are drawn on the map.
// They are independent references, not alternatives — any combination can be on, so the picker is
// three checkboxes rather than a choice of one. It opens every time, prefilled with what is
// currently on, so B is "change what I am looking at" rather than a one-off setup question.
//
// Enter takes the dialog's answer (Show is focused), Escape leaves the map as it was.
(function (global) {
    'use strict';

    // All three surveys draw in the SAME light purple, deliberately: they are three answers to one
    // question, and telling them apart by colour invites reading them as different KINDS of thing.
    // Low fill opacity is what makes the combination legible — where two surveys agree the overlap
    // stacks darker, so the eye finds the disagreements on its own.
    const BUILDING_LAYER_STYLE = { color: '#7c3aed', opacity: 0.55, weight: 1, fillColor: '#7c3aed', fillOpacity: 0.12 };

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

    function open() {
        return new Promise(resolve => {
            const showing = currentBuildingLayerState();
            const anyShowing = SURVEYS.some(survey => showing[survey.key]);
            // Prefill from the map when something is on it, otherwise from the last answer.
            const start = anyShowing ? showing : (rememberedBuildingLayers() || { gdi: true, dgu: false, osm: false });
            const overlay = document.createElement('div');
            overlay.className = 'cb-confirm-overlay';
            const dialog = document.createElement('div');
            dialog.className = 'cb-confirm-dialog building-layers-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');

            const title = document.createElement('div');
            title.className = 'cb-confirm-message';
            title.textContent = translate('modal.buildingLayers.title', 'Which buildings to show?');
            dialog.appendChild(title);

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
            dialog.appendChild(list);

            const buttons = document.createElement('div');
            buttons.className = 'cb-confirm-buttons';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'btn btn-secondary';
            cancel.textContent = translate('modal.buildingLayers.cancel', 'Cancel');
            const confirm = document.createElement('button');
            confirm.type = 'button';
            confirm.className = 'btn btn-action';
            confirm.textContent = translate('modal.buildingLayers.show', 'Show');
            buttons.appendChild(cancel);
            buttons.appendChild(confirm);
            dialog.appendChild(buttons);

            function cleanup(result) {
                document.removeEventListener('keydown', onKeydown, true);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(result);
            }
            const answer = () => {
                const picked = {};
                SURVEYS.forEach(survey => { picked[survey.key] = !!inputs[survey.key].checked; });
                rememberBuildingLayers(picked);
                return picked;
            };

            function onKeydown(event) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    cleanup(null);
                } else if (event.key === 'Enter') {
                    // Enter means Show wherever the focus sits — including on a checkbox, where
                    // Enter would otherwise do nothing at all.
                    event.preventDefault();
                    cleanup(answer());
                }
                // Nothing else may leak to the page behind: B, R and the drawing hotkeys all
                // listen on document too.
                event.stopPropagation();
            }
            document.addEventListener('keydown', onKeydown, true);
            cancel.addEventListener('click', () => cleanup(null));
            confirm.addEventListener('click', () => cleanup(answer()));
            overlay.addEventListener('click', event => { if (event.target === overlay) cleanup(null); });

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            // Focus after layout — a synchronous focus from inside another event handler loses to
            // whatever refocuses afterwards (the map container does).
            requestAnimationFrame(() => confirm.focus({ preventScroll: true }));
        });
    }

    global.BuildingLayersDialog = {
        style: BUILDING_LAYER_STYLE,
        open,
        currentBuildingLayerState,
        remember: rememberBuildingLayers,
        remembered: rememberedBuildingLayers
    };
})(typeof window !== 'undefined' ? window : globalThis);
