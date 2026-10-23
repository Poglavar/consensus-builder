// Pure rules of the click stack (click-stack.md): which sections a map click shows and in what
// order, how many instances each holds and which is selected, which section is expanded, and
// whether a click closes the panel or shows a new spot. No DOM; the panel renders the result.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.__clickStackModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
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


    // Top to bottom. A formed parcel is live ground a design made (the pieces a road leaves of a
    // parcel): it opens like a cadastral parcel, and is where the next design starts. Cadastral
    // parcels below it are the originals it came from. Ground is bare land with no register (the
    // former ground menu): it offers what can be drawn there, and shows only when nothing else is.
    const ORDER = Object.freeze(['agreements', 'designs', 'built', 'permitted', 'formed', 'parcels', 'ground']);
    const MULTI = new Set(['agreements', 'designs', 'built', 'permitted', 'formed', 'parcels']);
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
        // What is under the point comes before what only stands on its parcel (onParcel).
        const near = item => (item.onParcel ? 1 : 0);
        out.sort((a, b) => near(a) - near(b) || (NEWEST_FIRST.has(kind)
            ? time(b.createdAt) - time(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : 0));
        return out;
    }

    // The section's selected instance when the section has something under the point: only those
    // open by default and decide whether the same click closes the panel. A section holding only
    // what stands on the parcel (its buildings and proposals) waits for its row to be clicked.
    function pointSections(sections) {
        return sections.filter(section => section.atPoint);
    }

    function topRefOf(sections) {
        const top = pointSections(sections)[0] || sections[0];
        return top ? top.instances[top.selectedIndex].ref : null;
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
                expandable: EXPANDABLE.has(kind), selectedIndex: chosen >= 0 ? chosen : 0,
                atPoint: instances.some(item => !item.onParcel) });
        }
        const remembered = options.remembered;
        const candidates = pointSections(sections).filter(section => section.expandable);
        const expandedSection = candidates.find(section => section.kind === remembered) || candidates[0]
            || sections.find(section => section.expandable) || null;
        return { sections, expanded: expandedSection ? expandedSection.kind : null, selectedKind: expandedSection ? expandedSection.kind : null, topRef: topRefOf(sections) };
    }

    // Selection is a map mode, not a hit at a point. Its section exists with zero members too.
    function buildSelectionStack(summary, { expanded = true } = {}) {
        const instance = { ...summary, id: 'current', ref: 'selection:current' };
        return { sections: [{ kind: 'selection', instances: [instance], count: summary.count,
            multi: false, expandable: true, selectedIndex: 0, atPoint: false }],
            expanded: expanded ? 'selection' : null, selectedKind: 'selection', topRef: instance.ref };
    }

    // A repeat click retains selection. Empty ground deselects; another object replaces it.
    function clickAction(openTopRef, next) {
        if (!next || !next.topRef) return openTopRef ? 'close' : 'none';
        if (openTopRef && openTopRef === next.topRef) return 'retain';
        return 'open';
    }

    // Expanding a section collapses the others; the expanded kind becomes the remembered one.
    function expand(stack, kind) {
        const section = stack.sections.find(item => item.kind === kind);
        if (!section || !section.expandable) return stack;
        return { ...stack, expanded: kind, selectedKind: kind };
    }

    function selectInstance(stack, kind, id) {
        const sections = stack.sections.map(section => {
            if (section.kind !== kind) return section;
            const index = section.instances.findIndex(item => item.id === String(id));
            return index < 0 ? section : { ...section, selectedIndex: index };
        });
        return { ...stack, sections, topRef: topRefOf(sections) };
    }

    function selectedInstance(stack, kind) {
        const section = stack.sections.find(item => item.kind === kind);
        return section ? section.instances[section.selectedIndex] : null;
    }

    // Context strips navigate relationships, never siblings of the selected object.
    function contextFor(kind, instance, hits = {}) {
        if (!instance) return [];
        const groups = [];
        const add = (position, target, items) => {
            const seen = new Set();
            const instances = items.filter(item => item?.id != null && !seen.has(String(item.id)) && seen.add(String(item.id))).map(item => ({ ...item, id: String(item.id) }));
            if (instances.length) groups.push({ position, kind: target, instances, count: instances.length });
        };
        const id = String(instance.id);
        const designs = hits.designs || [], formed = hits.formed || [], parcels = hits.parcels || [];
        const sourceIds = item => (item.feature?.properties?.cadastreParcelIds || []).map(String);
        const designUsesParcel = (design, parcel) => {
            const ids = (design.proposal?.cadastreParcelIds || []).map(String);
            return ids.includes(String(parcel.id)) || sourceIds(parcel).some(id => ids.includes(id));
        };
        if (kind === 'agreements') {
            add('below', 'designs', (instance.agreement?.designs || []).map(design => designs.find(item => item.id === String(design.proposalId))
                || { id: String(design.proposalId), label: design.title || String(design.proposalId) }));
        } else if (kind === 'designs') {
            add('above', 'agreements', (hits.agreements || []).filter(item => (item.designIds || item.agreement?.designs?.map(design => String(design.proposalId)) || []).includes(id)));
            const pieces = formed.filter(item => String(item.designId) === id);
            if (pieces.length) add('below', 'formed', pieces);
            else add('below', 'parcels', parcels.filter(item => designUsesParcel(instance, item)));
        } else if (kind === 'formed') {
            if (instance.designId) add('above', 'designs', [designs.find(item => String(item.id) === String(instance.designId)) || { id: String(instance.designId), label: instance.designLabel || String(instance.designId) }]);
            add('below', 'parcels', parcels.filter(item => sourceIds(instance).includes(String(item.id))));
        } else if (kind === 'parcels') {
            const parents = formed.filter(item => sourceIds(item).includes(id));
            if (parents.length) add('above', 'formed', parents);
            else add('above', 'designs', designs.filter(item => designUsesParcel(item, instance)));
        }
        return groups;
    }

    return Object.freeze({ ORDER, summarizeSelection, buildSelectionStack, buildClickStack, clickAction, expand, selectInstance, selectedInstance, contextFor });
});
