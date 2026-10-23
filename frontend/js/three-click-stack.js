// The 3D model view's click stack (click-stack.md, "3D model view"): what one click in the scene
// stands on, as section cards floating over the scene down the right side, top to bottom Built →
// Design → Permitted → Parcel; no panel or header around them. It closes the way the 2D stack does:
// Escape, a click on nothing, the isolation banner's ×. The 2D stack's look (its
// frame and .click-stack__* classes) with the 3D view's own contents: the
// Design section holds the whole proposal's figures across all its parcels, the Parcel section the
// one parcel's. Expanding a section collapses the others. The scene (three-mode.js) supplies an
// adapter that does what a section means in 3D (isolate the proposal, outline the parcel, inspect a
// building) and fills or hosts its body. Pure rules first (node tests), the panel after.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.ThreeClickStack = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const ORDER = Object.freeze(['built', 'designs', 'permitted', 'parcels']);
    const ICONS = Object.freeze({ built: 'fas fa-building', designs: 'fas fa-drafting-compass', permitted: 'fas fa-cube', parcels: 'fas fa-border-all' });

    // ── pure rules ────────────────────────────────────────────────────────────────────────────

    // A building's name or address when the survey has one, else nothing (the row says "Built").
    function buildingLabel(feature) {
        const props = (feature && feature.properties) || {};
        return String(props.name || props.address || props.addr_street || '');
    }

    function parcelLabel(id) {
        return String(id).replace(/^HR-\d+-/, '');
    }

    // What a click picked decides which section opens: the thing the ray hit, else the parcel.
    function focusOf(picked) {
        if (picked && picked.planningId) return 'permitted';
        if (picked && picked.builtFeature) return 'built';
        if (picked && picked.proposalId) return 'designs';
        return 'parcels';
    }

    // input: { built, designs, permitted, parcels } arrays of { id, label, ... }; focus: a kind;
    // selected: { [kind]: id } for the instance a strip shows first (the clicked proposal).
    function buildThreeStack(input = {}, { focus = null, selected = {} } = {}) {
        const sections = [];
        for (const kind of ORDER) {
            const seen = new Set();
            const instances = (Array.isArray(input[kind]) ? input[kind] : []).filter(item => {
                const id = item && item.id !== undefined && item.id !== null ? String(item.id) : '';
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            }).map(item => ({ ...item, id: String(item.id) }));
            if (!instances.length) continue;
            const wanted = selected[kind] !== undefined ? instances.findIndex(item => item.id === String(selected[kind])) : -1;
            sections.push({ kind, instances, count: instances.length, multi: instances.length > 1, selectedIndex: Math.max(0, wanted) });
        }
        const expanded = (sections.find(section => section.kind === focus) || sections[sections.length - 1] || null);
        return { sections, expanded: expanded ? expanded.kind : null, selectedKind: expanded ? expanded.kind : null };
    }

    function expand(stack, kind) {
        return stack.sections.some(section => section.kind === kind) ? { ...stack, expanded: kind, selectedKind: kind } : stack;
    }

    function selectInstance(stack, kind, id) {
        return {
            ...stack,
            sections: stack.sections.map(section => {
                if (section.kind !== kind) return section;
                const index = section.instances.findIndex(item => item.id === String(id));
                return index < 0 ? section : { ...section, selectedIndex: index };
            })
        };
    }

    function selectedInstance(stack, kind) {
        const section = stack && stack.sections.find(item => item.kind === kind);
        return section ? section.instances[section.selectedIndex] : null;
    }

    const pure = { ORDER, buildingLabel, parcelLabel, focusOf, buildThreeStack, expand, selectInstance, selectedInstance };
    if (!global || !global.document) return Object.freeze(pure);

    // ── the panel ─────────────────────────────────────────────────────────────────────────────

    const doc = global.document;
    const state = { el: null, stack: null, adapter: null, input: null };

    function t(key, fallback, params = {}) {
        const value = global.i18n?.t?.(key, params);
        if (typeof value === 'string' && value && value !== key) return value;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    function rowTitle(section) {
        switch (section.kind) {
            case 'built': return section.multi ? t('clickStack.builtMany', 'Built ({{count}})', { count: section.count }) : t('threeMode.controls.built', 'Built');
            case 'designs': return section.multi ? t('clickStack.designs', 'Designs ({{count}})', { count: section.count }) : t('proposalDrafts.tabs.design', 'Design');
            case 'permitted': return section.multi ? t('clickStack.permittedMany', 'Permitted ({{count}})', { count: section.count }) : t('planningViews.permitted', 'Permitted');
            default: {
                if (section.multi) return t('clickStack.parcels', 'Parcels ({{count}})', { count: section.count });
                const parcel = section.instances[section.selectedIndex];
                const identity = global.ParcelMenuModel?.parcelIdentityKind(parcel?.feature?.properties, parcel?.id);
                return ['formed', 'plotPiece', 'remainder'].includes(identity)
                    ? t('clickStack.formed', 'Formed parcel') : t('clickStack.parcel', 'Cadastral parcel');
            }
        }
    }

    function button(className, text, data = {}) {
        const node = doc.createElement('button');
        node.type = 'button';
        node.className = className;
        if (text !== undefined) node.textContent = text;
        Object.entries(data).forEach(([key, value]) => { node.dataset[key] = value; });
        return node;
    }

    function ensureElement(container) {
        if (state.el && state.el.parentElement === container) return state.el;
        const el = doc.createElement('aside');
        el.id = 'three-click-stack';
        el.className = 'click-stack right-dock-panel';
        el.hidden = true;
        el.addEventListener('click', onPanelClick);
        el.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
        container.appendChild(el);
        state.el = el;
        return el;
    }

    function renderChoices(group) {
        const choices = doc.createElement('div');
        choices.className = 'click-stack__choices';
        choices.dataset.kind = group.kind;
        choices.setAttribute('role', 'group');
        choices.setAttribute('aria-label', rowTitle({ ...group, multi: group.count > 1 }));
        const count = doc.createElement('span');
        count.className = 'click-stack__choice-count';
        count.textContent = `(${group.count})`;
        const strip = doc.createElement('div');
        strip.className = 'click-stack__strip';
        group.instances.forEach(item => strip.appendChild(button('click-stack__chip', item.label || item.id, { action: 'related', kind: group.kind, id: item.id })));
        choices.append(count, strip);
        return choices;
    }

    function render() {
        const el = state.el;
        const { stack } = state;
        // Whatever the old body hosted goes home first; the expanded section hosts it again.
        state.adapter?.release?.({ keepSelection: !stack.expanded });
        el.textContent = '';
        el.setAttribute('aria-label', t('clickStack.title', 'At this spot'));
        const list = doc.createElement('div');
        list.className = 'click-stack__sections';
        stack.sections.forEach(section => {
            const expanded = stack.expanded === section.kind;
            const instance = section.instances[section.selectedIndex];
            const wrap = doc.createElement('section');
            wrap.className = 'click-stack__section';
            wrap.dataset.kind = section.kind;
            wrap.classList.toggle('is-expanded', expanded);
            wrap.classList.toggle('is-selected', stack.selectedKind === section.kind);
            const context = expanded ? global.__clickStackModel?.contextFor(section.kind, instance, state.input) || [] : [];
            context.filter(group => group.position === 'above').forEach(group => wrap.appendChild(renderChoices(group)));
            const card = doc.createElement('div');
            card.className = 'click-stack__card';
            card.id = `three-click-stack-${section.kind}-card`;
            const row = button('click-stack__row', undefined, { action: 'row', kind: section.kind });
            row.setAttribute('aria-expanded', String(expanded));
            const icon = doc.createElement('i');
            icon.className = ICONS[section.kind];
            icon.setAttribute('aria-hidden', 'true');
            const name = doc.createElement('span');
            name.className = 'click-stack__row-title';
            name.textContent = rowTitle(section.multi ? { ...section, multi: false, count: 1 } : section);
            const detail = doc.createElement('span');
            detail.className = 'click-stack__row-detail';
            detail.textContent = instance.label || '';
            const chevron = doc.createElement('i');
            chevron.className = 'click-stack__chevron fas fa-chevron-down';
            chevron.setAttribute('aria-hidden', 'true');
            row.append(icon, name, detail, chevron);
            const heading = doc.createElement('div');
            heading.className = 'click-stack__heading';
            heading.appendChild(row);
            card.appendChild(heading);
            if (expanded) {
                const body = doc.createElement('div');
                body.className = 'click-stack__body';
                card.appendChild(body);
            }
            wrap.appendChild(card);
            context.filter(group => group.position === 'below').forEach(group => wrap.appendChild(renderChoices(group)));
            list.appendChild(wrap);
        });
        el.appendChild(list);
    }

    function activate() {
        const kind = state.stack.selectedKind;
        if (!kind) return;
        if (!state.stack.expanded) { state.adapter.focus?.(kind, selectedInstance(state.stack, kind)); return; }
        const body = state.el.querySelector(`.click-stack__section[data-kind="${kind}"] .click-stack__body`);
        try {
            state.adapter.activate(kind, selectedInstance(state.stack, kind), body);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [ThreeClickStack] the ${kind} section could not open`, error);
        }
    }

    // Opens on a click: `input` and `options` as buildThreeStack takes them; `adapter` is the scene's
    // { activate(kind, instance, body), release(), closed() }. The focused section opens.
    function show(input, options, adapter) {
        const container = options.container || doc.body;
        ensureElement(container);
        state.adapter?.release?.();
        state.adapter = adapter;
        state.input = input;
        state.stack = buildThreeStack(input, options);
        if (!state.stack.sections.length) { close({ silent: true }); return false; }
        render();
        state.el.hidden = false;
        state.el.classList.add('visible');
        doc.body.classList.add('three-click-stack-open');
        activate();
        return true;
    }

    // Re-run the expanded section (the scene rebuilt and its figures may have changed).
    function refresh() {
        if (isOpen()) activate();
    }

    // `silent`: the scene closed it (it already cleared its own state); otherwise the person did,
    // and the scene is told so it can leave the views the stack opened.
    function close({ silent = false } = {}) {
        if (!isOpen()) return;
        const adapter = state.adapter;
        adapter?.release?.();
        state.stack = null;
        state.el.hidden = true;
        state.el.classList.remove('visible');
        state.el.textContent = '';
        doc.body.classList.remove('three-click-stack-open');
        if (!silent) adapter?.closed?.();
    }

    function isOpen() {
        return !!(state.el && !state.el.hidden && state.stack);
    }

    function onPanelClick(event) {
        const target = event.target.closest('[data-action]');
        if (!target || !state.el.contains(target)) return;
        const { action, kind, id } = target.dataset;
        if (action === 'row') {
            // The open section's row folds everything to rows; another row opens that section.
            if (state.stack.expanded === kind) {
                state.stack = { ...state.stack, expanded: null };
                render();
                activate();
            } else {
                state.stack = expand(state.stack, kind);
                render();
                activate();
            }
        } else if (action === 'related') {
            if (kind === 'agreements') {
                Promise.resolve(global.requestMapMode('2d')).then(() => global.ClickStack.showAgreement(id));
                return;
            }
            state.stack = expand(selectInstance(state.stack, kind, id), kind);
            render();
            activate();
        }
    }

    return Object.freeze({ ...pure, show, refresh, close, isOpen,
        expanded: () => state.stack?.expanded || null, current: () => state.stack });
});
