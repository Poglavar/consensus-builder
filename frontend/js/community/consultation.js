// Community consultation presentation and reporting: direct website verification, append-only
// signed reports and an external participation link. The agreement itself is never rewritten.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CommunityConsultation = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const results = () => root.CommunityResult || require('./result.js');
    const did = () => root.CommunityDidWeb || require('./did-web.js');
    const cidApi = () => root.Cid || require('../cid.js');
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    function t(key, fallback, params = {}) {
        const value = root.i18n?.t?.(key, params);
        return String(value && value !== key ? value : fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => params[name] ?? '');
    }
    const failure = (code, message) => Object.assign(new Error(message), { code });

    function createClient(win) {
        async function request(method, agreementCid, payload) {
            const base = String(win.resolveBackendBaseUrl() || '').replace(/\/$/, '');
            const response = await win.fetch(`${base}/agreements/${encodeURIComponent(agreementCid)}/community-reports`, {
                method, headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
                cache: 'no-store', signal: AbortSignal.timeout(45000), ...(payload ? { body: JSON.stringify(payload) } : {})
            });
            const body = await response.json();
            if (!response.ok) throw failure(body.code || 'report-request-failed', body.error || `HTTP ${response.status}`);
            return body;
        }
        async function list(agreementCid) {
            const body = await request('GET', agreementCid);
            if (body.agreementCid !== agreementCid || !Array.isArray(body.reports)) throw failure('invalid-report-index', t('community.errors.index', 'The server returned an invalid report history.'));
            return body.reports;
        }
        async function publish(content) {
            const cid = cidApi().cidOfObject(content);
            const response = await request('POST', content.agreementCid, { cid, content });
            if (response.cid !== cid || response.stored !== true) throw failure('report-not-stored', t('community.errors.notStored', 'The server did not confirm this report.'));
            const rows = await list(content.agreementCid);
            const observed = rows.find(row => row.cid === cid && cidApi().cidOfObject(row.content) === cid);
            if (!observed) throw failure('report-not-observed', t('community.errors.notObserved', 'The report was submitted, but could not be read back. Retry to confirm it.'));
            return { cid, rows };
        }
        return { list, publish };
    }

    function setupDocument(organiser, wallet, cluster) {
        const reference = results().CLUSTERS[cluster];
        if (!organiser || !wallet?.address || !reference) return null;
        const id = `${organiser}#reporter`;
        return {
            '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2018/v1',
                { blockchainAccountId: 'https://w3id.org/security#blockchainAccountId' }],
            id: organiser,
            verificationMethod: [{ id, type: 'Ed25519VerificationKey2018', controller: organiser,
                publicKeyBase58: wallet.address, blockchainAccountId: `solana:${reference}:${wallet.address}` }],
            assertionMethod: [id]
        };
    }

    function reportHtml(row, tr = t) {
        const report = row.content;
        const listed = row.websiteStatus === 'listed';
        const badge = listed ? tr('community.website.listed', 'Website lists this reporting wallet')
            : row.websiteStatus === 'unlisted' ? tr('community.website.unlisted', 'Wallet not listed by website')
                : tr('community.website.unavailable', 'Website verification unavailable');
        // Unverified website attribution is explicitly a wallet's claim, never the site's words.
        const attribution = listed ? tr('community.report.says', '{{site}} reports:', { site: new URL(did().documentUrl(report.attester)).host })
            : tr('community.report.walletSays', 'Signed wallet statement; website attribution unverified:');
        return `<article class="community-report" data-community-report="${esc(row.cid)}">`
            + `<span class="cb-badge cb-badge--${listed ? 'success' : 'neutral'}" data-community-website="${esc(row.websiteStatus)}">${esc(badge)}</span>`
            + `<p class="agreement-panel-meta">${esc(attribution)}</p><blockquote>${esc(report.statement)}</blockquote>`
            + `<p class="agreement-panel-meta"><time datetime="${esc(report.postedAt)}">${esc(root.CbFormat?.formatDateTime?.(report.postedAt) || report.postedAt)}</time></p>`
            + `<p class="agreement-panel-meta community-report-signer">${esc(report.signer)}</p>`
            + '<div class="agreement-panel-actions">'
            + (report.url ? `<a class="btn btn-sm btn-secondary" href="${esc(report.url)}" target="_blank" rel="noopener noreferrer">${esc(tr('community.report.details', 'Read the organiser’s report'))}</a>` : '')
            + `<a class="btn btn-sm btn-quiet" href="https://ipfs.io/ipfs/${esc(row.cid)}" target="_blank" rel="noopener noreferrer">${esc(tr('community.report.signed', 'Signed record'))}</a></div></article>`;
    }

    function picturesHtml(remote, tr = t) {
        const image = remote?.screenshotPairUrl;
        if (!image) return '';
        let url;
        try { url = results().httpsUrl(image); } catch (_) { return ''; }
        return `<figure class="community-pictures"><img src="${esc(url)}" alt="${esc(tr('community.pictures', 'Before / after'))}" loading="lazy">`
            + `<figcaption class="agreement-panel-meta">${esc(tr('community.pictures', 'Before / after'))}</figcaption></figure>`;
    }

    function viewHtml(agreement, state = {}, wallet = null, cluster = 'devnet', tr = t) {
        const consultation = agreement.consultation || {};
        const organiser = consultation.organiser;
        const published = agreement.published?.cid;
        const url = consultation.participationUrl;
        const intro = `<p class="agreement-panel-note" data-agreement-community-note>${esc(tr('community.intro', 'This consultation asks for non-binding community support. It gives no owner consent and moves no land or money.'))}</p>`;
        const takePart = url ? `<a class="btn btn-primary" data-community-participate href="${esc(results().httpsUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(tr('community.takePart', 'Take part'))}</a>` : '';
        const identity = organiser ? `<p class="agreement-panel-meta">${esc(tr('community.organiser', 'Organiser'))}: <a href="${esc(did().documentUrl(organiser))}" target="_blank" rel="noopener noreferrer">${esc(organiser)}</a></p>` : '';
        if (!published || !organiser) return intro + identity + takePart;
        const rows = state.rows || [];
        // Prefer the newest currently website-authorized report; retain all others as history.
        const latest = rows.find(row => row.websiteStatus === 'listed') || rows[0];
        const history = rows.filter(row => row !== latest);
        const reports = latest ? reportHtml(latest, tr) : `<p class="agreement-panel-meta">${esc(tr('community.noReports', 'No result has been reported yet.'))}</p>`;
        const setup = setupDocument(organiser, wallet, cluster);
        const enabled = !state.busy;
        const button = (action, label) => `<button type="button" class="btn btn-sm btn-secondary" data-community-action="${action}"${enabled ? '' : ' disabled'}>${esc(label)}</button>`;
        return intro + identity + takePart
            + `<p class="agreement-panel-hint">${esc(tr('community.verificationMeaning', 'Website verification only confirms that the site currently lists the signing wallet. The organiser is responsible for eligibility, counting and the statement.'))}</p>`
            + `<div class="agreement-panel-actions">${button('refresh', tr('community.refresh', 'Refresh verification'))}${button('compose', tr('community.reportResult', 'Report a result'))}</div>`
            + (state.loading ? `<p class="agreement-panel-meta" role="status">${esc(tr('community.loading', 'Checking reports and the organiser’s website…'))}</p>` : '')
            + (state.error ? `<p class="agreement-panel-note agreement-panel-note--danger" role="alert">${esc(state.error)}</p>` : '')
            + (state.websiteError ? `<p class="agreement-panel-hint" role="status">${esc(tr('community.website.failed', 'The organiser’s website could not be checked. It must allow browser access to its DID document.'))}</p>` : '')
            + reports
            + (history.length ? `<details class="community-history"><summary>${esc(tr('community.history', 'Previous reports ({{count}})', { count: history.length }))}</summary>${history.map(row => reportHtml(row, tr)).join('')}</details>` : '')
            + (state.composing ? '<form class="community-report-form" data-community-form>'
                + `<label class="agreement-mint__field"><span>${esc(tr('community.statement', 'Result statement (up to 280 characters)'))}</span><textarea data-community-statement rows="3" required>${esc(state.statement || '')}</textarea></label>`
                + `<label class="agreement-mint__field"><span>${esc(tr('community.resultUrl', 'Full report URL (optional)'))}</span><input type="url" data-community-url value="${esc(state.url || '')}" placeholder="https://"></label>`
                + `<p class="agreement-panel-hint">${esc(tr('community.signHint', 'A Solana wallet listed by the organiser’s website signs this statement. Signing costs no transaction fee.'))}</p>`
                + `<div class="agreement-panel-actions"><button class="btn btn-primary" type="submit"${enabled ? '' : ' disabled'}>${esc(state.busy ? tr('community.publishing', 'Signing and publishing…') : tr('community.signPublish', 'Sign and publish'))}</button>${button('cancel', tr('common.cancel', 'Cancel'))}</div></form>` : '')
            + (state.success ? `<p class="agreement-panel-meta" role="status">${esc(tr('community.published', 'Signed report published and read back.'))}</p>` : '')
            + '<details class="community-setup"><summary>' + esc(tr('community.setup.title', 'Set up website reporting')) + '</summary>'
            + `<p class="agreement-panel-hint">${esc(tr('community.setup.instructions', 'Serve the DID document at the address above with Access-Control-Allow-Origin: *. It must name the reporting wallet under assertionMethod. Keep existing methods when adding a wallet.'))}</p>`
            + (setup ? `<pre><code>${esc(JSON.stringify(setup, null, 2))}</code></pre>`
                : button('connect', tr('community.setup.connect', 'Connect reporting wallet to see a document example')))
            + '</details>';
    }

    function createController(win, { changed }) {
        const client = createClient(win);
        let agreement = null, token = 0;
        let state = {};
        const wallet = () => win.ProposalApprovalLensAuthority.browserWallet();
        const cluster = () => win.solanaWalletManager?.getCluster?.();
        const redraw = () => changed();
        const localError = error => {
            if (error.code === 4001 || /user rejected|user denied/i.test(error.message)) return t('community.errors.declined', 'The wallet signature was declined.');
            const messages = {
                'wallet-not-listed': t('community.errors.wallet', 'The organiser’s website does not list this wallet on this network for reporting.'),
                'invalid-url': t('community.errors.url', 'Use an HTTPS report address without credentials.'),
                'wallet-required': t('community.errors.walletRequired', 'Connect a Solana wallet on a supported network.'),
                'invalid-community-report': t('community.errors.statement', 'Enter a plain-text statement of up to 280 characters.')
            };
            return messages[error.code] || t('community.errors.failed', 'The report could not be published: {{reason}}', { reason: error.message });
        };

        async function load(next, { force = false } = {}) {
            if (next?.rule?.electorate !== 'community' || !next.published?.cid || !next.consultation?.organiser) return;
            if (!force && agreement?.published?.cid === next.published.cid) { agreement = next; return; }
            const same = agreement?.published?.cid === next.published.cid;
            agreement = next;
            const mine = ++token;
            state = { ...(same ? state : {}), loading: true, success: false, error: null, websiteError: false };
            redraw();
            // All website checks stay in the browser, with CORS and without sending credentials.
            const [history, identity] = await Promise.allSettled([
                client.list(next.published.cid), did().resolve(next.consultation.organiser, { fetch: win.fetch.bind(win) })
            ]);
            if (mine !== token) return;
            const resolved = identity.status === 'fulfilled' ? identity.value : null;
            try {
                if (history.status !== 'fulfilled') throw history.reason;
                const rows = await results().inspectReports(history.value, {
                    agreementCid: next.published.cid, organiser: next.consultation.organiser, resolved
                });
                if (mine !== token) return;
                state = { ...state, rows, loading: false, websiteError: !resolved, resolved };
            } catch (error) {
                if (mine !== token) return;
                state = { ...state, rows: [], loading: false, error: t('community.errors.history', 'Report history is unavailable or could not be verified. Refresh to try again.'), websiteError: !resolved, resolved };
            }
            redraw();
        }

        async function publish() {
            if (state.busy || !agreement) return;
            const mine = token, current = agreement;
            state.busy = true; state.error = null; state.success = false;
            redraw();
            try {
                const currentWallet = await win.ProposalApprovalLensAuthority.connectWallet();
                const resolved = await did().resolve(current.consultation.organiser, { fetch: win.fetch.bind(win) });
                if (mine !== token) return;
                const content = await results().signReport({
                    agreementCid: current.published.cid, organiser: current.consultation.organiser,
                    statement: state.statement || '', url: state.url || null, resolved, wallet: currentWallet, cluster: cluster()
                });
                if (mine !== token) return;
                const { rows } = await client.publish(content);
                const checked = await results().inspectReports(rows, { agreementCid: current.published.cid, organiser: current.consultation.organiser, resolved });
                if (mine !== token) return;
                state = { ...state, rows: checked, resolved, websiteError: false, composing: false, statement: '', url: '', success: true };
            } catch (error) {
                if (mine === token) state.error = localError(error);
            } finally {
                if (mine === token) { state.busy = false; redraw(); }
            }
        }

        function render(slot, next) {
            if (!slot) return;
            slot.innerHTML = viewHtml(next, agreement?.published?.cid === next.published?.cid ? state : {}, wallet(), cluster());
            slot.addEventListener('input', event => {
                if (event.target.matches('[data-community-statement]')) state.statement = event.target.value;
                if (event.target.matches('[data-community-url]')) state.url = event.target.value;
            });
            slot.addEventListener('submit', event => { event.preventDefault(); publish(); });
            slot.addEventListener('click', event => {
                const action = event.target.closest('[data-community-action]');
                if (!action || action.disabled) return;
                switch (action.dataset.communityAction) {
                    case 'refresh': load(next, { force: true }); break;
                    case 'compose': state.composing = true; state.success = false; redraw(); break;
                    case 'cancel': state.composing = false; redraw(); break;
                    case 'connect': win.ProposalApprovalLensAuthority.connectWallet().then(redraw).catch(error => { state.error = localError(error); redraw(); }); break;
                }
            });
        }
        return { load, render, reset: () => { token++; agreement = null; state = {}; } };
    }
    return { createClient, setupDocument, viewHtml, reportHtml, picturesHtml, createController };
});
