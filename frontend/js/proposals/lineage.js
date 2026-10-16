// Proposal lineage: which proposal a fork or counterproposal came from, and which ones were made from
// it. A fork records its source's id (sourceProposalId / replacementOfProposalId /
// copiedFromProposalId, proposals/create.js); the server resolves both directions
// (GET /proposals/:id/lineage). The details panel shows the list under the description, so an
// original names its counterproposals and every fork links back.
//
// The pure parts (publishedSourceIds, localDerived, mergeDerived) are tested headlessly; mount()
// is the browser renderer, resolving the app's globals at call time.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.ProposalLineage = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const SOURCE_KEYS = ['sourceProposalId', 'replacementOfProposalId', 'copiedFromProposalId'];
    const idOf = value => (value === undefined || value === null ? '' : String(value));

    function sourceIdsOf(record) {
        return SOURCE_KEYS.map(key => idOf(record && record[key])).filter(Boolean);
    }

    // A fork names its source by the id it has in this browser. A source that was drafted here and
    // published since is known to the server only by its published record, so the upload copy names
    // that one instead — otherwise the original could never find the forks made from it.
    // `findLocal(id)` returns this browser's record for an id.
    function publishedSourceIds(record, findLocal) {
        const out = {};
        if (!record || typeof findLocal !== 'function') return out;
        SOURCE_KEYS.forEach(key => {
            const id = idOf(record[key]);
            if (!id) return;
            const source = findLocal(id);
            const published = idOf(source && source.serverProposalId);
            if (published && published !== id) out[key] = published;
        });
        return out;
    }

    // Forks of `proposal` held in this browser (published or not), by either of its ids.
    function localDerived(proposal, all) {
        const own = new Set([idOf(proposal && proposal.proposalId), idOf(proposal && proposal.serverProposalId)].filter(Boolean));
        if (!own.size) return [];
        return (Array.isArray(all) ? all : []).filter(record => record && record !== proposal
            && !own.has(idOf(record.proposalId))
            && sourceIdsOf(record).some(id => own.has(id)));
    }

    // One list: the server's published forks first (newest first, as served), then forks that exist
    // only in this browser. A local copy of a published fork is the same entry, not a second one.
    function mergeDerived(serverList, localList) {
        const entries = [];
        const seen = new Set();
        (Array.isArray(serverList) ? serverList : []).forEach(entry => {
            const keys = [idOf(entry.id), idOf(entry.proposalId)].filter(Boolean);
            if (!keys.length || keys.some(key => seen.has(key))) return;
            keys.forEach(key => seen.add(key));
            entries.push({
                lookup: idOf(entry.id) || idOf(entry.proposalId),
                title: entry.title || null,
                author: entry.author || null,
                status: entry.status || null,
                landFork: entry.landFork === true,
                published: true
            });
        });
        (Array.isArray(localList) ? localList : []).forEach(record => {
            const keys = [idOf(record.serverProposalId), idOf(record.proposalId)].filter(Boolean);
            if (keys.some(key => seen.has(key))) return;
            keys.forEach(key => seen.add(key));
            entries.push({
                lookup: idOf(record.proposalId),
                title: record.title || record.name || null,
                author: record.author || null,
                status: record.lifecycleStatus || null,
                landFork: !!record.landFork,
                published: !!record.serverProposalId
            });
        });
        return entries;
    }

    // ---- browser ------------------------------------------------------------------------------

    const t = (key, fallback, params) => {
        const helper = typeof root.getProposalI18nHelper === 'function' ? root.getProposalI18nHelper() : null;
        return helper ? helper(key, fallback, params || {}) : fallback;
    };
    const esc = value => (typeof root.escapeHtml === 'function' ? root.escapeHtml(idOf(value)) : idOf(value));

    async function fetchLineage(proposal) {
        const id = idOf(proposal && proposal.serverProposalId);
        if (!id || typeof root.fetch !== 'function') return null;
        const base = (typeof root.getBackendBase === 'function' ? root.getBackendBase() : '').replace(/\/$/, '');
        const response = await root.fetch(`${base}/proposals/${encodeURIComponent(id)}/lineage`);
        if (!response.ok) throw new Error(`lineage ${response.status}`);
        return response.json();
    }

    // Open a related proposal: this browser's record if it has one, else the published record,
    // fetched the way a Proposals list row opens it.
    async function open(lookup) {
        const key = idOf(lookup);
        if (!key) return;
        const local = typeof root.getProposalByIdOrHash === 'function' ? root.getProposalByIdOrHash(key) : null;
        if (local && typeof root.focusProposalDetails === 'function') {
            root.focusProposalDetails(key, { centerOnProposal: true, showDetails: true });
            return;
        }
        try {
            const proposal = await root.importServerProposal(key);
            root.openProposalFromList(root.getProposalKey(proposal) || key, { proposal, closeSheets: true });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ProposalLineage] could not open proposal ${key}`, error);
            if (typeof root.showProposalAlertMessage === 'function') {
                root.showProposalAlertMessage('proposal_with_id_not_found', t('panel.proposal.lineage.openFailed', 'That proposal could not be opened.'));
            }
        }
    }

    function entryHtml(entry) {
        const title = entry.title || t('panel.proposal.lineage.untitled', 'Untitled proposal');
        const notes = [
            entry.author,
            entry.landFork ? t('panel.proposal.lineage.differentLand', 'on different land') : null,
            entry.published ? null : t('panel.proposal.lineage.localOnly', 'only in this browser')
        ].filter(Boolean).join(' · ');
        return `<li><button type="button" class="cb-link proposal-lineage__link" data-lineage-open="${esc(entry.lookup)}">${esc(title)}</button>${notes ? ` <span class="proposal-lineage__note">${esc(notes)}</span>` : ''}</li>`;
    }

    // The source named by the "Based on / Variant of" row, when this browser does not hold it: a
    // link when it was published, otherwise said to be a draft that was never shared.
    function patchSourceRow(container, source) {
        const name = container && container.querySelector('.proposal-based-on-name');
        if (!name || !source) return;
        if (source.published) {
            const link = root.document.createElement('button');
            link.type = 'button';
            link.className = 'cb-link proposal-based-on-link';
            link.textContent = source.title || name.textContent;
            link.setAttribute('data-lineage-open', idOf(source.id || source.proposalId));
            name.replaceWith(link);
        } else {
            name.textContent = t('panel.proposal.lineage.unpublishedSource', '{{name}} (a draft that was never published)',
                { name: source.title || name.textContent });
        }
    }

    async function mount(slot, proposal) {
        if (!slot || !proposal) return;
        const key = idOf(proposal.proposalId);
        slot.dataset.lineageFor = key;
        if (!slot.dataset.lineageBound) {
            slot.dataset.lineageBound = 'true';
            const panel = slot.closest('.proposal-description-row') || slot.parentElement;
            (panel || slot).addEventListener('click', event => {
                const control = event.target.closest('[data-lineage-open]');
                if (!control) return;
                event.preventDefault();
                event.stopPropagation();
                open(control.getAttribute('data-lineage-open'));
            });
        }
        let all = [];
        try { all = root.proposalStorage.getAllProposals(); } catch (_) { all = []; }
        const local = localDerived(proposal, all);
        let lineage = null;
        try { lineage = await fetchLineage(proposal); } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ProposalLineage] lineage unavailable for ${key}`, error);
        }
        // The panel may have moved on to another proposal while the request was out.
        if (slot.dataset.lineageFor !== key) return;
        patchSourceRow(slot.parentElement, lineage && lineage.source);
        const entries = mergeDerived(lineage && lineage.derived, local);
        if (!entries.length && !proposal.serverProposalId) { slot.hidden = true; return; }
        slot.hidden = false;
        slot.innerHTML = `<p class="proposal-lineage__title">${esc(entries.length
            ? t('panel.proposal.lineage.title', 'Counterproposals and forks ({{count}})', { count: entries.length })
            : t('panel.proposal.lineage.none', 'No counterproposals yet. Fork proposal makes one that links back here.'))}</p>
            ${entries.length ? `<ul class="proposal-lineage__list">${entries.map(entryHtml).join('')}</ul>` : ''}`;
    }

    // What saving a fork does, said on its button. A fork of a published record is a counterproposal:
    // the source stays standing and lists it. A fork of one's own unpublished draft replaces that
    // draft (proposal-supersession.js draws the same line).
    function forkSubmitLabel(sourceId) {
        const source = typeof root.getProposalByIdOrHash === 'function' && sourceId ? root.getProposalByIdOrHash(sourceId) : null;
        const published = !!source && typeof root.isPublishedProposalRecord === 'function' && root.isPublishedProposalRecord(source);
        return published
            ? t('proposalDrafts.actions.createCounterproposal', 'Create counterproposal')
            : t('proposalDrafts.actions.createReplacement', 'Create replacement proposal');
    }

    return { SOURCE_KEYS, sourceIdsOf, publishedSourceIds, localDerived, mergeDerived, mount, open, forkSubmitLabel };
});
