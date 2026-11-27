// Public agreement walkthrough: who takes part, a checklist of what the agreement needs and who
// stated each fact. The published terms, signed owner approvals, lens member services and the Solana
// account answer independently; LensWalkthroughModel turns their states into the checklist.
(function (win) {
    'use strict';
    const doc = win.document;
    const byId = id => doc.getElementById(id);
    const query = new URLSearchParams(win.location.search);
    const city = query.get('city');
    const base = win.getBackendBase().replace(/\/$/, '');
    const links = win.LensLinks;
    const Model = win.LensWalkthroughModel;
    const programId = () => win.AgreementClient?.constants?.AGREEMENT_PROGRAM_ID;
    const directory = new Map();
    const scripts = new Map();
    let selected = query.get('agreement');
    let current = null;
    let list = [];
    let listError = false;
    let listLoaded = false;
    let directoryError = false;
    let directoryReady;

    function t(key, fallback, params = {}) {
        const translated = win.i18n?.t(key, params);
        return translated && translated !== key ? translated : fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? '');
    }
    const w = (key, fallback, params) => t('lensWalk.' + key, fallback, params);
    function element(tag, text, cls) {
        const el = doc.createElement(tag);
        if (text != null) el.textContent = text;
        if (cls) el.className = cls;
        return el;
    }
    function anchor(label, href, external = false) {
        const a = element('a', label, 'cb-link');
        a.href = href;
        if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        return a;
    }
    function explorer(label, value, type = 'address') {
        return anchor(label, 'https://explorer.solana.com/' + type + '/' + encodeURIComponent(value) + '?cluster=devnet', true);
    }
    const nameOf = key => {
        const name = directory.get(key)?.name;
        return name ? name + ' · ' + win.LensCore.shortKey(key) : win.LensCore.shortKey(key);
    };
    // A lens member's name, linking to its statements when its service is listed.
    function lensMember(key) {
        const listed = directory.get(key)?.serviceUrl;
        const node = listed ? anchor(nameOf(key), links.pageUrl({ member: key, city: current?.record?.city || city })) : element('span', nameOf(key));
        node.title = key;
        return node;
    }
    // A lens member named inside an owner approval: jump to its row in the lens check.
    function lensMemberRef(key) {
        const a = anchor(nameOf(key), '#lc-lens-' + key);
        a.title = key;
        return a;
    }
    function field(label, value) {
        const row = element('div', null, 'lc-fact');
        row.append(element('dt', label), element('dd'));
        row.lastChild.append(value);
        return row;
    }
    function when(value) {
        if (value == null || value === '') return null;
        const date = new Date(typeof value === 'number' || typeof value === 'bigint' ? Number(value) * 1000 : value);
        if (!Number.isFinite(date.getTime())) return null;
        const time = element('time', new Intl.DateTimeFormat(win.i18n?.getLocale?.() || 'en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(date));
        time.dateTime = date.toISOString();
        time.title = time.dateTime;
        return time;
    }
    const loading = () => element('p', t('lensConsole.loading', 'Loading…'), 'lc-muted lc-loading');
    const message = (text, cls = 'lc-muted') => element('p', text, cls);
    function disclosure(id, label) {
        const details = element('details', null, 'lc-proof');
        details.id = id;
        details.append(element('summary', label));
        return details;
    }
    function line(...parts) {
        const p = element('p', null, 'lc-line');
        p.append(...parts.filter(part => part != null && part !== ''));
        return p;
    }
    function setContent(target, ...children) {
        const fragment = doc.createDocumentFragment();
        fragment.append(...children);
        for (const open of target.querySelectorAll('details[open]')) {
            const next = fragment.getElementById(open.id);
            if (next) next.open = true;
        }
        if (target.childNodes.length === fragment.childNodes.length && Array.from(target.childNodes).every((node, i) => node.isEqualNode(fragment.childNodes[i]))) return;
        const active = target.contains(doc.activeElement) && doc.activeElement;
        const href = active?.getAttribute?.('href');
        const detail = active?.closest?.('details')?.id;
        target.replaceChildren(fragment);
        const focus = href ? Array.from(target.querySelectorAll('a')).find(a => a.getAttribute('href') === href) : detail && byId(detail)?.querySelector('summary');
        focus?.focus({ preventScroll: true });
    }
    async function json(path) {
        const response = await win.fetch(base + path, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
    }
    // Load signature verification only when a record needs it.
    function library(src) {
        if (!scripts.has(src)) scripts.set(src, new Promise((resolve, reject) => {
            const tag = element('script');
            tag.src = src;
            tag.onload = resolve;
            tag.onerror = () => { tag.remove(); scripts.delete(src); reject(new Error(src)); };
            doc.head.append(tag);
        }));
        return scripts.get(src);
    }
    const usdc = value => win.AgreementRecord.formatUsdc(value);
    const STATE_LABELS = () => ({
        met: w('stateMet', 'Done'), waiting: w('stateWaiting', 'Waiting'), failed: w('stateFailed', 'Unmet'),
        unknown: w('stateUnknown', 'Not checked'), loading: w('stateLoading', 'Loading'), none: w('stateNone', 'Not needed')
    });
    const STATE_ICONS = { met: 'fa-circle-check', waiting: 'fa-clock', failed: 'fa-circle-xmark', unknown: 'fa-circle-question', loading: 'fa-spinner', none: 'fa-circle-minus' };

    // The hash a lens member's statement cites, recomputed from the verified approvals it could count.
    function approvalsRef(s) {
        const statement = s.chain?.statement;
        if (!statement?.fields || !s.receipts) return null;
        const subject = { ...win.AgreementRecord.approvalSubject(s.record.content), agreementCid: s.record.cid };
        const counted = Model.approvalsCountedBy(s.receipts.filter(row => row.verified).map(row => row.receipt), statement.fields.sourceObservedAt);
        const folded = win.ProposalApprovalRelay.fold(subject, counted, () => true);
        return win.ProposalApproval.decisionEvidenceRef(win.ProposalApprovalRelay.countedApprovals(folded));
    }
    function modelOf(s) {
        return Model.build({ ...s, programId: programId(), approvalsRef: approvalsRef(s) });
    }

    function roleCard(title, does, ...value) {
        const li = element('li', null, 'lc-role');
        li.append(element('h3', title, 'lc-role__title'), element('p', does, 'lc-muted'));
        const body = element('div', null, 'lc-role__value');
        body.append(...value.filter(Boolean));
        li.append(body);
        return li;
    }
    function drawRoles(s, m) {
        const cards = [];
        const approvals = m.checks.find(c => c.id === 'approvals');
        const funding = m.checks.find(c => c.id === 'funding');
        if (m.kind === 'owners') cards.push(roleCard(w('roleOwners', 'Owners'), w('roleOwnersDo', 'Approve with their own wallet'),
            approvals?.state === 'loading' ? loading() : approvals?.total != null ? element('p', w('ownersCount', '{{approved}} of {{total}} approved', { approved: approvals.approved, total: approvals.total })) : null));
        else if (m.kind === 'investors') cards.push(roleCard(w('roleInvestors', 'Contributors'), w('roleInvestorsDo', 'Fund the round'),
            funding?.required != null ? element('p', w('fundingCount', '{{observed}} of {{required}} USDC', { observed: usdc(funding.observed ?? 0n), required: usdc(funding.required) })) : null));
        else cards.push(roleCard(w('roleCommunity', 'Community'), w('community', 'Community members vote on the agreement.'), element('p', w('nonbinding', 'This vote is counted off chain.'))));
        if (m.kind !== 'poll') {
            const names = element('p', null, 'lc-names');
            m.lens.keys.forEach((key, i) => { if (i) names.append(', '); names.append(lensMember(key)); });
            cards.push(roleCard(w('roleLens', 'Lens members'), w('roleLensDo', 'Vouch for owners and confirm the rule was met'),
                m.lens.keys.length ? names : element('p', w('noLens', 'No lens: the program checks the funding target itself.')),
                m.lens.keys.length ? element('p', w('lensNeeded', '{{threshold}} of {{count}} must confirm', { threshold: m.lens.threshold, count: m.lens.keys.length }), 'lc-muted') : null));
            cards.push(roleCard(w('roleAgreement', 'The agreement on Solana'), w('roleAgreementDo', 'Pays out once the rule is met'),
                element('p', executionText(m.execution)), m.execution.account ? explorer(w('account', 'View agreement account'), m.execution.account) : null));
        }
        setContent(byId('lc-roles'), ...cards);
    }
    function executionText(execution) {
        return {
            executed: w('executed', 'Executed'), active: w('active', 'Waiting for execution'), expired: w('expired', 'Expired: the deadline passed'),
            cancelled: w('cancelled', 'Cancelled by its sponsor'), unminted: w('unminted', 'Not on Solana yet'),
            retired: w('retired', 'Recorded with a retired version of the agreement program, which this page no longer reads'),
            unreadable: w('noChain', 'The Solana account could not be read'), loading: t('lensConsole.loading', 'Loading…'), poll: w('nonbinding', 'This vote is counted off chain.')
        }[execution.state] || execution.status || '—';
    }

    function approvalRows(s, m) {
        if (!m.approvals.length) return [message(w('approvalsNone', 'No owner approvals have been relayed yet.'))];
        const ul = element('ul', null, 'lc-sublist');
        m.approvals.forEach((row, i) => {
            const li = element('li');
            const verb = row.decision === 'approve' ? w('approvedBy', 'Approved by') : row.decision === 'withdraw' ? w('withdrewBy', 'Approval withdrawn by') : (row.decision || '—');
            const owner = element('span', win.LensCore.shortKey(row.owner || '—'));
            owner.title = row.owner || '';
            li.append(line(verb, ' ', owner, ' · ', when(row.decidedAt) || '—'));
            if (row.signer && row.signer !== row.owner) li.append(line(w('signedFor', 'Signed by {{signer}} for the owner', { signer: win.LensCore.shortKey(row.signer) })));
            if (row.rightsBy) li.append(line(w('rightsPer', 'Owner of the parcel, per'), ' ', lensMemberRef(row.rightsBy)));
            if (row.authorityBy) li.append(line(w('authorityPer', 'Allowed to sign for the owner, per'), ' ', lensMemberRef(row.authorityBy)));
            if (!row.verified) li.append(message(w('invalid', 'The signatures on this approval do not verify, so it is not counted.'), 'lc-warn'));
            const raw = disclosure('lc-owner-raw-' + i, w('raw', 'Signed approval'));
            raw.append(element('pre', JSON.stringify(row.receipt, null, 2)));
            li.append(raw);
            ul.append(li);
        });
        return [ul];
    }
    function statementFacts(s, statement, idPrefix) {
        const nodes = [];
        const fields = statement.fields || statement.payload || {};
        const facts = element('dl', null, 'lc-facts');
        if (fields.decision) facts.append(field(w('says', 'Says'), fields.decision === 'satisfied' ? w('met', 'The agreement’s approval rule was met.') : String(fields.decision)));
        const observed = when(fields.sourceObservedAt);
        if (observed) facts.append(field(w('sourceTime', 'Approvals counted up to'), observed));
        const issued = when(statement.issuedAt);
        if (issued) facts.append(field(t('lensConsole.attestations.issuedAt', 'Issued (chain time)'), issued));
        nodes.push(facts);
        const details = disclosure(idPrefix + '-proof', w('details', 'Technical details'));
        const meta = element('dl', null, 'lc-facts');
        if (fields.evidenceRef) meta.append(field(w('evidence', 'Evidence reference'), fields.evidenceRef));
        if (statement.address) meta.append(field(t('lensConsole.decision.address', 'Attestation'), explorer(statement.address, statement.address)));
        if (statement.transactionSignature) meta.append(field(w('tx', 'Issuance transaction'), explorer(statement.transactionSignature, statement.transactionSignature, 'tx')));
        if (statement.credential) meta.append(field(t('lensActivity.credential', 'Credential'), explorer(statement.credential, statement.credential)));
        if (statement.schema) meta.append(field(t('lensActivity.schema', 'Schema'), explorer(statement.schema, statement.schema)));
        details.append(meta);
        nodes.push(details);
        const signer = statement.signer || statement.authority;
        if (statement.address && signer && directory.get(signer)?.serviceUrl) {
            const open = anchor(w('exact', 'Open this statement'), links.pageUrl({ member: signer, attestation: statement.address, subject: s.cid, city: s.record.city }));
            open.setAttribute('aria-label', w('exactBy', 'Open the statement by {{member}}', { member: nameOf(signer) }));
            nodes.push(open);
        }
        return nodes;
    }
    function lensRows(s, m) {
        const states = {
            confirmed: w('memberConfirmed', 'Confirmed on Solana'), issued: w('memberIssued', 'Statement issued, not yet recorded on Solana'),
            none: w('memberNone', 'No statement yet'), unlisted: w('memberUnlisted', 'Lists no statement service. Solana shows no confirmation from this lens member yet.'),
            unknown: w('memberUnknown', 'Its statement service could not be read'), loading: t('lensConsole.loading', 'Loading…')
        };
        const ul = element('ul', null, 'lc-sublist');
        for (const member of m.lens.members) {
            const li = element('li', null, 'lc-member lc-member--' + member.state);
            li.id = 'lc-lens-' + member.key;
            li.append(line(lensMember(member.key), ' · ', states[member.state]));
            if (member.recorded) {
                li.append(message(w('statementChecked', 'Statement checked against the agreement on Solana.'), 'lc-ok'));
                li.append(...statementFacts(s, member.recorded, 'lc-statement-' + member.key));
            } else for (const statement of member.statements) {
                li.append(message(w('statementReported', 'As its statement service reports it. Solana has not recorded it for this agreement.'), 'lc-muted'));
                li.append(...statementFacts(s, statement, 'lc-statement-' + statement.address));
            }
            ul.append(li);
        }
        return [ul];
    }
    function checkItem(check, title, ...body) {
        const li = element('li', null, 'lc-check lc-check--' + check.state);
        const icon = element('i', null, 'fa-solid ' + STATE_ICONS[check.state] + ' lc-check__icon');
        icon.setAttribute('aria-hidden', 'true');
        const head = element('p', null, 'lc-check__title');
        head.append(element('span', STATE_LABELS()[check.state] + ': ', 'lc-sr-only'), title);
        const main = element('div', null, 'lc-check__body');
        main.append(head, ...body.flat().filter(Boolean));
        li.append(icon, main);
        return li;
    }
    function drawChecks(s, m) {
        const target = byId('lc-checks');
        if (m.kind === 'poll') return setContent(target, element('li', w('nonbinding', 'This vote is counted off chain.'), 'lc-check lc-check--none'));
        const items = m.checks.map(check => {
            if (check.id === 'approvals') {
                const rule = s.record.content.rule;
                return checkItem(check, w('checkApprovals', 'Owners approve'),
                    element('p', win.ProposalApprovalText.rulesText(rule.approvalConfig?.policy, t, win.AgreementRecord.schemeOf(rule)), 'lc-muted'),
                    check.total != null ? element('p', w('approvalsCount', '{{approved}} of {{total}} owners approved', { approved: check.approved, total: check.total })) : null,
                    check.state === 'loading' ? loading() : s.receiptsError ? message(w('unavailable', 'This source could not be read.')) : approvalRows(s, m));
            }
            if (check.id === 'funding') return checkItem(check, w('checkFunding', 'The funding target is reached'),
                check.required != null ? element('p', w('fundingCount', '{{observed}} of {{required}} USDC', { observed: usdc(check.observed ?? 0n), required: usdc(check.required) })) : null);
            if (check.id === 'lens') {
                if (check.state === 'none') return checkItem(check, w('checkLens', 'Lens members confirm the rule was met'), element('p', w('noLens', 'No lens: the program checks the funding target itself.')));
                return checkItem(check, w('checkLens', 'Lens members confirm the rule was met'),
                    element('p', w('lensCount', '{{confirmed}} of {{threshold}} required confirmations recorded on Solana', { confirmed: check.confirmed, threshold: check.threshold })),
                    lensRows(s, m),
                    m.statementError ? message(w('proofUnavailable', 'The recorded statement could not be verified: {{reason}}', { reason: m.statementError }), 'lc-warn') : null);
            }
            if (check.id === 'cited') {
                const text = { met: w('citedMet', 'The approvals above are the ones the lens member counted.'),
                    failed: w('citedFailed', 'The approvals relayed up to the statement do not match the ones the lens member counted. Check them before relying on this agreement.'),
                    unknown: w('citedUnknown', 'Could not compare: the owner approvals could not be read.'), loading: t('lensConsole.loading', 'Loading…') }[check.state];
                return checkItem(check, w('checkCited', 'The lens counted these owner approvals'), message(text, check.state === 'failed' ? 'lc-warn' : 'lc-muted'));
            }
            const at = when(m.execution.at);
            return checkItem(check, w('checkExecution', 'The agreement executes on Solana'),
                line(executionText(m.execution), at ? ' · ' : '', at),
                m.execution.account ? explorer(w('account', 'View agreement account'), m.execution.account) : null);
        });
        setContent(target, ...items);
    }
    function draw(s) {
        if (current !== s || !s.record) return;
        const m = modelOf(s);
        drawRoles(s, m); drawChecks(s, m);
        byId('lc-retry').hidden = !win.BusyControl.isBusy(byId('lc-retry')) && !(m.retry || listError);
    }
    async function readReceipts(s) {
        if (Model.kindOf(s.record) !== 'owners') return;
        try {
            const [body] = await Promise.all([json('/agreements/' + s.record.cid + '/decisions'), library('vendor/noble-curves-1.2.0/ed25519.js')]);
            if (body.agreementCid !== s.record.cid || !Array.isArray(body.decisions)) throw new Error('Unexpected approval response');
            const subject = { ...win.AgreementRecord.approvalSubject(s.record.content), agreementCid: s.record.cid };
            s.receipts = body.decisions.map(receipt => ({ receipt, verified: win.ProposalApprovalRelay.verifyLensReceipt(subject, receipt) }));
            const folded = win.ProposalApprovalRelay.fold(subject, s.receipts.filter(row => row.verified).map(row => row.receipt), () => true);
            s.tally = win.ProposalApproval.tally(subject, Object.keys(folded.ownerApprovals));
        } catch { s.receiptsError = true; }
        draw(s);
    }
    async function readChain(s) {
        try {
            if (!await win.ensureWalletVendors('solana')) throw new Error('The Solana library could not be loaded.');
            const connection = await win.SolanaChainDataLoader.getVerifiedConnection(s.record.onchain?.cluster || 'devnet');
            s.chain = await win.LensAgreementEvidence.readChain({ record: s.record, connection, client: win.AgreementClient });
        } catch { s.chainError = true; }
        s.chainPending = false;
        draw(s);
    }
    async function memberIndex() {
        const result = await win.LensServiceClient.fetchDirectory({ base });
        directoryError = result.outcome.kind !== 'ok';
        if (!directoryError) result.members.forEach(m => directory.set(m.key, m));
    }
    // Each lens member's statements about this agreement, from the service the directory lists for it.
    async function readIssued(s) {
        await directoryReady;
        if (current !== s) return;
        const lens = Model.build({ record: s.record, programId: programId() }).lens.keys;
        s.services = {};
        const results = await Promise.all((s.record.content.sponsor ? lens : []).map(async key => {
            const issuer = directory.get(key);
            if (directoryError) { s.services[key] = 'error'; return []; }
            if (!issuer?.serviceUrl) { s.services[key] = 'unlisted'; return []; }
            try {
                const result = await win.LensServiceClient.fetchAttestations({ serviceUrl: issuer.serviceUrl, filter: { agreementCid: s.cid, kind: 'decision' } });
                if (!Array.isArray(result.attestations)) throw new Error('Lens member feed unavailable');
                s.services[key] = 'ok';
                return result.attestations.filter(r => r.authority === key && r.kind === 'decision' && r.payload?.agreementCid === s.cid
                    && r.payload.sponsor === s.record.content.sponsor && r.payload.decision === 'satisfied' && win.LensCore.isBase58Pubkey(r.address));
            } catch { s.services[key] = 'error'; return []; }
        }));
        s.issued = results.flat();
        draw(s);
    }
    async function openAgreement(cid) {
        const s = { cid, record: null, receipts: null, issued: null, services: {}, chain: null };
        current = s;
        byId('lc-story').hidden = true;
        byId('lc-retry').hidden = !win.BusyControl.isBusy(byId('lc-retry'));
        byId('lc-flow-status').replaceChildren(loading());
        try {
            if (!win.Cid.isCid(cid)) throw new Error('Invalid CID');
            const record = await json('/agreements/' + encodeURIComponent(cid));
            if (current !== s) return;
            if (record.cid !== cid || record.content?.schema !== 'agreement/v1' || !record.content.rule || win.Cid.cidOfObject(record.content) !== cid) throw new Error('Agreement does not match CID');
            s.record = record;
            // The chain is read whatever the index says, from the account the sponsor and CID derive;
            // an agreement minted under a retired program is not read.
            const chainReadable = Model.kindOf(record) !== 'poll' && record.content.sponsor && !Model.isRetiredProgram(record, programId());
            s.chainPending = Boolean(chainReadable);
            byId('lc-subject').textContent = record.content.title || record.title || cid;
            byId('lc-map-agreement').href = links.mapUrl({ agreement: cid, city: record.city });
            byId('lc-story').hidden = false;
            byId('lc-flow-status').replaceChildren();
            drawList(); draw(s);
            await Promise.all([readReceipts(s), readIssued(s), chainReadable && readChain(s)]);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [lens-walkthrough] agreement ${cid} could not be shown`, error);
            if (current !== s) return;
            byId('lc-flow-status').replaceChildren(message(w('unavailable', 'This source could not be read.')));
            byId('lc-retry').hidden = false;
        }
    }
    function drawList() {
        const select = byId('lc-agreement');
        const search = byId('lc-search').value.trim().toLocaleLowerCase();
        const choices = [...list];
        if (selected && !choices.some(r => r.cid === selected)) choices.unshift({ cid: selected, title: current?.record?.title || selected });
        const options = search ? choices.filter(r => (r.title + ' ' + r.cid).toLocaleLowerCase().includes(search)) : choices;
        select.replaceChildren(...options.map(r => {
            const option = element('option', r.title || r.cid); option.value = r.cid; return option;
        }));
        if (selected) select.value = selected;
        select.disabled = !options.length;
        byId('lc-list-status').textContent = listError ? w('chooseError', 'The agreement list could not be loaded.')
            : listLoaded && !choices.length ? w('none', 'No published agreements were found for this city.')
                : search && !options.length ? w('noMatches', 'No agreements match this search.') : '';
        if (listError) byId('lc-retry').hidden = false;
    }
    function selectAgreement(cid, push) {
        selected = cid;
        if (push) win.history.pushState(null, '', links.pageUrl({ agreement: cid, city }));
        else if (!new URLSearchParams(win.location.search).has('agreement')) win.history.replaceState(null, '', links.pageUrl({ agreement: cid, city }));
        byId('lc-flow-link').href = links.pageUrl({ agreement: cid, city });
        return openAgreement(cid);
    }
    async function loadList() {
        try {
            const params = new URLSearchParams({ limit: '50' });
            if (city) params.set('city', city);
            const data = await json('/agreements?' + params);
            if (!Array.isArray(data.agreements)) throw new Error('Invalid agreement list');
            list = data.agreements.filter(r => win.Cid.isCid(r.cid)); listError = false;
        } catch { listError = true; }
        listLoaded = true; drawList();
        if (!selected && list.length) {
            // Open an example the current program can read: executed first, then any minted one.
            const readable = list.filter(r => r.onchain && !Model.isRetiredProgram(r, programId()));
            const example = readable.find(r => r.onchain.status === 'executed') || readable[0] || list[0];
            return selectAgreement(example.cid, false);
        }
    }
    function init() {
        const members = links.isMemberView(win.location);
        byId('lc-flow-link').href = links.pageUrl({ agreement: selected || query.get('subject'), city });
        byId('lc-members-link').href = links.pageUrl({ view: 'members', city });
        byId('lc-back').href = links.mapUrl({ city });
        byId(members ? 'lc-members-link' : 'lc-flow-link').setAttribute('aria-current', 'page');
        byId('lc-members').hidden = !members; byId('lc-walkthrough').hidden = members;
        if (members) { if (query.has('service')) byId('lc-operator').open = true; return; }
        directoryReady = memberIndex();
        byId('lc-search').addEventListener('input', drawList);
        byId('lc-agreement').addEventListener('change', e => selectAgreement(e.target.value, true));
        byId('lc-retry').addEventListener('click', async e => {
            const button = e.currentTarget;
            if (win.BusyControl.isBusy(button)) return;
            if (directoryError) directoryReady = memberIndex();
            await win.BusyControl.track(button, () => Promise.all([listError && loadList(), selected && openAgreement(selected)]));
            if (current?.record) draw(current);
            else button.hidden = !listError && !current;
        });
        win.addEventListener('popstate', () => {
            const cid = new URLSearchParams(win.location.search).get('agreement');
            if (cid && cid !== selected) { selected = cid; drawList(); openAgreement(cid); }
        });
        const redraw = () => { drawList(); if (current?.record) draw(current); };
        win.i18n?.onChange(redraw);
        win.addEventListener('i18n:translationsLoaded', redraw);
        if (selected) openAgreement(selected);
        loadList();
    }
    init();
})(window);
