// B opens the shared Built visibility switch and the city's building source list. Changes apply immediately.
(function (global) {
    'use strict';

    function translate(key, fallback) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key);
                if (translated && translated !== key) return translated;
            }
        } catch (_) { }
        return fallback;
    }

    // The shared dialog (js/ui/dialogs.js) with `building-layers-dialog` as its identity class;
    // resolves when it closes (Done, Enter, Escape, the backdrop).
    function open() {
        const body = document.createElement('div');
        body.className = 'building-layers-body';
        const master = document.createElement('label');
        master.className = 'cb-switch building-layers-master';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('role', 'switch');
        const syncVisibility = () => { input.checked = global.PlanningViews.isBuiltVisible(); };
        syncVisibility();
        input.addEventListener('change', () => global.PlanningViews.setBuiltVisible(input.checked));
        const label = document.createElement('span');
        label.textContent = translate('sidebar.buildings.showLayer', 'Show buildings');
        master.append(input, label);
        const sources = document.createElement('div');
        sources.className = 'source-list-editor-host';
        body.append(master, sources);
        global.ParcelSourceSettings.renderBuildingSourceList(sources, global);

        let dialogApi = null;
        function onKeydown(event) {
            // Enter closes wherever the focus sits, except on a button (move up/down, Remove, Done),
            // where it presses that button.
            if (event.key === 'Enter' && !event.target?.closest?.('button')) {
                event.preventDefault();
                dialogApi.close(null);
            }
            // Nothing else may leak to the page behind: B, R and the drawing hotkeys all listen on
            // document too. (Escape is the modal router's, which runs first and closes the dialog.)
            event.stopPropagation();
        }
        dialogApi = global.CbDialog.open({
            title: translate('modal.buildingLayers.title', 'Which buildings to show?'),
            size: 'sm',
            className: 'building-layers-dialog',
            body,
            actions: [
                { id: 'done', value: null, label: translate('modal.buildingLayers.done', 'Done'), role: 'primary', autofocus: true }
            ]
        });
        if (!dialogApi) return Promise.resolve();
        document.addEventListener('building-layers-changed', syncVisibility);
        document.addEventListener('keydown', onKeydown, true);
        return dialogApi.closed.then(() => {
            document.removeEventListener('building-layers-changed', syncVisibility);
            document.removeEventListener('keydown', onKeydown, true);
        });
    }

    global.BuildingLayersDialog = { open };
})(typeof window !== 'undefined' ? window : globalThis);
