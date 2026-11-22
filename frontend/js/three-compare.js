// Side-by-side comparison in the model view and on the map: the view is split at a draggable divider
// and each half draws one chosen state of the same scene from the same camera. A state ("side") is Built
// today, Permitted massing, Proposed (every applied design), one saved design or one saved plan,
// applied or not: a design that is not applied, and a plan's members that no applied design stands
// for, are read without applying them (compare-unapplied.js) and drawn on that side alone.
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

    // The sides a person can choose: the three base states, then every saved design and every saved
    // plan. designs: [{ id, title, cid?, readId? }] where a design that is not applied carries its CID
    // and readId (the one-member plan it is read as, compare-unapplied.js); plans: [{ id, title,
    // members: [designId], unapplied: [designCid] }] where members lists every member (an applied copy
    // by its id, the rest by CID) and unapplied the members the plan draws itself. A side that draws
    // members itself carries readId, the plan read for them (a plan's own CID when not given).
    // agreements: [{ id, title, members, unapplied, readId }] where readId is the agreement's plan.
    // Each design, plan and agreement may carry `at`, the time it was made or published (ISO), which the
    // picker shows beside its title and orders by; one without a time has none shown.
    function sideOptions({ designs = [], plans = [], agreements = [] } = {}) {
        const options = BASE.map(kind => ({ value: kind, kind }));
        const atOf = row => (row.at ? { at: String(row.at) } : {});
        for (const design of designs) {
            if (design?.id == null) continue;
            const read = design.cid != null ? { members: [String(design.cid)], unapplied: [String(design.cid)], readId: String(design.readId) } : {};
            options.push({ value: `design:${design.id}`, kind: 'design', id: String(design.id), title: design.title || String(design.id), ...atOf(design), ...read });
        }
        for (const plan of plans) {
            if (plan?.id == null) continue;
            options.push({ value: `plan:${plan.id}`, kind: 'plan', id: String(plan.id), title: plan.title || String(plan.id), ...atOf(plan),
                members: (plan.members || []).map(String), unapplied: (plan.unapplied || []).map(String), readId: String(plan.id) });
        }
        for (const agreement of agreements) {
            if (agreement?.id == null || agreement.readId == null) continue;
            options.push({ value: `agreement:${agreement.id}`, kind: 'agreement', id: String(agreement.id), title: agreement.title || String(agreement.id), ...atOf(agreement),
                members: (agreement.members || []).map(String), unapplied: (agreement.unapplied || []).map(String), readId: String(agreement.readId) });
        }
        return options;
    }

    // The picker's groups, in order: today's states, then plans, agreements and designs, each newest
    // first (a side with no time after the dated ones, in the order given). Empty groups are left out.
    const GROUPS = Object.freeze(['today', 'plan', 'agreement', 'design']);
    function optionGroups(options) {
        const groupOf = option => (BASE.includes(option.kind) ? 'today' : option.kind);
        const timeOf = option => { const time = Date.parse(option.at); return Number.isFinite(time) ? time : null; };
        const newestFirst = (a, b) => {
            const ta = timeOf(a.option), tb = timeOf(b.option);
            if (ta !== tb) return ta === null ? 1 : tb === null ? -1 : tb - ta;
            return a.index - b.index;
        };
        return GROUPS.map(group => ({ group, options: (options || []).map((option, index) => ({ option, index }))
            .filter(row => groupOf(row.option) === group).sort(newestFirst).map(row => row.option) }))
            .filter(row => row.options.length);
    }

    // A select value back to its side, or null when the value names nothing offered any more.
    function parseSide(value, options) {
        return (options || []).find(option => option.value === value) || null;
    }

    // What the divider's stats button compares: the sides that are a design, plan or agreement, each
    // once, measured as Compare plans measures them (plan-stats.js), which names the dialog after
    // them (designs, agreements, or plans for a mix). Built today is the dialog's own Present state
    // column; Permitted massing and Proposed have no plan to measure and are left out. Null when
    // neither side has figures.
    const MEASURED = Object.freeze(['design', 'plan', 'agreement']);
    function statsOf(sides) {
        const chosen = [];
        for (const side of sides || []) {
            if (MEASURED.includes(side?.kind) && !chosen.some(other => other.value === side.value)) chosen.push(side);
        }
        if (!chosen.length) return null;
        const kinds = new Set(chosen.map(side => side.kind));
        const subject = kinds.size === 1 && !kinds.has('plan') ? `${[...kinds][0]}s` : 'plans';
        return { subject, sides: chosen };
    }

    // Whether a side applies one design: by: { id, unapplied } where unapplied marks a plan member no
    // applied design stands for. Proposed applies every applied design; an applied design's side
    // itself alone; a side that reads its members (a plan, an agreement's plan, a design that is not
    // applied) its members, applied or not; Built and Permitted apply nothing.
    function appliesDesign(side, by) {
        if (!side || by?.id == null) return false;
        const id = String(by.id);
        switch (side.kind) {
            case 'proposed': return !by.unapplied;
            case 'design': return side.members ? side.members.includes(id) : !by.unapplied && side.id === id;
            case 'plan':
            case 'agreement': return (side.members || []).includes(id);
            default: return false;
        }
    }

    // Whether a side shows one scene object. descriptor: { role, designIds, unapplied, demolishedBy }
    // where role is 'existing' (a building standing today; demolishedBy lists the designs that remove
    // or cut it, as { id, unapplied }), 'proposed' (what designs draw; designIds names the designs it
    // belongs to, several where their roads meet at a junction, and is empty when no design is known
    // for it; unapplied when a plan draws it itself) or 'permitted' (source massing). Proposed work
    // shows on a side applying any of its designs; work of no known design on Proposed alone.
    function showsOn(side, descriptor) {
        if (!side || !descriptor) return true;
        switch (descriptor.role) {
            case 'existing':
                return !(descriptor.demolishedBy || []).some(by => appliesDesign(side, by));
            case 'proposed':
                if (!descriptor.designIds?.length) return side.kind === 'proposed';
                return descriptor.designIds.some(id => appliesDesign(side, { id, unapplied: !!descriptor.unapplied }));
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

    // Whether two sides can be compared yet: a side that draws members itself (a plan with members no
    // applied design stands for, a design that is not applied) draws only once they are read.
    // statusOf(readId): { status: 'loading'|'ready'|'failed', error }
    // or null before a read starts. Returns { ready, reading: [side], failed: [{ side, error }] }; the
    // comparison draws (and its divider shows) only when ready, so a side that cannot be read is
    // told in the Compare tab and never reaches the divider.
    function readiness(sides, statusOf) {
        const reading = [];
        const failed = [];
        for (const side of sides || []) {
            if (!side?.unapplied?.length) continue;
            const read = statusOf(side.readId);
            if (read?.status === 'failed') failed.push({ side, error: read.error });
            else if (read?.status !== 'ready') reading.push(side);
        }
        return { ready: !reading.length && !failed.length, reading, failed };
    }

    // The plans a side can be: this browser's own (saved or opened) and the city's published ones, each
    // once by CID. A plan this browser holds keeps its own row, with its publication time from the
    // published list when it has none of its own.
    function planRowsOf(local, published) {
        const publishedAt = new Map((published || []).map(row => [String(row.cid), row.publishedAt]));
        const held = (local || []).map(row => (row.publishedAt || !publishedAt.get(String(row.cid)) ? row : { ...row, publishedAt: publishedAt.get(String(row.cid)) }));
        const known = new Set(held.map(row => String(row.cid)));
        return [...held, ...(published || []).filter(row => !known.has(String(row.cid)))];
    }

    // A comparison in the address: `compare=<left>,<right>`, each side Built today, Permitted massing
    // or Proposed by name (built, permitted, proposed), or a saved plan by its CID. Other sides (a
    // design or agreement this browser holds) have no shareable name, so such a comparison is not
    // written. compareParam gives the value for two select values, or null; parseCompareParam the
    // two select values back, or null when the value is not two such sides.
    const PLAN_CID = /^baf(?:krei[a-z2-7]{52}|ybei[a-z2-7]{52})$/;
    const tokenOf = value => (BASE.includes(value) ? value
        : typeof value === 'string' && value.startsWith('plan:') && PLAN_CID.test(value.slice(5)) ? value.slice(5) : null);
    const sideOf = token => (BASE.includes(token) ? token : PLAN_CID.test(token) ? `plan:${token}` : null);
    function compareParam(left, right) {
        const a = tokenOf(left), b = tokenOf(right);
        return a && b ? `${a},${b}` : null;
    }
    function parseCompareParam(value) {
        const parts = typeof value === 'string' ? value.split(',') : [];
        if (parts.length !== 2) return null;
        const [left, right] = parts.map(part => sideOf(part.trim()));
        return left && right ? { left, right } : null;
    }

    const pure = { BASE, sideOptions, optionGroups, planRowsOf, parseSide, statsOf, appliesDesign, showsOn, splitDescriptors, scissorRects, readiness,
        compareParam, parseCompareParam };
    if (!global || !global.document) return Object.freeze(pure);

    // ── the Compare tab and the divider ──────────────────────────────────────────────────────

    const doc = global.document;
    // model: the model view while it is open; map: the 2D map. The model view wins while open.
    const state = { enabled: false, left: 'built', right: 'proposed', percent: 50, options: pure.sideOptions(), model: null, map: null,
        divider: null, dividerScene: null, pending: null };
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
            case 'agreement': return t('planningViews.compare.options.agreement', 'Agreement: {{title}}', { title: option.title });
            default: return option.value;
        }
    }

    // An option in the picker: inside its group the kind goes without saying, and the time tells two
    // plans or designs of the same title apart.
    const GROUP_LABELS = { today: 'Today', plan: 'Plans', agreement: 'Agreements', design: 'Designs' };
    function menuLabel(option) {
        if (BASE.includes(option.kind)) return optionLabel(option);
        const date = option.at ? global.CbFormat?.formatDateTime?.(option.at) : '';
        return date ? t('planningViews.compare.options.dated', '{{title}} · {{date}}', { title: option.title, date }) : option.title;
    }

    const el = id => doc.getElementById(id);
    // The plan rows a side reads its members from, by readId: the saved plans by their CID, and each
    // design that is not applied as a one-member plan (its own composition, never saved).
    let planRows = new Map();
    // One-member plans by design CID: the same design is read once a page.
    const designReads = new Map();

    const cidOf = proposal => {
        try { return global.DesignSync?.publishedCid?.(proposal) || global.DesignRecord?.cidOf?.(proposal) || null; } catch (_) { return null; }
    };

    // A design that is not applied, as the one-member plan Plan stats would read it: the design's
    // CID is computed here from its content, published or not (DesignRecord.cidOf), so a local design
    // reads exactly as a published one. Its view only places the plan and is taken from its site.
    function designRead(proposal, cid) {
        if (designReads.has(cid)) return designReads.get(cid);
        let row = null;
        try {
            const site = global.__siteBinding.siteOf(proposal);
            const [lng, lat] = global.turf.centroid(site.type === 'Feature' ? site : global.turf.feature(site)).geometry.coordinates;
            row = global.PlanComposition.ofDesign(proposal, [lat, lng]);
        } catch (error) {
            global.console.warn(`[${new Date().toISOString()}] [ThreeCompare] design ${proposal.proposalId} cannot be a Compare side`, error?.message || error);
        }
        designReads.set(cid, row);
        return row;
    }

    // The city's published plans (GET /plans?city=), read once a city a page so any published plan can
    // be a side, not only one this browser has opened. Read in pages up to PUBLISHED_PLAN_LIMIT, each
    // from the offset the server names; the picker refills when they land. Nothing is read until the
    // sheet, its Compare tab or a comparison opens (publishedWanted), not on every page load. A failed
    // read leaves this browser's plans and is tried again the next time the sheet opens.
    const PUBLISHED_PLAN_PAGE = 50, PUBLISHED_PLAN_LIMIT = 500;
    const publishedPlans = new Map();
    let publishedWanted = false;
    async function readPublishedPlans(city) {
        const rows = [];
        for (let offset = 0; offset < PUBLISHED_PLAN_LIMIT;) {
            const params = new URLSearchParams({ city, limit: String(PUBLISHED_PLAN_PAGE), offset: String(offset) });
            const response = await global.fetch(`${global.getBackendBase()}/plans?${params}`, { cache: 'no-store' });
            const page = await response.json();
            if (!response.ok) throw new Error(page.error || `HTTP ${response.status}`);
            for (const row of page.plans || []) {
                // A row whose content does not hash to its CID is not that plan.
                if (global.PlanRecord.validate(row.content) || global.Cid.cidOfObject(row.content) !== row.cid) {
                    global.console.warn(`[${new Date().toISOString()}] [ThreeCompare] published plan ${row.cid} does not match its content; left out`);
                    continue;
                }
                rows.push({ cid: row.cid, content: row.content, publishedAt: row.publishedAt || null });
            }
            if (!page.hasMore) break;
            if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('GET /plans named no next page');
            offset = page.nextOffset;
        }
        return rows;
    }
    function publishedPlansOf(city) {
        if (!city) return [];
        if (!publishedPlans.has(city)) {
            if (!publishedWanted) return [];
            const entry = { rows: [] };
            publishedPlans.set(city, entry);
            readPublishedPlans(city).then(rows => { entry.rows = rows; refresh(); }).catch(error => {
                publishedPlans.delete(city);
                global.console.error(`[${new Date().toISOString()}] [ThreeCompare] the published plans of ${city} could not be read`, error);
            });
        }
        return publishedPlans.get(city).rows;
    }

    // This city's saved designs, plans (this browser's and the published ones) and agreements, as sides. An applied design is its applied copy; one that
    // is not applied is read as a one-member plan. A plan member with an applied copy is that copy;
    // the rest the plan draws itself once read (compare-unapplied.js).
    function collectOptions() {
        const store = global.proposalStorage;
        const city = global.normalizeCityCodeForApi?.(global.resolveCurrentCityCode?.()) || null;
        const inCity = value => !city || !value || global.normalizeCityCodeForApi(value) === city;
        const isApplied = proposal => global.isProposalApplied?.(proposal) ?? proposal.applied === true;
        const saved = (store?.getAllProposals?.() || []).filter(proposal => proposal?.proposalId != null);
        const applied = saved.filter(isApplied);
        const copies = applied.map(proposal => ({ id: String(proposal.proposalId), cid: cidOf(proposal) }));
        planRows = new Map();
        const designs = [];
        for (const proposal of saved) {
            const title = proposal.title || proposal.name || String(proposal.proposalId);
            const at = proposal.authoredAt || proposal.createdAt || null;
            if (isApplied(proposal)) { designs.push({ id: String(proposal.proposalId), title, at }); continue; }
            if (!inCity(proposal.city)) continue;
            const cid = cidOf(proposal);
            const row = cid ? designRead(proposal, cid) : null;
            if (!row) continue;
            planRows.set(String(row.cid), row);
            designs.push({ id: String(proposal.proposalId), title, at, cid, readId: String(row.cid) });
        }
        const localPlans = (global.PlanWorkspace?.list?.() || []).filter(row => inCity(row.content?.view?.city));
        const plans = pure.planRowsOf(localPlans, publishedPlansOf(city)).map(row => {
            planRows.set(String(row.cid), row);
            return { id: String(row.cid), title: row.content?.title || String(row.cid), at: row.publishedAt || null, ...global.CompareUnapplied.membersOf(row, copies) };
        });
        // An agreement draws its plan; one without a plan yet is no side.
        const agreements = (global.AgreementStore?.list?.() || []).filter(row => row?.plan?.cid && inCity(row.city)).map(row => {
            if (!planRows.has(String(row.plan.cid))) planRows.set(String(row.plan.cid), row.plan);
            return { id: String(row.id), title: row.title || String(row.id), at: row.createdAt || null, readId: String(row.plan.cid), ...global.CompareUnapplied.membersOf(row.plan, copies) };
        });
        return pure.sideOptions({ designs, plans, agreements });
    }

    // A side that draws members itself is read once it is chosen.
    function readUnapplied(side) {
        if (side?.unapplied?.length && planRows.has(side.readId)) global.CompareUnapplied.load(planRows.get(side.readId));
    }

    function readinessOf(current = sides()) {
        return pure.readiness([current.left, current.right], id => global.CompareUnapplied?.status?.(id) || null);
    }

    // Under the sides: a plan being read, or one that could not be read with its reason and Retry.
    // Hidden when both sides are ready or the comparison is off.
    function renderStatus(readiness) {
        const box = el('planning-compare-status');
        if (!box) return;
        box.replaceChildren();
        const shown = state.enabled && !!readiness && !readiness.ready;
        box.hidden = !shown;
        box.classList.toggle('is-error', shown && readiness.failed.length > 0);
        if (!shown) return;
        for (const { side, error } of readiness.failed) {
            const line = doc.createElement('p');
            line.className = 'planning-compare-status__line';
            line.textContent = t('planningViews.compare.unreadable', '{{label}} (could not be read: {{reason}})', { label: optionLabel(side), reason: error });
            const retry = doc.createElement('button');
            retry.type = 'button';
            retry.className = 'cb-link planning-compare-status__retry';
            retry.textContent = t('designMemberships.retry', 'Retry');
            retry.addEventListener('click', () => { if (planRows.has(side.readId)) global.CompareUnapplied.retry(planRows.get(side.readId)); syncDivider(); });
            box.append(line, retry);
        }
        for (const side of readiness.reading) {
            const line = doc.createElement('p');
            line.className = 'planning-compare-status__line';
            const spinner = doc.createElement('i');
            spinner.className = 'fas fa-spinner fa-spin';
            spinner.setAttribute('aria-hidden', 'true');
            line.append(spinner, ' ', t('planningViews.compare.reading', '{{label}} (reading…)', { label: optionLabel(side) }));
            box.appendChild(line);
        }
    }

    function fillSelect(select, value) {
        if (!select) return;
        select.replaceChildren();
        for (const { group, options } of pure.optionGroups(state.options)) {
            const node = doc.createElement('optgroup');
            node.label = t(`planningViews.compare.groups.${group}`, GROUP_LABELS[group]);
            for (const option of options) node.appendChild(new Option(menuLabel(option), option.value));
            select.appendChild(node);
        }
        select.value = pure.parseSide(value, state.options) ? value : state.options[0].value;
    }

    function sides() {
        return { left: pure.parseSide(state.left, state.options), right: pure.parseSide(state.right, state.options), percent: state.percent };
    }

    // Whether the comparison draws; given a scene, whether it draws in that one. Not before both
    // sides are read (readiness).
    function isActive(of = null) {
        const current = sides();
        return state.enabled && !!scene() && (!of || of === scene()) && !!current.left && !!current.right
            && readinessOf(current).ready;
    }

    // The address names the comparison while it is on (compare=, above) and drops it when it is off,
    // so a copied address opens the same two sides. A comparison that arrived in the address and is
    // still waiting for its sides leaves the address as it came.
    function writeAddress() {
        if (state.pending || !global.history?.replaceState) return;
        const url = new URL(global.location.href);
        const value = state.enabled ? pure.compareParam(state.left, state.right) : null;
        if (value) url.searchParams.set('compare', value); else url.searchParams.delete('compare');
        if (url.href !== global.location.href) global.history.replaceState(global.history.state, '', url.href);
    }

    function refresh() {
        state.options = collectOptions();
        // A comparison from the address opens once a view is there and both sides are offered (a
        // published plan is offered once the city's published plans are read).
        const pending = state.pending;
        if (pending && scene() && pure.parseSide(pending.left, state.options) && pure.parseSide(pending.right, state.options)) {
            state.pending = null;
            show(pending);
            return;
        }
        fillSelect(el('planning-compare-left'), state.left);
        fillSelect(el('planning-compare-right'), state.right);
        state.left = el('planning-compare-left')?.value || state.left;
        state.right = el('planning-compare-right')?.value || state.right;
        renderToggle();
        for (const id of ['planning-compare-left', 'planning-compare-right', 'planning-compare-swap']) {
            const control = el(id);
            if (control) control.disabled = !scene();
        }
        // On the map: what the halves draw there, and the way to the model view.
        const note = doc.querySelector('.planning-compare-note');
        if (note) note.hidden = !!state.model;
        syncDivider();
    }

    // The Compare / Stop comparing action under the sides: pressed while the comparison is on.
    function renderToggle() {
        const toggle = el('planning-compare-enable');
        if (!toggle) return;
        toggle.disabled = !scene();
        toggle.setAttribute('aria-pressed', String(state.enabled));
        // Compare is the panel's primary action; Stop comparing is a plain button.
        toggle.classList.toggle('btn-primary', !state.enabled);
        const label = toggle.querySelector('.planning-compare-toggle__label');
        if (label) label.textContent = state.enabled
            ? t('planningViews.compare.stop', 'Stop comparing')
            : t('planningViews.tabs.compare', 'Compare');
    }

    // Turns the comparison on or off: the action under the sides, and the X on the divider (the way
    // out when the sheet is closed).
    function setEnabled(enabled) {
        state.enabled = !!enabled;
        renderToggle();
        syncDivider();
    }

    // The divider over the canvas or map: present while the comparison draws, labelled with the two
    // sides. It moves to the other view when the model view opens or closes.
    function syncDivider() {
        writeAddress();
        if (state.enabled && scene()) {
            const chosen = sides();
            readUnapplied(chosen.left);
            readUnapplied(chosen.right);
        }
        renderStatus(state.enabled && scene() ? readinessOf() : null);
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
        // The scene draws what the sides' unapplied plan members add (the model view builds meshes).
        scene().compareChanged?.();
        const labels = { before: optionLabel(current.left), after: optionLabel(current.right) };
        if (state.divider) {
            state.divider.labelEls[0].textContent = labels.before;
            state.divider.labelEls[1].textContent = labels.after;
            syncStatsButton(current);
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
            closeLabel: t('planningViews.compare.stop', 'Stop comparing'),
            statsLabel: t('planningViews.compare.stats', 'Compare stats'),
            onStats: button => global.BusyControl.track(button, () => openStats()).catch(error => {
                global.console.error(`[${new Date().toISOString()}] [ThreeCompare] the stats of the comparison could not open`, error);
                global.updateStatus?.(t('planningViews.compare.statsFailed', 'The stats could not open: {{reason}}', { reason: error?.message || String(error) }));
            }),
            onClose: () => setEnabled(false),
            onChange: percent => { state.percent = percent; scene()?.invalidate(); }
        });
        state.dividerScene = scene();
        syncStatsButton(current);
        scene().invalidate();
    }

    // The stats button shows while a side has figures (pure.statsOf).
    function syncStatsButton(current = sides()) {
        if (state.divider?.statsEl) state.divider.statsEl.hidden = !pure.statsOf([current.left, current.right]);
    }

    // The two sides' figures in Compare plans (plan-stats.js comparePlanStats), each side read as the
    // plan it draws: a plan or an agreement's plan by its row, a design as its one-member plan. The
    // dialog's Side by side on the map comes back to these sides.
    function openStats() {
        const current = sides();
        const chosen = pure.statsOf([current.left, current.right]);
        if (!chosen) return null;
        const planOf = side => {
            if (side.readId && planRows.has(side.readId)) return planRows.get(side.readId);
            const proposal = side.kind === 'design' ? global.proposalStorage?.getProposal?.(side.id) : null;
            const cid = proposal ? cidOf(proposal) : null;
            const row = cid ? designRead(proposal, cid) : null;
            if (!row) throw new Error(`${optionLabel(side)} has no plan to measure`);
            return row;
        };
        const plans = chosen.sides.map(planOf);
        const terms = chosen.subject === 'agreements' ? chosen.sides.map(side => global.AgreementStore.get(side.id)) : null;
        return global.comparePlanStats(plans, { subject: chosen.subject, sides: chosen.sides.map(side => side.value),
            titles: chosen.sides.map(side => side.title), terms });
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
        publishedWanted = true;
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
            window.CbTabs?.sync(sheet.querySelector('.planning-tabs'));
            for (const panel of sheet.querySelectorAll('[data-planning-tab-panel]')) panel.hidden = panel.dataset.planningTabPanel !== tab.dataset.planningTab;
            if (tab.dataset.planningTab === 'compare') { publishedWanted = true; refresh(); }
        });
        el('planning-compare-enable')?.addEventListener('click', () => setEnabled(!state.enabled));
        el('planning-compare-left')?.addEventListener('change', event => { state.left = event.target.value; syncDivider(); });
        el('planning-compare-right')?.addEventListener('change', event => { state.right = event.target.value; syncDivider(); });
        el('planning-compare-swap')?.addEventListener('click', () => {
            [state.left, state.right] = [state.right, state.left];
            fillSelect(el('planning-compare-left'), state.left);
            fillSelect(el('planning-compare-right'), state.right);
            syncDivider();
        });
        el('planning-compare-open-model')?.addEventListener('click', () => global.requestMapMode?.('model'));
        doc.addEventListener('mapshell:sheetopened', event => {
            if (event.detail?.id === 'planning-views') { publishedWanted = true; refresh(); }
        });
        // A plan read for a side has arrived or failed: relabel the divider and redraw.
        global.addEventListener('compareunappliedchange', syncDivider);
        // A shared comparison: its sides open as soon as they are offered (refresh).
        state.pending = pure.parseCompareParam(new URLSearchParams(global.location.search).get('compare'));
        if (state.pending) publishedWanted = true;
        refresh();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wire, { once: true });
    else wire();

    return Object.freeze({ ...pure, attach, detach, attachMap, refresh, isActive, sides, show,
        getState: () => ({ ...state, model: undefined, map: undefined, divider: undefined, dividerScene: undefined, before: undefined, onMap: !!state.map && !state.model }) });
});
