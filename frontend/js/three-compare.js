// Side-by-side comparison in the model view and on the map: the view is split at a draggable divider
// and each half draws one chosen state of the same scene from the same camera. A state ("side") is Built
// today, Permitted massing, Proposed (every applied design), one applied design or one saved plan,
// applied or not: a plan's members that no applied design stands for are read without applying them
// (compare-unapplied.js) and drawn on that plan's side alone.
// Objects that both sides show are drawn once per half untouched; only what differs is switched.
// The pure rules (which object a side shows, how a scene splits, the option lists, the scissor
// rectangles) come first and are unit tested; the Compare tab of the Buildings and massing sheet
// and the divider are wired below them. three-mode.js draws the two passes (renderComparePasses);
// compare-on-map.js draws the two halves of the 2D map.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ThreeCompare = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const BASE = Object.freeze(['built', 'permitted', 'proposed']);

    // The sides a person can choose: the three base states, then every applied design and every
    // saved plan. designs: [{ id, title }], plans: [{ id, title, members: [designId], unapplied:
    // [designCid] }] where members lists every member (an applied copy by its id, the rest by CID)
    // and unapplied the members the plan draws itself.
    function sideOptions({ designs = [], plans = [] } = {}) {
        const options = BASE.map(kind => ({ value: kind, kind }));
        for (const design of designs) {
            if (design?.id == null) continue;
            options.push({ value: `design:${design.id}`, kind: 'design', id: String(design.id), title: design.title || String(design.id) });
        }
        for (const plan of plans) {
            if (plan?.id == null) continue;
            options.push({ value: `plan:${plan.id}`, kind: 'plan', id: String(plan.id), title: plan.title || String(plan.id),
                members: (plan.members || []).map(String), unapplied: (plan.unapplied || []).map(String) });
        }
        return options;
    }

    // A select value back to its side, or null when the value names nothing offered any more.
    function parseSide(value, options) {
        return (options || []).find(option => option.value === value) || null;
    }

    // Whether a side applies one design: by: { id, unapplied } where unapplied marks a plan member no
    // applied design stands for. Proposed applies every applied design; a design side itself alone;
    // a plan side its members, applied or not; Built and Permitted apply nothing.
    function appliesDesign(side, by) {
        if (!side || by?.id == null) return false;
        const id = String(by.id);
        switch (side.kind) {
            case 'proposed': return !by.unapplied;
            case 'design': return !by.unapplied && side.id === id;
            case 'plan': return (side.members || []).includes(id);
            default: return false;
        }
    }

    // Whether a side shows one scene object. descriptor: { role, designId, unapplied, demolishedBy }
    // where role is 'existing' (a building standing today; demolishedBy lists the designs that remove
    // or cut it, as { id, unapplied }), 'proposed' (what a design draws; designId names it, null when
    // the drawing is shared by several applied designs; unapplied when a plan draws it itself) or
    // 'permitted' (source massing).
    function showsOn(side, descriptor) {
        if (!side || !descriptor) return true;
        switch (descriptor.role) {
            case 'existing':
                return !(descriptor.demolishedBy || []).some(by => appliesDesign(side, by));
            case 'proposed':
                if (descriptor.designId == null) return side.kind === 'proposed';
                return appliesDesign(side, { id: descriptor.designId, unapplied: !!descriptor.unapplied });
            case 'permitted':
                return side.kind === 'permitted';
            default:
                return true;
        }
    }

    // What the two passes switch: objects only the left side shows, only the right side shows, or
    // neither. Objects both sides show are left alone, so the shared city is never touched.
    function splitDescriptors(left, right, descriptors) {
        const leftOnly = [], rightOnly = [], hidden = [];
        for (const descriptor of descriptors || []) {
            const onLeft = showsOn(left, descriptor), onRight = showsOn(right, descriptor);
            if (onLeft && !onRight) leftOnly.push(descriptor);
            else if (!onLeft && onRight) rightOnly.push(descriptor);
            else if (!onLeft && !onRight) hidden.push(descriptor);
        }
        return { leftOnly, rightOnly, hidden };
    }

    // The two scissor rectangles, in CSS pixels from the bottom-left as three.js takes them, at a
    // divider `percent` from the left edge.
    function scissorRects(width, height, percent) {
        const x = Math.round(Math.min(Math.max(width * (Number(percent) || 0) / 100, 0), width));
        return { left: [0, 0, x, height], right: [x, 0, Math.max(0, width - x), height] };
    }

    const pure = { BASE, sideOptions, parseSide, appliesDesign, showsOn, splitDescriptors, scissorRects };
    if (!global || !global.document) return Object.freeze(pure);

    // ── the Compare tab and the divider ──────────────────────────────────────────────────────

    const doc = global.document;
    // model: the model view while it is open; map: the 2D map. The model view wins while open.
    const state = { enabled: false, left: 'built', right: 'proposed', percent: 50, options: pure.sideOptions(), model: null, map: null,
        divider: null, dividerScene: null };
    const scene = () => state.model || state.map;

    function t(key, fallback, params = {}) {
        const value = global.i18n?.t?.(key, params);
        if (typeof value === 'string' && value && value !== key) return value;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    function optionLabel(option) {
        switch (option.kind) {
            case 'built': return t('planningViews.compare.options.built', 'Built today');
            case 'permitted': return t('planningViews.compare.options.permitted', 'Permitted massing');
            case 'proposed': return t('planningViews.compare.options.proposed', 'Proposed (all applied designs)');
            case 'design': return t('planningViews.compare.options.design', 'Design: {{title}}', { title: option.title });
            case 'plan': return t('planningViews.compare.options.plan', 'Plan: {{title}}', { title: option.title });
            default: return option.value;
        }
    }

    const el = id => doc.getElementById(id);
    // The saved plan rows behind the plan options, by CID, for reading a plan that is not applied.
    let planRows = new Map();

    // The applied designs and this city's saved plans, as sides. A plan member with an applied copy
    // is that copy; the rest the plan draws itself once read (compare-unapplied.js).
    function collectOptions() {
        const store = global.proposalStorage;
        const applied = (store?.getAllProposals?.() || []).filter(proposal => global.isProposalApplied?.(proposal) ?? proposal.applied === true);
        const designs = applied.map(proposal => ({ id: String(proposal.proposalId), title: proposal.title || proposal.name || String(proposal.proposalId) }));
        const cidOf = proposal => {
            try { return global.DesignSync?.publishedCid?.(proposal) || global.DesignRecord?.cidOf?.(proposal) || null; } catch (_) { return null; }
        };
        const copies = applied.map(proposal => ({ id: String(proposal.proposalId), cid: cidOf(proposal) }));
        const city = global.normalizeCityCodeForApi?.(global.resolveCurrentCityCode?.()) || null;
        const sameCity = row => !city || !row.content?.view?.city || global.normalizeCityCodeForApi(row.content.view.city) === city;
        planRows = new Map();
        const plans = (global.PlanWorkspace?.list?.() || []).filter(sameCity).map(row => {
            planRows.set(String(row.cid), row);
            return { id: String(row.cid), title: row.content?.title || String(row.cid), ...global.CompareUnapplied.membersOf(row, copies) };
        });
        return pure.sideOptions({ designs, plans });
    }

    // A plan side with members no applied design stands for is read once it is chosen.
    function readUnapplied(side) {
        if (side?.kind === 'plan' && side.unapplied.length && planRows.has(side.id)) global.CompareUnapplied.load(planRows.get(side.id));
    }

    // The divider's label for a side: the option's name, with the read's state while a plan's
    // unapplied members are being read or could not be.
    function sideLabel(option) {
        const label = optionLabel(option);
        const reading = option.kind === 'plan' && option.unapplied.length ? global.CompareUnapplied.status(option.id) : null;
        if (!reading || reading.status === 'ready') return label;
        return reading.status === 'failed'
            ? t('planningViews.compare.unreadable', '{{label}} (could not be read: {{reason}})', { label, reason: reading.error })
            : t('planningViews.compare.reading', '{{label}} (reading…)', { label });
    }

    function fillSelect(select, value) {
        if (!select) return;
        select.replaceChildren();
        for (const option of state.options) select.add(new Option(optionLabel(option), option.value));
        select.value = pure.parseSide(value, state.options) ? value : state.options[0].value;
    }

    function sides() {
        return { left: pure.parseSide(state.left, state.options), right: pure.parseSide(state.right, state.options), percent: state.percent };
    }

    // Whether the comparison draws; given a scene, whether it draws in that one.
    function isActive(of = null) {
        const current = sides();
        return state.enabled && !!scene() && (!of || of === scene()) && !!current.left && !!current.right;
    }

    function refresh() {
        state.options = collectOptions();
        fillSelect(el('planning-compare-left'), state.left);
        fillSelect(el('planning-compare-right'), state.right);
        state.left = el('planning-compare-left')?.value || state.left;
        state.right = el('planning-compare-right')?.value || state.right;
        const enable = el('planning-compare-enable');
        if (enable) { enable.checked = state.enabled; enable.disabled = !scene(); }
        for (const id of ['planning-compare-left', 'planning-compare-right', 'planning-compare-swap']) {
            const control = el(id);
            if (control) control.disabled = !scene();
        }
        // On the map: what the halves draw there, and the way to the model view.
        const note = doc.querySelector('.planning-compare-note');
        if (note) note.hidden = !!state.model;
        syncDivider();
    }

    // The divider over the canvas or map: present while the comparison draws, labelled with the two
    // sides. It moves to the other view when the model view opens or closes.
    function syncDivider() {
        const active = isActive();
        if (state.divider && (!active || state.dividerScene !== scene())) {
            state.divider.dispose();
            state.divider = null;
            state.before?.remove();
            state.before = null;
            state.dividerScene?.invalidate();
            state.dividerScene = null;
        }
        if (!active) {
            scene()?.compareChanged?.();
            scene()?.invalidate();
            return;
        }
        const current = sides();
        readUnapplied(current.left);
        readUnapplied(current.right);
        // The scene draws what the sides' unapplied plan members add (the model view builds meshes).
        scene().compareChanged?.();
        const labels = { before: sideLabel(current.left), after: sideLabel(current.right) };
        if (state.divider) {
            state.divider.labelEls[0].textContent = labels.before;
            state.divider.labelEls[1].textContent = labels.after;
            scene().invalidate();
            return;
        }
        const container = scene().container;
        const before = doc.createElement('div');
        before.className = 'map-compare__before';
        container.appendChild(before);
        state.before = before;
        state.divider = global.__MapBeforeAfter.attachDivider(container, before, {
            labels, percent: state.percent, labelPlacement: 'divider',
            sliderLabel: t('planningViews.compare.sliderLabel', 'Comparison divider'),
            onChange: percent => { state.percent = percent; scene()?.invalidate(); }
        });
        state.dividerScene = scene();
        scene().invalidate();
    }

    // three-mode.js attaches on entering the model view: { container, invalidate }.
    function attach(model) {
        state.model = model;
        refresh();
    }

    function detach() {
        state.model = null;
        refresh();
    }

    // compare-on-map.js attaches the 2D map once it is ready: { container, invalidate }.
    function attachMap(map) {
        state.map = map;
        refresh();
    }

    // Opens the comparison between two sides (select values, e.g. `plan:<cid>` or `built`): the
    // sheet's Compare tab with the sides chosen and the divider on. Compare plans uses it.
    function show({ left, right } = {}) {
        state.options = collectOptions();
        if (pure.parseSide(left, state.options)) state.left = left;
        if (pure.parseSide(right, state.options)) state.right = right;
        state.enabled = true;
        global.MapShell?.openSheet?.('planning-views');
        const tab = doc.querySelector('#planning-views [data-planning-tab="compare"]');
        if (tab) tab.click(); else refresh();
    }

    function wire() {
        const sheet = el('planning-views');
        if (!sheet) return;
        // The sheet's tabs: Display (the layer controls) and Compare.
        sheet.addEventListener('click', event => {
            const tab = event.target.closest('[data-planning-tab]');
            if (!tab || !sheet.contains(tab)) return;
            for (const button of sheet.querySelectorAll('[data-planning-tab]')) button.setAttribute('aria-selected', String(button === tab));
            for (const panel of sheet.querySelectorAll('[data-planning-tab-panel]')) panel.hidden = panel.dataset.planningTabPanel !== tab.dataset.planningTab;
            if (tab.dataset.planningTab === 'compare') refresh();
        });
        el('planning-compare-enable')?.addEventListener('change', event => { state.enabled = event.target.checked; syncDivider(); });
        el('planning-compare-left')?.addEventListener('change', event => { state.left = event.target.value; syncDivider(); });
        el('planning-compare-right')?.addEventListener('change', event => { state.right = event.target.value; syncDivider(); });
        el('planning-compare-swap')?.addEventListener('click', () => {
            [state.left, state.right] = [state.right, state.left];
            fillSelect(el('planning-compare-left'), state.left);
            fillSelect(el('planning-compare-right'), state.right);
            syncDivider();
        });
        el('planning-compare-open-model')?.addEventListener('click', () => global.requestMapMode?.('model'));
        doc.addEventListener('mapshell:sheetopened', event => { if (event.detail?.id === 'planning-views') refresh(); });
        // A plan read for a side has arrived or failed: relabel the divider and redraw.
        global.addEventListener('compareunappliedchange', syncDivider);
        refresh();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wire, { once: true });
    else wire();

    return Object.freeze({ ...pure, attach, detach, attachMap, refresh, isActive, sides, show,
        getState: () => ({ ...state, model: undefined, map: undefined, divider: undefined, dividerScene: undefined, before: undefined, onMap: !!state.map && !state.model }) });
});
