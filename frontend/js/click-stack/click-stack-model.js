// Pure rules of the click stack (click-stack.md): which sections a map click shows and in what
// order, how many instances each holds and which is selected, which section is expanded, and
// whether a click closes the panel or shows a new spot. No DOM; the panel renders the result.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.__clickStackModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Top to bottom. A formed parcel is live ground a design made (the pieces a road leaves of a
    // parcel): it opens like a cadastral parcel, and is where the next design starts. Cadastral
    // parcels below it are the originals it came from. Ground is bare land with no register (the
    // former ground menu): it offers what can be drawn there, and shows only when nothing else is.
    const ORDER = Object.freeze(['agreements', 'designs', 'built', 'permitted', 'formed', 'parcels', 'ground']);
    const MULTI = new Set(['agreements', 'designs', 'parcels']);
    const EXPANDABLE = new Set(['agreements', 'designs', 'built', 'permitted', 'formed', 'parcels', 'ground']);
    const NEWEST_FIRST = new Set(['agreements', 'designs']);

    const time = value => {
        const parsed = typeof value === 'number' ? value : Date.parse(value || '');
        return Number.isFinite(parsed) ? parsed : -Infinity;
    };
    const refOf = (kind, id) => `${kind}:${id}`;

    function instancesOf(kind, list) {
        const seen = new Set(), out = [];
        for (const item of Array.isArray(list) ? list : []) {
            const id = item && item.id !== undefined && item.id !== null ? String(item.id) : '';
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({ ...item, id, ref: refOf(kind, id) });
        }
        if (NEWEST_FIRST.has(kind)) {
            out.sort((a, b) => time(b.createdAt) - time(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        }
        return out;
    }

    // hits: { agreements, designs, built, permitted, formed, parcels } arrays of { id, label, ... }.
    // options.remembered: the kind last expanded; options.selected: { [kind]: id } to keep a
    // chosen instance (a strip click) when the same spot is rebuilt.
    function buildClickStack(hits = {}, options = {}) {
        const sections = [];
        for (const kind of ORDER) {
            const instances = instancesOf(kind, hits[kind]);
            if (!instances.length) continue;
            const wanted = options.selected && options.selected[kind];
            const chosen = wanted ? instances.findIndex(item => item.id === String(wanted)) : -1;
            sections.push({ kind, instances, count: instances.length, multi: MULTI.has(kind) && instances.length > 1,
                expandable: EXPANDABLE.has(kind), selectedIndex: chosen >= 0 ? chosen : 0 });
        }
        const remembered = options.remembered;
        const expandedSection = sections.find(section => section.expandable && section.kind === remembered)
            || sections.find(section => section.expandable) || null;
        const top = sections[0] ? sections[0].instances[sections[0].selectedIndex] : null;
        return { sections, expanded: expandedSection ? expandedSection.kind : null, topRef: top ? top.ref : null };
    }

    // A click on the same topmost object, or on a spot with nothing on it, closes an open panel;
    // any other click shows the new spot.
    function clickAction(openTopRef, next) {
        if (!next || !next.topRef) return openTopRef ? 'close' : 'none';
        if (openTopRef && openTopRef === next.topRef) return 'close';
        return 'open';
    }

    // Expanding a section collapses the others; the expanded kind becomes the remembered one.
    function expand(stack, kind) {
        const section = stack.sections.find(item => item.kind === kind);
        if (!section || !section.expandable) return stack;
        return { ...stack, expanded: kind };
    }

    function selectInstance(stack, kind, id) {
        const sections = stack.sections.map(section => {
            if (section.kind !== kind) return section;
            const index = section.instances.findIndex(item => item.id === String(id));
            return index < 0 ? section : { ...section, selectedIndex: index };
        });
        const top = sections[0] ? sections[0].instances[sections[0].selectedIndex] : null;
        return { ...stack, sections, topRef: top ? top.ref : null };
    }

    function selectedInstance(stack, kind) {
        const section = stack.sections.find(item => item.kind === kind);
        return section ? section.instances[section.selectedIndex] : null;
    }

    return Object.freeze({ ORDER, buildClickStack, clickAction, expand, selectInstance, selectedInstance });
});
