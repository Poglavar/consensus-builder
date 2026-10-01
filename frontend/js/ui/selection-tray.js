// ui/selection-tray.js — the selection tray: a bar at the bottom centre of the map (in
// #selection-tray-slot) while multi-parcel selection is on, with the parcel count, their total
// area and the actions UiCommands lists for the 'selection-tray' surface (Propose, Detect block,
// Clear, Done). It re-renders on every multiParcelSelection.updateUI (the
// 'multi-parcel-selection-change' event). summarizeSelection is pure and exported for
// backend/test/frontend-selection-tray.test.js; the DOM half only runs in a page.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SelectionTray = api;
})(typeof window !== 'undefined' ? window : null, function (win) {
    'use strict';

    // Count and total area of the selected parcels. `featureFor(id)` gives a parcel's live feature
    // (or null), `areaOf(feature)` its measured area in m². A parcel whose feature or area is
    // missing still counts, but adds no area, and is reported as unmeasured; with nothing measured
    // the total is null (unknown), never 0.
    function summarizeSelection(ids, { featureFor, areaOf } = {}) {
        const list = Array.isArray(ids) ? ids : [];
        let total = 0;
        let measured = 0;
        for (const id of list) {
            let area = null;
            try {
                const feature = typeof featureFor === 'function' ? featureFor(id) : null;
                area = feature && typeof areaOf === 'function' ? areaOf(feature) : null;
            } catch (_) { area = null; }
            if (typeof area === 'number' && Number.isFinite(area) && area > 0) {
                total += area;
                measured += 1;
            }
        }
        return { count: list.length, area: measured > 0 ? total : null, unmeasured: list.length - measured };
    }

    if (!win || !win.document) {
        return { summarizeSelection };
    }

    const doc = win.document;
    let el = null;
    let wired = false;

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (typeof value === 'string' && value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    };

    function measure(feature) {
        if (!feature || !feature.geometry || !win.turf || typeof win.turf.area !== 'function') return null;
        return win.turf.area(feature);
    }

    function currentSummary() {
        const multi = win.multiParcelSelection;
        const ids = multi && multi.selectedParcels ? Array.from(multi.selectedParcels) : [];
        const fabric = win.LiveParcelFabric;
        return summarizeSelection(ids, {
            featureFor: id => (fabric && typeof fabric.get === 'function' ? fabric.get(String(id)) : null),
            areaOf: measure
        });
    }

    function ensureElement() {
        if (el) return el;
        const slot = doc.getElementById('selection-tray-slot');
        if (!slot) throw new Error('SelectionTray: #selection-tray-slot is missing');
        el = doc.createElement('div');
        el.id = 'selection-tray';
        el.className = 'selection-tray';
        el.setAttribute('role', 'toolbar');
        el.innerHTML = `
            <div class="selection-tray__summary" aria-live="polite">
                <span class="selection-tray__count"></span>
                <span class="selection-tray__area"></span>
            </div>
            <div class="selection-tray__actions"></div>`;
        el.addEventListener('click', event => {
            const button = event.target.closest('[data-command]');
            if (!button) return;
            win.UiCommands.runCommand(button.getAttribute('data-command'), win.UiCommands.createBrowserContext(win));
        });
        return el;
    }

    // Shown while multi-select is on — also with nothing picked yet (it then says how to pick and
    // offers Done), so the mode is never on without a way out on screen.
    function render() {
        const multi = win.multiParcelSelection;
        const slot = doc.getElementById('selection-tray-slot');
        if (!slot) return;
        if (!multi || !multi.isActive) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
            return;
        }
        const tray = ensureElement();
        tray.setAttribute('aria-label', t('selectionTray.label', 'Selected parcels'));
        const summary = currentSummary();
        const countEl = tray.querySelector('.selection-tray__count');
        const areaEl = tray.querySelector('.selection-tray__area');
        countEl.textContent = summary.count > 0
            ? t('selectionTray.count', '{{count}} parcel(s)', { count: summary.count })
            : t('selectionTray.empty', 'Click parcels to select them');
        countEl.title = countEl.textContent; // the full line when a phone ellipsizes it
        areaEl.textContent = summary.area !== null
            ? `${Math.round(summary.area).toLocaleString('hr-HR')} ${t('panel.parcel.metrics.areaUnit', 'm²')}`
            : '';
        areaEl.hidden = summary.area === null;

        const translate = key => (win.i18n && typeof win.i18n.t === 'function' ? win.i18n.t(key) : key);
        const actions = tray.querySelector('.selection-tray__actions');
        actions.textContent = '';
        const order = id => (TRAY_ORDER.indexOf(id) === -1 ? TRAY_ORDER.length : TRAY_ORDER.indexOf(id));
        win.UiCommands.commandsFor('selection-tray', win.UiCommands.createBrowserContext(win))
            .sort((a, b) => order(a.id) - order(b.id))
            .forEach(entry => {
                const label = win.UiCommands.labelOf(entry, translate);
                const button = doc.createElement('button');
                button.type = 'button';
                button.className = `selection-tray__action selection-tray__action--${entry.id.replace(/\./g, '-')}`;
                button.setAttribute('data-command', entry.id);
                button.title = label;
                button.setAttribute('aria-label', label);
                const icon = doc.createElement('i');
                icon.className = entry.icon;
                icon.setAttribute('aria-hidden', 'true');
                const text = doc.createElement('span');
                text.className = 'selection-tray__action-label';
                text.textContent = trayLabel(entry, label);
                button.appendChild(icon);
                button.appendChild(text);
                actions.appendChild(button);
            });
        if (tray.parentNode !== slot) slot.appendChild(tray);
    }

    // Propose leads: it is what a selection is usually for.
    const TRAY_ORDER = ['selection.propose', 'blocks.fromSelected', 'selection.clear', 'selection.done'];

    // The registry labels say what a command does anywhere (the palette lists them out of
    // context); in the tray, next to the count, the short word is enough.
    const SHORT_LABELS = {
        'blocks.fromSelected': ['selectionTray.actions.detectBlock', 'Detect block'],
        'selection.clear': ['selectionTray.actions.clearShort', 'Clear'],
        'selection.done': ['selectionTray.actions.doneShort', 'Done']
    };
    function trayLabel(entry, label) {
        const short = SHORT_LABELS[entry.id];
        return short ? t(short[0], short[1]) : label;
    }

    // Propose: the parcel panel's build palette, for the whole selection.
    function propose() {
        const multi = win.multiParcelSelection;
        if (!multi || !multi.isActive || multi.selectedParcels.size === 0) {
            throw new Error('SelectionTray.propose: no parcels are selected');
        }
        multi.showSelectionInPanel();
        win.switchParcelTab(null, 'proposals-tab');
    }

    function initializeSelectionTray() {
        if (wired) return;
        wired = true;
        doc.addEventListener('multi-parcel-selection-change', render);
        // Labels follow a language switch and the translations arriving after boot.
        win.addEventListener('i18n:translationsLoaded', render);
        if (win.i18n && typeof win.i18n.onChange === 'function') win.i18n.onChange(render);
        render();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', initializeSelectionTray);
    else initializeSelectionTray();

    return { summarizeSelection, render, propose, initializeSelectionTray };
});
