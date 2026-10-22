// Owner acceptance for proposals with an approval setup (abstract owners, pinned rights, a lens):
// the "Owner acceptance" card in Details > Land & ownership, the "Act for an owner" dialog (a lens
// member confirms which owners the connected wallet may act for) and the "Accept as Owner X" review
// dialog, which shows exactly what that owner gives and gets before the wallet signs, then becomes
// the receipt. The same review opens read-only for anyone from the card's owner row ("Owner X's
// deal"), with the before/after divider focused on that owner's land. Rules and counting live in
// approval.js / approval-review.js; this file only renders.
(function () {
    const root = typeof window !== 'undefined' ? window : null;
    if (!root) return;
    const doc = root.document;
    const OVERLAY_ID = 'proposal-approval-dialog';
    const state = { overlay: null, opener: null, unregisterEscape: null };

    const t = (key, fallback, params) => getProposalI18nHelper()(key, fallback, params || {});
    const esc = value => escapeHtml(String(value === undefined || value === null ? '' : value));
    const format = () => root.CbFormat;
    const area = value => format().formatArea(value, { missing: '—' });
    const money = (cents, currency) => format().formatMoney(cents / 100, currency, { minFractionDigits: 2, maxFractionDigits: 2 });
    // A readjustment's cash is in its deal's currency (the city's money when it was authored).
    const cashCurrency = review => review.conditions?.money?.currency || review.proposal?.offerCurrency || root.CityMoney.currentCurrency();
    const runtime = () => root.ProposalApprovalRuntime;
    const actor = () => (typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null) || null;
    const wallet = () => root.ProposalApprovalLensAuthority.browserWallet();

    function labels(proposal) {
        const state = runtime().inspect(proposal);
        return id => runtime().label(id, state);
    }
    const list = names => names.join(', ');
    // The cadastral number people know ("1236"), as the rest of the panel shows it.
    function parcelName(id) {
        // A parcel a readjustment replaced is gone from the live fabric; the cadastre still has it.
        const properties = root.LiveParcelFabric?.get?.(id)?.properties || root.CadastralParcelRepository?.get?.(id)?.properties;
        const number = root.ProposalDisplayText.parcelLabel(getParcelDisplayNumberFromProperties(properties, id));
        return t('panel.proposal.parcels.label', 'Parcel {{id}}', { id: number });
    }
    const words = () => root.ProposalApprovalText;
    const ruleText = (policy, regime) => words().rulesText(policy, t, regime);

    // The signer the installed providers would use for this owner right now (a wallet, a profile).
    function signerFor(proposal, ownerId) {
        const current = actor();
        return current ? root.ProposalApprovalAuthorities.resolve(proposal, ownerId, current)?.actorId || null : null;
    }

    function acceptedIds(proposal, hash) {
        return hash ? runtime().validIds(proposal, hash) : [];
    }

    // ---- relay --------------------------------------------------------------------------------

    // Any installed provider's receipt, checked from its own evidence and signatures.
    const verifyAny = (proposal, receipt) => root.ProposalApproval.evidenceAllows(proposal, receipt?.ownerId, receipt?.actorId, receipt?.evidence)
        && root.ProposalApprovalAuthorities.verifyReceipt(proposal, receipt);
    const syncing = new Map();
    // Per minted proposal: { status: 'reading'|'ready'|'error'|'anchoring', anchored: Set, transactions, message }.
    const chainState = new Map();
    const anchors = () => root.ProposalApprovalAnchor;

    async function solana(cluster) {
        if (!root.solanaWeb3?.PublicKey && typeof root.ensureWalletVendors === 'function') await root.ensureWalletVendors();
        if (!root.solanaWeb3?.PublicKey || !root.SolanaChainDataLoader?.getConnection) throw new Error('Solana web3.js is unavailable');
        return { web3: root.solanaWeb3, connection: root.SolanaChainDataLoader.getConnection(cluster) };
    }

    async function fetchBundle(uri) {
        for (const url of anchors().gatewayUrls(uri)) {
            try {
                const response = await root.fetch(url, { cache: 'no-store' });
                if (response.ok) return await response.json();
            } catch (_) { /* next gateway */ }
        }
        return null;
    }

    // Decisions anchored on chain for a minted proposal, folded in after this browser verifies them.
    async function readChain(proposal) {
        const id = String(proposal.proposalId);
        const ref = anchors()?.chainRef(proposal);
        if (!ref) return;
        chainState.set(id, { ...(chainState.get(id) || {}), status: 'reading' });
        try {
            const read = await anchors().readAnchors(proposal, { ...(await solana(ref.cluster)), fetchJson: fetchBundle });
            const { changed } = root.ProposalApprovalRelay.merge(proposal, read.decisions, verifyAny);
            if (changed) {
                refreshProposalAcceptanceValidity(proposal);
                proposalStorage._indexProposal?.(proposal);
                proposalStorage.save();
            }
            chainState.set(id, { ...(chainState.get(id) || {}), status: 'ready', anchored: anchors().anchoredSignatures(read), transactions: read.transactions, rejected: read.rejected });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] chain read failed for ${id}`, error);
            chainState.set(id, { ...(chainState.get(id) || {}), status: 'error', anchored: new Set(), transactions: [] });
        }
        refreshAll();
    }

    // Reads the relay's decisions for a published proposal (each re-verified here before it counts)
    // and sends the ones only this browser holds. Runs each time a Details card mounts.
    function sync(proposalId) {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal || !root.ProposalApprovalRelay || (!proposal.serverProposalId && !anchors()?.chainRef(proposal))) return Promise.resolve(null);
        if (syncing.has(proposalId)) return syncing.get(proposalId);
        const relayed = proposal.serverProposalId ? root.ProposalApprovalRelay.sync(proposal, { verify: verifyAny })
            : Promise.resolve({ synced: false, changed: false, sent: 0 });
        const run = relayed.then(async result => {
            await readChain(proposal);
            if (result.changed) {
                refreshProposalAcceptanceValidity(proposal);
                proposalStorage._indexProposal?.(proposal);
                proposalStorage.save();
            }
            if (result.changed || result.sent) refreshAll();
            return result;
        }).catch(error => {
            console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] relay sync failed for ${proposalId}`, error);
            return null;
        }).finally(() => syncing.delete(proposalId));
        syncing.set(proposalId, run);
        return run;
    }

    function sharedText(shared) {
        if (shared?.shared) return t('proposalApproval.relay.shared', 'Shared: other browsers can verify and count this decision.');
        return shared?.code === 'not_published'
            ? t('proposalApproval.relay.unpublished', 'Saved in this browser only: the proposal is not published yet.')
            : t('proposalApproval.relay.retry', 'Saved in this browser only for now; it is sent again the next time this proposal opens.');
    }

    // ---- card ---------------------------------------------------------------------------------

    function meter(kind, label, valueText, value, max, needText) {
        const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
        return `<div class="approval-card__meter" data-approval-meter="${kind}">
            <div class="approval-card__meter-head"><span>${esc(label)}</span><strong>${esc(valueText)}</strong></div>
            <div class="approval-card__bar" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${esc(max)}" aria-valuenow="${esc(value)}" aria-valuetext="${esc(valueText)}"><span class="approval-card__fill" style="width: ${percent}%"></span></div>
            ${needText ? `<small class="approval-card__need">${esc(needText)}</small>` : ''}
        </div>`;
    }

    function needText(test, isArea) {
        if (test.vacuous) return t('proposalApproval.rules.vacuous', 'Nobody to count here, so this test does not block.');
        if (!isArea) return t('proposalApproval.ownersNeeded', 'Needs {{count}}', { count: test.needed });
        return test.strict
            ? t('proposalApproval.areaNeededMoreThan', 'Needs more than {{area}}', { area: area(test.needed) })
            : t('proposalApproval.areaNeededAtLeast', 'Needs at least {{area}}', { area: area(test.needed) });
    }

    // One meter per test the rules count, then owners and land as plain information where no test
    // counts them (every owner must accept; or an authority decides and owners are heard).
    function metersHtml(progress) {
        const html = words().orderTests(progress.tests).map(test => {
            const isArea = test.measure === 'area';
            const name = words().meterName(test), label = words().meterLabel(test, t);
            if (!test.known) return `<p class="approval-card__note" data-approval-meter="${esc(name)}">${esc(label)}: ${esc(t('proposalApproval.areaUnknown', 'Parcel areas are unresolved.'))}</p>`;
            const valueText = isArea
                ? t('proposalApproval.amountOf', '{{amount}} of {{total}}', { amount: area(test.support), total: area(test.total) })
                : t('proposalApproval.ownersCount', '{{accepted}} of {{total}} accepted', { accepted: test.support, total: test.total });
            return meter(name, label, valueText, test.support, test.total, needText(test, isArea));
        });
        const counts = (measure, of) => progress.tests.some(test => test.measure === measure && test.of.split('+').includes(of));
        const unanimous = progress.policy.type === 'unanimous';
        if (!counts('headcount', 'owners')) {
            html.push(meter('owners', t('proposalApproval.meterOwners', 'Owners'),
                t('proposalApproval.ownersCount', '{{accepted}} of {{total}} accepted', { accepted: progress.acceptedOwners, total: progress.totalOwners }),
                progress.acceptedOwners, progress.totalOwners, t('proposalApproval.rules.heard', 'Heard, not counted')));
        }
        if (!counts('area', 'owners')) {
            html.push(progress.totalAreaM2 == null
                ? `<p class="approval-card__note">${esc(t('proposalApproval.areaUnknown', 'Parcel areas are unresolved.'))}</p>`
                : meter('area', t('reparcellization.modal.colArea', 'Area'),
                    t('proposalApproval.amountOf', '{{amount}} of {{total}}', { amount: area(progress.acceptedAreaM2), total: area(progress.totalAreaM2) }),
                    progress.acceptedAreaM2, progress.totalAreaM2, unanimous
                        ? t('proposalApproval.areaNeededAll', 'Needs every parcel: {{area}}', { area: area(progress.totalAreaM2) }) : null));
        }
        return html.join('');
    }

    // Required authority decisions, each given or pending.
    function authoritiesHtml(progress, label) {
        if (!progress.authorities.length) return '';
        const role = words().authorityText(progress.regime, t);
        return `<ul class="approval-card__authorities">${progress.authorities.map(row => `<li data-approval-authority="${esc(row.authorityId)}" data-approval-authority-state="${row.approved ? 'approved' : 'pending'}">
            <strong>${esc(label(row.authorityId))}</strong> · ${esc(row.approved
                ? t('proposalApproval.authority.approved', 'approved: {{role}}', { role })
                : t('proposalApproval.authority.pending', 'pending: {{role}}', { role }))}</li>`).join('')}</ul>`;
    }

    function progressHtml(proposal, progress, label) {
        const authorityLed = !progress.tests.length;
        const outstanding = authorityLed
            ? t('proposalApproval.rules.ownersHeard', 'Owners are heard; the authority decides.')
            : progress.outstanding.length
                ? t('proposalApproval.stillToAccept', 'Still to accept: {{owners}}', { owners: list(progress.outstanding.map(row => label(row.ownerId))) })
                : t('proposalApproval.everyoneAccepted', 'Every owner has accepted.');
        const coOwned = progress.coOwned.map(parcel => `<li data-approval-co-owned="${esc(parcel.parcelId)}">${esc(t('proposalApproval.coOwnedRule',
            '{{parcel}} counts toward the area once {{owners}} have all accepted ({{accepted}} of {{total}} so far).', {
                parcel: parcelName(parcel.parcelId), owners: list(parcel.owners.map(owner => label(owner.ownerId))),
                accepted: parcel.owners.filter(owner => owner.accepted).length, total: parcel.owners.length
            }))}</li>`).join('');
        return `${metersHtml(progress)}${authoritiesHtml(progress, label)}
            <p class="approval-card__outstanding" data-approval-outstanding>${esc(outstanding)}</p>
            ${coOwned ? `<ul class="approval-card__co-owned">${coOwned}</ul>` : ''}`;
    }

    // The named scheme, if any: what it is, its stage, and that it is a research template.
    function regimeHtml(progress) {
        const template = words().regimeOf(progress.regime);
        if (!template) return '';
        return `<p class="approval-card__regime" data-approval-regime="${esc(template.id)}"><strong>${esc(words().regimeName(progress.regime, t))}</strong>
            <span class="cb-badge approval-card__research">${esc(t('proposalApproval.regime.research', 'Research template'))}</span>
            <small>${esc(words().familyText(template, t))} · ${esc(words().stageText(template, t))}</small></p>`;
    }

    function youHtml(proposal, hash, label, accepted) {
        if (!hash) return `<p class="approval-card__note">${esc(t('proposalApproval.invalidTerms', 'Correct the proposal terms before accepting.'))}</p>`;
        const current = actor();
        const mine = current ? runtime().authorizedOwnerIds(proposal, current) : [];
        const connected = wallet();
        let html = '';
        if (mine.length) {
            const names = list(mine.map(label));
            html += `<p class="approval-card__you-line" data-approval-you>${esc(connected && mine.some(id => signerFor(proposal, id) === connected.address)
                ? t('proposalApproval.walletActsFor', 'Your wallet {{wallet}} can act for {{owners}}.', { wallet: root.LensCore.shortKey(connected.address), owners: names })
                : t('proposalApproval.youActFor', 'You can act for {{owners}}.', { owners: names }))}</p>`;
            html += '<div class="approval-card__actions">' + mine.map(id => {
                if (!accepted.includes(id)) {
                    return `<button type="button" class="btn btn-success btn-sm" data-approval-action="review" data-owner-id="${esc(id)}">${esc(t('proposalApproval.reviewAndAccept', 'Review and accept as {{owner}}', { owner: label(id) }))}</button>`;
                }
                const mayWithdraw = proposal.ownerApprovals?.[id]?.actorId === signerFor(proposal, id);
                return `<span class="approval-card__accepted" data-approval-accepted="${esc(id)}"><i class="fas fa-check" aria-hidden="true"></i> ${esc(t('proposalApproval.acceptedAs', 'Accepted as {{owner}}', { owner: label(id) }))}</span>`
                    + (mayWithdraw ? `<button type="button" class="btn btn-danger btn-sm" data-approval-action="withdraw" data-owner-id="${esc(id)}">${esc(t('proposalApproval.withdraw', 'Withdraw acceptance'))}</button>` : '');
            }).join('') + '</div>';
        }
        html += `<div class="approval-card__verify">
            <button type="button" class="btn btn-sm" data-approval-action="verify">${esc(t('proposalApproval.actForOwner', 'Act for an owner'))}</button>
            <small>${esc(t('proposalApproval.actForOwnerHint', 'A member of this proposal’s lens confirms which owners your wallet may act for. Nothing is accepted until you review and sign.'))}</small>
        </div>`;
        return `<div class="approval-card__you">${html}</div>`;
    }

    // Every owner's position, for anyone: what they put in and what they get, without a wallet.
    function dealsHtml(proposal, label, accepted) {
        const state = runtime().inspect(proposal);
        const ids = [...state.ownerIds, ...state.leaseholderIds.filter(id => !state.ownerIds.includes(id))];
        if (!ids.length) return '';
        return `<div class="approval-card__deals" data-approval-deals>
            <p class="approval-card__deals-title">${esc(t('proposalApproval.deals.title', 'Proposed owner contributions and allocations'))}</p>
            <div class="approval-card__actions">${ids.map(id => `<button type="button" class="btn btn-sm" data-approval-action="inspect" data-owner-id="${esc(id)}"${accepted.includes(id) ? ' data-approval-deal-accepted' : ''}>${accepted.includes(id) ? '<i class="fas fa-check" aria-hidden="true"></i> ' : ''}${esc(label(id))}</button>`).join('')}</div>
        </div>`;
    }

    // Minted on Solana: how many of the decisions this browser holds are anchored, and the action
    // that anchors the rest. The chain records them; it does not count or pay this approval setup.
    function chainHtml(proposal, hash) {
        const ref = anchors()?.chainRef(proposal);
        if (!ref) return '';
        const id = String(proposal.proposalId);
        const chain = chainState.get(id) || { status: 'reading' };
        const known = root.ProposalApprovalRelay.fold(proposal, [...Object.values(proposal.ownerApprovals || {}),
            ...(proposal.ownerApprovalHistory || [])], verifyAny).applied;
        const anchored = known.filter(receipt => chain.anchored?.has(root.ProposalApprovalRelay.signatureOf(receipt))).length;
        let line;
        if (chain.status === 'reading') line = t('proposalApproval.chain.reading', 'Reading anchored decisions from the chain…');
        else if (chain.status === 'error') line = t('proposalApproval.chain.readFailed', 'The chain could not be read; decisions shown are from this browser and the relay.');
        else line = t('proposalApproval.chain.anchored', 'On chain: {{anchored}} of {{total}} decisions anchored.', { anchored, total: known.length });
        const canAnchor = chain.status === 'ready' && anchored < known.length && !!proposal.serverProposalId && !!hash;
        const last = chain.lastTransaction;
        return `<div class="approval-card__chain" data-approval-chain="${esc(chain.status)}">
            <p class="approval-card__chain-line" data-approval-chain-line>${esc(line)}</p>
            ${chain.message ? `<p class="approval-card__note" data-approval-chain-status role="status">${esc(chain.message)}</p>` : ''}
            ${last ? `<p class="approval-card__note"><a class="cb-link cb-link--external" href="${esc(explorerTx(last, ref.cluster))}" target="_blank" rel="noopener noreferrer" data-approval-chain-tx>${esc(t('proposalApproval.chain.lastAnchor', 'Latest anchor transaction'))}</a></p>` : ''}
            ${canAnchor ? `<div class="approval-card__actions"><button type="button" class="btn btn-sm" data-approval-action="anchor">${esc(t('proposalApproval.chain.anchor', 'Anchor on chain'))}</button></div>` : ''}
            <small class="approval-card__need">${esc(t('proposalApproval.chain.scope', 'The chain keeps the approval setup and the signed decisions so anyone can recount them; it does not count or pay them.'))}</small>
        </div>`;
    }

    function explorerTx(signature, cluster) {
        const suffix = cluster && cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(cluster)}` : '';
        return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${suffix}`;
    }

    // Pins the decisions the relay holds as one bundle, then the connected wallet records it on chain.
    async function anchorDecisions(proposalId) {
        const proposal = proposalStorage.getProposal(proposalId);
        const ref = proposal ? anchors()?.chainRef(proposal) : null;
        if (!ref) return;
        const id = String(proposal.proposalId);
        const set = patch => { chainState.set(id, { ...(chainState.get(id) || {}), ...patch }); renderCards(); };
        set({ status: 'anchoring', message: t('proposalApproval.chain.anchoring', 'Pinning the decisions and waiting for your wallet…') });
        try {
            await root.ProposalApprovalRelay.sync(proposal, { verify: verifyAny });
            await root.ProposalApprovalLensAuthority.connectWallet();
            const base = (typeof root.getBackendBase === 'function' ? root.getBackendBase() : '').replace(/\/$/, '');
            const result = await anchors().anchor(proposal, {
                ...(await solana(ref.cluster)),
                provider: root.solanaWalletManager.getProvider(),
                async publishBundle() {
                    const response = await root.fetch(`${base}/proposals/${encodeURIComponent(proposal.serverProposalId)}/owner-decisions/bundle`, { method: 'POST' });
                    const body = await response.json().catch(() => ({}));
                    if (!response.ok) throw Object.assign(new Error(body.error || `Pinning failed (${response.status})`), { code: body.code || 'pin_failed' });
                    return body;
                }
            });
            console.info(`[${new Date().toISOString()}] [ProposalApprovalPanel] anchored ${result.uri} for ${id} in ${result.signature}`);
            set({ message: t('proposalApproval.chain.anchoredNow', 'Anchored {{count}} decisions.', { count: result.count }), lastTransaction: result.signature });
            await readChain(proposal);
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] anchoring failed for ${id}`, error);
            set({ status: 'ready', message: t('proposalApproval.chain.anchorFailed', 'Nothing was anchored: {{reason}}', { reason: error?.message || String(error) }) });
        }
    }

    function cardHtml(proposal) {
        const hash = currentConsentBindingHash(proposal);
        const accepted = acceptedIds(proposal, hash);
        const progress = root.ProposalApprovalReview.progress(proposal, accepted);
        const titleId = `approval-card-title-${String(proposal.proposalId || 'draft').replace(/[^A-Za-z0-9_-]/g, '_')}`;
        if (!progress.ready) {
            return `<section class="approval-card" data-approval-card aria-labelledby="${titleId}">
                <div class="approval-card__head"><h4 id="${titleId}" class="approval-card__title">${esc(t('panel.parcel.acceptance.ownerTitle', 'Owner acceptance'))}</h4>
                <span class="cb-badge approval-card__status approval-card__status--unresolved">${esc(t('proposalApproval.status.unresolved', 'Ownership unresolved'))}</span></div>
                <p class="approval-card__note">${esc(t('proposalApproval.ownershipUnresolved', 'Ownership unresolved. You can design and share this proposal; owner approval needs a complete rights snapshot.'))}</p>
            </section>`;
        }
        const label = labels(proposal);
        const status = progress.passed
            ? `<span class="cb-badge approval-card__status approval-card__status--passed">${esc(t('proposalApproval.status.passed', 'Configured approval rules met'))}</span>`
            : progress.supportMet
                ? `<span class="cb-badge approval-card__status approval-card__status--pending" data-approval-awaiting-authority>${esc(t('proposalApproval.status.authorityPending', 'Required authority decision pending'))}</span>`
                : `<span class="cb-badge approval-card__status approval-card__status--pending">${esc(t('proposalApproval.status.pending', 'Configured approval rules not met'))}</span>`;
        return `<section class="approval-card" data-approval-card aria-labelledby="${titleId}">
            <div class="approval-card__head"><h4 id="${titleId}" class="approval-card__title">${esc(t('panel.parcel.acceptance.ownerTitle', 'Owner acceptance'))}</h4>${status}</div>
            ${regimeHtml(progress)}
            <p class="approval-card__rule">${esc(ruleText(progress.policy, progress.regime))}</p>
            ${progressHtml(proposal, progress, label)}
            ${dealsHtml(proposal, label, accepted)}
            ${chainHtml(proposal, hash)}
            ${proposal.serverProposalId ? '' : `<p class="approval-card__note" data-approval-local-only>${esc(t('proposalApproval.relay.localOnly', 'Acceptances stay in this browser until the proposal is published.'))}</p>`}
            ${youHtml(proposal, hash, label, accepted)}
        </section>`;
    }

    function render(slot, proposal) {
        if (!slot || !proposal) return;
        slot.dataset.proposalId = String(proposal.proposalId);
        slot.innerHTML = cardHtml(proposal);
        if (slot.dataset.approvalBound) return;
        slot.dataset.approvalBound = 'true';
        sync(String(proposal.proposalId));
        slot.addEventListener('click', event => {
            const control = event.target.closest('[data-approval-action]');
            if (!control || !slot.contains(control)) return;
            event.preventDefault();
            event.stopPropagation();
            const proposalId = slot.dataset.proposalId;
            const ownerId = control.dataset.ownerId || null;
            if (control.dataset.approvalAction === 'verify') openVerify(proposalId);
            else if (control.dataset.approvalAction === 'review') openReview(proposalId, ownerId);
            else if (control.dataset.approvalAction === 'inspect') openReview(proposalId, ownerId, null, { inspect: true });
            else if (control.dataset.approvalAction === 'withdraw') withdraw(proposalId, ownerId);
            else if (control.dataset.approvalAction === 'anchor') anchorDecisions(proposalId);
        });
    }

    function mountedProposals() {
        return [...doc.querySelectorAll('[data-approval-card-slot]')]
            .map(slot => (slot.dataset.proposalId ? proposalStorage.getProposal(slot.dataset.proposalId) : null)).filter(Boolean);
    }

    // Every mounted card (execution.js calls this after it refreshes the owner rows).
    function renderCards() {
        doc.querySelectorAll('[data-approval-card-slot]').forEach(slot => {
            const proposal = slot.dataset.proposalId ? proposalStorage.getProposal(slot.dataset.proposalId) : null;
            if (proposal) render(slot, proposal);
        });
    }

    // Cards and per-parcel owner rows: who may accept changes with the wallet and its evidence.
    function refreshAll() {
        mountedProposals().forEach(proposal => (proposal.cadastreParcelIds || [])
            .forEach(parcelId => refreshProposalOwnerAcceptanceUI(proposal, parcelId)));
        renderCards();
    }

    function firstParcelOf(proposal, ownerId) {
        return runtime().inspect(proposal).parcels.find(parcel => parcel.owners.some(owner => owner.ownerId === ownerId))?.parcelId || null;
    }

    async function withdraw(proposalId, ownerId) {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) return;
        const parcelId = firstParcelOf(proposal, ownerId);
        // An owner withdraws from one of their parcels; a leaseholder or an authority has none.
        if (parcelId) await handleUserRejectProposal(proposalId, parcelId, ownerId);
        else await recordAbstractProposalDecision(proposal, null, ownerId, actor(), true);
        refreshAll();
    }

    // ---- dialogs ------------------------------------------------------------------------------

    function el(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function button(className, text, onClick) {
        const node = el('button', className, text);
        node.type = 'button';
        node.addEventListener('click', onClick);
        return node;
    }

    function close() {
        const overlay = state.overlay;
        if (!overlay) return;
        if (typeof state.unregisterEscape === 'function') state.unregisterEscape();
        overlay.remove();
        const opener = state.opener;
        state.overlay = null; state.opener = null; state.unregisterEscape = null;
        if (opener && opener.isConnected && typeof opener.focus === 'function') {
            try { opener.focus({ preventScroll: true }); } catch (_) { /* focus is best effort */ }
        }
    }

    function mount(title, size = '') {
        doc.getElementById(OVERLAY_ID)?.remove();
        if (state.overlay) close();
        state.opener = doc.activeElement;
        const overlay = el('div', 'cb-dialog-overlay approval-dialog-overlay');
        overlay.id = OVERLAY_ID;
        const dialog = el('div', `cb-dialog approval-dialog ${size}`.trim());
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', `${OVERLAY_ID}-title`);
        dialog.tabIndex = -1;
        const header = el('div', 'cb-dialog__header');
        const heading = el('h2', 'cb-dialog__title', title);
        heading.id = `${OVERLAY_ID}-title`;
        const closeButton = button('close-circle-btn', '×', close);
        closeButton.setAttribute('aria-label', t('common.close', 'Close'));
        header.append(heading, closeButton);
        const body = el('div', 'cb-dialog__body approval-dialog__body');
        const footer = el('div', 'cb-dialog__footer');
        dialog.append(header, body, footer);
        overlay.append(dialog);
        overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
        doc.body.appendChild(overlay);
        state.overlay = overlay;
        state.unregisterEscape = root.ModalEscape && typeof root.ModalEscape.register === 'function' ? root.ModalEscape.register(overlay, close) : null;
        dialog.focus({ preventScroll: true });
        return { dialog, heading, body, footer };
    }

    function verifyErrorText(error) {
        const code = error && error.code;
        if (code === 'not_authorized') return t('proposalApproval.verify.notAuthorized', 'This lens member does not recognize this wallet as acting for any owner of this proposal.');
        if (code === 'rights_mismatch' || code === 'area_mismatch') return t('proposalApproval.verify.rightsMismatch', 'This lens member’s records do not match the proposal’s ownership snapshot, so it will not confirm them.');
        if (code === 'unknown_parcel') return t('proposalApproval.verify.unknownParcel', 'This lens member has no record of one of the proposal’s parcels.');
        if (code === 'not_in_lens' || code === 'member-not-in-lens') return t('proposalApproval.verify.notInLens', 'That member is not in this proposal’s lens.');
        if (code === 'rights_incomplete' || code === 'ownership-unresolved') return t('proposalApproval.verify.rightsIncomplete', 'The proposal’s ownership snapshot is incomplete.');
        if (code === 'no-wallet' || code === 'wallet-required') return t('panel.proposal.lens.noWallet', 'No Solana wallet found in this browser.');
        if (code === 'no-sign-message') return t('panel.proposal.lens.noSignMessage', 'This wallet cannot sign messages.');
        if (code === 'bad-challenge') return t('proposalApproval.verify.badChallenge', 'The lens member asked the wallet to sign something unexpected; nothing was signed.');
        if (code === 'bad-evidence') return t('proposalApproval.verify.badEvidence', 'The lens member’s answer did not verify, so it was not used.');
        return t('proposalApproval.verify.failed', 'Verification failed: {{message}}', { message: (error && error.message) || String(error) });
    }

    // Lens members of this proposal with the directory's names and service addresses.
    async function lensMembers(proposal) {
        const keys = root.ProposalApproval.lensKeys(proposal);
        const directory = await root.LensPicker.loadDirectory();
        const members = directory.members || [];
        return keys.map(key => {
            const entry = members.find(member => member.key === key);
            return { key, label: root.LensCore.memberLabel(key, members), serviceUrl: entry?.serviceUrl || null };
        });
    }

    async function openVerify(proposalId, { thenReviewOwnerId = null } = {}) {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) return;
        const parts = mount(t('proposalApproval.actForOwner', 'Act for an owner'), 'cb-dialog--sm');
        parts.body.append(el('p', 'approval-dialog__intro', t('proposalApproval.verify.intro',
            'Choose a lens member. Your wallet signs a one-time challenge so the member can tell you which owners you may act for.')));
        const field = el('label', 'approval-dialog__field');
        field.append(el('span', null, t('panel.proposal.lens.memberSelect', 'Lens member')));
        const select = el('select', 'approval-dialog__member');
        select.setAttribute('data-approval-member', '');
        field.append(select);
        const status = el('p', 'approval-dialog__status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        parts.body.append(field, status);
        const cancel = button('btn', t('common.cancel', 'Cancel'), close);
        const submit = button('btn btn-primary', t('proposalApproval.verify.submit', 'Verify with wallet'), () => verify());
        submit.setAttribute('data-approval-verify-submit', '');
        parts.footer.append(cancel, submit);

        submit.disabled = true;
        const members = await lensMembers(proposal);
        if (state.overlay?.contains(select) !== true) return;
        members.forEach(member => {
            const option = el('option', null, member.serviceUrl ? member.label
                : `${member.label} (${t('panel.proposal.lens.noServiceUrlShort', 'no service URL')})`);
            option.value = member.key;
            option.disabled = !member.serviceUrl;
            select.append(option);
        });
        const usable = members.filter(member => member.serviceUrl);
        if (!usable.length) {
            status.textContent = t('proposalApproval.verify.noService', 'No member of this lens offers owner verification.');
            return;
        }
        select.value = usable[0].key;
        submit.disabled = false;

        async function verify() {
            const member = members.find(entry => entry.key === select.value);
            if (!member?.serviceUrl) return;
            submit.disabled = true;
            select.disabled = true;
            status.textContent = t('proposalApproval.verify.working', 'Waiting for your wallet…');
            try {
                await root.ProposalApprovalLensAuthority.connectWallet();
                const result = await root.ProposalApprovalLensAuthority.instance.verifyOwner(proposalStorage.getProposal(proposalId) || proposal,
                    { memberKey: member.key, serviceUrl: member.serviceUrl });
                const label = labels(proposal);
                status.textContent = t('proposalApproval.walletActsFor', 'Your wallet {{wallet}} can act for {{owners}}.', {
                    wallet: root.LensCore.shortKey(result.wallet), owners: list(result.ownerIds.map(label))
                });
                status.setAttribute('data-approval-verified', result.ownerIds.join(' '));
                refreshAll();
                parts.footer.replaceChildren();
                const next = thenReviewOwnerId && result.ownerIds.includes(thenReviewOwnerId) ? thenReviewOwnerId
                    : result.ownerIds.length === 1 ? result.ownerIds[0] : null;
                if (next && !acceptedIds(proposal, currentConsentBindingHash(proposal)).includes(next)) {
                    parts.footer.append(button('btn', t('common.close', 'Close'), close),
                        button('btn btn-success', t('proposalApproval.reviewAndAccept', 'Review and accept as {{owner}}', { owner: label(next) }),
                            () => openReview(proposalId, next)));
                } else {
                    parts.footer.append(button('btn btn-primary', t('proposalApproval.done', 'Done'), close));
                }
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] owner verification failed`, error);
                status.textContent = verifyErrorText(error);
                submit.disabled = false;
                select.disabled = false;
            }
        }
    }

    function section(title, content) {
        return `<section class="approval-review__section"><h3>${esc(title)}</h3>${content}</section>`;
    }

    // The review speaks to the owner when they are about to accept, and about the owner when
    // anyone opens it from the card's owner row. Both views describe proposed terms.
    function reviewVoice(inspect, owner, kind = 'owner') {
        if (!inspect) {
            return {
                inspect: false,
                title: kind === 'authority' ? t('proposalApproval.review.approveAs', 'Approve as {{owner}}', { owner })
                    : t('proposalApproval.review.acceptAs', 'Accept as {{owner}}', { owner }),
                contributes: t('proposalApproval.review.contributes', 'Your proposed contribution'),
                receives: t('proposalApproval.review.receives', 'Your proposed allocation'),
                share: share => t('proposalApproval.review.yourShare', 'Your share {{share}}', { share }),
                landBefore: t('proposalApproval.review.landBefore', 'Land you would contribute'),
                landAfter: t('proposalApproval.review.landAfter', 'Land allocated to you'),
                cash: t('proposalApproval.review.cash', 'Cash offered to you'),
                cashPay: t('proposalApproval.review.cashYouPay', 'Cash you would pay'),
                withAcceptance: progress => t('proposalApproval.review.withYou', 'With your acceptance: {{progress}}', { progress }),
                passes: t('proposalApproval.review.passesWithYou', 'Your acceptance would meet the configured approval rules.'),
                needsMore: t('proposalApproval.review.needsMore', 'Further decisions would still be needed under the configured approval rules.')
            };
        }
        return {
            inspect: true,
            title: t('proposalApproval.deals.dealOf', '{{owner}}’s deal', { owner }),
            contributes: t('proposalApproval.deals.contributes', 'Proposed contribution from {{owner}}', { owner }),
            receives: t('proposalApproval.deals.receives', 'Proposed allocation to {{owner}}', { owner }),
            share: share => t('proposalApproval.deals.share', 'Share {{share}}', { share }),
            landBefore: t('proposalApproval.deals.landBefore', 'Contributed land area'),
            landAfter: t('proposalApproval.deals.landAfter', 'Allocated land area'),
            cash: t('proposalApproval.deals.cashReceived', 'Cash offered'),
            cashPay: t('proposalApproval.deals.cashPaid', 'Proposed cash payment'),
            withAcceptance: progress => t('proposalApproval.deals.withOwner', 'With {{owner}}’s acceptance: {{progress}}', { owner, progress }),
            passes: t('proposalApproval.deals.passesWithOwner', '{{owner}}’s acceptance would meet the configured approval rules.', { owner }),
            needsMore: t('proposalApproval.deals.needsMoreThanOwner', 'Further decisions besides {{owner}}’s acceptance would still be needed under the configured approval rules.', { owner })
        };
    }

    function contributesHtml(review, label, voice) {
        const leases = review.leases.map(row => `<li data-approval-lease="${esc(row.leaseId)}">
            <span>${esc(t('proposalApproval.review.lease', 'Lease {{lease}} on {{parcel}}', { lease: row.leaseId, parcel: parcelName(row.parcelId) }))}</span>
            <span>${esc(voice.share(row.share))}${row.shareAreaM2 == null ? ''
                : ` · ${esc(t('proposalApproval.amountOf', '{{amount}} of {{total}}', { amount: area(row.shareAreaM2), total: area(row.leaseAreaM2) }))}`}${row.coHolderIds.length
                ? ` · ${esc(t('proposalApproval.review.heldWith', 'held with {{owners}}', { owners: list(row.coHolderIds.map(label)) }))}` : ''}</span>
        </li>`).join('');
        const rows = review.contributes.map(row => `<li data-approval-contribution="${esc(row.parcelId)}">
            <span>${esc(parcelName(row.parcelId))}</span>
            <span>${esc(voice.share(row.share))}${row.shareAreaM2 == null ? ''
                : ` · ${esc(t('proposalApproval.amountOf', '{{amount}} of {{total}}', { amount: area(row.shareAreaM2), total: area(row.parcelAreaM2) }))}`}${row.coOwnerIds.length
                ? ` · ${esc(t('proposalApproval.review.coOwnedWith', 'co-owned with {{owners}}', { owners: list(row.coOwnerIds.map(label)) }))}` : ''}</span>
        </li>`).join('');
        return `<ul class="approval-review__list">${rows}${leases}</ul>`;
    }

    // What an authority decides on: the whole plan, not a share of it.
    function planHtml(proposal, review) {
        const state = runtime().inspect(proposal);
        const plots = Array.isArray(proposal.reparcellization?.polygons) ? proposal.reparcellization.polygons.length : null;
        const facts = [
            [t('proposalDrafts.review.parcels', 'Parcels'), state.parcels.length],
            [t('proposalApproval.meterOwners', 'Owners'), state.ownerIds.length],
            ...(state.leaseholderIds.length ? [[t('proposalApproval.rules.meter.headcount-leaseholders-all', 'Leaseholders'), state.leaseholderIds.length]] : []),
            ...(plots != null ? [[t('reparcellization.modal.newPlots', 'New plots'), plots]] : []),
            ...(review.progressWithout.totalAreaM2 != null ? [[t('reparcellization.modal.colArea', 'Area'), area(review.progressWithout.totalAreaM2)]] : [])
        ];
        return `<dl class="approval-review__facts" data-approval-plan>${facts.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
    }

    function receivesHtml(review, label, voice) {
        const receives = review.receives;
        if (!receives.inLedger && !receives.plots.length) {
            return `<p class="approval-review__warning" data-approval-no-allocation>${esc(t('proposalApproval.review.noAllocation', 'This plan assigns no plot or cash to this owner.'))}</p>`;
        }
        const plots = receives.plots.map(plot => `<li data-approval-plot="${plot.index + 1}">
            <span>${esc(t('proposalApproval.review.plot', 'Plot {{number}}', { number: plot.index + 1 }))}</span>
            <span>${esc(t('proposalApproval.review.plotShare', '{{share}} of {{area}} = {{yours}}', {
                share: format().formatPercent(plot.share, { maxFractionDigits: 2 }), area: area(plot.areaM2), yours: area(plot.assignedAreaM2)
            }))}${plot.coRecipientIds.length ? ` · ${esc(t('proposalApproval.review.sharedWith', 'shared with {{owners}}', {
                owners: list(plot.coRecipientIds.map(id => (review.ownerIds.includes(id) ? label(id) : id)))
            }))}` : ''}</span>
        </li>`).join('');
        const change = receives.areaChangeM2 == null ? '—' : `${receives.areaChangeM2 > 0 ? '+' : ''}${area(receives.areaChangeM2)}`;
        return `${plots ? `<ul class="approval-review__list">${plots}</ul>` : ''}
            <dl class="approval-review__facts">
                <div><dt>${esc(voice.landBefore)}</dt><dd>${esc(area(receives.contributedAreaM2 ?? review.contributedAreaM2))}</dd></div>
                <div><dt>${esc(voice.landAfter)}</dt><dd>${esc(area(receives.assignedAreaM2))}</dd></div>
                <div><dt>${esc(t('proposalApproval.review.landChange', 'Change in land'))}</dt><dd>${esc(change)}</dd></div>
                ${receives.payCents > 0
                    ? `<div data-approval-cash="pays"><dt>${esc(voice.cashPay)}</dt><dd>${esc(money(receives.payCents, cashCurrency(review)))}</dd></div>`
                    : `<div data-approval-cash="receives"><dt>${esc(voice.cash)}</dt><dd>${esc(money(receives.cashCents, cashCurrency(review)))}</dd></div>`}
            </dl>`;
    }

    // The whole money schedule, so an owner sees who else pays and who covers the rest.
    function moneyLines(schedule, currency) {
        if (!schedule || (!schedule.payOutCents && !schedule.payInCents)) return [];
        const lines = [t('proposalApproval.money.summary', 'Proposed owner cash: {{out}} to receive and {{in}} to pay.', {
            out: money(schedule.payOutCents, currency), in: money(schedule.payInCents, currency) })];
        if (schedule.sponsorCents < 0) lines.push(t('proposalApproval.money.sponsorPays', 'The sponsor would pay {{amount}}.', { amount: money(-schedule.sponsorCents, currency) }));
        else if (schedule.sponsorCents > 0) lines.push(t('proposalApproval.money.sponsorReceives', 'The sponsor would receive {{amount}}.', { amount: money(schedule.sponsorCents, currency) }));
        else lines.push(t('proposalApproval.money.sponsorNothing', 'Proposed owner payments cover all payouts; no sponsor payment is specified.'));
        return lines;
    }

    function conditionsHtml(review, members, voice) {
        const c = review.conditions;
        const template = words().regimeOf(c.regime);
        const lines = [ruleText(c.policy, c.regime)];
        if (template) {
            lines.push(`${words().regimeName(c.regime, t)} — ${words().stageText(template, t)}`, ...words().allocationLines(template, t));
            const check = regimeCheck(review.proposal);
            if (check) lines.push(...words().checkLines(check, t, id => labels(review.proposal)(id)));
        }
        const payoutMode = root.ProposalPublishTerms.payoutMode(review.proposal);
        if (payoutMode) {
            lines.push(payoutMode === 'conditional'
                ? t('panel.proposal.disbursement.conditionalHint', 'Authored terms require every owner to accept before payout. This does not confirm funding or payment.')
                : t('panel.proposal.disbursement.partialHint', 'Authored terms allow partial payouts. Acceptance alone does not confirm payment.'));
        }
        lines.push(...moneyLines(c.money, cashCurrency(review)));
        lines.push(c.expiresAt
            ? t('proposalApproval.review.openUntil', 'Open until {{date}}', { date: format().formatDateTime(c.expiresAt) })
            : t('proposalApproval.review.noDeadline', 'No deadline'));
        // Only the sponsor's share is funded beforehand; owner payments settle with the payouts.
        const sponsorFunding = c.money ? c.money.sponsorFundingCents : c.totalCashCents;
        if (sponsorFunding > 0) {
            lines.push(c.fundingConfirmed
                ? t('proposalApproval.review.funded', 'Funding is marked ready in this record; payment is not verified.')
                : t('proposalApproval.review.unfunded', 'Funding is not marked ready in this record.'));
        }
        lines.push(...words().reviewBasisLines(c, t, key => root.LensCore.memberLabel(key, members)));
        return `<ul class="approval-review__conditions">${lines.map(line => `<li>${esc(line)}</li>`).join('')}</ul>
            ${voice.inspect ? '' : `<p class="approval-review__sign-note">${esc(t('proposalApproval.review.signNote', 'Your wallet signs these exact terms. If they change, your acceptance stops counting.'))}</p>`}`;
    }

    // "2 of 4 owners, 100 m² of 175 m²", then any other test the rules count and the authority.
    function progressLine(progress) {
        const base = progress.totalAreaM2 == null
            ? t('proposalApproval.review.progressOwners', '{{accepted}} of {{total}} owners', { accepted: progress.acceptedOwners, total: progress.totalOwners })
            : t('proposalApproval.review.progressBoth', '{{accepted}} of {{total}} owners, {{area}} of {{totalArea}}', {
                accepted: progress.acceptedOwners, total: progress.totalOwners, area: area(progress.acceptedAreaM2), totalArea: area(progress.totalAreaM2)
            });
        const others = words().orderTests(progress.tests || []).filter(test => test.known && !(test.of === 'owners' && test.scope === 'all'))
            .map(test => `${words().meterLabel(test, t)} ${test.measure === 'area'
                ? t('proposalApproval.amountOf', '{{amount}} of {{total}}', { amount: area(test.support), total: area(test.total) })
                : t('proposalApproval.amountOf', '{{amount}} of {{total}}', { amount: test.support, total: test.total })}`);
        const authority = (progress.authorities || []).length
            ? [progress.authorityMet ? t('proposalApproval.authority.given', 'authority approved') : t('proposalApproval.authority.awaited', 'authority pending')] : [];
        return [base, ...others, ...authority].join('; ');
    }

    // The plan against its scheme's distribution rules (reparcellization-validation.js), when it has both.
    function regimeCheck(proposal) {
        if (!proposal?.reparcellization || !root.ReparcellizationValidation) return null;
        try { return root.ReparcellizationValidation.validate(proposal, { turf: root.turf }).regimeCheck || null; } catch (_) { return null; }
    }

    function reviewProgressHtml(review, voice) {
        if (review.alreadyAccepted) {
            return `<p data-approval-progress-now>${esc(t('proposalApproval.review.alreadyAccepted', 'This owner has already accepted these terms.'))}</p>`;
        }
        return `<p data-approval-progress-now>${esc(t('proposalApproval.review.now', 'Now: {{progress}}', { progress: progressLine(review.progressWithout) }))}</p>
            <p data-approval-progress-with>${esc(voice.withAcceptance(progressLine(review.progressWith)))}</p>
            <p class="approval-review__verdict">${esc(review.progressWith.passed ? voice.passes : voice.needsMore)}</p>`;
    }

    // The before/after divider, focused on this owner: their parcels outlined before, their plots
    // after. Offered only where the proposal is applied on the map (there is an "after" to show).
    function mapButton(proposal, ownerId) {
        const compare = root.ProposalBeforeAfter;
        if (!compare || typeof root.toggleProposalBeforeAfter !== 'function' || !compare.canCompare(proposal)) return null;
        const node = button('btn', t('proposalApproval.deals.showOnMap', 'Show on map'), () => {
            close();
            root.toggleProposalBeforeAfter(proposal.proposalId, { focusOwnerId: ownerId });
        });
        node.setAttribute('data-approval-show-map', ownerId);
        node.title = t('proposalApproval.deals.showOnMapHint', 'Before: the parcels this owner puts in. After: the plots they get.');
        return node;
    }

    // Accepting always goes through this review: the owner sees what they give and get first.
    // { inspect: true } opens the same review read-only for anyone (the card's owner row).
    async function openReview(proposalId, ownerId, parcelId = null, { inspect = false } = {}) {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) return;
        const hash = currentConsentBindingHash(proposal);
        if (!hash) {
            showProposalAlertMessage('readjustment_terms_invalid', 'Complete and correct the readjustment allocations and cash terms before accepting.');
            return;
        }
        const label = labels(proposal);
        const review = root.ProposalApprovalReview.ownerReview(proposal, ownerId, { acceptedOwnerIds: acceptedIds(proposal, hash), turf: root.turf });
        if (!review) {
            showProposalAlertMessage('abstract_approval_unavailable', t('proposalApproval.approvalUnavailable',
                'The selected lens has not established these rights and your authority to act for this owner.'));
            return;
        }
        review.proposal = proposal;
        const members = (await root.LensPicker.loadDirectory()).members || [];
        const voice = reviewVoice(inspect, label(ownerId), review.kind);
        const parts = mount(voice.title, 'cb-dialog--lg');
        parts.dialog.setAttribute(inspect ? 'data-approval-deal' : 'data-approval-review', ownerId);
        const leaseNote = review.kind === 'leaseholder'
            ? `<p class="approval-card__note" data-approval-lease-note>${esc(t('proposalApproval.review.leaseNote', 'The plan reallocates ownership. A lease counts toward the approval rules but gets no plot from this plan’s ledger.'))}</p>` : '';
        parts.body.innerHTML = (review.kind === 'authority'
            ? section(t('proposalApproval.review.planTitle', 'The plan to decide on'), planHtml(proposal, review))
            : section(voice.contributes, contributesHtml(review, label, voice) + leaseNote))
            + (review.receives ? section(voice.receives, receivesHtml(review, label, voice)) : '')
            + section(t('proposalApproval.review.conditions', 'Conditions'), conditionsHtml(review, members, voice))
            + section(t('proposalApproval.review.progress', 'Progress'), reviewProgressHtml(review, voice))
            + '<p class="approval-dialog__status" role="status" aria-live="polite" data-approval-review-status></p>';
        const status = parts.body.querySelector('[data-approval-review-status]');
        const authorized = !!signerFor(proposal, ownerId);
        const cancel = button('btn', t('common.cancel', 'Cancel'), close);
        const showOnMap = mapButton(proposal, ownerId);
        if (showOnMap) parts.footer.append(showOnMap);
        if (inspect) {
            // Read-only: the owner (or whoever acts for them) goes on to the signing review.
            parts.footer.append(button('btn', t('common.close', 'Close'), close));
            if (!review.alreadyAccepted) {
                const acceptAs = button('btn btn-success', t('proposalApproval.deals.acceptAsOwner', 'I am {{owner}} — review and accept', { owner: label(ownerId) }),
                    () => openReview(proposalId, ownerId));
                acceptAs.setAttribute('data-approval-deal-accept', ownerId);
                parts.footer.append(acceptAs);
            }
            return;
        }
        if (review.alreadyAccepted) {
            parts.footer.append(button('btn btn-primary', t('common.close', 'Close'), close));
            return;
        }
        if (!authorized) {
            status.textContent = t('proposalApproval.review.verifyFirst', 'To accept, first confirm with a lens member that your wallet may act for this owner.');
            parts.footer.append(cancel, button('btn btn-primary', t('proposalApproval.actForOwner', 'Act for an owner'),
                () => openVerify(proposalId, { thenReviewOwnerId: ownerId })));
            return;
        }
        const accept = button('btn btn-success', voice.title, async () => {
            accept.disabled = true;
            cancel.disabled = true;
            status.textContent = t('panel.proposal.lens.awaitingSignature', 'Waiting for your wallet signature…');
            // An owner decides from one of their parcels; a leaseholder or an authority from none.
            const parcel = parcelId && review.contributes.some(row => row.parcelId === String(parcelId)) ? String(parcelId) : firstParcelOf(proposal, ownerId);
            let result = null;
            try {
                result = await recordAbstractProposalDecision(proposal, parcel, ownerId, actor());
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] owner decision was not signed`, error);
                status.textContent = t('proposalApproval.review.notSigned', 'The wallet did not sign, so nothing was accepted.');
                accept.disabled = false;
                cancel.disabled = false;
                return;
            }
            if (!result) {
                status.textContent = '';
                accept.disabled = false;
                cancel.disabled = false;
                return;
            }
            refreshAll();
            showReceipt(parts, proposal, ownerId, label, result.shared);
        });
        accept.setAttribute('data-approval-accept', ownerId);
        parts.footer.append(cancel, accept);
    }

    // After the wallet signs, the dialog is the receipt: what was signed, by whom, and the new tally.
    function showReceipt(parts, proposal, ownerId, label, shared) {
        const receipt = proposal.ownerApprovals?.[ownerId];
        const progress = root.ProposalApprovalReview.progress(proposal, acceptedIds(proposal, currentConsentBindingHash(proposal)));
        parts.heading.textContent = t('proposalApproval.acceptedAs', 'Accepted as {{owner}}', { owner: label(ownerId) });
        parts.dialog.setAttribute('data-approval-receipt', ownerId);
        parts.body.innerHTML = `<p data-approval-receipt-signer>${esc(t('proposalApproval.receipt.signed', 'Signed by {{signer}} on {{date}}.', {
            signer: root.LensCore.isBase58Pubkey(receipt?.actorId) ? root.LensCore.shortKey(receipt.actorId) : String(receipt?.actorId || ''),
            date: format().formatDateTime(receipt?.acceptedAt)
        }))}</p>
            <p data-approval-receipt-progress>${esc(t('proposalApproval.review.now', 'Now: {{progress}}', { progress: progressLine(progress) }))}</p>
            <p class="approval-review__verdict">${esc(progress.passed
                ? t('proposalApproval.receipt.passed', 'The verified decisions meet this proposal’s configured approval rules.')
                : t('proposalApproval.receipt.pending', 'Further decisions are needed to meet this proposal’s configured approval rules.'))}</p>
            <p class="approval-card__note" data-approval-receipt-shared="${shared?.shared ? 'yes' : 'no'}">${esc(sharedText(shared))}</p>`;
        parts.footer.replaceChildren(button('btn btn-primary', t('proposalApproval.done', 'Done'), close));
        parts.footer.querySelector('button').focus();
    }

    root.solanaWalletManager.on('stateChanged', () => refreshAll());
    root.ProposalApprovalPanel = { cardHtml, render, renderCards, refreshAll, openVerify, openReview, sync };
})();
