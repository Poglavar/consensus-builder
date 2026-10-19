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
    const rowIdOf = value => {
        const read = typeof root?.getSerialProposalId === 'function' ? root.getSerialProposalId
            : (typeof require === 'function' ? require('./sharing.js').getSerialProposalId : null);
        return read ? read({ serverProposalId: value }) : null;
    };

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
    // only in this browser. Only an explicit row reference identifies a local copy of a published
    // fork. Equal local/authored keys in the two lists are not evidence of shared identity.
    function mergeDerived(serverList, localList) {
        const entries = [];
        const seenRows = new Set();
        const seenLocalKeys = new Set();
        (Array.isArray(serverList) ? serverList : []).forEach(entry => {
            const proposalRowId = rowIdOf(entry?.proposalRowId);
            if (!proposalRowId || seenRows.has(proposalRowId)) return;
            seenRows.add(proposalRowId);
            entries.push({
                proposalRowId,
                title: entry.title || null,
                author: entry.author || null,
                status: entry.status || null,
                landFork: entry.landFork === true,
                published: true
            });
        });
        (Array.isArray(localList) ? localList : []).forEach(record => {
            const localProposalId = idOf(record?.proposalId);
            const proposalRowId = rowIdOf(record?.serverProposalId);
            if (!localProposalId || seenLocalKeys.has(localProposalId) || (proposalRowId && seenRows.has(proposalRowId))) return;
            seenLocalKeys.add(localProposalId);
            if (proposalRowId) seenRows.add(proposalRowId);
            entries.push({
                localProposalId,
                title: record.title || record.name || null,
                author: record.author || null,
                status: record.lifecycleStatus || null,
                landFork: !!record.landFork,
                published: !!proposalRowId
            });
        });
        return entries;
    }

    // Publication is an identity boundary. A generic content hash is not evidence that a local
    // copy has been minted or stored by the server.
    function isPublished(proposal) {
        if (!proposal || typeof proposal !== 'object') return false;
        try {
            if (typeof root?.isProposalImmutable === 'function' && root.isProposalImmutable(proposal)) return true;
            if (typeof root?.isProposalMinted === 'function' && root.isProposalMinted(proposal)) return true;
        } catch (_) { }
        if (proposal.serverProposalId || proposal.onchain?.transactionHash || proposal.onchainData
            || proposal.isMinted === true || proposal.tokenId || proposal.chainProposalId) return true;
        const status = typeof root?.getLifecycleStatus === 'function'
            ? root.getLifecycleStatus(proposal)
            : String(proposal.lifecycleStatus || proposal.effectiveStatus || proposal.status || '').toLowerCase();
        return ['published', 'minted', 'on-chain', 'onchain'].includes(String(status).toLowerCase());
    }

    // What saving an edit of `source` does. One's own local, unpublished record is edited in place:
    // same id, no new record. A published or minted record is immutable, so an edit of it forks a
    // counterproposal that links back through sourceProposalId and leaves the source standing.
    // `fork: true` is the explicit Fork action, which always makes a new record.
    function editsInPlace(source, options = {}) {
        return !!source && typeof source === 'object' && options.fork !== true && !isPublished(source);
    }

    // The fields an in-place save keeps from the record it rewrites: its identity, its place in the
    // replay order (createdAt, plan-order.js) and its own lineage. A fork of a published proposal
    // stays that proposal's counterproposal however often it is edited. The defaulted fields come
    // from the record only where the edit says nothing: a design edit leaves the record's lifecycle
    // and terms as they were, a save from the create dialog writes the terms it confirmed.
    const KEPT_IDENTITY_KEYS = ['proposalId', 'createdAt'];
    const KEPT_LINEAGE_KEYS = [...SOURCE_KEYS, 'copiedFromName', 'landFork', 'proposalDraftId', 'proposalDraftRevision'];
    const DEFAULTED_KEYS = ['authorAgentId', 'lifecycleStatus', 'termsConfirmed'];
    const copyOf = value => JSON.parse(JSON.stringify(value));

    // The edited content (an editor's built proposal) with the identity of the record it rewrites.
    function inPlaceRecord(source, edited) {
        const out = copyOf(edited || {});
        [...KEPT_IDENTITY_KEYS, ...KEPT_LINEAGE_KEYS].forEach(key => {
            if (source && source[key] !== undefined && source[key] !== null) out[key] = copyOf(source[key]);
            else delete out[key];
        });
        DEFAULTED_KEYS.forEach(key => {
            if (out[key] === undefined && source && source[key] !== undefined && source[key] !== null) out[key] = copyOf(source[key]);
        });
        if (out.roadProposal && typeof out.roadProposal === 'object') {
            out.roadProposal.id = out.proposalId;
            out.roadProposal.proposalId = out.proposalId;
        }
        return out;
    }

    // ---- browser ------------------------------------------------------------------------------

    const t = (key, fallback, params) => {
        const helper = typeof root.getProposalI18nHelper === 'function' ? root.getProposalI18nHelper() : null;
        return helper ? helper(key, fallback, params || {}) : fallback;
    };
    const esc = value => (typeof root.escapeHtml === 'function' ? root.escapeHtml(idOf(value)) : idOf(value));

    async function fetchLineage(proposal) {
        const id = rowIdOf(proposal && proposal.serverProposalId);
        if (!id || typeof root.fetch !== 'function') return null;
        const base = (typeof root.getBackendBase === 'function' ? root.getBackendBase() : '').replace(/\/$/, '');
        const response = await root.fetch(`${base}/proposals/${encodeURIComponent(id)}/lineage`);
        if (!response.ok) throw new Error(`lineage ${response.status}`);
        return response.json();
    }

    // Navigation keeps the source namespace. A server row can only select an explicitly linked
    // local copy; a local link never falls through to a request for an equal-looking server row.
    async function open(reference) {
        const localProposalId = idOf(reference?.localProposalId);
        const proposalRowId = rowIdOf(reference?.proposalRowId);
        if (!!localProposalId === !!proposalRowId) return;
        try {
            let proposal;
            if (localProposalId) {
                proposal = root.proposalStorage?.getProposal(localProposalId);
                if (!proposal || idOf(proposal.proposalId) !== localProposalId) throw new Error('Local proposal not found');
            } else {
                proposal = root.proposalStorage?.getProposalByServerRowId(proposalRowId)
                    || await root.importServerProposal(proposalRowId);
                if (rowIdOf(proposal?.serverProposalId) !== proposalRowId) throw new Error('Published proposal row mismatch');
            }
            root.openProposalFromList(idOf(proposal.proposalId), { proposal, closeSheets: true, centerOnProposal: true });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ProposalLineage] could not open related proposal`, error);
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
        const target = entry.proposalRowId ? `data-lineage-row-id="${esc(entry.proposalRowId)}"`
            : `data-lineage-local-id="${esc(entry.localProposalId)}"`;
        return `<li><button type="button" class="cb-link proposal-lineage__link" ${target}>${esc(title)}</button>${notes ? ` <span class="proposal-lineage__note">${esc(notes)}</span>` : ''}</li>`;
    }

    // A resolved source has a row-qualified link. A missing source is only a lookup result in
    // this publication store; neither its past publication nor its existence elsewhere is known.
    function patchSourceRow(container, source) {
        const name = container && container.querySelector('.proposal-based-on-name, .proposal-based-on-link');
        if (!name || !source) return;
        const proposalRowId = source.resolution === 'resolved' ? rowIdOf(source.proposalRowId) : null;
        if (proposalRowId) {
            const link = root.document.createElement('button');
            link.type = 'button';
            link.className = 'cb-link proposal-based-on-link';
            link.textContent = source.title || name.textContent;
            link.setAttribute('data-lineage-row-id', proposalRowId);
            name.replaceWith(link);
        } else if (source.resolution === 'not-found' && !name.matches('.proposal-based-on-link')) {
            name.textContent = t('panel.proposal.lineage.sourceNotFound', '{{name}} (source not found in this publication store)',
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
                const control = event.target.closest('[data-lineage-row-id], [data-lineage-local-id]');
                if (!control) return;
                event.preventDefault();
                event.stopPropagation();
                open({ proposalRowId: control.getAttribute('data-lineage-row-id'), localProposalId: control.getAttribute('data-lineage-local-id') });
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
        const publishedRowId = rowIdOf(proposal.serverProposalId);
        if (!entries.length && !publishedRowId) { slot.hidden = true; return; }
        const unavailable = !!publishedRowId && !lineage;
        slot.hidden = false;
        const heading = entries.length
            ? t('panel.proposal.lineage.title', 'Counterproposals and forks ({{count}})', { count: entries.length })
            : (unavailable ? '' : t('panel.proposal.lineage.none', 'No related proposals found in this publication store or this browser.'));
        slot.innerHTML = `${heading ? `<p class="proposal-lineage__title">${esc(heading)}</p>` : ''}
            ${unavailable ? `<p class="proposal-lineage__note">${esc(t('panel.proposal.lineage.unavailable', 'Published proposal relationships could not be loaded.'))}</p>` : ''}
            ${entries.length ? `<ul class="proposal-lineage__list">${entries.map(entryHtml).join('')}</ul>` : ''}`;
    }

    // What saving an edit does, said on its button (editsInPlace above draws the line). A published
    // source gets a counterproposal that it lists; one's own local record is saved in place; an
    // explicit Fork of a local record is a new proposal beside it.
    function forkSubmitLabel(sourceId, options = {}) {
        const source = typeof root.getProposalByIdOrHash === 'function' && sourceId ? root.getProposalByIdOrHash(sourceId) : null;
        if (isPublished(source)) return t('proposalDrafts.actions.createCounterproposal', 'Create counterproposal');
        return editsInPlace(source, options)
            ? t('proposalDrafts.actions.saveChanges', 'Save changes')
            : t('proposalDrafts.actions.createProposal', 'Create proposal');
    }

    // The publication test is read as a global by the classic scripts (editor shell, sharing, copy).
    if (root && typeof root.document !== 'undefined') root.isPublishedProposalRecord = isPublished;

    return {
        SOURCE_KEYS, sourceIdsOf, publishedSourceIds, localDerived, mergeDerived,
        isPublished, editsInPlace, inPlaceRecord, mount, open, forkSubmitLabel
    };
});
