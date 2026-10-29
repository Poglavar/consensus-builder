// A tab keeps its running build until the person explicitly reloads it.
(function (win) {
    'use strict';
    const doc = win.document;
    function mount() {
        const checkButton = doc.getElementById('app-update-check');
        if (!checkButton) return;
        const running = { ...win.__BUILD_INFO };
        const notice = doc.getElementById('app-update-notice');
        const reloadButtons = [...doc.querySelectorAll('[data-app-update-reload]')];
        let dismissedBuild = null, blocked = false;
        const t = (key, params) => win.i18n.t(key, params || {});
        const text = (id, value) => { const el = doc.getElementById(id); if (el.textContent !== value) el.textContent = value; };
        const formatTime = value => win.CbFormat.formatDateTime(new Date(value));
        const checker = win.ReleaseUpdates.createChecker({ running, changed: render, request: async () => {
            const controller = new AbortController();
            const timeout = win.setTimeout(() => controller.abort(), 15000);
            try {
                const url = new URL('release.json', doc.baseURI);
                url.searchParams.set('check', String(Date.now()));
                const response = await win.fetch(url.href, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
                if (!response.ok) throw new Error('Release check failed');
                return await response.json();
            } finally { win.clearTimeout(timeout); }
        } });
        function render(snapshot = checker.snapshot()) {
            text('app-running-build', checker.deployed ? t('appUpdates.build', { number: running.buildNumber }) : t('appUpdates.development'));
            const deployedDate = doc.getElementById('app-deployed-at');
            deployedDate.hidden = !checker.deployed;
            if (checker.deployed) deployedDate.textContent = t('appUpdates.deployed', { date: formatTime(running.generatedAt) });
            let status;
            switch (snapshot.status) {
                case 'development': status = t('appUpdates.developmentHint'); break;
                case 'checking': status = t('appUpdates.checking'); break;
                case 'available': status = t('appUpdates.availableBuild', { number: snapshot.latest.buildNumber }); break;
                case 'current': status = t('appUpdates.current'); break;
                case 'error': status = t('appUpdates.failed'); break;
                default: status = t('appUpdates.notChecked');
            }
            text('app-update-state', status);
            text('app-update-last-checked', snapshot.checkedAt ? t('appUpdates.lastChecked', { date: formatTime(snapshot.checkedAt) }) : '');
            checkButton.disabled = !checker.deployed;
            reloadButtons.forEach(button => { button.hidden = !snapshot.available; });
            notice.hidden = !snapshot.available || dismissedBuild === snapshot.latest?.buildId;
            text('app-update-blocked', blocked ? t('appUpdates.finishEditing') : '');
            text('app-update-reload-hint', blocked ? t('appUpdates.finishEditing') : '');
        }
        function reload() {
            // Existing map locks and modal ownership protect unsaved geometry and agreement forms.
            if (win.__mapEditLock?.isHeld() || win.roadDrawingMode || win.OnMapEditor?.isActive()
                || doc.getElementById('proposal-editor-shell')?.classList.contains('is-open')
                || win.MapShell?.isBlockingDialogOpen() || doc.querySelector('[aria-busy="true"]')) {
                blocked = true; render(); return false;
            }
            saveResume();
            win.location.reload(); // Native beforeunload handlers and draft flushes still run.
            return true;
        }
        // The person continues where they were: the address gets the current pose now rather than
        // after its debounce, and the open click stack is recorded for the next page of this tab.
        function saveResume() {
            try { win.MapShare?.createAddressSync(win).write(); } catch (error) {
                console.error(`[${new Date().toISOString()}] [app-updates] the address could not take the current view`, error);
            }
            const three = doc.body.classList.contains('three-mode-active');
            const stackApi = three ? win.ThreeClickStack : win.ClickStack;
            const stack = stackApi?.isOpen?.() ? stackApi.current() : null;
            const record = win.ReleaseUpdates.resumeRecord({
                mode: win.__mapModeState?.desired || '2d', pathname: win.location.pathname, now: Date.now(), stack,
                selectedInstance: (three ? win.ThreeClickStack : win.__clickStackModel)?.selectedInstance,
                point: three ? null : win.ClickStack?.point?.()
            });
            try { win.sessionStorage.setItem(win.ReleaseUpdates.RESUME_KEY, JSON.stringify(record)); } catch (error) {
                console.warn(`[${new Date().toISOString()}] [app-updates] the open selection could not be kept for the reload`, error);
            }
        }
        checkButton.addEventListener('click', () => {
            if (win.BusyControl.isBusy(checkButton)) return;
            dismissedBuild = null; blocked = false;
            win.BusyControl.track(checkButton, () => checker.check());
        });
        reloadButtons.forEach(button => button.addEventListener('click', reload));
        doc.getElementById('app-update-later').addEventListener('click', () => {
            dismissedBuild = checker.snapshot().latest?.buildId; blocked = false; render();
        });
        const automaticCheck = () => {
            if (doc.visibilityState === 'visible' && checker.deployed) checker.check();
        };
        const interval = win.setInterval(automaticCheck, win.ReleaseUpdates.INTERVAL_MS);
        doc.addEventListener('visibilitychange', automaticCheck);
        win.addEventListener('focus', automaticCheck);
        win.addEventListener('pagehide', () => win.clearInterval(interval), { once: true });
        win.addEventListener('i18n:translationsLoaded', () => render());
        win.i18n.onChange?.(() => render());
        win.AppUpdates = Object.freeze({ check: () => checker.check(), snapshot: checker.snapshot });
        render(); automaticCheck();
        resumeAfterUpdate();
    }

    // After "Update now": reopen what the click stack held once its designs and parcels are back.
    // Each data or mode event retries; a click or key press of the person's own ends the attempt.
    const RESUME_WINDOW_MS = 60 * 1000;
    function resumeAfterUpdate() {
        let record = null;
        try {
            record = win.ReleaseUpdates.readResume(win.sessionStorage.getItem(win.ReleaseUpdates.RESUME_KEY),
                { now: Date.now(), pathname: win.location.pathname });
            win.sessionStorage.removeItem(win.ReleaseUpdates.RESUME_KEY);
        } catch (_) { return; }
        if (!record) return;
        const deadline = Date.now() + RESUME_WINDOW_MS;
        let active = true;
        const log = message => console.log(`[${new Date().toISOString()}] [app-updates] resume after update: ${message}`);
        const listeners = [[win, 'parcelDataLoaded'], [win, 'parcelFabricCommitted'], [doc, 'proposalStorageChanged'],
            [win, 'planninggeometrychange'], [win, 'buildingsLayerUpdated'], [win, 'threeModeReady'], [win, 'mapmodechange']];
        const stop = reason => {
            if (!active) return;
            active = false;
            listeners.forEach(([target, name]) => target.removeEventListener(name, attempt));
            doc.removeEventListener('pointerdown', takeOver, true);
            doc.removeEventListener('keydown', takeOver, true);
            log(reason);
        };
        const takeOver = () => stop('the person took over');
        function attempt() {
            if (!active) return;
            if (Date.now() > deadline) { stop(`gave up; ${Object.keys(record.selected).join(', ')} not found again`); return; }
            const three = record.mode !== '2d';
            if (three !== doc.body.classList.contains('three-mode-active')) return;
            if (!Object.keys(record.selected).length) { stop('nothing was open'); return; }
            const done = three ? win.resumeThreeModeStack?.(record)
                : win.ClickStack?.resume(win.L.latLng(record.point[0], record.point[1]), record);
            if (done) stop(`reopened ${record.selectedKind || 'stack'}`);
        }
        win.UpdateResume = Object.freeze({ pending: () => active && Date.now() <= deadline });
        listeners.forEach(([target, name]) => target.addEventListener(name, attempt));
        doc.addEventListener('pointerdown', takeOver, true);
        doc.addEventListener('keydown', takeOver, true);
        log(`${record.mode} view, ${JSON.stringify(record.selected)}`);
        attempt();
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
})(window);
