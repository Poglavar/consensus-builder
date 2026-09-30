// DOM wiring for lens.html, the lens member console: pick or type a member service URL, read its
// status and issued attestations, connect the member wallet, and post operator verdicts. The
// operator token is read from its input per request and never stored. Logic: lens-core.js.
(function () {
    const root = typeof window !== 'undefined' ? window : null;
    if (!root || !root.document) return;
    const doc = root.document;
    const SERVICE_URL_KEY = 'lensConsoleServiceUrl';
    const core = root.LensCore;
    const client = root.LensServiceClient;
    const state = { serviceUrl: null, status: null, directory: [], wallet: null };

    function t(key, fallback, params = {}) {
        const api = root.i18n;
        if (api && typeof api.t === 'function') {
            const value = api.t(key, params);
            if (value && value !== key) return value;
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
    }

    function el(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function line(label, value, mono = false) {
        const row = el('div', 'lc-kv');
        row.append(el('span', 'lc-k', label), el(mono ? 'code' : 'span', 'lc-v', value));
        return row;
    }

    function explorerLink(address) {
        const cluster = root.solanaWalletManager ? root.solanaWalletManager.getCluster() : 'devnet';
        const link = el('a', 'lc-mono', address);
        link.href = `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=${encodeURIComponent(cluster)}`;
        link.target = '_blank';
        link.rel = 'noopener';
        return link;
    }

    function outcomeMessage(outcome) {
        if (outcome.kind === 'error' && outcome.status === 0) {
            return t('lensConsole.errors.network', 'Could not reach the service ({{message}}). Is it running, and does it allow this origin (CORS)?', { message: outcome.message });
        }
        return t('lensConsole.errors.http', 'The service answered {{status}}: {{message}}', { status: outcome.status, message: outcome.message || outcome.code || '' });
    }

    function showError(target, message) {
        target.replaceChildren(el('p', 'lc-error', message));
    }

    function readStoredServiceUrl() {
        try { return root.localStorage.getItem(SERVICE_URL_KEY); } catch (_) { return null; }
    }

    function storeServiceUrl(url) {
        try { root.localStorage.setItem(SERVICE_URL_KEY, url); } catch (_) { /* per-viewer convenience only */ }
    }

    function renderWallet() {
        const target = doc.getElementById('lc-wallet');
        target.replaceChildren();
        if (!state.wallet) {
            target.append(el('p', 'lc-muted', t('lensConsole.wallet.disconnected', 'No wallet connected.')));
            return;
        }
        target.append(line(t('lensConsole.wallet.address', 'Wallet'), state.wallet, true));
        if (state.status && state.status.key) {
            const same = state.status.key === state.wallet;
            target.append(el('p', same ? 'lc-ok' : 'lc-warn', same
                ? t('lensConsole.wallet.matches', 'This wallet is the member key of the loaded service.')
                : t('lensConsole.wallet.differs', 'This wallet is not the member key of the loaded service ({{key}}).', { key: core.shortKey(state.status.key) })));
        }
    }

    function renderStatus() {
        const target = doc.getElementById('lc-status');
        const status = state.status;
        // Without a loaded status the node holds loading/error text; a language change must not wipe it.
        if (!status) return;
        target.replaceChildren();
        const price = core.describeOwnershipPrice(status);
        const counts = status.counts && typeof status.counts === 'object' ? status.counts : {};
        const keyRow = line(t('lensConsole.status.key', 'Member key'), '');
        keyRow.lastChild.replaceWith(explorerLink(status.key));
        target.append(
            keyRow,
            line(t('lensConsole.status.kind', 'Kind'), status.kind || '—'),
            line(t('lensConsole.status.identity', 'Identity check'), status.identity || '—'),
            line(t('lensConsole.status.credential', 'Credential'), status.credential || '—', true),
            line(t('lensConsole.status.counts', 'Issued'), Object.entries(counts).map(([kind, n]) => `${kind}: ${n}`).join(' · ') || '0'),
            line(t('lensConsole.status.price', 'Ownership price'), price || t('lensConsole.status.free', 'not priced (free or not configured)'))
        );
        if (status.dryRun) target.append(el('p', 'lc-warn', t('lensConsole.status.dryRun', 'Dry run: attestations are built in memory and never reach the chain.')));
        if (status.ephemeralKey) target.append(el('p', 'lc-warn', t('lensConsole.status.ephemeral', 'Ephemeral key: this member has no persistent identity; restart it with a keypair to be listed in a lens.')));
    }

    function renderAttestations(list) {
        const target = doc.getElementById('lc-attestations');
        target.replaceChildren();
        if (!list.length) {
            target.append(el('p', 'lc-muted', t('lensConsole.attestations.empty', 'No attestations match.')));
            return;
        }
        const ul = el('ul', 'lc-list');
        list.forEach(att => {
            const li = el('li', 'lc-item');
            const head = el('div', 'lc-item-head');
            head.append(el('span', 'lc-tag', att.kind || '?'), explorerLink(att.address));
            li.append(head);
            if (att.parcelUid) li.append(line(t('lensConsole.attestations.parcel', 'Parcel'), att.parcelUid));
            if (att.owner) li.append(line(t('lensConsole.attestations.owner', 'Owner'), att.owner, true));
            if (att.proposalAccount) li.append(line(t('lensConsole.verdict.proposal', 'Proposal account'), att.proposalAccount, true));
            if (att.payload && att.payload.verdict) li.append(line(t('lensConsole.verdict.verdict', 'Verdict'), att.payload.verdict));
            if (att.accountHash) li.append(line(t('lensConsole.attestations.hash', 'Account hash'), att.accountHash, true));
            li.append(line(t('lensConsole.attestations.issuedAt', 'Issued (chain time)'), att.issuedAt || t('lensConsole.attestations.unknownTime', 'unknown')));
            ul.append(li);
        });
        target.append(ul);
    }

    async function loadAttestations() {
        const target = doc.getElementById('lc-attestations');
        if (!state.serviceUrl) return showError(target, t('lensConsole.errors.noService', 'Load a service URL first.'));
        target.replaceChildren(el('p', 'lc-muted', t('lensConsole.loading', 'Loading…')));
        const result = await client.fetchAttestations({
            serviceUrl: state.serviceUrl,
            filter: { kind: doc.getElementById('lc-filter-kind').value, parcelUid: doc.getElementById('lc-filter-parcel').value }
        });
        if (result.outcome.kind !== 'ok') return showError(target, outcomeMessage(result.outcome));
        renderAttestations(result.attestations);
    }

    async function loadService() {
        const input = doc.getElementById('lc-service-url');
        const target = doc.getElementById('lc-status');
        const url = core.normalizeServiceUrl(input.value);
        if (!url) return showError(target, t('lensConsole.errors.badUrl', 'Enter an http(s) URL of a lens member service.'));
        state.serviceUrl = url;
        state.status = null;
        storeServiceUrl(url);
        target.replaceChildren(el('p', 'lc-muted', t('lensConsole.loading', 'Loading…')));
        const result = await client.fetchStatus({ serviceUrl: url });
        if (result.outcome.kind !== 'ok') return showError(target, outcomeMessage(result.outcome));
        state.status = result.body;
        renderStatus();
        renderWallet();
        await loadAttestations();
    }

    async function loadDirectory() {
        let members = [];
        try {
            const result = await client.fetchDirectory({ base: String(root.getBackendBase()).replace(/\/+$/, '') });
            members = result.outcome.kind === 'ok' ? result.members : [];
            if (result.outcome.kind !== 'ok') console.warn(`[${new Date().toISOString()}] [lens-console] directory: ${result.outcome.message || result.status}`);
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [lens-console] directory failed`, error);
        }
        state.directory = members.filter(member => member.serviceUrl);
        renderDirectory();
    }

    function renderDirectory() {
        const select = doc.getElementById('lc-directory');
        select.replaceChildren();
        const placeholder = el('option', '', state.directory.length
            ? t('lensConsole.service.directoryPick', 'Pick a member…')
            : t('lensConsole.service.directoryNone', 'No member in the directory publishes a service URL'));
        placeholder.value = '';
        select.append(placeholder);
        state.directory.forEach(member => {
            const option = el('option', '', `${member.name || core.shortKey(member.key)} — ${member.serviceUrl}`);
            option.value = member.serviceUrl;
            select.append(option);
        });
        select.disabled = !state.directory.length;
    }

    async function connectWallet() {
        const target = doc.getElementById('lc-wallet');
        const manager = root.solanaWalletManager;
        const connectors = manager ? manager.getConnectors() : [];
        if (!connectors.length) return showError(target, t('lensConsole.wallet.none', 'No Solana wallet found in this browser.'));
        try {
            const connected = await manager.connect(connectors[0].id);
            state.wallet = connected.accounts[0] || null;
            renderWallet();
        } catch (error) {
            showError(target, error && error.message ? error.message : String(error));
        }
    }

    async function submitVerdict(event) {
        event.preventDefault();
        const target = doc.getElementById('lc-verdict-result');
        if (!state.serviceUrl) return showError(target, t('lensConsole.errors.noService', 'Load a service URL first.'));
        const tokenInput = doc.getElementById('lc-verdict-token');
        const built = core.buildVerdictRequest({
            proposalAccount: doc.getElementById('lc-verdict-proposal').value,
            verdict: doc.getElementById('lc-verdict-kind').value,
            evidenceRef: doc.getElementById('lc-verdict-evidence').value,
            sourceObservedAt: doc.getElementById('lc-verdict-observed').value
        });
        if (!built.ok) {
            const messages = {
                proposal: t('lensConsole.verdict.errors.proposal', 'The proposal account must be a Solana public key.'),
                verdict: t('lensConsole.verdict.errors.verdict', 'Choose executed or expired.'),
                time: t('lensConsole.verdict.errors.time', 'Enter when the source recorded the outcome.')
            };
            return showError(target, messages[built.error]);
        }
        if (!tokenInput.value) return showError(target, t('lensConsole.verdict.errors.token', 'Enter the operator token.'));
        target.replaceChildren(el('p', 'lc-muted', t('lensConsole.loading', 'Loading…')));
        const result = await client.postVerdict({ serviceUrl: state.serviceUrl, token: tokenInput.value, body: built.body });
        tokenInput.value = '';
        if (result.outcome.kind !== 'ok') return showError(target, outcomeMessage(result.outcome));
        const body = result.body || {};
        target.replaceChildren(
            el('p', 'lc-ok', body.reused ? t('lensConsole.verdict.reused', 'Already attested; the stored verdict was returned.') : t('lensConsole.verdict.done', 'Verdict attested.')),
            line(t('lensConsole.attestations.hash', 'Account hash'), body.accountHash || '—', true)
        );
        if (body.address) target.prepend(explorerLink(body.address));
        await loadAttestations();
    }

    function init() {
        const language = doc.getElementById('lc-language');
        if (root.i18n) {
            language.value = root.i18n.getLanguage();
            language.addEventListener('change', () => root.i18n.setLanguage(language.value, { userChoice: true }));
            root.i18n.onChange(() => { renderStatus(); renderWallet(); renderDirectory(); });
        }
        root.addEventListener('i18n:translationsLoaded', () => { renderStatus(); renderWallet(); renderDirectory(); });

        const input = doc.getElementById('lc-service-url');
        const fromQuery = new URLSearchParams(root.location.search).get('service');
        input.value = fromQuery || readStoredServiceUrl() || '';
        doc.getElementById('lc-directory').addEventListener('change', event => {
            if (event.target.value) {
                input.value = event.target.value;
                loadService();
            }
        });
        doc.getElementById('lc-service-load').addEventListener('click', loadService);
        input.addEventListener('keydown', event => { if (event.key === 'Enter') loadService(); });
        doc.getElementById('lc-attestations-load').addEventListener('click', loadAttestations);
        doc.getElementById('lc-wallet-connect').addEventListener('click', connectWallet);
        doc.getElementById('lc-verdict-form').addEventListener('submit', submitVerdict);

        renderWallet();
        loadDirectory();
        if (input.value) loadService();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
    else init();
})();
