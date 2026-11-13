// Lens picker (the Lens settings on the Solana path, and the agreement dialog's lens on either chain):
// choose lens members from the backend attester directory (GET /lenses/members) or paste a key, see
// which selected parcels each member has attested, and keep the choice as the app's lens of that chain;
// a community agreement's mint names its first member (agreement-panel.js, M3). `family` ('solana' by
// default, or 'evm') is the chain the lens is for: only members with an address there are offered, and
// the lens holds those addresses, never another chain's.
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

    // The Solana path: a connected Solana wallet (an agreement minted from it names the lens, M3).
    function isActive() {
        try {
            const state = root.solanaWalletManager && typeof root.solanaWalletManager.getState === 'function'
                ? root.solanaWalletManager.getState() : null;
            return !!(state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length);
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

    // The chain's name in the picker's sentences.
    const chainName = family => (family === 'evm' ? 'EVM' : 'Solana');

    // Entries ({ address, name }) whose address is on `family`, each address once.
    function onFamily(list, family) {
        const core = root.LensCore;
        const kept = [];
        (Array.isArray(list) ? list : []).forEach(entry => {
            const address = typeof entry === 'string' ? entry.trim() : String((entry && entry.address) || '').trim();
            if (core.keyFamily(address) !== family || kept.some(item => core.sameAddress(item.address, address))) return;
            kept.push({ address, name: (entry && typeof entry === 'object' && entry.name) || '' });
        });
        return kept;
    }

    function renderBody(container, entries, family = 'solana') {
        const core = root.LensCore;
        const parcelIds = selectedParcelIds();
        const chosen = entries.map(entry => entry.address);
        const isChosen = address => chosen.some(item => core.sameAddress(item, address));
        const coverage = coverageState.coverage;
        // Only the members with an address on this chain; the lens holds that address.
        const members = core.sortMembersByCoverage(directory.members, coverage).filter(member => core.memberAddress(member, family));
        const addressOf = member => core.memberAddress(member, family);
        const pasted = entries.filter(entry => !members.some(member => core.sameAddress(addressOf(member), entry.address)));
        // Coverage is counted per member identity (its key), whichever address the lens names.
        const chosenKeys = new Set(members.filter(member => isChosen(addressOf(member))).map(member => member.key));

        let directoryHtml;
        if (directory.status === 'loading' || directory.status === 'idle') {
            directoryHtml = `<p class="lens-picker-note">${escapeText(t('modal.lens.picker.loading', 'Loading lens members…'))}</p>`;
        } else if (directory.status === 'error') {
            directoryHtml = `<p class="lens-picker-error">${escapeText(t('modal.lens.picker.loadFailed', 'Could not load the lens member directory: {{error}}', { error: directory.error }))}</p>`;
        } else if (!directory.members.length) {
            directoryHtml = `<p class="lens-picker-note">${escapeText(t('modal.lens.picker.emptyDirectory', 'No lens members are known yet. Paste a member key below.'))}</p>`;
        } else if (!members.length) {
            directoryHtml = `<p class="lens-picker-error" data-lens-none-on-chain>${escapeText(t('modal.lens.picker.noneOnChain', 'No lens member publishes an address on {{chain}}, so this lens cannot name one there.', { chain: chainName(family) }))}</p>`;
        } else {
            directoryHtml = `<ul class="lens-picker-members">${members.map(member => `
                <li class="lens-picker-member">
                    <label>
                        <input type="checkbox" data-lens-member="${escapeText(addressOf(member))}" ${isChosen(addressOf(member)) ? 'checked' : ''} />
                        <span class="lens-picker-member-text">
                            <span class="lens-picker-member-name">${escapeText(member.name || core.shortKey(addressOf(member)))}</span>
                            ${member.kind ? `<span class="cb-badge lens-picker-kind">${escapeText(member.kind)}</span>` : ''}
                            ${member.description ? `<span class="lens-picker-desc">${escapeText(member.description)}</span>` : ''}
                            <span class="lens-picker-key">${escapeText(addressOf(member))}</span>
                            <span class="lens-picker-coverage">${escapeText(memberCoverageLine(member, coverage, parcelIds.length))}</span>
                        </span>
                    </label>
                </li>`).join('')}</ul>`;
        }

        const removeLabel = escapeText(t('modal.lens.removeAddress', 'Remove address'));
        const pastedHtml = pasted.length ? `<ul class="lens-picker-pasted">${pasted.map(entry => `
            <li><span class="lens-picker-key">${escapeText(entry.address)}</span>
                <button type="button" class="btn btn-quiet btn-sm btn-icon lens-remove-btn" data-lens-remove="${escapeText(entry.address)}" title="${removeLabel}" aria-label="${removeLabel}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></li>`).join('')}</ul>` : '';

        let parcelsHtml = '';
        if (parcelIds.length) {
            const shown = core.filterParcelsByLens(parcelIds, coverage, [...chosenKeys], onlyCovered);
            const rows = shown.map(parcelUid => {
                const slot = coverage && coverage.byParcel[parcelUid];
                const coveredBy = slot ? slot.covered.filter(key => chosenKeys.has(key)) : [];
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
                    <input id="lens-picker-paste-input" class="lens-input" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeText(family === 'evm' ? t('modal.lens.picker.pastePlaceholderEvm', '0x address') : t('modal.lens.picker.pastePlaceholder', 'Base58 public key'))}" />
                    <button type="button" class="btn lens-add-btn" data-lens-paste-add>${escapeText(t('modal.lens.picker.pasteAdd', 'Add'))}</button>
                </div>
                <p class="lens-picker-error" data-lens-paste-error hidden></p>
                ${pastedHtml}
            </div>
            ${parcelsHtml}
            <p class="${entries.length ? 'lens-picker-note' : 'lens-picker-error'}" data-lens-summary>${escapeText(entries.length
                ? t('modal.lens.picker.chosenCount', '{{count}} lens member(s) chosen', { count: entries.length })
                : family === 'evm'
                    ? t('modal.lens.picker.requiredEvm', 'Choose at least one lens member with an EVM address.')
                    : t('modal.lens.picker.required', 'Choose at least one lens member; a Solana design cannot be published without one.'))}</p>`;
    }

    function wire(container, rerender, { getEntries, setEntries }, family = 'solana') {
        const core = root.LensCore;
        container.querySelectorAll('[data-lens-member]').forEach(input => {
            input.addEventListener('change', () => {
                const key = input.getAttribute('data-lens-member');
                const member = core.findMember(directory.members, key);
                const next = getEntries().filter(entry => !core.sameAddress(entry.address, key));
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
            const { keys, invalid } = core.parsePastedKeys(input.value, family);
            if (invalid.length || !keys.length) {
                errorNode.hidden = false;
                const value = invalid.join(', ') || input.value;
                errorNode.textContent = family === 'evm'
                    ? t('modal.lens.picker.pasteInvalidEvm', 'Not an EVM address: {{value}}', { value })
                    : t('modal.lens.picker.pasteInvalid', 'Not a Solana public key: {{value}}', { value });
                return;
            }
            const next = getEntries();
            keys.forEach(key => { if (!next.some(entry => core.sameAddress(entry.address, key))) next.push({ address: key, name: '' }); });
            setEntries(next);
            rerender();
        };
        addButton.addEventListener('click', add);
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    }

    // The picker is the shared dialog (js/ui/dialogs.js) on the dialog-over-dialog rung: it opens
    // from the create dialog. `lens-modal-overlay`, `lens-close-btn` and `data-lens-picker-done`
    // stay as hooks for scripts and tests.
    let pickerDialog = null;

    // options: entries (the lens to edit; the stored Solana lens by default), family ('solana' or
    // 'evm', the chain the lens is for), parent, onChange(entries), onClose(entries). The choice also
    // becomes that chain's default lens: the Solana one here, the EVM one in lens.js.
    function show(options = {}) {
        if (typeof root.closeLensModal === 'function') root.closeLensModal();
        if (pickerDialog) pickerDialog.close();
        const family = options.family === 'evm' ? 'evm' : 'solana';
        const initial = Array.isArray(options.entries) ? options.entries : getEntries();
        let workingEntries = onFamily(initial, family);
        const selection = { getEntries: () => workingEntries.map(entry => ({ ...entry })), setEntries: next => {
            workingEntries = onFamily(next, family);
            if (family === 'solana') setEntries(workingEntries);
            else root.setEvmLensEntries(workingEntries);
            options.onChange?.(selection.getEntries());
        } };
        const subtitle = document.createElement('p');
        subtitle.className = 'lens-modal-subtitle';
        subtitle.textContent = t('modal.lens.picker.subtitle', 'Choose the trusted members of your lens. Changes become your default; saved agreements keep their own lens.');
        const body = document.createElement('div');
        body.className = 'lens-picker-body';
        body.setAttribute('data-lens-picker-body', '');
        const dialogApi = root.CbDialog.open({
            title: t('modal.lens.title', 'The lens through which I see the world'),
            parent: options.parent,
            size: 'lg',
            top: true,
            className: 'lens-modal lens-picker',
            // The directory loads after the box opens: it keeps its size, the list scrolls.
            fixedHeight: true,
            overlayClassName: 'lens-modal-overlay',
            bodyClassName: 'lens-modal-body',
            closeLabel: t('modal.lens.closeLabel', 'Close lens modal'),
            body: [subtitle, body],
            actions: [{ id: 'done', label: t('modal.lens.picker.done', 'Done'), role: 'primary' }],
            onClose: () => { if (pickerDialog === dialogApi) pickerDialog = null; options.onClose?.(selection.getEntries()); }
        });
        if (!dialogApi) return;
        pickerDialog = dialogApi;
        const overlay = dialogApi.overlay;
        const closeButton = dialogApi.header && dialogApi.header.querySelector('.close-circle-btn');
        if (closeButton) closeButton.classList.add('lens-close-btn');
        const done = dialogApi.getActionButton('done');
        if (done) done.setAttribute('data-lens-picker-done', '');

        const rerender = () => {
            if (!overlay.isConnected) return;
            renderBody(body, selection.getEntries(), family);
            wire(body, rerender, selection, family);
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
        return dialogApi;
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
