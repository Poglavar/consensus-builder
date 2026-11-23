// The same Plan stats and named critics for Lists and the map's plan inspector.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanAnalysisControls = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function button(win, doc, label, run, className = '') {
        const el = doc.createElement('button');
        el.type = 'button';
        el.className = `btn btn-sm ${className}`;
        el.textContent = label;
        el.disabled = !run;
        if (run) el.addEventListener('click', () => {
            if (win.BusyControl.isBusy(el)) return;
            win.BusyControl.track(el, run).catch(error => win.showStyledAlert(error.message));
        });
        return el;
    }

    function stats(win, doc, getPlan, summary) {
        const control = button(win, doc, win.i18n.t('sidebar.proposals.planStats.modalTitle'),
            () => win.showPlanStatsModal(summary, { readPlan: getPlan, returnFocus: control }));
        const icon = doc.createElement('i');
        icon.className = 'fas fa-chart-pie';
        icon.setAttribute('aria-hidden', 'true');
        control.prepend(icon);
        return control;
    }

    async function restoreCriticOrigin(win, doc, { plan, row, returnTo, mode }, critic) {
        if (mode && mode !== '2d') await win.requestMapMode(mode);
        if (returnTo) return returnTo(plan, critic);
        if (!row) return;
        if (!win.MapShell.isOpen('proposals-sheet')) win.MapShell.openSheet('proposals-sheet');
        const picker = doc.querySelector(`#plan-list-host [data-list-id="${win.CSS.escape(row)}"] .lists-critics`);
        if (picker) {
            picker.open = true;
            picker.querySelector(`[data-critic-control="${critic}"]`)?.focus();
        }
    }

    function critics(win, doc, getPlan, { open = false, row = null, returnTo = null } = {}) {
        const picker = doc.createElement('details');
        picker.className = 'lists-critics';
        picker.open = open;
        const summary = doc.createElement('summary');
        summary.textContent = win.i18n.t('lists.critics.choose');
        summary.dataset.criticControl = 'choose';
        const choices = doc.createElement('div');
        choices.className = 'lists-critics__choices';
        for (const [id, image, run] of [
            ['rooster', 'grain-rooster-critic.png', async () => win.summonUrbanistRooster(await getPlan(), row, returnTo)],
            ['cat', 'critic-cat.webp', async () => win.SquareCritic.open(await getPlan(), row, returnTo)],
            ['beaver', 'critic-beaver.webp', async () => win.BeaverCritic.open(await getPlan(), row, returnTo)],
            ['dog', 'critic-dog.webp', async () => win.DogCritic.open(await getPlan(), row, returnTo)],
            ['hare', 'critic-hare.webp', async () => win.HareCritic.open(await getPlan(), row, returnTo)],
            ['owl', 'critic-owl.webp'],
            ['crow', 'critic-crow.webp']
        ]) {
            const choice = button(win, doc, '', run, 'lists-critics__choice');
            choice.dataset.criticControl = id;
            const portrait = doc.createElement('img');
            portrait.className = 'lists-critics__portrait';
            portrait.src = `/images/${image}`;
            portrait.alt = '';
            portrait.width = 40;
            portrait.height = 40;
            portrait.loading = 'lazy';
            const label = doc.createElement('span');
            label.className = 'lists-critics__label';
            const name = doc.createElement('strong');
            name.textContent = id === 'rooster' ? win.i18n.t('sidebar.proposals.grainScore.buttonLabel')
                : win.i18n.t(`lists.critics.${id}.name`);
            const axis = doc.createElement('small');
            axis.textContent = win.i18n.t(`lists.critics.${id}.axis`);
            label.append(name, axis);
            choice.append(portrait, label);
            choices.append(choice);
        }
        picker.append(summary, choices);
        return picker;
    }

    return { stats, critics, restoreCriticOrigin };
});
