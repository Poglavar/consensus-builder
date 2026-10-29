// The address names what the click stack has selected (?parcel=, ?design=, ?plan= or ?agreement=,
// one at a time), so a reload or a copied address reopens it where the view (?at=, ?camera=) left
// it. It is written in place on every selection and dropped when nothing is selected. Reopening a
// selection never applies anything: share links (/designs/<cid>, /plans/<cid>, /agreements/<cid>)
// keep their own meaning. See docs/location-first.md.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.SelectionAddress = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';
    const PARAMS = Object.freeze({ parcels: 'parcel', designs: 'design', plans: 'plan', agreements: 'agreement' });

    // A published design is named by its CID (publishedCid: DesignSync.publishedCid), so the address
    // also opens on another device; an unpublished one by its local key. A plan by its CID; an
    // agreement by its local id, or its CID when it is read from the index.
    function idOf(kind, instance, publishedCid = () => null) {
        if (!instance) return null;
        const record = instance.proposal;
        const id = kind === 'designs' ? (record ? publishedCid(record) || instance.id : instance.serverId || instance.cid || instance.id)
            : kind === 'plans' ? instance.cid || instance.id
            : kind === 'agreements' ? instance.localId || instance.cid || instance.id
            : instance.id;
        return id == null || id === '' ? null : String(id);
    }

    // The stack's selection as { kind, id }, or null. The expanded section is the one selected; a
    // formed piece or the ground names the parcel of its spot. A building or a permitted volume is
    // the planning inspector's own (?planningSelection=, planning/views.js): none of these.
    function selectionOf(stack, selectedInstance, publishedCid) {
        if (!stack) return null;
        const kind = stack.expanded || stack.selectedKind;
        if (kind === 'built' || kind === 'permitted') return null;
        const linkable = Object.hasOwn(PARAMS, kind) ? kind : 'parcels';
        const id = idOf(linkable, selectedInstance(stack, linkable), publishedCid);
        return id ? { kind: linkable, id } : null;
    }

    function read(search) {
        const params = new URLSearchParams(search || '');
        for (const [kind, param] of Object.entries(PARAMS)) {
            const id = params.get(param);
            if (id && id.trim()) return { kind, id: id.trim() };
        }
        return null;
    }

    // A link that opened a record (/designs/<cid>, /plans/<cid>, /agreements/<cid>, /parcel/<id>)
    // has done its work once the stack shows a selection: kept, a reload would import and apply
    // its designs again, so the address becomes the selection.
    const RECORD_PATH = /^\/(designs|plans|agreements|parcel)\/./;

    // The address with exactly this selection (null: none), or null when it already says so.
    function withSelection(href, selection) {
        const url = new URL(href);
        const wanted = selection ? String(selection.id) : null;
        const current = read(url.search);
        if (!RECORD_PATH.test(url.pathname) && (current ? current.kind === selection?.kind && current.id === wanted
            && Object.values(PARAMS).filter(param => url.searchParams.has(param)).length === 1 : !selection)) return null;
        if (RECORD_PATH.test(url.pathname)) url.pathname = '/';
        Object.values(PARAMS).forEach(param => url.searchParams.delete(param));
        if (selection) url.searchParams.set(PARAMS[selection.kind], wanted);
        // commas are valid in a query: keep the view readable (WorldEntryModel.addressWithView)
        return url.toString().replace(/([?&]at=)([^&#]*)/, (match, key, value) => key + value.replace(/%2C/gi, ','));
    }

    const pure = { PARAMS, idOf, selectionOf, read, withSelection };
    if (!global || !global.document) return Object.freeze(pure);

    function write(selection) {
        try {
            const next = withSelection(global.location.href, selection);
            if (next) global.history.replaceState(global.history.state, '', next);
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [SelectionAddress] could not keep the selection in the address`, error);
        }
    }

    // Whether this page load's address carried a view (?at=, which the model and photo views write
    // beside ?camera=): reopening its selection then keeps the camera there; without one the
    // selection is framed, as a link to it is. Read from the boot entry: the map writes ?at= into
    // the address on its first move, before this script runs.
    const keepsView = () => global.CityConfigManager?.getBootEntry?.()?.source === 'at';

    // A reload reopens a plan or an agreement (a parcel: parcels/route.js; a design:
    // world/proposal-entry.js).
    async function restore() {
        const selection = read(global.location.search);
        if (!selection || (selection.kind !== 'plans' && selection.kind !== 'agreements')) return;
        await global.whenAppBooted();
        try {
            if (keepsView()) global.ClickStack.keepNextView();
            if (selection.kind === 'plans') {
                const stored = global.NamedPlans.list({ storedOnly: true }).find(plan => plan.cid === selection.id);
                const draft = !!stored && stored.published !== true && Array.isArray(stored.designs);
                const plan = await global.PlanWorkspace.resolve(stored || { ...await global.NamedPlans.fetchPlan(selection.id), published: true });
                await global.ClickStack.showPlan(plan, { designs: global.PlanComposition.localRecords(plan, { apiBase: global.DesignSync.apiBase() }), draft });
            } else {
                const local = global.AgreementStore.get(selection.id);
                const resolved = local ? { agreement: local, readOnly: false, designs: [] } : await global.AgreementSync.resolveDetails(selection.id);
                await global.ClickStack.showAgreement(resolved.agreement, { readOnly: resolved.readOnly, designs: resolved.designs });
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [SelectionAddress] could not reopen ${selection.kind} ${selection.id}`, error);
            write(null);
        } finally {
            global.ClickStack.keepNextView(false);
        }
    }
    if (global.document.readyState === 'complete') restore();
    else global.addEventListener('load', restore, { once: true });

    return Object.freeze({ ...pure, write, restore, keepsView,
        selectionOf: (stack, selectedInstance) => selectionOf(stack, selectedInstance, record => global.DesignSync?.publishedCid?.(record) || null) });
});
