// Map and focus lifecycle shared by the Dog and Hare dialogs.
(function (win) {
    'use strict';
    const doc = win.document;

    function create({ id, shell, evaluate, render, t }) {
        let session;
        function close(restore = true) {
            const current = session;
            if (!current) return;
            session = null;
            current.unregister();
            current.network?.remove();
            current.route?.remove();
            current.panel.remove();
            if (current.month && current.clockPlan === win.BuildoutClock.plan()) win.BuildoutClock.open(current.month);
            if (!restore) return;
            if (current.framed) win.map.setView(current.center, current.zoom, { animate: false });
            const mode = current.mode !== '2d' && win.requestMapMode(current.mode);
            if (current.returnTo) {
                void Promise.resolve(mode).then(() => current.returnTo(current.plan, id))
                    .catch(error => win.showStyledAlert(error.message));
            } else if (current.row) {
                win.MapShell.openSheet('proposals-sheet');
                doc.querySelector(`#plan-list-host [data-list-id="${win.CSS.escape(current.row)}"] [data-critic-control="${id}"]`)?.focus();
            }
        }

        function frame(current, bounds) {
            if (!bounds.isValid()) return;
            const map = win.map.getContainer().getBoundingClientRect(), panel = current.panel.getBoundingClientRect();
            const mobile = win.matchMedia('(max-width: 767px)').matches;
            win.map.fitBounds(bounds, { maxZoom: 19, animate: false, paddingTopLeft: [35, 80],
                paddingBottomRight: mobile ? [35, map.bottom - panel.top + 12] : [map.right - panel.left + 20, 70] });
            current.framed = true;
        }

        async function open(plan, row, returnTo) {
            close(false);
            const current = { ...shell(plan), plan, row, returnTo, mode: win.__mapModeState?.desired || '2d',
                center: win.map.getCenter(), zoom: win.map.getZoom() };
            session = current;
            current.unregister = win.ModalEscape.register(current.panel, () => close());
            current.ui.close.addEventListener('click', () => close());
            win.MapShell.closeSheets();
            win.ClickStack?.close();
            win.clearProposalPreview?.();
            current.ui.close.focus();
            try {
                const snapshot = await win.PlanWorkspace.resolve(plan);
                if (session !== current) return;
                if (current.mode !== '2d' && !await win.requestMapMode('2d')) throw new Error(t('mapUnavailable'));
                if (session !== current) return;
                const assessment = evaluate(snapshot.content, snapshot.designs);
                current.month = win.BuildoutClock?.month();
                if (current.month) {
                    current.clockPlan = win.BuildoutClock.plan();
                    win.BuildoutClock.close();
                }
                render(current, assessment, bounds => frame(current, bounds));
            } catch (error) {
                if (session !== current) return;
                current.network?.remove();
                current.route?.remove();
                current.ui.results.hidden = true;
                current.ui.status.hidden = false;
                current.ui.status.textContent = t('failed', { reason: error.message });
            }
        }

        win.addEventListener('cityChanged', () => close(false));
        doc.addEventListener('mapshell:sheetopened', () => close(false));
        win.addEventListener('mapmodechange', event => {
            if (session && event.detail?.desired !== '2d') close(false);
        });
        return { open };
    }

    win.ActiveTravelPanel = { create };
})(window);
