// mint-checklist.js — the one mint dialog for designs, plans and agreements (blockchain-flows.md,
// Flow 3): each step shown with its state, run in order on one chain adapter (chain/evm-adapter.js or
// chain/solana-adapter.js): the content retrievable from IPFS (chain/ipfs-courier.js), every
// input parcel anchored, the record minted. A failed step stops the run and Retry resumes at it;
// what is done stays done, so a refused signature costs nothing. window.MintChecklist.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.MintChecklist = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // The object kinds as Compare names them; the shared keys keep the copy in one place.
    const KIND_KEYS = Object.freeze({ design: 'planCompare.design', plan: 'planCompare.plan', agreement: 'planCompare.agreement' });

    const t = (key, vars) => (root.i18n && typeof root.i18n.t === 'function' ? root.i18n.t(key, vars) : key);
    const shortKey = value => (value && value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value || '');

    /**
     * The steps of one mint, each { id, label, run(report) } where run resolves when the step is done
     * and `report(note, extra)` narrates it. Pure: the dialog renders what this says.
     * spec: { kind, objects: [{ cid, bytes, label, kind? }], parcelIds?, metadataUriOf?, tokenUri, adapter, courier, apiBase, pinataJwt(),
     *   mintRecord? }. An object's own `kind` (a plan's member design) is what the courier pins it as.
     * An agreement's record is its account in the Agreement contract, not a registry token:
     * `mintRecord({ report })` creates it and resolves { txHash (null when it existed), record: { minter, … }, address? }.
     */
    function steps(spec) {
        const { kind, adapter, courier } = spec;
        const list = spec.objects.map(object => ({
            id: `content:${object.cid}`, cid: object.cid,
            label: t('mint.steps.retrievable', { label: object.label || shortKey(object.cid) }),
            async run(report) {
                const narrate = status => {
                    if (status.phase === 'checking') report(t('mint.status.checking'));
                    else if (status.phase === 'pinning') report(t(status.courier === 'server' ? 'mint.status.pinningServer' : 'mint.status.pinningPinata'));
                    else if (status.phase === 'waiting') report(t('mint.status.waiting', { courier: status.courier, attempt: status.attempt, total: status.total }));
                };
                const delivered = await courier.deliver({ kind: object.kind || kind, cid: object.cid, bytes: object.bytes, apiBase: spec.apiBase, pinataJwt: spec.pinataJwt ? spec.pinataJwt() : null, onStatus: narrate });
                report(t('mint.status.retrievable', { gateway: delivered.gateway.replace(/^https?:\/\//, '').replace(/\/ipfs\/?$/, '') }));
                return delivered;
            }
        }));
        if (Array.isArray(spec.parcelIds) && spec.parcelIds.length) {
            list.push({
                id: 'anchors', label: t('mint.steps.anchors'),
                async run(report) {
                    const missing = await adapter.anchorsMissing(spec.parcelIds);
                    if (!missing.length) { report(t('mint.status.anchorsAll', { count: spec.parcelIds.length })); return { anchored: 0 }; }
                    const batches = Math.ceil(missing.length / (adapter.anchorBatch || 25));
                    report(t('mint.status.anchorsMissing', { missing: missing.length, count: spec.parcelIds.length, batches }));
                    const result = await adapter.mintAnchors(missing, {
                        metadataUriOf: spec.metadataUriOf || (() => ''),
                        onBatch: ({ done, total, txHash }) => report(t('mint.status.anchorsProgress', { done, total }), { tx: txHash })
                    });
                    report(t('mint.status.anchorsAll', { count: spec.parcelIds.length }), { tx: result.txHashes[result.txHashes.length - 1] });
                    return result;
                }
            });
        }
        // The record is the subject's (a plan's, after its members); by default the first object's.
        const subject = spec.subject || spec.objects[0].cid;
        list.push({
            id: 'record', label: t('mint.steps.record', { kind: t(KIND_KEYS[kind] || KIND_KEYS.design), chain: adapter.name }),
            async run(report) {
                if (typeof spec.mintRecord === 'function') {
                    report(t('mint.status.minting'));
                    const minted = await spec.mintRecord({ report });
                    const minter = shortKey(minted.record && minted.record.minter);
                    if (minted.txHash) report(t('mint.status.minted', { minter }), { tx: minted.txHash });
                    else report(t('mint.status.alreadyMinted', { minter }), minted.address ? { address: minted.address } : null);
                    return minted;
                }
                const existing = await adapter.recordOf(subject);
                if (existing) { report(t('mint.status.alreadyMinted', { minter: shortKey(existing.minter) }), { address: existing.address || adapter.addresses.RecordRegistry }); return { record: existing, txHash: null }; }
                report(t('mint.status.minting'));
                const minted = await adapter.mintRecord(kind, subject, spec.tokenUri);
                report(t('mint.status.minted', { minter: shortKey(minted.record.minter) }), { tx: minted.txHash });
                return minted;
            }
        });
        return list;
    }

    /**
     * Runs `list` from the first step not yet done; `state` (Map id → { status, note, extra, result })
     * is updated as it goes and `onChange(step)` redraws. Resolves true when every step is done.
     */
    async function run(list, state, onChange) {
        for (const step of list) {
            const entry = state.get(step.id) || { status: 'pending', note: '', extra: null, result: null };
            state.set(step.id, entry);
            if (entry.status === 'done') continue;
            entry.status = 'running'; entry.note = ''; entry.extra = null; onChange(step);
            try {
                entry.result = await step.run((note, extra = null) => { entry.note = note; entry.extra = extra; onChange(step); });
                entry.status = 'done'; onChange(step);
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [MintChecklist] step ${step.id} failed`, error);
                entry.status = 'failed';
                entry.note = error && error.code === 'no-courier' ? t('mint.status.noCourier')
                    : error && error.code === 'not-retrievable' ? t('mint.status.notRetrievable')
                        : (error && (error.shortMessage || error.message)) || String(error);
                entry.extra = { error };
                onChange(step);
                return false;
            }
        }
        return true;
    }

    /**
     * Opens the dialog and starts the run. Resolves { record, txHash, delivered } once every step is
     * done, or null when the dialog is closed first.
     * spec: as `steps`, plus title and (browser) nothing else: the courier, dialog and i18n are the page's.
     */
    function open(spec) {
        const win = root;
        const doc = win.document;
        const courier = spec.courier || win.IpfsCourier;
        const list = steps({ ...spec, courier, pinataJwt: spec.pinataJwt || (() => courier.pinataJwt()) });
        const state = new Map();
        const node = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
        const body = node('div', 'mint-checklist');
        body.append(node('p', 'sheet-note', t('mint.intro')));
        const ol = node('ol', 'mint-steps');
        const rows = new Map();
        for (const step of list) {
            const li = node('li', 'mint-step'); li.dataset.step = step.id; li.dataset.state = 'pending';
            const label = node('span', 'mint-step__label', step.label);
            const note = node('span', 'mint-step__note'); note.setAttribute('role', 'status');
            const actions = node('span', 'cb-actions mint-step__actions');
            li.append(node('span', 'mint-step__icon'), label, note, actions);
            ol.append(li); rows.set(step.id, { li, note, actions });
        }
        body.append(ol);
        const outcome = node('p', 'mint-checklist__outcome'); outcome.setAttribute('role', 'status'); body.append(outcome);

        let settled = false;
        let resolveResult = null;
        const result = new Promise(resolve => { resolveResult = resolve; });
        const link = (href, text) => { const a = node('a', 'cb-link cb-link--external', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
        const button = (text, onClick) => { const b = node('button', 'btn btn-sm', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

        function redraw(step) {
            const entry = state.get(step.id);
            const row = rows.get(step.id);
            row.li.dataset.state = entry.status;
            row.note.textContent = entry.note;
            row.actions.replaceChildren();
            const extra = entry.extra || {};
            const explorer = extra.tx ? spec.adapter.explorerUrl({ tx: extra.tx }) : extra.address ? spec.adapter.explorerUrl({ address: extra.address }) : null;
            if (explorer) row.actions.append(link(explorer, t('panel.proposal.lifecycle.viewOnExplorer')));
            if (entry.status === 'failed' && extra.error && extra.error.code === 'no-courier' && step.cid) {
                const object = spec.objects.find(item => item.cid === step.cid);
                row.actions.append(button(t('mint.actions.download'), () => courier.download(step.cid, object.bytes)));
                row.actions.append(button(t('mint.actions.pinataKey'), async () => {
                    const jwt = await win.CbDialog.prompt(t('mint.pinataPrompt'), { title: t('mint.actions.pinataKey'), top: true });
                    if (jwt) courier.savePinataJwt(String(jwt).trim());
                }));
            }
        }

        let api = null;
        async function start() {
            const control = api && api.getActionButton('run');
            if (control && win.BusyControl.isBusy(control)) return;
            const work = async () => {
                const done = await run(list, state, redraw);
                if (!done) { if (control) control.textContent = t('designMemberships.retry'); return; }
                const record = state.get('record').result;
                outcome.textContent = t('mint.done', { chain: spec.adapter.name });
                if (control) control.hidden = true;
                settled = true;
                resolveResult({ record: record.record, txHash: record.txHash, delivered: list.filter(step => step.cid).map(step => state.get(step.id).result) });
            };
            await (control ? win.BusyControl.track(control, work) : work());
        }

        api = win.CbDialog.open({
            title: spec.title || t('mint.actions.start', { chain: spec.adapter.name }), size: 'md', className: 'mint-checklist-dialog', fixedHeight: true, body,
            actions: [
                { id: 'run', label: t('mint.actions.start', { chain: spec.adapter.name }), role: 'primary', keepOpen: true, onClick: () => { start(); } },
                { id: 'close', label: t('modal.common.close') }
            ],
            onClose: () => { if (!settled) resolveResult(null); }
        });
        start();
        return result;
    }

    return { KIND_KEYS, steps, run, open };
});
