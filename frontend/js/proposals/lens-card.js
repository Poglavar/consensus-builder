// Proposal Details "Lens" card for Solana proposals: the lens decoded from the proposal account with
// member names from the attester directory, and per parcel: the on-chain consent tally, "Attest my
// ownership" (challenge -> signMessage -> POST /lens/ownership at a lens member) and "Say yes"
// (accept_with_attestations signed by the attested owner's wallet). Below the parcels, a
// permissionless "Submit verdict" (settle_with_verdict). Logic lives in lens-core,
// lens-service-client, solana/acceptance-client and solana/acceptance-bridge.
(function () {
    const root = typeof window !== 'undefined' ? window : null;
    if (!root) return;

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

    function explorerUrl(address, cluster) {
        return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=${encodeURIComponent(cluster || 'devnet')}`;
    }

    function log(level, message, extra) {
        const line = `[${new Date().toISOString()}] [ProposalLensCard] ${message}`;
        if (extra === undefined) console[level](line); else console[level](line, extra);
    }

    async function connectWallet() {
        const manager = root.solanaWalletManager;
        if (!manager) throw new Error(t('panel.proposal.lens.noWallet', 'No Solana wallet found in this browser.'));
        let state = manager.getState();
        if (state.status !== 'connected' || !state.accounts.length) {
            const connectors = manager.getConnectors();
            if (!connectors.length) throw new Error(t('panel.proposal.lens.noWallet', 'No Solana wallet found in this browser.'));
            state = await manager.connect(connectors[0].id);
        }
        return { manager, state, provider: manager.getProvider() };
    }

    async function connectedWallet() {
        const { manager, state, provider } = await connectWallet();
        if (!provider || typeof provider.signMessage !== 'function') {
            throw new Error(t('panel.proposal.lens.noSignMessage', 'This wallet cannot sign messages.'));
        }
        return { owner: state.accounts[0], cluster: manager.getCluster(), sign: bytes => provider.signMessage(bytes, 'utf8') };
    }

    // Accept / settle need transaction signing, not message signing.
    async function transactionWallet() {
        const { provider } = await connectWallet();
        if (!provider || typeof provider.signTransaction !== 'function') {
            throw new Error(t('panel.proposal.lens.noSignTransaction', 'This wallet cannot sign transactions.'));
        }
    }

    function currentWallet() {
        const state = root.solanaWalletManager && root.solanaWalletManager.getState ? root.solanaWalletManager.getState() : null;
        return state && state.status === 'connected' && state.accounts.length ? state.accounts[0] : null;
    }

    function outcomeText(result) {
        const { step, outcome } = result;
        if (step === 'payment') {
            return result.price
                ? t('panel.proposal.lens.paymentRequired', 'This lens member charges {{price}} per ownership attestation, paid over x402. Paying from the browser is not supported yet; an agent or CLI x402 client can pay it.', { price: result.price })
                : t('panel.proposal.lens.paymentRequiredNoPrice', 'This lens member requires an x402 payment for ownership attestations. Paying from the browser is not supported yet.');
        }
        if (step === 'check') return t('panel.proposal.lens.badChallenge', 'The service returned a challenge that does not match this wallet and parcel ({{reason}}); nothing was signed.', { reason: outcome.code });
        if (outcome.kind === 'not_configured') return t('panel.proposal.lens.notConfigured', 'This lens member is not configured to issue attestations: {{message}}', { message: outcome.message || outcome.status });
        return t('panel.proposal.lens.refused', 'The lens member refused: {{message}}', { message: outcome.message || outcome.code || `HTTP ${outcome.status}` });
    }

    // Transaction lifecycle states emitted by SolanaAcceptanceBridge -> one progress line.
    function statusText(state) {
        switch (state) {
            case 'finding_attestation': return t('panel.proposal.lens.findingAttestation', 'Looking for your ownership attestation…');
            case 'preparing': return t('panel.proposal.lens.preparing', 'Preparing the transaction…');
            case 'awaiting_signature': return t('panel.proposal.lens.awaitingSignature', 'Waiting for your wallet signature…');
            case 'submitted': return t('panel.proposal.lens.submitted', 'Submitted; waiting for confirmation…');
            default: return '';
        }
    }

    function txLink(url) {
        return url ? `<a href="${escapeText(url)}" target="_blank" rel="noopener">${escapeText(t('panel.proposal.lens.viewTransaction', 'View transaction'))} ↗</a>` : '';
    }

    function errorText(error, members) {
        const code = error && error.code;
        if (code === 'NO_ATTESTATION') {
            return error.requiredMember
                ? t('panel.proposal.lens.noAttestationMember', 'No ownership attestation for this wallet from {{member}}, the lens member that opened this parcel\'s tally. Ask it with "Attest my ownership" first.', { member: root.LensCore.memberLabel(error.requiredMember, members) })
                : t('panel.proposal.lens.noAttestation', 'No lens member has attested this wallet as an owner of this parcel. Use "Attest my ownership" first.');
        }
        if (code === 'ALREADY_ACCEPTED') return t('panel.proposal.lens.alreadyAccepted', 'This wallet has already said yes for this parcel.');
        if (code === 'BAD_PAYOUT') return t('panel.proposal.lens.badPayout', 'The payout must be a Solana address, or empty.');
        if (code === 'BAD_ATTESTATION') return t('panel.proposal.lens.badVerdictAddress', 'Paste the address of a verdict attestation.');
        if (code === 'PRECHECK_FAILED') return t('panel.proposal.lens.precheckFailed', 'The program would reject this ({{reason}}); nothing was signed.', { reason: error.reason });
        if (typeof root.parseOnChainErrorMessage === 'function' && (error.logs || /Error Code:/.test(String(error.message)))) {
            return root.parseOnChainErrorMessage(error);
        }
        return error && error.message ? error.message : String(error);
    }

    function consentText(entry, members) {
        if (!entry) return '';
        const { tally, record, complete } = entry;
        const parts = [];
        if (complete) {
            parts.push(tally
                ? t('panel.proposal.lens.consentComplete', 'Consent complete: {{accepted}} of {{required}} attested owners said yes.', { accepted: tally.accepted, required: tally.required })
                : t('panel.proposal.lens.consentCompleteLegacy', 'Accepted on chain.'));
        } else if (tally) {
            parts.push(t('panel.proposal.lens.consentProgress', '{{accepted}} of {{required}} attested owners said yes (owners attested by {{member}}).', {
                accepted: tally.accepted, required: tally.required, member: root.LensCore.memberLabel(tally.member, members)
            }));
        } else {
            parts.push(t('panel.proposal.lens.consentNone', 'No attested owner has said yes yet.'));
        }
        if (record) parts.push(t('panel.proposal.lens.consentYours', 'Your wallet said yes.'));
        return parts.join(' ');
    }

    function renderParcelRow(parcelUid, lensMembers) {
        const withService = lensMembers.filter(member => member.serviceUrl);
        const options = lensMembers.map(member => `<option value="${escapeText(member.key)}" ${member.serviceUrl ? '' : 'disabled'}>${escapeText(member.label)}${member.serviceUrl ? '' : ` (${escapeText(t('panel.proposal.lens.noServiceUrlShort', 'no service URL'))})`}</option>`).join('');
        return `
            <li class="proposal-lens-parcel" data-lens-parcel="${escapeText(parcelUid)}">
                <span class="proposal-lens-parcel-id">${escapeText(parcelUid)}</span>
                <span class="proposal-lens-consent" data-lens-consent aria-live="polite">${escapeText(t('panel.proposal.lens.consentLoading', 'Reading consent from chain…'))}</span>
                ${withService.length ? `
                    <div class="proposal-lens-parcel-actions">
                        <select data-lens-parcel-member aria-label="${escapeText(t('panel.proposal.lens.memberSelect', 'Lens member'))}">${options}</select>
                        <button type="button" class="btn btn-secondary" data-lens-attest>${escapeText(t('panel.proposal.lens.requestAttestation', 'Attest my ownership'))}</button>
                    </div>
                    <div class="proposal-lens-parcel-actions" data-lens-yes-row>
                        <input type="text" class="lens-input" data-lens-payout autocomplete="off" spellcheck="false"
                            placeholder="${escapeText(t('panel.proposal.lens.payoutPlaceholder', 'Payout address (optional)'))}"
                            aria-label="${escapeText(t('panel.proposal.lens.payoutLabel', 'Payout address for your share of the proposal funds (optional)'))}">
                        <button type="button" class="btn btn-action" data-lens-say-yes>${escapeText(t('panel.proposal.lens.sayYes', 'Say yes'))}</button>
                    </div>` : `<small>${escapeText(t('panel.proposal.lens.noServiceUrl', 'No service URL: none of this lens publishes where to ask for an attestation.'))}</small>`}
                <div class="proposal-lens-result" data-lens-result aria-live="polite"></div>
            </li>`;
    }

    function renderConsent(section, state, members) {
        section.querySelectorAll('[data-lens-parcel]').forEach(row => {
            const parcelUid = row.getAttribute('data-lens-parcel');
            const entry = state.parcels[parcelUid];
            const line = row.querySelector('[data-lens-consent]');
            if (line) line.textContent = consentText(entry, members);
            row.classList.toggle('is-complete', !!(entry && entry.complete));
            const yesRow = row.querySelector('[data-lens-yes-row]');
            // A parcel whose consent is complete, or a wallet that already said yes, has nothing to sign.
            if (yesRow) yesRow.hidden = !!(entry && (entry.complete || entry.record)) || state.proposal.statusCode !== 0;
        });
    }

    async function refreshConsent(section, ctx) {
        if (!ctx.proposalAccount || !root.SolanaAcceptanceBridge) return;
        try {
            const state = await root.SolanaAcceptanceBridge.readAcceptanceState({ proposal: ctx.proposalAccount, parcelIds: ctx.parcelIds, owner: currentWallet() });
            if (!section.isConnected) return;
            renderConsent(section, state, ctx.members);
            const verdictStatus = section.querySelector('[data-lens-proposal-status]');
            if (verdictStatus) verdictStatus.textContent = t('panel.proposal.lens.proposalStatus', 'On-chain status: {{status}}.', { status: state.proposal.status });
        } catch (error) {
            log('warn', 'consent state unavailable', error);
            if (!section.isConnected) return;
            section.querySelectorAll('[data-lens-consent]').forEach(line => {
                line.textContent = t('panel.proposal.lens.consentUnavailable', 'Consent state unavailable: {{message}}', { message: error && error.message ? error.message : String(error) });
            });
        }
    }

    function bindAttest(section, lensMembers) {
        section.querySelectorAll('[data-lens-attest]').forEach(button => {
            button.addEventListener('click', async () => {
                const row = button.closest('[data-lens-parcel]');
                const parcelUid = row.getAttribute('data-lens-parcel');
                const memberKey = row.querySelector('[data-lens-parcel-member]').value;
                const target = lensMembers.find(entry => entry.key === memberKey);
                const out = row.querySelector('[data-lens-result]');
                out.className = 'proposal-lens-result';
                out.textContent = t('panel.proposal.lens.working', 'Waiting for the wallet and the lens member…');
                button.disabled = true;
                try {
                    const wallet = await connectedWallet();
                    const result = await root.LensServiceClient.runOwnershipFlow({
                        serviceUrl: target.serviceUrl, parcelUid, owner: wallet.owner, memberKey, sign: wallet.sign
                    });
                    if (result.step === 'done') {
                        const body = result.body || {};
                        out.classList.add('is-ok');
                        const headline = body.reused
                            ? t('panel.proposal.lens.attestedExisting', 'Already attested.')
                            : t('panel.proposal.lens.attested', 'Attested.');
                        out.innerHTML = `${escapeText(headline)}
                            <span>${escapeText(t('panel.proposal.lens.attestationAddress', 'Attestation'))}: <a href="${explorerUrl(body.address, wallet.cluster)}" target="_blank" rel="noopener">${escapeText(body.address)}</a></span>
                            <span>${escapeText(t('panel.proposal.lens.accountHash', 'Account hash'))}: <code>${escapeText(body.accountHash)}</code></span>`;
                    } else {
                        out.classList.add(result.step === 'payment' ? 'is-warn' : 'is-error');
                        out.textContent = outcomeText(result);
                    }
                } catch (error) {
                    log('error', 'ownership flow failed', error);
                    out.classList.add('is-error');
                    out.textContent = error && error.message ? error.message : String(error);
                } finally {
                    button.disabled = false;
                }
            });
        });
    }

    function bindSayYes(section, ctx, lensMembers) {
        section.querySelectorAll('[data-lens-say-yes]').forEach(button => {
            button.addEventListener('click', async () => {
                const row = button.closest('[data-lens-parcel]');
                const parcelUid = row.getAttribute('data-lens-parcel');
                const payout = row.querySelector('[data-lens-payout]').value.trim() || null;
                const out = row.querySelector('[data-lens-result]');
                out.className = 'proposal-lens-result';
                out.textContent = t('panel.proposal.lens.working', 'Waiting for the wallet and the lens member…');
                button.disabled = true;
                try {
                    await transactionWallet();
                    const result = await root.SolanaAcceptanceBridge.sayYes({
                        proposal: ctx.proposalAccount,
                        parcelId: parcelUid,
                        members: lensMembers.map(entry => ({ key: entry.key, serviceUrl: entry.serviceUrl })),
                        payout,
                        onStatus: ({ state, explorerUrl: url }) => {
                            const text = statusText(state);
                            if (text) out.innerHTML = `${escapeText(text)} ${txLink(url)}`;
                        }
                    });
                    out.classList.add('is-ok');
                    const lines = [t('panel.proposal.lens.saidYes', 'You said yes.')];
                    if (result.tally) lines.push(t('panel.proposal.lens.tallyAfter', '{{accepted}} of {{required}} attested owners have signed.', { accepted: result.tally.accepted, required: result.tally.required }));
                    if (result.parcelComplete) lines.push(t('panel.proposal.lens.parcelComplete', 'This parcel\'s consent is complete.'));
                    if (result.executed) lines.push(t('panel.proposal.lens.proposalExecuted', 'Every parcel has consented: the proposal is executed.'));
                    out.innerHTML = `${lines.map(line => `<span>${escapeText(line)}</span>`).join('')}<span>${txLink(result.explorerUrl)}</span>`;
                    await refreshConsent(section, ctx);
                } catch (error) {
                    log('error', `say yes failed for ${parcelUid}`, error);
                    out.classList.add('is-error');
                    out.innerHTML = `${escapeText(errorText(error, ctx.members))} ${txLink(error && error.explorerUrl)}`;
                } finally {
                    button.disabled = false;
                }
            });
        });
    }

    function bindVerdict(section, ctx) {
        const button = section.querySelector('[data-lens-submit-verdict]');
        if (!button) return;
        button.addEventListener('click', async () => {
            const input = section.querySelector('[data-lens-verdict-address]');
            const out = section.querySelector('[data-lens-verdict-result]');
            out.className = 'proposal-lens-result';
            // A malformed address is the user's to fix before any wallet prompt.
            if (!root.LensCore.isBase58Pubkey(input.value.trim())) {
                out.classList.add('is-error');
                out.textContent = errorText({ code: 'BAD_ATTESTATION' }, ctx.members);
                return;
            }
            out.textContent = t('panel.proposal.lens.preparing', 'Preparing the transaction…');
            button.disabled = true;
            try {
                await transactionWallet();
                const result = await root.SolanaAcceptanceBridge.submitVerdict({
                    proposal: ctx.proposalAccount,
                    verdictAttestation: input.value.trim(),
                    onStatus: ({ state, explorerUrl: url }) => {
                        const text = statusText(state);
                        if (text) out.innerHTML = `${escapeText(text)} ${txLink(url)}`;
                    }
                });
                out.classList.add('is-ok');
                out.innerHTML = `<span>${escapeText(t('panel.proposal.lens.verdictSettled', 'Verdict "{{verdict}}" from {{member}} settled; on-chain status is now {{status}}.', {
                    verdict: result.verdict,
                    member: root.LensCore.memberLabel(result.member, ctx.members),
                    status: result.proposal ? result.proposal.status : '?'
                }))}</span><span>${txLink(result.explorerUrl)}</span>`;
                await refreshConsent(section, ctx);
            } catch (error) {
                log('error', 'submit verdict failed', error);
                out.classList.add('is-error');
                out.innerHTML = `${escapeText(errorText(error, ctx.members))} ${txLink(error && error.explorerUrl)}`;
            } finally {
                button.disabled = false;
            }
        });
    }

    function render(section, ctx) {
        const { lensKeys, members, parcelIds, directoryError, proposalAccount } = ctx;
        const core = root.LensCore;
        const byKey = new Map(members.map(member => [member.key, member]));
        const lensMembers = lensKeys.map(key => {
            const member = byKey.get(key);
            return { key, label: (member && member.name) || core.shortKey(key), member, serviceUrl: member ? member.serviceUrl : null };
        });
        const list = lensMembers.length ? lensMembers.map(entry => `
            <li>
                <strong>${escapeText(entry.member && entry.member.name ? entry.member.name : entry.key)}</strong>
                ${entry.member && entry.member.kind ? `<span class="lens-picker-kind">${escapeText(entry.member.kind)}</span>` : ''}
                ${entry.member && entry.member.name ? `<a class="proposal-lens-key" href="${explorerUrl(entry.key)}" target="_blank" rel="noopener">${escapeText(entry.key)}</a>` : `<a class="proposal-lens-key" href="${explorerUrl(entry.key)}" target="_blank" rel="noopener">${escapeText(t('panel.proposal.lens.unknownMember', 'not in the directory'))} ↗</a>`}
            </li>`).join('') : `<li>${escapeText(t('panel.proposal.lens.empty', 'This proposal names no lens.'))}</li>`;
        section.innerHTML = `
            <div class="proposal-funding-head">
                <div>
                    <div class="proposal-funding-eyebrow">${escapeText(t('panel.proposal.lens.eyebrow', 'Trusted attesters'))}</div>
                    <h3>${escapeText(t('panel.proposal.lens.title', 'Lens'))}</h3>
                </div>
            </div>
            ${directoryError ? `<p class="lens-picker-note">${escapeText(t('panel.proposal.lens.directoryUnavailable', 'Member directory unavailable; showing keys only.'))}</p>` : ''}
            <ul class="proposal-lens-members">${list}</ul>
            ${lensMembers.length && parcelIds.length ? `
                <h4>${escapeText(t('panel.proposal.lens.ownershipTitle', 'Ownership attestation'))}</h4>
                <p class="lens-picker-note">${escapeText(t('panel.proposal.lens.ownershipHint', 'If you own one of these parcels, ask a lens member to attest it: your wallet signs a one-time challenge, the member checks its registry and issues the attestation.'))}</p>
                <p class="lens-picker-note">${escapeText(t('panel.proposal.lens.sayYesHint', 'Once attested, "Say yes" signs your consent on chain. Every owner the member attested must say yes before the parcel counts; a yes cannot be withdrawn.'))}</p>
                <ul class="proposal-lens-parcels">${parcelIds.map(parcelUid => renderParcelRow(parcelUid, lensMembers)).join('')}</ul>` : ''}
            ${lensMembers.length && proposalAccount ? `
                <h4>${escapeText(t('panel.proposal.lens.verdictTitle', 'Settle with a verdict'))}</h4>
                <p class="lens-picker-note">${escapeText(t('panel.proposal.lens.verdictHint', 'Anyone may submit a lens member\'s verdict attestation. "expired" ends the proposal; "executed" only applies to proposals minted to accept it.'))}</p>
                <p class="lens-picker-note" data-lens-proposal-status></p>
                <div class="proposal-lens-parcel-actions">
                    <input type="text" class="lens-input" data-lens-verdict-address autocomplete="off" spellcheck="false"
                        placeholder="${escapeText(t('panel.proposal.lens.verdictPlaceholder', 'Verdict attestation address'))}"
                        aria-label="${escapeText(t('panel.proposal.lens.verdictPlaceholder', 'Verdict attestation address'))}">
                    <button type="button" class="btn btn-secondary" data-lens-submit-verdict>${escapeText(t('panel.proposal.lens.submitVerdict', 'Submit verdict'))}</button>
                </div>
                <div class="proposal-lens-result" data-lens-verdict-result aria-live="polite"></div>` : ''}`;

        bindAttest(section, lensMembers);
        bindSayYes(section, ctx, lensMembers);
        bindVerdict(section, ctx);
        refreshConsent(section, ctx);
    }

    // resolveLens: () => entries | Promise<entries> ({address} or strings). proposalAccount: the
    // proposal PDA, needed to read consent and to sign. The section may be replaced while this
    // awaits (another proposal opened), so every write checks it is attached.
    async function mount(section, { resolveLens, parcelIds = [], proposalAccount = null } = {}) {
        if (!section) return;
        section.textContent = t('panel.proposal.lens.loading', 'Loading lens…');
        let lensKeys = [];
        try {
            lensKeys = root.LensCore.validateSolanaLens(await resolveLens()).keys;
        } catch (error) {
            log('warn', 'lens unavailable', error);
        }
        let members = [];
        let directoryError = null;
        try {
            const result = await root.LensServiceClient.fetchDirectory({ base: String(root.getBackendBase()).replace(/\/+$/, '') });
            if (result.outcome.kind === 'ok') members = result.members;
            else directoryError = result.outcome.message || `HTTP ${result.status}`;
        } catch (error) {
            directoryError = error && error.message ? error.message : String(error);
        }
        if (directoryError) log('warn', `directory: ${directoryError}`);
        if (!section.isConnected) return;
        render(section, {
            lensKeys,
            members,
            parcelIds: Array.from(new Set(parcelIds.map(String))),
            directoryError,
            proposalAccount: proposalAccount && root.LensCore.isBase58Pubkey(String(proposalAccount)) ? String(proposalAccount) : null
        });
    }

    root.ProposalLensCard = { mount };
})();
