// DOM wiring for lens.html, the lens member console: pick or type a member service URL, read its
// status and issued attestations, connect the member wallet, and, as the operator, attest the
// decision of an agreement. The operator token is read from its input per request and never stored.
// Logic: lens-core.js.
(function () {
    const root = typeof window !== 'undefined' ? window : null;
    if (!root || !root.document) return;
    const doc = root.document;
    const SERVICE_URL_KEY = 'lensConsoleServiceUrl';
    const core = root.LensCore;
    const client = root.LensServiceClient;
    // directoryError: why the directory could not be read (null when it was). attestations: the last
    // list rendered, kept so a language switch can redraw it.
    const state = { serviceUrl: null, status: null, directory: [], directoryError: null, wallet: null, attestations: null };

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
        const link = el('a', 'cb-link cb-link--external lc-mono', address);
        link.href = `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=${encodeURIComponent(cluster)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    }

    // An attestation's kind (ownership, decision, evidence) as a neutral badge.
    function kindBadge(kind) {
        return el('span', 'cb-badge', kind || '?');
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
        state.attestations = list;
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
            head.append(kindBadge(att.kind), explorerLink(att.address));
            li.append(head);
            if (att.parcelUid) li.append(line(t('lensConsole.attestations.parcel', 'Parcel'), att.parcelUid));
            if (att.owner) li.append(line(t('lensConsole.attestations.owner', 'Owner'), att.owner, true));
            // An AgreementDecision names its agreement and the decision in its payload.
            if (att.payload && att.payload.agreementCid) li.append(line(t('lensConsole.attestations.agreement', 'Agreement'), att.payload.agreementCid, true));
            if (att.payload && att.payload.decision) li.append(line(t('lensConsole.attestations.decision', 'Decision'), att.payload.decision));
            if (att.accountHash) li.append(line(t('lensConsole.attestations.hash', 'Account hash'), att.accountHash, true));
            li.append(line(t('lensConsole.attestations.issuedAt', 'Issued (chain time)'), att.issuedAt || t('lensConsole.attestations.unknownTime', 'unknown')));
            ul.append(li);
        });
        target.append(ul);
    }

    async function loadAttestations() {
        const target = doc.getElementById('lc-attestations');
        if (!state.serviceUrl) return showError(target, t('lensConsole.errors.noService', 'Load a service URL first.'));
        state.attestations = null;
        target.replaceChildren(el('p', 'lc-muted', t('lensConsole.loading', 'Loading…')));
        const result = await client.fetchAttestations({
            serviceUrl: state.serviceUrl,
            filter: { kind: doc.getElementById('lc-filter-kind').value, parcelUid: doc.getElementById('lc-filter-parcel').value }
        });
        if (result.outcome.kind !== 'ok') return showError(target, outcomeMessage(result.outcome));
        renderAttestations(result.attestations);
    }

    async function refreshStatus() {
        const serviceUrl = state.serviceUrl;
        const result = await client.fetchStatus({ serviceUrl });
        if (state.serviceUrl !== serviceUrl) return;
        if (result.outcome.kind !== 'ok') return showError(doc.getElementById('lc-status'), outcomeMessage(result.outcome));
        state.status = result.body;
        renderStatus();
        renderWallet();
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
        // The previous service's attestations must not stay under a service that failed to load.
        state.attestations = null;
        doc.getElementById('lc-attestations').replaceChildren();
        const result = await client.fetchStatus({ serviceUrl: url });
        if (result.outcome.kind !== 'ok') return showError(target, outcomeMessage(result.outcome));
        state.status = result.body;
        renderStatus();
        renderWallet();
        await loadAttestations();
    }

    async function loadDirectory() {
        let members = [];
        state.directoryError = null;
        try {
            const result = await client.fetchDirectory({ base: String(root.getBackendBase()).replace(/\/+$/, '') });
            members = result.outcome.kind === 'ok' ? result.members : [];
            if (result.outcome.kind !== 'ok') {
                // A failed read is not an empty directory; say which one it was.
                state.directoryError = result.outcome.message || result.outcome.code || `HTTP ${result.outcome.status}`;
                console.warn(`[${new Date().toISOString()}] [lens-console] directory: ${state.directoryError}`);
            }
        } catch (error) {
            state.directoryError = error && error.message ? error.message : String(error);
            console.warn(`[${new Date().toISOString()}] [lens-console] directory failed`, error);
        }
        state.directory = members.filter(member => member.serviceUrl);
        renderDirectory();
    }

    function renderDirectory() {
        const select = doc.getElementById('lc-directory');
        select.replaceChildren();
        const placeholder = el('option', '', state.directoryError
            ? t('lensConsole.service.directoryFailed', 'Could not load the lens directory ({{message}})', { message: state.directoryError })
            : state.directory.length
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

    // Why the member would not attest, by its answer's code (backend/lens/server.js and
    // agreement-decision.js); any other refusal shows the member's own message.
    function decisionRefusalMessage(outcome) {
        switch (outcome.code) {
        case 'rule_not_met': return t('lensConsole.decision.errors.ruleNotMet', 'The owner decisions relayed so far do not meet the agreement’s decision rule.');
        case 'deadline_passed': return t('lensConsole.decision.errors.deadlinePassed', 'The agreement’s deadline has passed; its account can only expire.');
        case 'agreement_closed': return t('lensConsole.decision.errors.agreementClosed', 'The agreement is already executed or cancelled.');
        case 'not_in_lens': return t('lensConsole.decision.errors.notInLens', 'This member is not in the agreement’s lens.');
        case 'not_agreement_lens': return t('lensConsole.decision.errors.notAgreementLens', 'The agreement’s account names another lens member; only its decision settles it.');
        case 'decision_recorded': return t('lensConsole.decision.errors.decisionRecorded', 'The agreement’s account already records a decision.');
        case 'no_sponsor': return t('lensConsole.decision.errors.noSponsor', 'The agreement names no sponsor wallet, so no chain account can carry its decision.');
        case 'agreement_not_found': return t('lensConsole.decision.errors.notFound', 'This member’s agreement index does not hold that agreement.');
        case 'operator_only': return t('lensConsole.decision.errors.operatorOnly', 'The member refused the operator token.');
        case 'operator_not_configured':
        case 'agreements_not_configured':
            return t('lensConsole.decision.errors.notConfigured', 'This member is not set up to attest agreement decisions ({{message}}).', { message: outcome.message || outcome.code });
        default: return outcomeMessage(outcome);
        }
    }

    // The tally an answer carries (LensCore.describeDecisionTally), as rows: whether the decision rule
    // is met, then the owners and the land in favour.
    function tallyRows(tally) {
        if (!tally) return [];
        const rule = !tally.ready
            ? t('lensConsole.decision.tally.uncounted', 'cannot be counted ({{reason}})', { reason: tally.reason || '?' })
            : tally.passed ? t('lensConsole.decision.tally.met', 'met') : t('lensConsole.decision.tally.notMet', 'not met');
        const rows = [line(t('lensConsole.decision.tally.rule', 'Decision rule'), rule)];
        if (tally.acceptedOwners !== null && tally.totalOwners !== null) {
            rows.push(line(t('proposalApproval.meterOwners', 'Owners'),
                t('proposalApproval.ownersCount', '{{accepted}} of {{total}} accepted', { accepted: tally.acceptedOwners, total: tally.totalOwners })));
        }
        if (tally.acceptedAreaM2 !== null && tally.totalAreaM2 !== null) {
            const m2 = value => `${Number(value.toFixed(2))} m²`;
            rows.push(line(t('proposalApproval.meterArea', 'Area'),
                t('proposalApproval.amountOf', '{{amount}} of {{total}}', { amount: m2(tally.acceptedAreaM2), total: m2(tally.totalAreaM2) })));
        }
        return rows;
    }

    function renderDecisionAnswer(target, answer) {
        const address = line(t('lensConsole.decision.address', 'Attestation'), '');
        address.lastChild.replaceWith(explorerLink(answer.address));
        target.replaceChildren(
            el('p', 'lc-ok', answer.reused
                ? t('lensConsole.decision.reused', 'Already attested; the stored decision was returned.')
                : t('lensConsole.decision.done', 'Decision attested.')),
            address,
            line(t('lensConsole.attestations.decision', 'Decision'), answer.decision || '—'),
            ...tallyRows(answer.tally)
        );
        if (answer.counted !== null) target.append(line(t('lensConsole.decision.counted', 'Owner decisions counted'), answer.counted));
    }

    // The operator asks the member for the agreement's AgreementDecision-v1; the member counts the
    // relayed owner decisions itself, so the CID is all the request names. The result's data-outcome
    // (pending | issued | reused | refused | invalid) and data-code (the refusal's code) state the answer.
    async function submitDecision(event) {
        event.preventDefault();
        const target = doc.getElementById('lc-decision-result');
        const settle = (outcome, code = '') => {
            target.dataset.outcome = outcome;
            target.dataset.code = code;
        };
        if (!state.serviceUrl) {
            settle('invalid', 'service');
            return showError(target, t('lensConsole.errors.noService', 'Load a service URL first.'));
        }
        const cid = doc.getElementById('lc-decision-cid').value.trim();
        if (!root.Cid.isCid(cid)) {
            settle('invalid', 'cid');
            return showError(target, t('lensConsole.decision.errors.cid', 'Enter the CID of an agreement (bafkrei…).'));
        }
        const tokenInput = doc.getElementById('lc-decision-token');
        if (!tokenInput.value) {
            settle('invalid', 'token');
            return showError(target, t('lensConsole.decision.errors.token', 'Enter the operator token.'));
        }
        settle('pending');
        target.replaceChildren(el('p', 'lc-muted', t('lensConsole.loading', 'Loading…')));
        const result = await client.postAgreementDecision({ serviceUrl: state.serviceUrl, token: tokenInput.value, cid });
        tokenInput.value = '';
        if (result.outcome.kind !== 'ok') {
            settle('refused', result.outcome.code || `http_${result.outcome.status}`);
            showError(target, decisionRefusalMessage(result.outcome));
            // A refusal of the rule, the deadline or the lens carries the tally it was judged on.
            target.append(...tallyRows(core.describeDecisionTally(result.body && result.body.tally)));
            return;
        }
        const answer = core.readDecisionAnswer(result.body, cid);
        if (!answer.ok) {
            settle('refused', answer.reason);
            return showError(target, t('lensConsole.decision.errors.answer', 'The member answered something other than the decision of this agreement.'));
        }
        settle(answer.reused ? 'reused' : 'issued');
        renderDecisionAnswer(target, answer);
        await Promise.all([refreshStatus(), loadAttestations()]);
    }

    // Everything rendered from state, redrawn in the new language.
    function rerender() {
        renderStatus();
        renderWallet();
        renderDirectory();
        if (state.attestations) renderAttestations(state.attestations);
    }

    function init() {
        const language = doc.getElementById('lc-language');
        if (root.i18n) {
            language.value = root.i18n.getLanguage();
            language.addEventListener('change', () => root.i18n.setLanguage(language.value, { userChoice: true }));
            root.i18n.onChange(rerender);
        }
        root.addEventListener('i18n:translationsLoaded', rerender);

        doc.getElementById('lc-run-own').href = `${String(root.getBackendBase()).replace(/\/+$/, '')}/docs/agents`;

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
        doc.getElementById('lc-decision-form').addEventListener('submit', submitDecision);

        renderWallet();
        loadDirectory();
        if (input.value) loadService();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
    else init();
})();
