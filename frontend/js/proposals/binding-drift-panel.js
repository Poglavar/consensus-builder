// Details-panel glue for binding drift (PARCEL-OPTIONAL.md rule 5): for a published record, ask the
// server once (lazily, after the panel has rendered, cached per record) whether today's cadastre
// binds its site differently, and if so show a notice with a Re-bind action. Re-bind publishes a NEW
// record derived from this one (binding-drift.js deriveReboundRecord) through the ordinary publish
// path; the published record is never edited. Pure logic lives in binding-drift.js.
(function attachBindingDriftPanel(global) {
    'use strict';

    // serverId → { promise, response } for this page session. A failed check is cached as null so
    // re-rendering the panel never hammers the API; a reload asks again.
    const cache = new Map();
    const MAX_LISTED_IDS = 6;

    function api() {
        return global.__bindingDrift || null;
    }

    function text(key, fallback, params = {}) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const value = global.i18n.t(key, params);
                if (value && value !== key) return value;
            }
        } catch (_) { }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    }

    function escape(value) {
        return typeof global.escapeHtml === 'function'
            ? global.escapeHtml(String(value))
            : String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function serverIdOf(proposal) {
        return typeof global.getSerialProposalId === 'function' ? global.getSerialProposalId(proposal) : null;
    }

    function backendBase() {
        return typeof global.resolveBackendBaseUrl === 'function' ? global.resolveBackendBaseUrl() : '';
    }

    function fetchDrift(serverId) {
        const cached = cache.get(serverId);
        if (cached) return cached.promise;
        const entry = { response: undefined, promise: null };
        entry.promise = fetch(`${backendBase()}/proposals/${encodeURIComponent(serverId)}/binding-drift`)
            .then(async response => {
                const body = await response.json().catch(() => null);
                if (!response.ok) throw new Error((body && body.error) || `binding-drift answered ${response.status}`);
                return body;
            })
            .then(body => { entry.response = body; return body; })
            .catch(error => {
                console.warn(`[${new Date().toISOString()}] [binding-drift] check failed for ${serverId}`, error);
                entry.response = null;
                return null;
            });
        cache.set(serverId, entry);
        return entry.promise;
    }

    function localRecords() {
        try { return global.proposalStorage?.getAllProposals?.() || []; } catch (_) { return []; }
    }

    function idList(ids) {
        const shown = ids.slice(0, MAX_LISTED_IDS).map(escape).join(', ');
        return ids.length > MAX_LISTED_IDS ? `${shown}, … (+${ids.length - MAX_LISTED_IDS})` : shown;
    }

    function countText(count, sign) {
        if (sign === '+') {
            return count === 1
                ? text('panel.proposal.bindingDrift.addedOne', '+1 parcel')
                : text('panel.proposal.bindingDrift.addedMany', '+{{count}} parcels', { count });
        }
        return text('panel.proposal.bindingDrift.removed', '−{{count}}', { count });
    }

    function coverageWord(value) {
        return text(`panel.proposal.bindingDrift.coverageKinds.${value || 'unknown'}`, value || 'unknown');
    }

    function noticeHtml(notice) {
        const summary = `${countText(notice.addedCount, '+')}, ${countText(notice.removedCount, '−')}`;
        const lines = [];
        if (notice.addedIds.length) {
            lines.push(`<li>${escape(text('panel.proposal.bindingDrift.addedList', 'Now also reaches: {{list}}', { list: '\u0000' })).replace('\u0000', idList(notice.addedIds))}</li>`);
        }
        if (notice.removedIds.length) {
            lines.push(`<li>${escape(text('panel.proposal.bindingDrift.removedList', 'No longer reaches: {{list}}', { list: '\u0000' })).replace('\u0000', idList(notice.removedIds))}</li>`);
        }
        if (notice.coverageChanged) {
            lines.push(`<li>${escape(text('panel.proposal.bindingDrift.coverage', 'Coverage: {{from}} → {{to}}',
                { from: coverageWord(notice.coverageFrom), to: coverageWord(notice.coverageTo) }))}</li>`);
        }
        let action = '';
        if (notice.reboundAs) {
            const target = notice.reboundAs.proposalId || notice.reboundAs.serverProposalId;
            const label = notice.reboundAs.title || target;
            action = `<p class="proposal-binding-drift-note">${escape(text('panel.proposal.bindingDrift.reboundAs', 'Re-bound as'))}
                <button type="button" class="proposal-binding-drift-link" data-binding-drift-open="${escape(target)}">${escape(label)}</button></p>`;
        } else if (notice.canRebind) {
            action = `<p class="proposal-binding-drift-note">${escape(text('panel.proposal.bindingDrift.note',
                'Re-binding publishes a new record with the current parcels. This one stays as it was published.'))}</p>
                <button type="button" class="btn btn-outline-primary proposal-binding-drift-rebind" data-binding-drift-rebind>
                    <i class="fas fa-link" aria-hidden="true"></i> ${escape(text('panel.proposal.bindingDrift.rebind', 'Re-bind'))}
                </button>`;
        }
        return `
            <div class="proposal-binding-drift-title"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                ${escape(text('panel.proposal.bindingDrift.title', 'The cadastre changed since this was published: {{summary}}', { summary }))}</div>
            ${lines.length ? `<ul class="proposal-binding-drift-list">${lines.join('')}</ul>` : ''}
            ${action}`;
    }

    function render(container, proposal, serverId, response) {
        if (!container || !container.isConnected || container.dataset.bindingDriftFor !== serverId) return;
        container.querySelectorAll('.proposal-binding-drift').forEach(node => node.remove());
        const reboundAs = api().findRebound(localRecords(), { serverId, proposalId: proposal.proposalId });
        const notice = api().driftNotice(response, { reboundAs });
        if (!notice) return;
        const box = global.document.createElement('div');
        box.className = 'proposal-binding-drift';
        box.setAttribute('role', 'status');
        box.innerHTML = noticeHtml(notice);
        const rebindButton = box.querySelector('[data-binding-drift-rebind]');
        rebindButton?.addEventListener('click', () => {
            rebindButton.disabled = true;
            rebind(proposal.proposalId || serverId).finally(() => { rebindButton.disabled = false; });
        });
        box.querySelector('[data-binding-drift-open]')?.addEventListener('click', event => {
            const target = event.currentTarget.dataset.bindingDriftOpen;
            if (target && typeof global.focusProposalDetails === 'function') {
                global.focusProposalDetails(target, { centerOnProposal: true, showDetails: true });
            }
        });
        container.prepend(box);
    }

    // Called after the details panel rendered `proposal` into `container`. Never blocks: a cached
    // answer renders at once, otherwise the request runs in the background.
    function mount(container, proposal) {
        if (!container || !proposal || !api()) return;
        const serverId = serverIdOf(proposal);
        container.dataset.bindingDriftFor = serverId || '';
        if (!serverId) return;
        const cached = cache.get(serverId);
        if (cached && cached.response !== undefined) {
            render(container, proposal, serverId, cached.response);
            return;
        }
        fetchDrift(serverId).then(response => render(container, proposal, serverId, response));
    }

    async function rebind(proposalKey) {
        const source = typeof global.getProposalByIdOrHash === 'function' ? global.getProposalByIdOrHash(proposalKey) : null;
        const serverId = serverIdOf(source);
        const response = serverId ? cache.get(serverId)?.response : null;
        const alertText = message => (typeof global.showStyledAlert === 'function' ? global.showStyledAlert(message) : global.alert?.(message));
        if (!source || !response || !response.current) {
            alertText(text('panel.proposal.bindingDrift.unavailable', 'The current binding of this record is not available. Reopen it and try again.'));
            return null;
        }
        const question = text('panel.proposal.bindingDrift.confirm',
            'Publish a new record with the same site and design and the current parcels? The record you are viewing is not changed.');
        const ok = typeof global.showStyledConfirm === 'function'
            ? await global.showStyledConfirm(question, {
                okText: text('panel.proposal.bindingDrift.rebind', 'Re-bind'),
                cancelText: text('panel.proposal.bindingDrift.cancel', 'Cancel')
            })
            : global.confirm?.(question);
        if (!ok) return null;

        let derived;
        try {
            derived = api().deriveReboundRecord(source, response, { sourceServerId: serverId });
        } catch (error) {
            alertText(error.message || String(error));
            return null;
        }
        const newId = global.proposalStorage.addProposal(derived);
        const stored = newId ? global.proposalStorage.getProposal(newId) : null;
        if (!stored) {
            alertText(text('panel.proposal.bindingDrift.failed', 'Re-binding failed: {{reason}}', { reason: 'not stored' }));
            return null;
        }
        console.log(`[${new Date().toISOString()}] [binding-drift] re-binding ${serverId} as ${newId}: +${derived.rebind.added.length} −${derived.rebind.removed.length}`);
        const result = await global.uploadProposalToServer(stored);
        const publishedId = result && result.ok ? String(result.proposalId || result.id || '') : '';
        if (!publishedId || publishedId === serverId) {
            // Not published (or deduplicated onto the source): the derived record is not kept.
            global.proposalStorage.removeProposal(newId);
            if (!(result && result.cancelled)) {
                alertText(text('panel.proposal.bindingDrift.failed', 'Re-binding failed: {{reason}}',
                    { reason: (result && result.message) || 'the server returned the source record' }));
            }
            return null;
        }
        console.log(`[${new Date().toISOString()}] [binding-drift] re-bound ${serverId} → published ${publishedId}`);
        if (typeof global.showEphemeralMessage === 'function') {
            global.showEphemeralMessage(text('panel.proposal.bindingDrift.done', 'Re-bound: published as record {{id}}.', { id: publishedId }), 5000);
        }
        if (typeof global.focusProposalDetails === 'function') {
            global.focusProposalDetails(newId, { centerOnProposal: true, showDetails: true });
        }
        return newId;
    }

    global.__bindingDriftPanel = { mount, rebind, _cache: cache };
})(typeof window !== 'undefined' ? window : globalThis);
