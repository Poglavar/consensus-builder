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
    const subjectTitles = new Map();
    // directoryError: why the directory could not be read (null when it was). attestations: the last
    // list rendered, kept so a language switch can redraw it.
    const state = { serviceUrl: null, status: null, directory: [], directoryError: null, wallet: null, attestations: null, serviceRequest: 0, listRequest: 0, expectedKey: null };

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

    function explorerLink(address, kind = 'address') {
        const cluster = 'devnet';
        const link = el('a', 'cb-link cb-link--external lc-mono', address);
        link.href = `https://explorer.solana.com/${kind}/${encodeURIComponent(address)}?cluster=${encodeURIComponent(cluster)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    }

    function kindLabel(kind) {
        const labels = {
            ownership: ['lensConsole.attestations.kindOwnership', 'Ownership'],
            decision: ['lensConsole.attestations.kindDecision', 'Agreement decision'],
            evidence: ['lensConsole.attestations.kindEvidence', 'Market evidence'],
            propertyOffer: ['lensActivity.propertyOffer', 'Property qualification']
        };
        return labels[kind] ? t(...labels[kind]) : kind || '—';
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

    function internalLink(label, selection) {
        const link = el('a', 'cb-link', label);
        link.href = root.LensLinks.pageUrl(selection);
        return link;
    }

    // A feed may contain hundreds of decisions. Resolve the content-addressed title only for
    // a statement the reader opens. Repeated statements about one agreement share the request.
    function showAgreementTitle(link, cid) {
        if (!root.Cid.isCid(cid)) return;
        if (!subjectTitles.has(cid)) {
            const url = root.getBackendBase().replace(/\/$/, '') + '/agreements/' + encodeURIComponent(cid);
            subjectTitles.set(cid, root.fetch(url).then(async response => {
                if (!response.ok) throw new Error('Agreement unavailable');
                const record = await response.json();
                if (record.cid !== cid || !record.content || root.Cid.cidOfObject(record.content) !== cid) throw new Error('Agreement CID mismatch');
                return record.content.title;
            }).catch(() => { subjectTitles.delete(cid); return null; }));
        }
        subjectTitles.get(cid).then(title => {
            if (title) link.textContent = t('lensActivity.openSubject', 'Follow this agreement') + ' · ' + title;
        });
    }

    function statementText(att) {
        const p = att.payload || {};
        if (att.kind === 'decision' && p.decision === 'satisfied') return t('lensWalk.met', 'The agreement’s approval rule was met.');
        if (att.kind === 'ownership' && p.owner && p.parcelUid) return t('lensActivity.ownershipClaim', '{{owner}} holds ownership rights on parcel {{parcel}}.', { owner: p.owner, parcel: p.parcelUid });
        if (att.kind === 'evidence' && p.subject && p.value != null) return t('lensActivity.evidenceClaim', '{{subject}} was reported as {{value}}.', p);
        if (att.kind === 'propertyOffer' && p.counterpartyQualified === 1 && p.cid) return t('lensActivity.offerClaim', 'The counterparty qualified for offer {{offer}}.', { offer: p.cid });
        return kindLabel(att.kind);
    }

    function dateLine(label, value) {
        const row = line(label, t('lensConsole.attestations.unknownTime', 'unknown'));
        if (!value) return row;
        const date = new Date(typeof value === 'number' ? value * 1000 : value);
        if (!Number.isFinite(date.getTime())) return row;
        const time = el('time', 'lc-v', date.toLocaleString(root.i18n?.getLocale?.() || 'en', { dateStyle: 'medium', timeStyle: 'medium' }));
        time.dateTime = date.toISOString();
        time.title = time.dateTime;
        row.lastChild.replaceWith(time);
        return row;
    }

    function receiptCard(att, exact) {
        const li = el('li', 'lc-item');
        const payload = att.payload || {};
        const entry = state.directory.find(m => m.key === att.authority);
        const issuer = entry?.name ? `${entry.name} · ${core.shortKey(att.authority)}` : att.authority;
        li.append(el('p', 'lc-meta', kindLabel(att.kind)), el('h3', 'lc-claim', statementText(att)),
            line(t('lensActivity.signedBy', 'Issued by'), issuer),
            dateLine(t('lensConsole.attestations.issuedAt', 'Issued (chain time)'), att.issuedAt));
        if (state.status.dryRun) li.append(el('p', 'lc-warn', t('lensActivity.dryRun', 'Simulated statement')));
        const subject = payload.agreementCid;
        const subjectLink = subject && internalLink(t('lensActivity.openSubject', 'Follow this agreement') + ' · ' + subject.slice(0, 12) + '…' + subject.slice(-6), { agreement: subject });
        if (subjectLink) li.append(subjectLink);
        const details = el('details', 'lc-proof');
        details.id = 'lc-att-' + att.address;
        details.open = !!exact;
        if (subjectLink) {
            if (exact) showAgreementTitle(subjectLink, subject);
            else details.addEventListener('toggle', () => { if (details.open) showAgreementTitle(subjectLink, subject); });
        }
        details.append(el('summary', '', t('lensActivity.details', 'Statement details')),
            line(t('lensConsole.status.key', 'Member key'), att.authority, true));
        if (subject) details.append(line(t('lensConsole.attestations.agreement', 'Agreement'), subject, true));
        if (payload.sourceObservedAt) details.append(dateLine(t('lensActivity.sourceObservedAt', 'Source observed'), payload.sourceObservedAt));
        if (payload.evidenceRef || payload.sourceRef) details.append(line(t('lensActivity.source', 'Evidence source'), payload.evidenceRef || payload.sourceRef, true));
        if (att.expiry) details.append(dateLine(t('lensActivity.expiry', 'Expires'), att.expiry));
        const identifiers = [[t('lensConsole.decision.address', 'Attestation'), att.address], [t('lensActivity.credential', 'Credential'), att.credential],
            [t('lensActivity.schema', 'Schema'), att.schema], [t('lensActivity.transaction', 'Issuance transaction'), att.transactionSignature, 'tx']];
        for (const [label, id, kind] of identifiers) {
            if (!id) continue;
            const row = line(label, id, true);
            if (!state.status.dryRun) row.lastChild.replaceWith(explorerLink(id, kind));
            details.append(row);
        }
        if (att.accountHash) details.append(line(t('lensConsole.attestations.hash', 'Account hash'), att.accountHash, true));
        const raw = el('details', 'lc-proof');
        raw.id = details.id + '-payload';
        raw.append(el('summary', '', t('lensActivity.raw', 'Statement payload')), el('pre', '', JSON.stringify(payload, null, 2)));
        details.append(raw);
        li.append(details);
        if (!exact) li.append(internalLink(t('lensActivity.openReceipt', 'Open this statement'), { member: att.authority, attestation: att.address, subject }));
        return li;
    }

    function renderAttestations(list) {
        state.attestations = list;
        const target = doc.getElementById('lc-attestations');
        const exact = new URLSearchParams(root.location.search).get('attestation');
        const open = Array.from(target.querySelectorAll?.('details[open]') || [], d => d.id);
        const focus = target.contains?.(doc.activeElement) && doc.activeElement.closest('details')?.id;
        const ul = el('ul', 'lc-list');
        for (const att of list) ul.append(receiptCard(att, exact));
        target.replaceChildren(list.length ? ul : el('p', 'lc-muted', t('lensActivity.empty', 'This response contains no matching statements from this member.')));
        if (exact) target.append(internalLink(t('lensActivity.allStatements', 'See all statements by this member'), { member: state.status.key }));
        for (const id of open) { const d = doc.getElementById(id); if (d) d.open = true; }
        if (focus) doc.getElementById(focus)?.querySelector('summary')?.focus({ preventScroll: true });
    }

    async function loadAttestations() {
        const target = doc.getElementById('lc-attestations');
        if (!state.status) return;
        const request = ++state.listRequest;
        const memberKey = state.status.key;
        const params = new URLSearchParams(root.location.search);
        const address = params.get('attestation');
        const agreementCid = address ? params.get('subject') : null;
        state.attestations = null;
        target.replaceChildren(el('p', 'lc-muted lc-loading', t('lensConsole.loading', 'Loading…')));
        const filter = { address, agreementCid, kind: doc.getElementById('lc-filter-kind').value, parcelUid: doc.getElementById('lc-filter-parcel').value };
        const result = await client.fetchAttestations({ serviceUrl: state.serviceUrl, filter });
        if (request !== state.listRequest) return;
        if (result.outcome.kind !== 'ok') return showError(target, outcomeMessage(result.outcome));
        const records = core.filterMemberAttestations(result.attestations, { memberKey, address });
        renderAttestations(agreementCid ? records.filter(r => r.payload?.agreementCid === agreementCid) : records);
    }

    async function readStatus(request) {
        const result = await client.fetchStatus({ serviceUrl: state.serviceUrl });
        if (request !== state.serviceRequest) return false;
        const error = result.outcome.kind !== 'ok' ? outcomeMessage(result.outcome)
            : !core.isBase58Pubkey(result.body?.key) || (state.expectedKey && result.body.key !== state.expectedKey)
                ? t('lensActivity.wrongMember', 'The service returned a different member identity.') : null;
        if (error) {
            showError(doc.getElementById('lc-status'), error);
            showError(doc.getElementById('lc-attestations'), error);
            return false;
        }
        state.status = result.body;
        renderStatus(); renderWallet();
        return true;
    }

    async function loadService({ persist = false, expectedKey = null } = {}) {
        const input = doc.getElementById('lc-service-url');
        const url = core.normalizeServiceUrl(input.value);
        const request = ++state.serviceRequest;
        state.listRequest++;
        if (state.serviceUrl && state.serviceUrl !== url) {
            doc.getElementById('lc-decision-token').value = '';
            doc.getElementById('lc-decision-result').replaceChildren();
        }
        state.serviceUrl = url; state.status = null; state.attestations = null; state.expectedKey = expectedKey;
        const target = doc.getElementById('lc-status');
        const feed = doc.getElementById('lc-attestations');
        feed.replaceChildren();
        if (!url) return showError(target, t('lensConsole.errors.badUrl', 'Enter an http(s) URL of a lens member service.'));
        if (persist) storeServiceUrl(url);
        for (const node of [target, feed]) node.replaceChildren(el('p', 'lc-muted lc-loading', t('lensConsole.loading', 'Loading…')));
        if (await readStatus(request)) await loadAttestations();
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
        state.directory = members;
        renderDirectory();
        return selectDirectoryFromQuery();
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
            const option = el('option', '', `${member.name || member.kind || '—'} · ${core.shortKey(member.key)}`);
            option.value = member.serviceUrl || '';
            select.append(option);
        });
        select.disabled = !state.directory.length;
        select.value = state.serviceUrl || '';
    }

    function selectDirectoryFromQuery() {
        const params = new URLSearchParams(root.location.search);
        const requestedKey = params.get('member');
        const input = doc.getElementById('lc-service-url');
        if (state.serviceRequest) return;
        const member = requestedKey ? state.directory.find(entry => entry.key === requestedKey) : state.directory[0];
        if (requestedKey && !member?.serviceUrl) return showError(doc.getElementById('lc-attestations'), state.directoryError || t('lensActivity.unknownMember', 'This member has no service listed in the directory.'));
        const url = requestedKey ? member?.serviceUrl : params.get('service') || member?.serviceUrl || input.value;
        if (!url) return;
        input.value = url;
        doc.getElementById('lc-directory').value = url;
        return loadService({ expectedKey: state.directory.find(entry => entry.serviceUrl === url)?.key });
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
        if (!state.status) return showError(target, t('lensConsole.errors.noService', 'Load a service URL first.'));
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
        const serviceRequest = state.serviceRequest;
        const result = await client.postAgreementDecision({ serviceUrl: state.serviceUrl, token: tokenInput.value, cid });
        if (serviceRequest !== state.serviceRequest) return;
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
        await Promise.all([readStatus(state.serviceRequest), loadAttestations()]);
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

        if (!root.LensLinks.isMemberView(root.location) && doc.getElementById('lc-walkthrough')) return;
        doc.getElementById('lc-run-own').href = `${String(root.getBackendBase()).replace(/\/+$/, '')}/docs/agents`;
        const input = doc.getElementById('lc-service-url');
        const params = new URLSearchParams(root.location.search);
        input.value = params.get('service') || readStoredServiceUrl() || '';
        doc.getElementById('lc-directory').addEventListener('change', event => {
            const member = state.directory.find(m => m.serviceUrl === event.target.value);
            if (!member) return;
            input.value = member.serviceUrl;
            root.history.replaceState(null, '', root.LensLinks.pageUrl({ member: member.key }));
            return loadService({ expectedKey: member.key });
        });
        const listen = (id, fn) => {
            const button = doc.getElementById(id);
            button.addEventListener('click', () => root.BusyControl.track(button, fn));
        };
        function manualService() {
            const entry = state.directory.find(m => m.serviceUrl === core.normalizeServiceUrl(input.value));
            if (root.history) root.history.replaceState(null, '', root.LensLinks.pageUrl(entry ? { member: entry.key } : { view: 'members' }));
            return loadService({ persist: true, expectedKey: entry?.key });
        }
        listen('lc-service-load', manualService);
        input.addEventListener('keydown', event => { if (event.key === 'Enter') doc.getElementById('lc-service-load').click(); });
        listen('lc-attestations-load', () => state.status ? loadAttestations() : state.serviceUrl ? loadService({ expectedKey: state.expectedKey }) : loadDirectory());
        listen('lc-wallet-connect', connectWallet);
        doc.getElementById('lc-decision-form').addEventListener('submit', event => {
            event.preventDefault();
            const button = doc.getElementById('lc-decision-submit');
            if (!root.BusyControl.isBusy(button)) return root.BusyControl.track(button, () => submitDecision(event));
        });
        renderWallet();
        loadDirectory();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
    else init();
})();
