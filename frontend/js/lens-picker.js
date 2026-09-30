// Solana lens picker for the create dialog: choose lens members from the backend attester directory
// (GET /lenses/members) or paste any base58 key, see which selected parcels each member has attested,
// and keep the choice as the Solana lens that create.js snapshots into proposal.lens.
// Logic lives in lens-core.js / lens-service-client.js; this file is DOM wiring only.
(function () {
    const root = typeof window !== 'undefined' ? window : null;
    if (!root) return;

    const STORAGE_KEY = 'solanaLensEntries';
    let entries = [];
    let directory = { status: 'idle', members: [], error: null, promise: null };
    let coverageState = { key: '', coverage: null, loading: false };
    let onlyCovered = false;

    function t(key, fallback, params = {}) {
        const api = root.i18n;
        if (api && typeof api.t === 'function') {
            const value = api.t(key, params);
            if (value && value !== key) return value;
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }

    function escapeText(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // The Solana path is the one create.js mints on: a connected Solana wallet, Canton off.
    function isActive() {
        try {
            const state = root.solanaWalletManager && typeof root.solanaWalletManager.getState === 'function'
                ? root.solanaWalletManager.getState() : null;
            const connected = !!(state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length);
            const canton = !!(root.CantonMode && typeof root.CantonMode.isActive === 'function' && root.CantonMode.isActive());
            return connected && !canton;
        } catch (_) {
            return false;
        }
    }

    function readStored() {
        try {
            const raw = root.PersistentStorage && root.PersistentStorage.getItem ? root.PersistentStorage.getItem(STORAGE_KEY) : null;
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [LensPicker] stored Solana lens unreadable`, error);
            return [];
        }
    }

    function setEntries(next) {
        const check = root.LensCore.validateSolanaLens(next);
        const names = new Map((next || []).map(entry => [entry && entry.address, entry && entry.name]));
        entries = check.keys.map(address => ({ address, name: names.get(address) || '' }));
        try {
            if (root.PersistentStorage && root.PersistentStorage.setItem) root.PersistentStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [LensPicker] could not store Solana lens`, error);
        }
        if (typeof root.refreshLensPatternPreviews === 'function') root.refreshLensPatternPreviews();
    }

    function getEntries() {
        return entries.map(entry => ({ ...entry }));
    }

    function backendBase() {
        if (typeof root.getBackendBase !== 'function') throw new Error('getBackendBase() is not loaded');
        return String(root.getBackendBase()).replace(/\/+$/, '');
    }

    function loadDirectory(force = false) {
        if (directory.promise && !force) return directory.promise;
        directory = { status: 'loading', members: [], error: null, promise: null };
        directory.promise = root.LensServiceClient.fetchDirectory({ base: backendBase() }).then(result => {
            if (result.outcome.kind === 'ok') {
                directory.status = 'ready';
                directory.members = result.members;
            } else {
                directory.status = 'error';
                directory.error = result.outcome.message || `HTTP ${result.status}`;
                console.warn(`[${new Date().toISOString()}] [LensPicker] GET /lenses/members failed: ${directory.error}`);
            }
            return directory;
        });
        return directory.promise;
    }

    // Cadastral ids of the parcels selected for the proposal being authored.
    function selectedParcelIds() {
        try {
            if (typeof getCurrentParcelSelectionContext !== 'function' || !root.LiveParcelFabric) return [];
            const ids = getCurrentParcelSelectionContext().ids || [];
            if (!ids.length || typeof root.LiveParcelFabric.cadastreIdsForParcelIds !== 'function') return [];
            return Array.from(new Set(root.LiveParcelFabric.cadastreIdsForParcelIds(ids)));
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [LensPicker] could not resolve selected parcels`, error);
            return [];
        }
    }

    async function loadCoverage(members, parcelIds, rerender) {
        const withService = members.filter(member => member.serviceUrl);
        const key = `${withService.map(m => m.key).join(',')}|${parcelIds.join(',')}`;
        if (!withService.length || !parcelIds.length) {
            coverageState = { key, coverage: null, loading: false };
            return;
        }
        if (coverageState.key === key && (coverageState.coverage || coverageState.loading)) return;
        coverageState = { key, coverage: null, loading: true };
        rerender();
        const coverage = await root.LensServiceClient.collectParcelCoverage({ members: withService, parcelIds });
        if (coverageState.key !== key) return;
        coverageState = { key, coverage, loading: false };
        rerender();
    }

    function memberCoverageLine(member, coverage, parcelCount) {
        const counts = t('modal.lens.picker.coverageCounts', '{{ownership}} ownership attestations · {{parcels}} parcels · {{executed}} executed', member.coverage);
        if (!parcelCount) return counts;
        if (!member.serviceUrl) return `${counts} · ${t('modal.lens.picker.noServiceUrl', 'No service URL: coverage of the selected parcels is unknown')}`;
        const stats = coverage && coverage.byMember[member.key];
        if (!stats) return `${counts} · ${t('modal.lens.picker.coverageLoading', 'Checking the selected parcels…')}`;
        if (!stats.checked) return `${counts} · ${t('modal.lens.picker.coverageUnavailable', 'Service did not answer; coverage unknown')}`;
        return `${counts} · ${t('modal.lens.picker.coverageSelected', 'Attests {{covered}} of {{total}} selected parcels', { covered: stats.covered, total: parcelCount })}`;
    }

    function renderBody(container) {
        const core = root.LensCore;
        const parcelIds = selectedParcelIds();
        const chosen = new Set(entries.map(entry => entry.address));
        const coverage = coverageState.coverage;
        const members = core.sortMembersByCoverage(directory.members, coverage);
        const memberKeys = new Set(members.map(member => member.key));
        const pasted = entries.filter(entry => !memberKeys.has(entry.address));

        let directoryHtml;
        if (directory.status === 'loading' || directory.status === 'idle') {
            directoryHtml = `<p class="lens-picker-note">${escapeText(t('modal.lens.picker.loading', 'Loading lens members…'))}</p>`;
        } else if (directory.status === 'error') {
            directoryHtml = `<p class="lens-picker-error">${escapeText(t('modal.lens.picker.loadFailed', 'Could not load the lens member directory: {{error}}', { error: directory.error }))}</p>`;
        } else if (!members.length) {
            directoryHtml = `<p class="lens-picker-note">${escapeText(t('modal.lens.picker.emptyDirectory', 'No lens members are known yet. Paste a member key below.'))}</p>`;
        } else {
            directoryHtml = `<ul class="lens-picker-members">${members.map(member => `
                <li class="lens-picker-member">
                    <label>
                        <input type="checkbox" data-lens-member="${escapeText(member.key)}" ${chosen.has(member.key) ? 'checked' : ''} />
                        <span class="lens-picker-member-text">
                            <span class="lens-picker-member-name">${escapeText(member.name || core.shortKey(member.key))}</span>
                            ${member.kind ? `<span class="lens-picker-kind">${escapeText(member.kind)}</span>` : ''}
                            ${member.description ? `<span class="lens-picker-desc">${escapeText(member.description)}</span>` : ''}
                            <span class="lens-picker-key">${escapeText(member.key)}</span>
                            <span class="lens-picker-coverage">${escapeText(memberCoverageLine(member, coverage, parcelIds.length))}</span>
                        </span>
                    </label>
                </li>`).join('')}</ul>`;
        }

        const pastedHtml = pasted.length ? `<ul class="lens-picker-pasted">${pasted.map(entry => `
            <li><span class="lens-picker-key">${escapeText(entry.address)}</span>
                <button type="button" class="lens-remove-btn" data-lens-remove="${escapeText(entry.address)}" title="${escapeText(t('modal.lens.removeAddress', 'Remove address'))}">×</button></li>`).join('')}</ul>` : '';

        let parcelsHtml = '';
        if (parcelIds.length) {
            const chosenKeys = entries.map(entry => entry.address);
            const shown = core.filterParcelsByLens(parcelIds, coverage, chosenKeys, onlyCovered);
            const rows = shown.map(parcelUid => {
                const slot = coverage && coverage.byParcel[parcelUid];
                const coveredBy = slot ? slot.covered.filter(key => chosen.has(key)) : [];
                const label = !coverage
                    ? t('modal.lens.picker.parcelUnknown', 'coverage unknown')
                    : coveredBy.length
                        ? t('modal.lens.picker.parcelCoveredBy', 'attested by {{members}}', { members: coveredBy.map(key => core.memberLabel(key, members)).join(', ') })
                        : t('modal.lens.picker.parcelNotCovered', 'no ownership attestation from your lens');
                return `<li class="${coveredBy.length ? 'is-covered' : ''}"><span>${escapeText(parcelUid)}</span><small>${escapeText(label)}</small></li>`;
            }).join('');
            parcelsHtml = `
                <section class="lens-picker-parcels">
                    <h3>${escapeText(t('modal.lens.picker.parcelsTitle', 'Selected parcels'))}</h3>
                    ${coverageState.loading ? `<p class="lens-picker-note">${escapeText(t('modal.lens.picker.coverageLoading', 'Checking the selected parcels…'))}</p>` : ''}
                    ${coverage && coverage.available ? `<label class="lens-picker-filter"><input type="checkbox" data-lens-only-covered ${onlyCovered ? 'checked' : ''} /> ${escapeText(t('modal.lens.picker.onlyCovered', 'Only parcels covered by my lens'))}</label>` : ''}
                    ${!coverage && !coverageState.loading ? `<p class="lens-picker-note">${escapeText(t('modal.lens.picker.noParcelCoverage', 'No lens member publishes a service URL, so per-parcel coverage cannot be shown; the counts above are directory totals.'))}</p>` : ''}
                    <ul>${rows || `<li><small>${escapeText(t('modal.lens.picker.noCoveredParcels', 'None of the selected parcels is covered by your lens.'))}</small></li>`}</ul>
                </section>`;
        }

        container.innerHTML = `
            ${directoryHtml}
            <div class="lens-picker-paste">
                <label for="lens-picker-paste-input">${escapeText(t('modal.lens.picker.pasteLabel', 'Paste a key'))}</label>
                <div class="lens-picker-paste-row">
                    <input id="lens-picker-paste-input" class="lens-input" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeText(t('modal.lens.picker.pastePlaceholder', 'Base58 public key'))}" />
                    <button type="button" class="lens-add-btn" data-lens-paste-add>${escapeText(t('modal.lens.picker.pasteAdd', 'Add'))}</button>
                </div>
                <p class="lens-picker-error" data-lens-paste-error hidden></p>
                ${pastedHtml}
            </div>
            ${parcelsHtml}
            <p class="${entries.length ? 'lens-picker-note' : 'lens-picker-error'}" data-lens-summary>${escapeText(entries.length
                ? t('modal.lens.picker.chosenCount', '{{count}} lens member(s) chosen', { count: entries.length })
                : t('modal.lens.picker.required', 'Choose at least one lens member; a Solana proposal cannot be minted without one.'))}</p>`;
    }

    function wire(container, rerender) {
        container.querySelectorAll('[data-lens-member]').forEach(input => {
            input.addEventListener('change', () => {
                const key = input.getAttribute('data-lens-member');
                const member = directory.members.find(entry => entry.key === key);
                const next = getEntries().filter(entry => entry.address !== key);
                if (input.checked) next.push({ address: key, name: (member && member.name) || '' });
                setEntries(next);
                rerender();
            });
        });
        container.querySelectorAll('[data-lens-remove]').forEach(button => {
            button.addEventListener('click', () => {
                const key = button.getAttribute('data-lens-remove');
                setEntries(getEntries().filter(entry => entry.address !== key));
                rerender();
            });
        });
        const onlyToggle = container.querySelector('[data-lens-only-covered]');
        if (onlyToggle) onlyToggle.addEventListener('change', () => { onlyCovered = onlyToggle.checked; rerender(); });
        const input = container.querySelector('#lens-picker-paste-input');
        const addButton = container.querySelector('[data-lens-paste-add]');
        const errorNode = container.querySelector('[data-lens-paste-error]');
        const add = () => {
            const { keys, invalid } = root.LensCore.parsePastedKeys(input.value);
            if (invalid.length || !keys.length) {
                errorNode.hidden = false;
                errorNode.textContent = t('modal.lens.picker.pasteInvalid', 'Not a Solana public key: {{value}}', { value: invalid.join(', ') || input.value });
                return;
            }
            const next = getEntries();
            keys.forEach(key => { if (!next.some(entry => entry.address === key)) next.push({ address: key, name: '' }); });
            setEntries(next);
            rerender();
        };
        addButton.addEventListener('click', add);
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    }

    function show() {
        if (typeof root.closeLensModal === 'function') root.closeLensModal();
        const overlay = document.createElement('div');
        overlay.className = 'lens-modal-overlay';
        overlay.innerHTML = `
            <div class="lens-modal lens-picker" role="dialog" aria-modal="true" aria-labelledby="lens-picker-title">
                <div class="lens-modal-header">
                    <div class="lens-modal-title-group">
                        <h2 class="lens-modal-title" id="lens-picker-title">${escapeText(t('modal.lens.picker.title', 'Lens for this proposal'))}</h2>
                        <p class="lens-modal-subtitle">${escapeText(t('modal.lens.picker.subtitle', 'Pick the lens members whose ownership attestations this proposal will accept. The lens is fixed at mint.'))}</p>
                    </div>
                    <button type="button" class="lens-close-btn close-circle-btn close-circle-btn--lg" aria-label="${escapeText(t('modal.lens.closeLabel', 'Close lens modal'))}">&times;</button>
                </div>
                <div class="lens-modal-body" data-lens-picker-body></div>
                <div class="lens-modal-footer">
                    <button type="button" class="btn btn-proposal lens-close-footer-btn" data-lens-picker-done>${escapeText(t('modal.lens.picker.done', 'Done'))}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const body = overlay.querySelector('[data-lens-picker-body]');
        const close = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
        overlay.querySelector('.lens-close-btn').addEventListener('click', close);
        overlay.querySelector('[data-lens-picker-done]').addEventListener('click', close);
        overlay.addEventListener('click', event => { if (event.target === overlay) close(); });

        const rerender = () => {
            if (!overlay.parentNode) return;
            renderBody(body);
            wire(body, rerender);
        };
        rerender();
        loadDirectory().then(() => {
            rerender();
            return loadCoverage(directory.members, selectedParcelIds(), rerender);
        }).catch(error => {
            console.error(`[${new Date().toISOString()}] [LensPicker] failed`, error);
            directory.status = 'error';
            directory.error = error && error.message ? error.message : String(error);
            rerender();
        });
    }

    function hydrate() {
        const stored = readStored();
        entries = root.LensCore.validateSolanaLens(stored).keys.map(address => {
            const match = stored.find(entry => entry && entry.address === address);
            return { address, name: (match && match.name) || '' };
        });
        if (typeof root.refreshLensPatternPreviews === 'function') root.refreshLensPatternPreviews();
    }

    if (root.PersistentStorage && root.PersistentStorage.ready && typeof root.PersistentStorage.ready.then === 'function') {
        root.PersistentStorage.ready.then(hydrate);
    } else {
        hydrate();
    }

    root.LensPicker = { isActive, getEntries, setEntries, show, loadDirectory };
})();
