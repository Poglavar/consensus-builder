// Public agreement evidence. The published terms, signed owner messages, member service and
// Solana account can answer independently. A slow or unavailable source affects only its stage.
(function (win) {
    'use strict';
    const doc = win.document;
    const byId = id => doc.getElementById(id);
    const query = new URLSearchParams(win.location.search);
    const city = query.get('city');
    const base = win.getBackendBase().replace(/\/$/, '');
    const links = win.LensLinks;
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
    const w = (key, fallback) => t('lensWalk.' + key, fallback);
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
    function member(key) {
        const name = directory.get(key)?.name;
        const label = name ? name + ' · ' + win.LensCore.shortKey(key) : win.LensCore.shortKey(key);
        const a = anchor(label, links.pageUrl({ member: key, subject: current?.cid, city: current?.record?.city || city }));
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
        if (!value) return null;
        const date = new Date(typeof value === 'number' || typeof value === 'bigint' ? Number(value) * 1000 : value);
        if (!Number.isFinite(date.getTime())) return null;
        const time = element('time', new Intl.DateTimeFormat(win.i18n?.getLocale?.() || 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(date));
        time.dateTime = date.toISOString();
        time.title = time.dateTime;
        return time;
    }
    const loading = () => element('p', t('lensConsole.loading', 'Loading…'), 'lc-muted lc-loading');
    const message = text => element('p', text, 'lc-muted');
    function disclosure(id, label) {
        const details = element('details', null, 'lc-proof');
        details.id = id;
        details.append(element('summary', label));
        return details;
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
    // Load the large web3 and signature verification libraries only when a record needs them.
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
    function drawRule(s) {
        const { rule } = s.record.content;
        const block = element('div');
        const description = rule.electorate === 'owners'
            ? win.ProposalApprovalText.rulesText(rule.approvalConfig?.policy, t, win.AgreementRecord.schemeOf(rule))
            : rule.electorate === 'investors' ? t('agreement.lens.crowdfunding', 'The program checks the funding target. The lens checks investor eligibility and any other conditions.')
                : w('community', 'Community members vote on the agreement.');
        block.append(element('p', description));
        const facts = element('dl', null, 'lc-facts');
        const keys = (rule.lens || []).map(x => typeof x === 'string' ? x : x?.address).filter(Boolean);
        for (const key of keys) facts.append(field(w('selected', 'Selected lens'), member(key)));
        for (const chainLens of s.chain?.account?.lenses || []) {
            if (!keys.includes(chainLens)) facts.append(field(w('chainLens', 'Lens named on Solana'), member(chainLens)));
        }
        block.append(facts.childElementCount ? facts : message(w('noLens', 'This agreement names no lens member.')));
        setContent(byId('lc-rule'), block);
    }
    function drawReceipts(s) {
        if (s.record.content.rule.electorate !== 'owners') return;
        const target = byId('lc-receipts');
        if (s.receiptsError) return setContent(target, message(w('unavailable', 'This source could not be read.')));
        if (!s.receipts) return setContent(target, loading());
        if (!s.receipts.length) return setContent(target, message(w('noReceipts', 'No owner decisions have been relayed.')));
        const rows = s.receipts.map(({ receipt, verified }, i) => {
            const outcome = receipt.decision === 'approve' ? w('approved', 'Approved') : receipt.decision === 'withdraw' ? w('withdrew', 'Withdrew approval') : (receipt.decision || '—');
            const signedAt = when(receipt.decidedAt);
            const details = disclosure('lc-owner-' + i, outcome + ' · ' + win.LensCore.shortKey(receipt.actorId) + (signedAt ? ' · ' + signedAt.textContent : ''));
            if (!verified) details.firstChild.append(' · ', w('invalid', 'Receipt could not be verified'));
            const facts = element('dl', null, 'lc-facts');
            facts.append(field(w('signed', 'Signed by'), receipt.actorId || '—'));
            if (receipt.ownerId && receipt.ownerId !== receipt.actorId) facts.append(field(w('owner', 'Owner'), receipt.ownerId));
            for (const [fact, label] of [[receipt.evidence?.rights, w('rights', 'Rights attested by')], [receipt.evidence?.authority, w('authority', 'Signing authority attested by')]]) {
                if (fact?.member) facts.append(field(label, member(fact.member)));
            }
            details.append(element('p', verified ? w('valid', 'Signatures verified') : w('invalid', 'Receipt could not be verified'), verified ? 'lc-ok' : 'lc-warn'), facts);
            const raw = disclosure('lc-owner-raw-' + i, w('raw', 'Signed receipt'));
            raw.append(element('pre', JSON.stringify(receipt, null, 2)));
            details.append(raw);
            return details;
        });
        setContent(target, ...rows);
    }
    function drawStatement(s) {
        const target = byId('lc-statement');
        const recorded = s.chain?.account?.decisionAttestation;
        const verified = s.chain?.statement;
        const receipt = recorded ? s.issued?.find(r => r.address === recorded) : s.issued?.[0];
        const nodes = [];
        if (verified || receipt || recorded) {
            const title = verified ? w('matched', 'Verified against the agreement on Solana.')
                : recorded ? w('recorded', 'Recorded on Solana') : s.chain?.account ? w('issued', 'Issued by the member · awaiting recording') : w('listed', 'Reported by the member');
            nodes.push(element('p', title, verified ? 'lc-ok' : ''));
            const att = verified?.fields || receipt?.payload;
            const facts = element('dl', null, 'lc-facts');
            const signer = verified?.signer || receipt?.authority;
            if (signer) facts.append(field(w('signed', 'Signed by'), member(signer)));
            if (att?.decision) facts.append(field(t('lensConsole.attestations.decision', 'Decision'), att.decision === 'satisfied' ? w('met', 'The agreement’s approval rule was met.') : String(att.decision)));
            const observed = when(att?.sourceObservedAt), issued = when(receipt?.issuedAt), at = when(s.chain?.account?.decisionAttestedAt);
            if (observed) facts.append(field(w('sourceTime', 'Source observed'), observed));
            if (issued) facts.append(field(t('lensConsole.attestations.issuedAt', 'Issued (chain time)'), issued));
            if (recorded && at) facts.append(field(w('recordedTime', 'Decision recorded'), at));
            nodes.push(facts);
            if (verified && s.ownerEvidenceRef && att.evidenceRef === s.ownerEvidenceRef) {
                nodes.push(anchor(w('receiptsMatch', 'The owner approvals match the evidence cited by this member.'), '#lc-receipts-title'));
            }
            const details = disclosure('lc-decision-proof', w('details', 'Evidence details'));
            const meta = element('dl', null, 'lc-facts');
            if (att?.evidenceRef) meta.append(field(w('evidence', 'Evidence reference'), att.evidenceRef));
            const address = recorded || receipt?.address;
            if (address) meta.append(field(t('lensConsole.decision.address', 'Attestation'), explorer(address, address)));
            if (receipt?.transactionSignature) meta.append(field(w('tx', 'Issuance transaction'), explorer(receipt.transactionSignature, receipt.transactionSignature, 'tx')));
            const credential = verified?.credential || receipt?.credential, schema = verified?.schema || receipt?.schema;
            if (credential) meta.append(field(t('lensActivity.credential', 'Credential'), explorer(credential, credential)));
            if (schema) meta.append(field(t('lensActivity.schema', 'Schema'), explorer(schema, schema)));
            details.append(meta);
            nodes.push(details);
            if (address && signer) nodes.push(anchor(w('exact', 'Open this statement'), links.pageUrl({ member: signer, attestation: address, subject: s.cid, city: s.record.city })));
            if (!recorded && s.issued?.length > 1) {
                for (const other of s.issued.slice(1)) {
                    const row = element('p');
                    row.append(member(other.authority), ' · ', anchor(w('exact', 'Open this statement'), links.pageUrl({ member: other.authority, attestation: other.address, subject: s.cid, city: s.record.city })));
                    nodes.push(row);
                }
            }
        } else if (s.chainError) nodes.push(message(w('noChain', 'The live Solana account could not be read.')));
        else if (s.chainPending || s.servicePending) nodes.push(loading());
        else if (s.record.content.rule.binding === false) nodes.push(message(w('nonbinding', 'This vote is counted off chain.')));
        else nodes.push(message(w('awaiting', 'Awaiting a recorded lens decision.')));
        if (s.chain?.statementError) nodes.push(message(w('proofUnavailable', 'The signed statement could not be verified.')));
        if (s.serviceError && !verified) nodes.push(message(w('unavailable', 'This source could not be read.')));
        setContent(target, ...nodes);
    }
    function drawExecution(s) {
        const target = byId('lc-execution');
        const account = s.chain?.account;
        if (!account) {
            const text = s.chainError ? w('noChain', 'The live Solana account could not be read.') : s.record.onchain ? w('noAccount', 'The indexed agreement account was not found.')
                : s.record.content.rule.binding === false ? w('nonbinding', 'This vote is counted off chain.') : w('unminted', 'This agreement has no indexed Solana account.');
            if (s.chainPending) return setContent(target, loading());
            const indexed = s.chainError && s.record.onchain?.status;
            if (indexed) {
                const labels = { executed: w('executed', 'Executed'), active: w('active', 'Awaiting execution'), expired: w('expired', 'Expired'), cancelled: w('cancelled', 'Cancelled') };
                const snapshot = element('p', w('indexed', 'Last indexed outcome') + ' · ' + (labels[indexed] || indexed));
                return setContent(target, snapshot, message(text));
            }
            return setContent(target, message(text));
        }
        const status = { Active: w('active', 'Awaiting execution'), Executed: w('executed', 'Executed'), Cancelled: w('cancelled', 'Cancelled'), Expired: w('expired', 'Expired') }[account.status] || account.status;
        const outcome = element('p', status, 'lc-result' + (account.status === 'Executed' ? ' lc-ok' : ''));
        const at = when(account.executedAt);
        if (account.status === 'Executed' && at) outcome.append(' · ', at);
        setContent(target, outcome, explorer(w('account', 'View agreement account'), account.address));
    }
    function draw(s) {
        if (current !== s || !s.record) return;
        drawRule(s); drawReceipts(s); drawStatement(s); drawExecution(s);
        byId('lc-retry').hidden = !win.BusyControl.isBusy(byId('lc-retry')) && !(s.receiptsError || s.chainError || s.chain?.statementError || s.serviceError || listError);
    }
    async function readReceipts(s) {
        if (s.record.content.rule.electorate !== 'owners') return;
        try {
            const [body] = await Promise.all([json('/agreements/' + s.record.cid + '/decisions'), library('vendor/noble-curves-1.2.0/ed25519.js')]);
            if (body.agreementCid !== s.record.cid || !Array.isArray(body.decisions)) throw new Error('Unexpected receipt response');
            const subject = { ...win.AgreementRecord.approvalSubject(s.record.content), agreementCid: s.record.cid };
            s.receipts = body.decisions.map(receipt => ({ receipt, verified: win.ProposalApprovalRelay.verifyLensReceipt(subject, receipt) }));
            const verifiedReceipts = s.receipts.filter(row => row.verified).map(row => row.receipt);
            const folded = win.ProposalApprovalRelay.fold(subject, verifiedReceipts, () => true);
            if (verifiedReceipts.length) s.ownerEvidenceRef = win.ProposalApproval.decisionEvidenceRef(win.ProposalApprovalRelay.countedApprovals(folded));
        } catch { s.receiptsError = true; }
        if (current === s) { drawReceipts(s); drawStatement(s); if (s.receiptsError) byId('lc-retry').hidden = false; }
    }
    async function readStatement(s) {
        try {
            await library('vendor/solana-web3-1.98.4/index.iife.min.js');
            const connection = await win.SolanaChainDataLoader.getVerifiedConnection(s.record.onchain.cluster);
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
    async function readIssued(s) {
        await directoryReady;
        if (current !== s) return;
        const keys = s.record.onchain?.lenses || s.record.content.rule.lens || [];
        const results = await Promise.allSettled((s.record.content.sponsor ? keys : []).map(async key => {
            const issuer = directory.get(key);
            if (directoryError || !issuer?.serviceUrl) throw new Error('Member service unavailable');
            const result = await win.LensServiceClient.fetchAttestations({ serviceUrl: issuer.serviceUrl, filter: { agreementCid: s.cid, kind: 'decision' } });
            if (!Array.isArray(result.attestations)) throw new Error('Member feed unavailable');
            return result.attestations.filter(r => r.authority === key && r.kind === 'decision' && r.payload?.agreementCid === s.cid
                && r.payload.sponsor === s.record.content.sponsor && r.payload.decision === 'satisfied' && win.LensCore.isBase58Pubkey(r.address));
        }));
        s.issued = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
        s.serviceError = results.some(result => result.status === 'rejected');
        s.servicePending = false; draw(s);
    }
    async function openAgreement(cid) {
        const s = { cid, record: null, servicePending: true };
        current = s;
        byId('lc-story').hidden = true;
        byId('lc-retry').hidden = !win.BusyControl.isBusy(byId('lc-retry'));
        byId('lc-flow-status').replaceChildren(loading());
        try {
            if (!win.Cid.isCid(cid)) throw new Error('Invalid CID');
            const record = await json('/agreements/' + encodeURIComponent(cid));
            if (current !== s) return;
            if (record.cid !== cid || record.content?.schema !== 'agreement/v1' || !record.content.rule || win.Cid.cidOfObject(record.content) !== cid) throw new Error('Agreement does not match CID');
            s.record = record; s.chainPending = !!record.onchain;
            byId('lc-subject').textContent = record.content.title || record.title || cid;
            byId('lc-map-agreement').href = links.mapUrl({ agreement: cid, city: record.city });
            byId('lc-owner-stage').hidden = record.content.rule.electorate !== 'owners';
            byId('lc-story').hidden = false;
            byId('lc-flow-status').replaceChildren();
            drawList(); draw(s);
            await Promise.all([readReceipts(s), readIssued(s), record.onchain && readStatement(s)]);
        } catch {
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
            const example = list.find(r => r.onchain?.status === 'executed' && r.onchain.decision === 'satisfied') || list[0];
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
