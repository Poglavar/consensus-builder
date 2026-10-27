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
            win.location.reload(); // Native beforeunload handlers and draft flushes still run.
            return true;
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
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
})(window);
