// proposals/create.js — extracted from proposals.js (behavior-preserving relocation).

// The city a proposal belongs to, as a city id ('zagreb', 'new_york', …) — the same form the
// backend's `proposal.city` column stores. Recorded on the proposal itself so its origin survives
// being uploaded from elsewhere, opened from a link, or copied.
function getProposalCityId() {
    try {
        if (typeof window !== 'undefined' && window.CityConfigManager
            && typeof window.CityConfigManager.getCurrentCityId === 'function') {
            return window.CityConfigManager.getCurrentCityId() || null;
        }
        if (typeof getCurrentCityId === 'function') return getCurrentCityId() || null;
    } catch (_) { }
    return null;
}

function updateCreateProposalSubmitState() {
    const btn = document.getElementById('createProposalSubmitButton');
    const hint = document.getElementById('proposalGeometryRequirementHint');
    const goalKey = currentGeometryGoal || getSelectedProposalTool();
    const needsGeometry = goalRequiresGeometry(goalKey);
    const hasGeometry = proposalGeometrySubmitted || !needsGeometry;

    const publishesInPlace = typeof proposalDialogOverrides !== 'undefined' && !!proposalDialogOverrides?.publishInPlace;
    if (btn) {
        // A record published in place already has its design.
        btn.disabled = !publishesInPlace && !hasGeometry;
        // Relabel the submit action for either vote kind, so the proposer sees the outcome
        // ("Submit for voting" → status "Open for voting").
        const isVote = window.ProposalKind.isNonBinding({ kind: getSelectedProposalKind() });
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const createsReplacement = !!(typeof window !== 'undefined'
            && window.pendingProposalReplacementSource?.proposalId);
        btn.textContent = publishesInPlace
            ? (t ? t('modal.createProposal.publishSubmit', 'Save terms') : 'Save terms')
            : createsReplacement
            ? window.ProposalLineage.forkSubmitLabel(window.pendingProposalReplacementSource.proposalId,
                { fork: window.pendingProposalReplacementSource.fork === true })
            : (isVote
                ? (t ? t('panel.proposal.voting.submit', 'Submit for voting') : 'Submit for voting')
                : (t ? t('modal.createProposal.submit', 'Create Proposal') : 'Create Proposal'));
    }
    if (hint) {
        hint.textContent = (!publishesInPlace && !hasGeometry) ? 'Please add a geometry first.' : '';
    }
    // The kind's terms follow the relabel.
    applyProposalKindToDialog();
    refreshReparcellizationAgreementSubmit();
}

function pendingReparcellizationAgreementBatch() {
    const draft = window.pendingProposalDraftId && window.proposalDraftStore?.getDraft(window.pendingProposalDraftId);
    return draft?.publish?.parcelAgreementBatch || window.pendingReparcellizationPlan?.agreementBatch || null;
}

function cloneProposalCreateValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

// A published editor draft is a new proposal snapshot, but its chosen rights, approval policy,
// and exact lens selection (including an empty selection) are part of the authored terms. Which
// records carry an approval setup at all: ProposalPublishTerms.approvalSetupFor.
function applyPublishingDraftApproval(proposal, draftFields = {}) {
    const hasDraftLens = Object.prototype.hasOwnProperty.call(draftFields, 'lens') && Array.isArray(draftFields.lens);
    const config = publishingApprovalSetup(proposal.kind ?? null, isReadjustmentRecord(proposal), draftFields);
    if (config) {
        const approval = typeof window !== 'undefined' ? window.ProposalApproval : null;
        proposal.approvalConfig = approval?.normalizeConfig
            ? approval.normalizeConfig(config)
            : cloneProposalCreateValue(config);
    } else {
        delete proposal.approvalConfig;
    }
    if (hasDraftLens) proposal.lens = cloneProposalCreateValue(draftFields.lens);

    const governed = proposal?.goal === 'reparcellization' || !!proposal?.reparcellization || proposal?.approvalConfig != null;
    if (governed) {
        proposal.acceptedParcelIds = [];
        proposal.ownerAcceptances = {};
        proposal.ownerApprovals = {};
        delete proposal.ownerApprovalHistory;
        delete proposal.ownerAcceptanceHistory;
    }
    return hasDraftLens;
}

function isReadjustmentRecord(proposal) {
    return proposal?.goal === 'reparcellization' || !!proposal?.reparcellization;
}

function publishingApprovalSetup(kind, readjustment, draftFields = {}) {
    return window.ProposalPublishTerms.approvalSetupFor({
        kind, readjustment,
        approvalConfig: draftFields.approvalConfig || null,
        fromDraft: Object.prototype.hasOwnProperty.call(draftFields, 'approvalConfig')
    });
}

function shouldSkipUnsupportedApprovalMint({ selectedTool, proposalMainType, approvalConfig }, adapter) {
    const requiresAbstractApproval = selectedTool === 'reparcellization'
        || proposalMainType === 'Reparcellization' || approvalConfig != null;
    if (!requiresAbstractApproval) return false;
    return typeof adapter?.supportsProposalApproval !== 'function'
        || adapter.supportsProposalApproval('proposal-approval/v1') !== true;
}

function refreshReparcellizationAgreementSubmit() {
    const t = getProposalI18nHelper();
    const batch = pendingReparcellizationAgreementBatch();
    const button = document.getElementById('createProposalSubmitButton');
    if (!button) return;
    if (batch) {
        // A retry finishes the immutable proposals already saved, so terms cannot change midway.
        document.querySelector('.create-proposal-modal')?.querySelectorAll('input, select, textarea, [data-geometry-action]').forEach(input => { input.disabled = true; });
        button.disabled = false;
        button.textContent = t('reparcellization.modal.agreementRetry', 'Retry remaining agreements');
    } else if (window.pendingReparcellizationPlan?.agreementMode === 'individual') {
        button.textContent = t('reparcellization.modal.agreementCreate', 'Create parcel agreements');
    }
}

async function finishReparcellizationAgreementBatch(batch, draftId) {
    const t = getProposalI18nHelper();
    // The agreements are the draft's layout split by owner, on the same plots. When that layout is
    // one's own local record (proposals/lineage.js editsInPlace), the split is its edit: the layout
    // comes off the map once, before the first agreement applies. A published layout stays
    // standing, as any counterproposal's source does.
    const layoutId = draftId ? window.proposalDraftStore?.getDraft(draftId)?.sourceProposalId : null;
    let layoutReleased = !layoutId;
    const releaseLocalLayout = async () => {
        if (layoutReleased) return true;
        const layout = proposalStorage.getProposal(String(layoutId));
        if (!window.ProposalLineage.editsInPlace(layout) || !isProposalApplied(layout)) {
            layoutReleased = true;
            return true;
        }
        layoutReleased = await ProposalManager.unapplyProposal(layout.proposalId) === true;
        return layoutReleased;
    };
    const result = await window.ReparcellizationAgreements.resumeBatch(batch, {
        storage: proposalStorage,
        persistBatch(next) {
            if (window.pendingReparcellizationPlan) window.pendingReparcellizationPlan.agreementBatch = next;
            if (draftId && window.proposalDraftStore?.getDraft(draftId)) {
                window.proposalDraftStore.updateDraft(draftId, { publish: { parcelAgreementBatch: next } },
                    { force: true, recordHistory: false, dirty: false });
                window.proposalDraftStore.flush();
            }
        },
        apply: async id => (await releaseLocalLayout()) && ProposalManager.applyProposal(id),
        isApplied: proposal => typeof isProposalApplied === 'function' ? isProposalApplied(proposal) : proposal?.applied === true,
        applyFailure: id => ProposalManager.getLastApplyFailure?.(id)?.message
    });
    updateShowProposalsButton();
    updateProposalList();
    if (!result.complete) {
        const message = t('reparcellization.modal.agreementFailed',
            'Created {{created}} parcel agreements; {{failed}} need attention. Your draft is kept for retry.',
            { created: result.created, failed: result.failures.length });
        const error = new Error(`${message}\n${result.failures[0]?.message || ''}`);
        if (draftId) window.proposalDraftStore?.markPublishFailed(draftId, error);
        console.error('[reparcellization] Agreement batch incomplete', result.failures);
        updateStatus(error.message);
        if (typeof window.showStyledAlert === 'function') window.showStyledAlert(error.message);
        return false;
    }
    const ids = result.batch.items.map(item => item.proposalId);
    if (draftId && window.proposalDraftStore?.getDraft(draftId)) window.proposalDraftStore.consumeAfterPublish(draftId, ids[0]);
    const user = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (user) agentStorage.updateAgent(user.id, { proposalsCreated: [...new Set([...(user.proposalsCreated || []), ...ids])] });
    window.pendingReparcellizationPlan = null;
    closeProposalDialog();
    if (typeof window.releaseEditorSeededMultiSelection === 'function') window.releaseEditorSeededMultiSelection();
    if (typeof selectAndHighlightProposal === 'function') selectAndHighlightProposal(ids[0], null, false, true);
    const message = t('reparcellization.modal.agreementCreated', 'Created {{count}} parcel agreements.', { count: ids.length });
    updateStatus(message);
    if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'success');
    return true;
}

// ---- Kind ("Who decides?", proposal-kinds.md) ----
// The kind is chosen first in both create dialogs; the overlay's data-proposal-kind shows the terms
// that belong to it (css/proposals.css): money for an owner deal, a voting period for a vote.
// The owner offers their own parcels: always an owner deal, whatever the row shows.
function isOwnerSaleOfferInDialog() {
    return !!window.proposalOwnerOfferMode
        || (typeof getSelectedProposalTool === 'function' && getSelectedProposalTool() === 'ownership-transfer-from-me');
}

function getSelectedProposalKind() {
    const kinds = window.ProposalKind;
    if (isOwnerSaleOfferInDialog()) return kinds.OWNER_DEAL;
    const checked = document.querySelector('.create-proposal-modal input[name="proposalKind"]:checked');
    return checked && kinds.KINDS.includes(checked.value) ? checked.value : kinds.DEFAULT_PUBLISH_KIND;
}

function proposalKindExplanation(kind, sale) {
    const t = getProposalI18nHelper();
    if (sale) return t('modal.createProposal.kind.explainSale', 'You offer your own parcels and a buyer pays. Binding.');
    if (kind === 'owner-vote') return t('modal.createProposal.kind.explainOwnerVote', 'The owners of these parcels vote. Non-binding: nothing is paid and no one\'s land changes.');
    if (kind === 'community-vote') return t('modal.createProposal.kind.explainCommunityVote', 'Residents take part through the organiser. Non-binding: nothing is paid and no one\'s land changes.');
    return t('modal.createProposal.kind.explainOwnerDeal', 'The owners accept a binding deal, and you offer money for it.');
}

function applyProposalKindToDialog() {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const kinds = window.ProposalKind;
    const sale = isOwnerSaleOfferInDialog();
    modal.querySelectorAll('input[name="proposalKind"]').forEach(input => {
        input.disabled = sale && input.value !== kinds.OWNER_DEAL;
        if (sale) input.checked = input.value === kinds.OWNER_DEAL;
    });
    const kind = getSelectedProposalKind();
    modal.dataset.proposalKind = kind;
    const explain = modal.querySelector('#proposalKindExplain');
    if (explain) explain.textContent = proposalKindExplanation(kind, sale);
}

// Whether the chosen kind is a vote: it then needs no offer.
function readProposalKindTerms() {
    const kind = getSelectedProposalKind();
    return { kind, nonBinding: window.ProposalKind.isNonBinding({ kind }) };
}

// The terms as the dialog holds them, for ProposalPublishTerms.publishFields.
function readProposalTermsFromDialog(offer, offerCurrency) {
    const field = id => document.getElementById(id);
    const checked = id => field(id)?.checked === true;
    const expiryMs = checked('proposalExpireCheckbox') ? parseExpiryTime(field('proposalExpiryTime')?.value) : 0;
    return {
        kind: getSelectedProposalKind(),
        offer,
        offerCurrency,
        isConditional: checked('proposalConditionalCheckbox'),
        expiresAt: expiryMs > 0 ? new Date(Date.now() + expiryMs).toISOString() : null,
        decayEnabled: checked('proposalDecayCheckbox'),
        decayPercent: parseInt(field('proposalDecayPercent')?.value, 10),
        decayDurationMs: checked('proposalDecayCheckbox') ? parseExpiryTime(field('proposalDecayTime')?.value) : 0,
        depositEnabled: checked('proposalDepositCheckbox'),
        depositPercent: parseInt(field('proposalDepositPercent')?.value, 10),
        voteExpiryDays: field('proposalVoteExpiryDays')?.value
    };
}

// ---- Publishing in place (proposal-kinds.md) ----
// A local record whose terms were never chosen gets them in the create dialog, its design sections
// hidden (data-publish-in-place): saving appends the kind, terms and details to that same record.
// Nothing about the design is re-created; the share dialog then uploads or mints the record.
function openPublishTermsDialog(proposalId, { afterSave = null } = {}) {
    const record = proposalStorage.getProposal(proposalId);
    if (!record) return false;
    showProposalDialog({
        prefill: buildCopyPrefill(record),
        publishInPlace: { proposalId: record.proposalId, afterSave }
    });
    return true;
}

function publishTermsInPlace(proposalId, afterSave) {
    const record = proposalStorage.getProposal(proposalId);
    if (!record) {
        showProposalAlertMessage('cannot_share_this_proposal_right_now', 'Cannot share this proposal right now.');
        return;
    }
    const author = getProposalAuthorValue();
    if (!author) {
        showProposalAlertMessage('please_enter_an_author_name', 'Please enter an author name.');
        return;
    }
    const description = (document.getElementById('proposalDescription')?.value || '').trim();
    if (!description) {
        showProposalAlertMessage('please_enter_a_description', 'Please enter a description.');
        return;
    }
    const kindTerms = readProposalKindTerms();
    // A readjustment's cash is its owner ledger, already on the record.
    const readjustment = isReadjustmentRecord(record);
    const offer = kindTerms.nonBinding ? 0
        : (readjustment ? Number(record.offer) || 0 : window.parseProposalOfferValue(document.getElementById('proposalOffer')?.value));
    if (!kindTerms.nonBinding && !readjustment && !(Number.isFinite(offer) && offer > 0)) {
        showProposalAlertMessage('please_enter_a_valid_offer_amount', 'Please enter a valid offer amount.');
        return;
    }
    if (kindTerms.kind === window.ProposalKind.OWNER_VOTE
        && typeof window.isSolanaLensPath === 'function' && window.isSolanaLensPath()) {
        showProposalAlertMessage('owner_vote_not_on_solana', 'Owner votes cannot be minted on Solana yet. Choose another kind, or keep the proposal off-chain.');
        return;
    }
    // As at create: a Solana mint needs a lens the proposer chose, so ask for it here rather than
    // let the share dialog fail later.
    if (typeof window.isSolanaLensPath === 'function' && window.isSolanaLensPath()
        && !(Array.isArray(record.lens) && record.lens.length)
        && !window.LensCore.validateSolanaLens(getLensEntries()).ok) {
        showProposalAlertMessage('solana_lens_required', 'Choose at least one lens member (the lens button) before minting on Solana.');
        if (typeof showLensModal === 'function') showLensModal();
        return;
    }
    const name = (document.getElementById('proposalName')?.value || '').trim() || record.title || record.name || '';
    let fields;
    try {
        fields = window.ProposalPublishTerms.termsInPlace(record,
            readProposalTermsFromDialog(offer, document.getElementById('proposalCurrency')?.value || 'USDT'), {
                name, description, author,
                epochYear: window.__proposalEpoch ? window.__proposalEpoch.readCreateDialogEpoch() : (record.epochYear ?? null)
            });
    } catch (error) {
        showProposalAlertMessage('invalid_proposal_terms', error.message);
        return;
    }
    const { approvalConfig, ...terms } = fields;
    Object.assign(record, terms);
    // The lens is part of what is published, as at create: the current one when the drawing has none.
    if (!window.ProposalKind.isOwnerSaleOffer(record) && !(Array.isArray(record.lens) && record.lens.length)) {
        const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
        if (lensSnapshot.length) record.lens = lensSnapshot;
    }
    if (approvalConfig) {
        record.approvalConfig = window.ProposalApproval?.normalizeConfig
            ? window.ProposalApproval.normalizeConfig(approvalConfig) : cloneProposalCreateValue(approvalConfig);
    } else {
        delete record.approvalConfig;
    }
    proposalStorage._indexProposal?.(record);
    proposalStorage.save();
    closeProposalDialog();
    if (typeof updateProposalList === 'function') updateProposalList();
    if (afterSave) afterSave(record.proposalId);
}

// ---- Owner offer ("Offer my land") ----
// An attested owner offers its own parcels: proposalRole 'owner-offer'. The mode is offered on the
// Solana path when a lens member in the picker has attested the connected wallet as owner of at least
// one selected parcel (GET {serviceUrl}/lens/attestations?parcelUid=&owner=), and it can only be
// submitted when every selected parcel is the wallet's. The pure gate is OwnerOffer.ownerOfferEligibility.
let ownerOfferCheckSeq = 0;

function ownerOfferSelectedCadastreIds() {
    try {
        if (typeof getCurrentParcelSelectionContext !== 'function' || !window.LiveParcelFabric
            || typeof window.LiveParcelFabric.cadastreIdsForParcelIds !== 'function') return [];
        const ids = getCurrentParcelSelectionContext().ids || [];
        return ids.length ? Array.from(new Set(window.LiveParcelFabric.cadastreIdsForParcelIds(ids).map(String))) : [];
    } catch (error) {
        console.warn(`[${new Date().toISOString()}] [OwnerOffer] could not resolve selected parcels`, error);
        return [];
    }
}

// -> { ok: false, reason } | { ok: true, owner, parcelIds, lensKeys, eligibility }
async function checkOwnerOfferEligibility() {
    const api = window.OwnerOffer;
    const picker = window.LensPicker;
    const client = window.LensServiceClient;
    if (!api || !picker || !client || !window.LensCore) return { ok: false, reason: 'unavailable' };
    if (!picker.isActive()) return { ok: false, reason: 'no-solana' };
    const state = window.solanaWalletManager.getState();
    const owner = String(state.accounts[0]);
    const lensKeys = window.LensCore.validateSolanaLens(picker.getEntries()).keys;
    if (!lensKeys.length) return { ok: false, reason: 'no-lens' };
    const parcelIds = ownerOfferSelectedCadastreIds();
    if (!parcelIds.length) return { ok: false, reason: 'no-parcels' };
    let directory = await picker.loadDirectory();
    if (directory.status === 'error') directory = await picker.loadDirectory(true);
    const members = (directory.members || []).filter(member => lensKeys.includes(member.key) && member.serviceUrl);
    if (!members.length) return { ok: false, reason: 'no-service' };
    const jobs = [];
    members.forEach(member => parcelIds.forEach(parcelUid => jobs.push({ member, parcelUid })));
    const results = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const index = next++;
            const { member, parcelUid } = jobs[index];
            const response = await client.fetchAttestations({ serviceUrl: member.serviceUrl, filter: { parcelUid, owner, kind: 'ownership' } });
            if (response.outcome.kind !== 'ok') {
                console.warn(`[${new Date().toISOString()}] [OwnerOffer] ${member.key} attestations for ${parcelUid}: ${response.outcome.message || `HTTP ${response.status}`}`);
            }
            results[index] = { memberKey: member.key, parcelUid, attestations: response.attestations };
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    const eligibility = api.ownerOfferEligibility({ parcelIds, results, owner, lensKeys });
    return { ok: true, owner, parcelIds, lensKeys, eligibility };
}

function ownerOfferStatusText(check) {
    const t = getProposalI18nHelper();
    if (!check.ok) {
        const messages = {
            'no-lens': ['modal.createProposal.ownerOffer.needLens', 'Choose your lens first: the offer needs a lens member that attested your ownership.'],
            'no-parcels': ['modal.createProposal.ownerOffer.needParcels', 'Select the parcels you own.'],
            'no-service': ['modal.createProposal.ownerOffer.noService', 'None of your lens members publishes a service URL, so your ownership cannot be checked.'],
            unavailable: ['modal.createProposal.ownerOffer.unavailable', 'Ownership attestations cannot be checked right now.']
        };
        const [key, fallback] = messages[check.reason] || messages.unavailable;
        return t(key, fallback);
    }
    const { eligibility, parcelIds } = check;
    if (!eligibility.eligible) {
        return t('modal.createProposal.ownerOffer.notAttested', 'No lens member in your lens has attested this wallet as owner of a selected parcel.');
    }
    const attested = t('modal.createProposal.ownerOffer.attested', 'Your wallet is the attested owner of {{attested}} of {{total}} selected parcels.',
        { attested: eligibility.attestedParcelIds.length, total: parcelIds.length });
    if (eligibility.submittable) return attested;
    return `${attested} ${t('modal.createProposal.ownerOffer.deselectOthers', 'Offer only your own parcels: deselect {{parcels}}.',
        { parcels: eligibility.unattestedParcelIds.join(', ') })}`;
}

// The "Offer my land" gate (GuestPolicy 'ownership-proof'): a connected wallet that a lens member
// attested as owner of the selected parcels, and a profile name (the offer is published). Returns
// true when the offer may open; otherwise says what is missing and how to get it, and returns false.
async function requireOwnerOfferProof() {
    const t = getProposalI18nHelper();
    const walletConnected = !!(window.LensPicker && window.LensPicker.isActive());
    let check = null;
    if (walletConnected) {
        try {
            check = await checkOwnerOfferEligibility();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [OwnerOffer] proof check failed`, error);
            check = { ok: false, reason: 'unavailable' };
        }
    }
    const state = {
        isGuest: currentProfileIsGuest(),
        walletConnected,
        ownershipAttested: !!(check && check.ok && check.eligibility.eligible)
    };
    const verdict = window.GuestPolicy.check('ownerOffer', state);
    console.info(`[${new Date().toISOString()}] [OwnerOffer] proof: ${verdict.allowed ? 'ok' : `missing ${verdict.missing.join(', ')}`}`);
    if (verdict.allowed) return true;
    const steps = verdict.missing.map(gap => {
        if (gap === 'wallet') return t('modal.createProposal.ownerOffer.proof.wallet', 'connect your Solana wallet');
        if (gap === 'attestation') {
            // With a wallet, the eligibility check knows the precise reason (no lens, no service...).
            if (check) return ownerOfferStatusText(check);
            return t('modal.createProposal.ownerOffer.proof.attestation', 'ask a member of your lens to attest your wallet as the owner of these parcels');
        }
        return t('modal.createProposal.ownerOffer.proof.name', 'choose a profile name (top-right bubble)');
    });
    const message = `${t('modal.createProposal.ownerOffer.proof.intro', 'Offering your land needs proof that it is yours:')} ${steps.join('; ')}.`;
    if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 10000);
    else updateStatus(message);
    return false;
}

// Re-evaluates the gate and renders the "Offer my land" group. Called when the dialog opens and from
// its Check again button (the lens and the wallet can change while the dialog is open).
async function refreshOwnerOfferMode() {
    const group = document.getElementById('proposalOwnerOfferGroup');
    const checkbox = document.getElementById('proposalOwnerOfferCheckbox');
    const status = document.getElementById('proposalOwnerOfferStatus');
    if (!group || !checkbox || !status) return;
    const seq = ++ownerOfferCheckSeq;
    if (!(window.LensPicker && window.LensPicker.isActive())) {
        group.hidden = true;
        checkbox.checked = false;
        onProposalOwnerOfferChange();
        return;
    }
    const t = getProposalI18nHelper();
    group.hidden = false;
    checkbox.disabled = true;
    status.textContent = t('modal.createProposal.ownerOffer.checking', 'Checking your ownership attestations…');
    let check;
    try {
        check = await checkOwnerOfferEligibility();
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [OwnerOffer] eligibility check failed`, error);
        check = { ok: false, reason: 'unavailable' };
    }
    if (seq !== ownerOfferCheckSeq || !group.isConnected) return;
    const eligible = !!(check.ok && check.eligibility.eligible);
    checkbox.disabled = !eligible;
    if (!eligible) checkbox.checked = false;
    // Opened from "Offer my land", which already proved ownership: start in owner-offer mode.
    else if (typeof proposalDialogOverrides !== 'undefined' && proposalDialogOverrides && proposalDialogOverrides.ownerOffer) checkbox.checked = true;
    status.textContent = ownerOfferStatusText(check);
    onProposalOwnerOfferChange();
}

function onProposalOwnerOfferChange() {
    const checkbox = document.getElementById('proposalOwnerOfferCheckbox');
    const explain = document.getElementById('proposalOwnerOfferExplain');
    const on = !!(checkbox && checkbox.checked && !checkbox.disabled);
    window.proposalOwnerOfferMode = on;
    if (explain) explain.hidden = !on;
    // An owner offering unchanged land still changes ownership. Initialize the
    // visible ownership facet so submission and the stored goal agree.
    if (on && !getSelectedProposalTool()) {
        setProposalOwnershipMode('third-party');
        syncProposalFacets();
    }
    // An owner offer is always an owner deal.
    applyProposalKindToDialog();
}

function resolveProposalAuthorName() {
    let authorName = '';
    if (typeof getCurrentUsername === 'function') {
        try {
            authorName = getCurrentUsername() || '';
        } catch (e) {
            console.warn('Failed to resolve username for proposal author', e);
        }
    }
    if (!authorName && typeof getCurrentUserAgent === 'function') {
        try {
            const agent = getCurrentUserAgent();
            if (agent && agent.name) {
                authorName = agent.name;
            }
        } catch (e) {
            console.warn('Failed to resolve agent for proposal author', e);
        }
    }
    return authorName;
}

function populateProposalAuthorUI({ inputId = 'proposalAuthor', avatarId = 'proposalAuthorAvatar' } = {}) {
    const input = document.getElementById(inputId);
    const avatarImg = document.getElementById(avatarId);
    const authorName = resolveProposalAuthorName();

    if (input) {
        input.value = authorName;
        input.disabled = true;
    }

    if (avatarImg) {
        let avatarApplied = false;
        if (typeof getCurrentUserAgent === 'function' && typeof getAvatarImagePath === 'function') {
            try {
                const agent = getCurrentUserAgent();
                if (agent && typeof agent.avatarIndex !== 'undefined') {
                    const src = getAvatarImagePath(agent.avatarIndex);
                    if (src) {
                        avatarImg.src = src;
                        avatarImg.alt = `${agent.name || authorName || 'Author'} avatar`;
                        avatarImg.style.display = 'block';
                        avatarApplied = true;
                    }
                }
            } catch (e) {
                console.warn('Failed to set proposal author avatar', e);
            }
        }
        if (!avatarApplied) {
            avatarImg.style.display = 'none';
        }
    }

    return authorName;
}

function getProposalAuthorValue(inputId = 'proposalAuthor') {
    const input = document.getElementById(inputId);
    const value = (input && typeof input.value === 'string') ? input.value.trim() : '';
    return value || resolveProposalAuthorName();
}

// The type a proposal is born with is an internal English token ('Road', 'Track', 'Residences', …).
// Both the default name and the default description are persisted, so they are localized HERE, at
// creation time, in the language the author is actually using.
const PROPOSAL_TYPE_TRANSLATION_KEYS = {
    'residences': 'modal.createProposal.goalOptions.buildings',
    'single building': 'modal.createProposal.goalOptions.single',
    'building(s)': 'modal.createProposal.goalOptions.single',
    'park': 'modal.createProposal.goalOptions.park',
    'square': 'modal.createProposal.goalOptions.square',
    'lake': 'modal.createProposal.goalOptions.lake',
    // A drawn corridor knows whether it is a road or a track — say so, instead of the "Road/Track"
    // category name the user never picked.
    'road': 'modal.roadWidth.proposalList.goalLabels.road',
    'track': 'modal.roadWidth.proposalList.goalLabels.track',
    'road/track': 'modal.createProposal.goalOptions.roadTrack',
    'decide later': 'modal.createProposal.goalOptions.decideLater',
    'reparcellization': 'modal.createProposal.goalOptions.reparcellization',
    'urban rule': 'modal.createProposal.proposalTypeOptions.urbanRule',
    'joint investment': 'modal.createProposal.proposalTypeOptions.jointInvestment',
    'purchase': 'modal.createProposal.proposalTypeOptions.purchase',
    'ownership-transfer-to-me': 'modal.createProposal.ownershipTransfer.nameToMe',
    'ownership-transfer-from-me': 'modal.createProposal.ownershipTransfer.nameFromMe',
    'ownership-transfer-to-city': 'modal.createProposal.ownershipTransfer.nameToCity',
    'ownership-transfer-third-party': 'modal.createProposal.ownershipTransfer.nameThirdParty',
    'offer-to-sell': 'modal.createProposal.ownershipTransfer.nameOfferToSell'
};

function localizeProposalTypeLabel(proposalType) {
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const normalizedType = (proposalType || '').toString().trim();
    if (!t || !normalizedType) return normalizedType;

    const key = normalizedType.toLowerCase();
    const translationKey = PROPOSAL_TYPE_TRANSLATION_KEYS[key];
    if (translationKey) return t(translationKey, normalizedType);
    if (typeof getProposalTypeLabel === 'function') return getProposalTypeLabel(normalizedType);
    return normalizedType;
}

// "Block · parcel 2143", "Park · 24 parcels", or, without a parcel set, "Block · 3 Oct 2026, 00:26".
// It used to be a clock code ("Block 0310-0026"), which told the reader nothing about the proposal.
function generateDefaultProposalName(proposalType, context = {}) {
    const localizedType = localizeProposalTypeLabel(proposalType);
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : ((_k, fallback) => fallback);
    let ids = Array.isArray(context.parcelIds) ? context.parcelIds.filter(Boolean).map(String) : [];
    if (!ids.length && typeof getCurrentParcelSelectionContext === 'function') {
        // The create dialog names a proposal before the caller knows its parcels: use the selection.
        try { ids = (getCurrentParcelSelectionContext()?.ids || []).filter(Boolean).map(String); } catch (_) { ids = []; }
    }
    let place;
    if (ids.length === 1) {
        // The cadastral number is the part people recognise; the municipality prefix is not.
        const short = ids[0].split('-').pop();
        place = t('proposals.autoName.parcel', 'parcel {{id}}', { id: short });
    } else if (ids.length > 1) {
        place = t('proposals.autoName.parcels', '{{count}} parcels', { count: ids.length });
    } else {
        place = typeof CbFormat !== 'undefined' ? CbFormat.formatDateTime(new Date()) : new Date().toLocaleString();
    }
    return `${localizedType} · ${place}`;
}

function generateDefaultProposalDescription(proposalType, proposalName) {
    const authorName = resolveProposalAuthorName() || 'User';
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const localizedType = localizeProposalTypeLabel(proposalType);

    // Generate simpler description without repeating the name
    // The name is shown separately in the proposal details
    const fallback = `A new ${localizedType} proposal by ${authorName}`;
    return t
        ? t('modal.createProposal.defaultDescription', fallback, { type: localizedType, author: authorName })
        : fallback;
}

function updateProposalNameAndDescription(proposalType, forceUpdate = false) {
    const nameInput = document.getElementById('proposalName');
    const descriptionInput = document.getElementById('proposalDescription');

    if (nameInput) {
        if (forceUpdate || !nameInput.value.trim()) {
            nameInput.value = generateDefaultProposalName(proposalType);
        }
    }

    if (descriptionInput) {
        if (forceUpdate || !descriptionInput.value.trim()) {
            const proposalName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : generateDefaultProposalName(proposalType);
            descriptionInput.value = generateDefaultProposalDescription(proposalType, proposalName);
        }
    }
}

async function createProposal() {
    console.debug('[createProposal] START - Create proposal button clicked');
    const startTime = performance.now();
    // Terms for a record that already exists: appended in place, nothing below re-creates it.
    const publishInPlace = (typeof proposalDialogOverrides !== 'undefined') ? proposalDialogOverrides?.publishInPlace : null;
    if (publishInPlace) return publishTermsInPlace(publishInPlace.proposalId, publishInPlace.afterSave);
    const t = getProposalI18nHelper();
    const publishingDraftId = (typeof window !== 'undefined' && window.pendingProposalDraftId)
        ? String(window.pendingProposalDraftId)
        : null;
    const publishingDraft = publishingDraftId ? window.proposalDraftStore?.getDraft?.(publishingDraftId) : null;
    // Set below when this save edits one's own local record in place (proposals/lineage.js).
    let inPlaceSourceId = null;
    const draftOwnFields = publishingDraft?.fields && typeof publishingDraft.fields === 'object'
        ? publishingDraft.fields : {};
    // The dialog's own Ownership and approval row (dialog-create.js) is what the author chose last.
    const dialogApproval = typeof window !== 'undefined' ? window.pendingProposalApprovalSetup : null;
    const publishingDraftFields = dialogApproval
        ? { ...draftOwnFields, approvalConfig: dialogApproval.approvalConfig, lens: dialogApproval.lens }
        : draftOwnFields;
    const markDraftPublishFailed = (error) => {
        if (!publishingDraftId || !window.proposalDraftStore?.getDraft?.(publishingDraftId)) return;
        window.proposalDraftStore.markPublishFailed(publishingDraftId, error);
    };
    const pendingAgreementBatch = pendingReparcellizationAgreementBatch();
    if (pendingAgreementBatch) {
        setProposalCreateButtonState(true);
        setProposalModalInteractivity(false);
        try { return await finishReparcellizationAgreementBatch(pendingAgreementBatch, publishingDraftId); }
        catch (error) {
            markDraftPublishFailed(error);
            console.error('[reparcellization] Agreement retry failed', error);
            updateStatus(error.message);
        } finally {
            setProposalModalInteractivity(true);
            setProposalCreateButtonState(false);
            refreshReparcellizationAgreementSubmit();
        }
        return;
    }
    const selectedTool = getSelectedProposalTool();
    if (!selectedTool) {
        showProposalAlertMessage('select_a_proposal_goal_before_creating_a_proposal', 'Select a proposal goal before creating a proposal.');
        return;
    }
    if (selectedTool === 'decide-later') {
        showProposalAlertMessage(
            'proposal_type_no_longer_available',
            'Merge / Decide Later is no longer available. Use Land readjustment.'
        );
        return;
    }
    if (goalRequiresGeometry(selectedTool) && !proposalGeometrySubmitted) {
        showProposalAlertMessage('please_add_a_geometry_first', 'Please add a geometry first.');
        updateCreateProposalSubmitState();
        return;
    }
    console.debug('[createProposal] Selected tool:', selectedTool);
    const goalBadge = getProposalGoalBadge(selectedTool);

    // All proposal types are handled uniformly below.
    // Building/urban-rule geometry is expected in pendingBuildingProposalContext (set by geometry tools).

    const author = getProposalAuthorValue();
    const proposalTypeInput = document.getElementById('proposalType');
    const proposalType = proposalTypeInput && proposalTypeInput.value ? proposalTypeInput.value : DEFAULT_PROPOSAL_TYPE;
    const proposalMainTypeInput = document.getElementById('proposalMainType');
    const proposalMainType = proposalMainTypeInput && proposalMainTypeInput.value ? proposalMainTypeInput.value : 'Purchase';
    const pendingReparcelPlan = (typeof window !== 'undefined') ? window.pendingReparcellizationPlan : null;
    const separateAgreements = proposalMainType === 'Reparcellization' && pendingReparcelPlan?.agreementMode === 'individual';
    if (proposalMainType === 'Reparcellization') {
        if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.polygons) || pendingReparcelPlan.polygons.length === 0) {
            showProposalAlertMessage('run_the_reparcellization_algorithm_and_click_done_before_creating_this_proposal', 'Run the reparcellization algorithm and click Done before creating this proposal.');
            return;
        }
    }
    const proposalName = (document.getElementById('proposalName') && document.getElementById('proposalName').value || '').trim();
    const description = document.getElementById('proposalDescription').value.trim();
    const kindTerms = readProposalKindTerms();
    const offer = kindTerms.nonBinding ? 0 : (proposalMainType === 'Reparcellization'
        ? window.ReparcellizationAgreements.cashOfferTotal(pendingReparcelPlan)
        : window.parseProposalOfferValue(document.getElementById('proposalOffer').value) || 0);
    const offerCurrencySelect = document.getElementById('proposalCurrency');
    const offerCurrency = proposalMainType === 'Reparcellization' ? 'EUR'
        : (offerCurrencySelect && offerCurrencySelect.value ? offerCurrencySelect.value : 'USDT');
    const acquisitionInput = document.getElementById('proposalAcquisitionMode');
    const acquisitionMode = acquisitionInput && acquisitionInput.value ? acquisitionInput.value : null;
    const boundaryInput = document.getElementById('proposalBoundaryMode');
    const boundaryMode = boundaryInput && boundaryInput.value ? boundaryInput.value : null;

    // Validation
    if (!author) {
        showProposalAlertMessage('please_enter_an_author_name', 'Please enter an author name.');
        return;
    }
    // Owners have no way to cast a vote on Solana yet (proposal-kinds.md M3): minting one there
    // would leave a vote nobody can take part in.
    if (kindTerms.kind === window.ProposalKind.OWNER_VOTE
        && typeof window.isSolanaLensPath === 'function' && window.isSolanaLensPath()) {
        showProposalAlertMessage('owner_vote_not_on_solana', 'Owner votes cannot be minted on Solana yet. Choose another kind, or keep the proposal off-chain.');
        return;
    }
    // A Solana mint needs a lens the proposer chose; nothing substitutes one.
    if (typeof window.isSolanaLensPath === 'function' && window.isSolanaLensPath()
        && !window.LensCore.validateSolanaLens(getLensEntries()).ok) {
        showProposalAlertMessage('solana_lens_required', 'Choose at least one lens member (the lens button) before minting on Solana.');
        if (typeof showLensModal === 'function') showLensModal();
        return;
    }
    // "Offer my land": re-check at submit, since the lens, wallet or selection may have changed.
    const ownerOfferRequested = !!window.proposalOwnerOfferMode;
    if (ownerOfferRequested) {
        let ownerOfferCheck;
        try {
            ownerOfferCheck = await checkOwnerOfferEligibility();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [OwnerOffer] submit check failed`, error);
            ownerOfferCheck = { ok: false, reason: 'unavailable' };
        }
        if (!ownerOfferCheck.ok || !ownerOfferCheck.eligibility.submittable) {
            showProposalAlertMessage('owner_offer_not_attested', 'An owner offer can only name parcels your wallet is attested to own by a member of your lens. {{detail}}',
                { detail: ownerOfferStatusText(ownerOfferCheck) });
            refreshOwnerOfferMode();
            return;
        }
    }
    if (!description) {
        showProposalAlertMessage('please_enter_a_description', 'Please enter a description.');
        return;
    }
    if (!kindTerms.nonBinding && (!Number.isFinite(offer) || offer < 0 || (offer === 0 && proposalMainType !== 'Reparcellization'))) {
        showProposalAlertMessage('please_enter_a_valid_offer_amount', 'Please enter a valid offer amount.');
        return;
    }

    // Lock UI while creating
    console.debug('[createProposal] Locking UI and starting proposal creation');
    setProposalCreateButtonState(true);
    setProposalModalInteractivity(false);
    let waitingPopupVisible = false;
    const hideWaitingPopupSafe = () => {
        if (waitingPopupVisible) {
            hideProposalWaitingPopup();
            waitingPopupVisible = false;
        }
        setProposalModalDimmed(false);
    };

    try {
        // Get the parcelIds that were determined in showProposalDialog
        console.debug('[createProposal] Collecting parcel IDs');
        let finalParcelIds = [];

        const createdFromMultiSelect = multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 1;

        if (multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            finalParcelIds = [selectedParcelId];
        }

        // A site-first proposal (the dialog's site context, js/site-drawing.js) has its ground as a
        // site and its declaration as the binding — possibly empty on bare ground.
        const siteContext = (typeof window !== 'undefined' && window.pendingProposalSiteContext
            && window.pendingProposalSiteContext.site && !ownerOfferRequested) ? window.pendingProposalSiteContext : null;
        if (siteContext) finalParcelIds = [];
        console.debug('[createProposal] Final parcel IDs:', finalParcelIds.length, 'parcels', siteContext ? '(site-first)' : '');
        if (finalParcelIds.length === 0 && !siteContext) {
            showProposalAlertMessage('no_parcels_selected_please_select_parcels_before_creating_a_proposal', 'No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        // The selection is a set of current live pieces. It is transient authoring input only;
        // every durable or external relationship (proposal storage, ownership and chain minting)
        // uses the immutable cadastral projection.
        const selectedLiveParcelIds = finalParcelIds.map(id => id && id.toString ? id.toString() : String(id));
        const liveFabric = window.LiveParcelFabric;
        if (!liveFabric || typeof liveFabric.cadastreIdsForParcelIds !== 'function') {
            throw new Error('Live parcel fabric is required to author proposal ground.');
        }
        const authoredCadastreParcelIds = siteContext
            ? (siteContext.cadastreParcelIds || []).map(String)
            : liveFabric.cadastreIdsForParcelIds(selectedLiveParcelIds);
        // The intrusion tolerance (the dialog's Options): linear metres, default 0.
        const toleranceInput = document.getElementById('proposalToleranceM');
        const toleranceRaw = toleranceInput ? Number(toleranceInput.value) : 0;
        const toleranceM = Number.isFinite(toleranceRaw) && toleranceRaw > 0 ? Math.min(toleranceRaw, 1) : 0;

        // Check if parcels have NFTs on-chain before proceeding
        console.debug('[createProposal] Checking blockchain support and wallet connection');
        const blockchainSupported = typeof window.ProposalChainBridge !== 'undefined'
            && window.ProposalChainBridge.isSupported();
        const solanaBlockchainSupported = typeof window.SolanaProposalChainBridge !== 'undefined'
            && window.SolanaProposalChainBridge.isSupported();

        // First check if wallet is connected - skip all NFT checking if not connected
        let walletManager = window.walletManager;
        let isEvmWalletConnected = false;
        if (walletManager && typeof walletManager.getState === 'function') {
            const walletState = walletManager.getState();
            isEvmWalletConnected = walletState && walletState.status === 'connected'
                && Array.isArray(walletState.accounts) && walletState.accounts.length > 0;
        }
        const solWm = window.solanaWalletManager;
        const isSolanaWalletConnected = solWm && typeof solWm.getState === 'function'
            && solWm.getState().status === 'connected'
            && Array.isArray(solWm.getState().accounts) && solWm.getState().accounts.length > 0;
        const isWalletConnected = isEvmWalletConnected || isSolanaWalletConnected;
        // Canton is a custodial network (no wallet) selected via CantonMode. When
        // active we mint on Canton instead of EVM/Solana — and skip NFT checks.
        const cantonActive = !!(window.CantonMode && typeof window.CantonMode.isActive === 'function' && window.CantonMode.isActive());

        console.debug('[createProposal] Blockchain supported:', blockchainSupported, 'Solana supported:', solanaBlockchainSupported, 'Wallet connected:', isWalletConnected, 'Canton:', cantonActive);
        let shouldMintOnchain = !separateAgreements && ((((blockchainSupported || solanaBlockchainSupported) && isWalletConnected) || cantonActive) && (finalParcelIds.length > 0 || !!siteContext));
        const approvalMintAdapter = cantonActive ? window.CantonProposalChainBridge
            : isSolanaWalletConnected ? window.SolanaProposalChainBridge : window.ProposalChainBridge;
        if (shouldMintOnchain && shouldSkipUnsupportedApprovalMint({
            selectedTool, proposalMainType,
            approvalConfig: publishingApprovalSetup(kindTerms.kind,
                selectedTool === 'reparcellization' || proposalMainType === 'Reparcellization', publishingDraftFields)
        }, approvalMintAdapter)) {
            shouldMintOnchain = false;
            const unsupportedMessage = t('proposalApproval.chainUnsupported', 'This approval setup is not supported by the current chain adapter.');
            showProposalAlertMessage('abstract_approval_chain_unsupported', unsupportedMessage);
        }
        // Minting leaves the device and the record carries its author (GuestPolicy 'mint').
        if (shouldMintOnchain && guestPolicyBlocks('mint')) return;

        // Parcel NFTs represent original cadastral land, never a browser's materialized pieces.
        const parcelIds = authoredCadastreParcelIds.slice();

        // Build a feature map for parcels (used when minting prerequisites to get parcel names)
        const parcelFeatureById = new Map();
        for (const parcelId of parcelIds) {
            const feature = window.CadastralParcelRepository?.get?.(parcelId)
                || liveFabric?.entriesForCadastre?.([parcelId], { includeCorridors: false })?.[0]
                || null;
            if (feature) parcelFeatureById.set(parcelId, feature);
        }

        if (shouldMintOnchain && !cantonActive && parcelIds.length) {
            // Get chain ID from wallet or use default
            let chainId = null;
            if (isSolanaWalletConnected) {
                const cluster = solWm.getCluster ? solWm.getCluster() : 'devnet';
                chainId = `solana-${cluster}`;
            } else if (walletManager && typeof walletManager.getState === 'function') {
                const walletState = walletManager.getState();
                chainId = walletState?.chainId || null;
            }

            // If no chain ID from wallet, try to get from default
            if (!chainId) {
                const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
                if (globalScope && globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                    chainId = globalScope.DEFAULT_CHAIN_ID;
                } else {
                    const env = globalScope?.current_environment || 'production';
                    chainId = env === 'development' ? '31337' : '84532';
                }
            }

            // Check if parent parcels have NFTs on-chain
            console.debug('[createProposal] Checking if parcels have NFTs on-chain, parcel count:', parcelIds.length);
            const nftCheckStartTime = performance.now();
            updateStatus('Checking if parcels have NFTs on-chain...');
            const isSolanaChain = typeof chainId === 'string' && chainId.startsWith('solana');
            const parcelCheckResult = isSolanaChain
                ? await checkParcelsHaveNFTsSolana(parcelIds, chainId)
                : await checkParcelsHaveNFTs(parcelIds, chainId);
            console.debug('[createProposal] NFT check took:', (performance.now() - nftCheckStartTime).toFixed(2), 'ms');

            if (!parcelCheckResult.allHaveNFTs && parcelCheckResult.missingParcels.length > 0) {
                // Some parcels don't have NFTs - show modal
                const chainDisplay = parcelCheckResult.chainName || parcelCheckResult.chainId || 'the blockchain';
                const action = await showMissingParcelsModal(parcelCheckResult.missingParcels, chainDisplay, { anchors: isSolanaChain });
                const tAnchor = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
                const afterPrerequisitesText = isSolanaChain
                    ? (tAnchor ? tAnchor('modal.createProposal.missingParcels.anchorThenCreate', 'Create the parcel anchors, then click Create again.') : 'Create the parcel anchors, then click Create again.')
                    : 'Mint the prerequisite parcel NFTs, then click Create again.';

                if (action === 'mint') {
                    const mintableParcels = parcelCheckResult.missingParcels.map((parcelId) => {
                        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                        const feature = parcelFeatureById.get(idStr) || null;
                        const props = feature && feature.properties ? feature.properties : {};
                        const parcelName = props.name || props.parcel_name || props.parcel || props.BROJ_CESTICE || `Parcel ${idStr}`;
                        return { parcelId: idStr, parcelName, feature };
                    });

                    try {
                        await openParcelMintModal({
                            parcels: mintableParcels,
                            onExit: () => {
                                updateStatus(afterPrerequisitesText);
                            }
                        });
                        updateStatus(afterPrerequisitesText);
                    } catch (mintModalError) {
                        console.error('Unable to open mint modal for missing parcels', mintModalError);
                        updateStatus('Unable to open mint modal. Please mint parcels before creating the proposal.');
                    }
                    return;
                }

                if (action !== 'memory') {
                    updateStatus('Proposal creation cancelled.');
                    return;
                }

                // User chose to proceed with local-only proposal
                shouldMintOnchain = false;
                updateStatus('Creating in-memory proposal (not minted on-chain)...');
            } else if (parcelCheckResult.allHaveNFTs) {
                // All parcels have NFTs - proceed silently with on-chain minting
                updateStatus('All parcels have NFTs. Proceeding with on-chain proposal...');
            }
        }

        // Calculate bounds for the proposal (for reliable positioning)
        console.debug('[createProposal] Calculating proposal bounds');
        const boundsStartTime = performance.now();
        const bounds = calculateProposalBounds(finalParcelIds, siteContext ? { site: siteContext.site } : {});
        console.debug('[createProposal] Bounds calculation took:', (performance.now() - boundsStartTime).toFixed(2), 'ms');

        // The kind and its terms become record fields through the one builder every publish path
        // uses (proposals/publish-terms.js): a vote carries no money and runs to its deadline.
        const termFields = window.ProposalPublishTerms.publishFields(
            readProposalTermsFromDialog(offer, offerCurrency),
            { saleOffer: isOwnerSaleOfferInDialog() }
        );
        const isConditional = termFields.isConditional;

        if (publishingDraftId && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.updateDraft(publishingDraftId, {
                fields: {
                    name: proposalName || proposalType,
                    description,
                    selectedParcelIds: selectedLiveParcelIds,
                    acquisitionMode,
                    boundaryAdjustment: boundaryMode,
                    ...termFields
                }
            }, { coalesceKey: 'publish-form' });
        }

        const proposal = {
            author,
            title: proposalName || proposalType, // Keep a stable human-readable title
            name: proposalName || proposalType,
            proposalName: proposalName || proposalType,
            description: description || proposalName || proposalType,
            ...termFields, // kind, money terms or voting period (proposals/publish-terms.js)
            acquisitionMode: acquisitionMode,
            boundaryAdjustment: boundaryMode,
            cadastreParcelIds: authoredCadastreParcelIds,
            primaryType: proposalMainType,
            goal: selectedTool,
            acceptedParcelIds: [], // Track which parcels have accepted the proposal
            ownerAcceptances: {},
            applied: false,
            bounds: bounds, // Store bounds for reliable positioning
            createdAt: new Date().toISOString(), // Add creation timestamp
            // Which decade of the plan this builds — set in the dialog, sticky between creates.
            epochYear: (typeof window !== 'undefined' && window.__proposalEpoch)
                ? window.__proposalEpoch.readCreateDialogEpoch()
                : null,
            // The city this proposal's parcels belong to. Stamped at creation, not at upload, so a
            // proposal made in Zagreb and uploaded later from New York is still labelled Zagreb —
            // and so a shared link can be recognised as cross-city even without a ?city= param.
            city: getProposalCityId()
        };
        if (siteContext && siteContext.authored !== false) proposal.site = JSON.parse(JSON.stringify(siteContext.site));
        if (siteContext && siteContext.binding) proposal.binding = JSON.parse(JSON.stringify(siteContext.binding));
        if (toleranceM > 0) proposal.toleranceM = toleranceM;

        // Lineage for "Copy into new proposal". The source is never mutated — the fork just
        // records where it came from. Set by showProposalDialog() from its `copySource` override,
        // and re-cleared on every dialog open, so a plain create leaves this undefined.
        const proposalCopySource = (typeof window !== 'undefined') ? window.pendingProposalCopySource : null;
        if (proposalCopySource && proposalCopySource.proposalId) {
            proposal.copiedFromProposalId = String(proposalCopySource.proposalId);
            proposal.copiedFromName = proposalCopySource.name || null;
        }
        if (publishingDraftId) {
            const source = window.pendingProposalReplacementSource || {};
            const draft = window.proposalDraftStore?.getDraft?.(publishingDraftId);
            const immutableSourceId = draft?.sourceProposalId || source.proposalId || proposal.copiedFromProposalId || null;
            if (immutableSourceId) {
                proposal.sourceProposalId = String(immutableSourceId);
                proposal.replacementOfProposalId = String(immutableSourceId);
                // One's own local record is saved in place; a published one, or an explicit Fork,
                // makes a new record that links back (proposals/lineage.js editsInPlace).
                const editSource = proposalStorage.getProposal(String(immutableSourceId));
                if (window.ProposalLineage.editsInPlace(editSource, { fork: source.fork === true })) {
                    inPlaceSourceId = String(editSource.proposalId);
                }
            }
            proposal.proposalDraftId = publishingDraftId;
            proposal.proposalDraftRevision = draft?.revision ?? source.revision ?? null;
            // A counterproposal whose land differs from its origin's is a land fork: record the
            // origin set it departed from. Decided from the authored parcels, not from which button
            // started it, so an unchanged set stays a plain counterproposal with no landFork.
            const relationApi = window.ParcelSetRelations;
            const originSnapshot = draft?.sourceSnapshot || null;
            if (immutableSourceId && originSnapshot && relationApi && typeof relationApi.buildLandForkLineage === 'function') {
                const landFork = relationApi.buildLandForkLineage(
                    { ...originSnapshot, proposalId: String(immutableSourceId) },
                    authoredCadastreParcelIds
                );
                if (landFork) proposal.landFork = landFork;
            }
        }

        // "Ownership transfer from me" proposals are automatically accepted but not funded
        // This means all parcels are marked as accepted, but the proposal cannot be executed
        if (selectedTool === 'ownership-transfer-from-me') {
            proposal.acceptedParcelIds = authoredCadastreParcelIds.slice();
            proposal.funded = false; // Explicitly mark as not funded - prevents execution
            proposal.ownershipTransferProposal = {
                direction: 'from-me',
                status: 'accepted-not-funded'
            };
        }

        // "Ownership transfer to me" proposals work like decide-later
        if (selectedTool === 'ownership-transfer-to-me') {
            proposal.ownershipTransferProposal = {
                direction: 'to-me',
                status: 'pending'
            };
        }

        // Record the three facets, and the explicit recipient (to-me / to-city /
        // third-party) so the proposal carries who receives the land beyond the
        // legacy to-me/from-me direction. (Recipient-accept enforcement is a later phase.)
        const chosenFacets = window.proposalFacets || null;
        if (chosenFacets) {
            proposal.facets = {
                landUse: chosenFacets.landUse,
                parcels: chosenFacets.parcels,
                ownership: chosenFacets.ownership
            };
            const recip = chosenFacets.ownership;
            if (recip === 'to-me' || recip === 'to-city' || recip === 'third-party') {
                proposal.ownershipTransferProposal = proposal.ownershipTransferProposal || {
                    direction: 'to-me',
                    status: 'pending'
                };
                proposal.ownershipTransferProposal.recipient = recip;
                if (recip === 'third-party') {
                    // 'any' = open offer to sell (recipient unspecified); 'specific' = named address.
                    proposal.ownershipTransferProposal.recipientScope = chosenFacets.recipientScope || 'specific';
                    if (chosenFacets.recipientScope !== 'any') {
                        proposal.ownershipTransferProposal.recipientAddress = chosenFacets.recipientAddress || '';
                    }
                }
            }
        }

        // An attested owner offering its own land; bids arrive as pledges and donations and the
        // owner's own acceptance executes it. Absent for an ordinary proposal.
        if (ownerOfferRequested) {
            proposal.proposalRole = 'owner-offer';
        }

        // Auto-tag structure proposals (park/square/lake) created from Purchase flow so they carry geometry and parent ids
        if (proposalMainType === 'Purchase' && (selectedTool === 'park' || selectedTool === 'square' || selectedTool === 'lake')) {
            const kind = selectedTool;
            let structureGeometry = null;
            try {
                if (siteContext) {
                    // A site-first structure is its authored geometry (the draft), else its site.
                    const draft = publishingDraftId ? window.proposalDraftStore?.getDraft?.(publishingDraftId) : null;
                    const authored = draft?.editorPayload?.structureProposal?.geometry || draft?.editorPayload?.geometry || null;
                    structureGeometry = authored || (siteContext.site.coordinates.length === 1
                        ? { type: 'Polygon', coordinates: siteContext.site.coordinates[0] } : siteContext.site);
                } else if (typeof buildGeometryFromParcels === 'function') {
                    if (finalParcelIds.length) {
                        structureGeometry = buildGeometryFromParcels(finalParcelIds);
                    }
                }
            } catch (_) { /* geometry rebuild best-effort */ }

            proposal.structureProposal = {
                kind,
                geometry: structureGeometry || null,
                blockName: formatParcelSelectionLabel(selectedLiveParcelIds)
            };
        }

        // Road/track proposals created through the constrained corridor modal
        if (selectedTool === 'road-track') {
            const corridor = pendingConstrainedCorridor || (typeof window !== 'undefined' ? window.pendingConstrainedCorridor : null);
            const roadDrawingContext = (typeof window !== 'undefined' && window.pendingRoadDrawingProposal)
                ? window.pendingRoadDrawingProposal
                : pendingRoadDrawingProposal;
            const safeClone = (value) => {
                if (!value) return value;
                try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
            };

            if (roadDrawingContext) {
                const isTrackContext = roadDrawingContext?.metadata?.isTrack === true;
                const selectedRoadParcelIds = (Array.isArray(roadDrawingContext.parcelIds) ? roadDrawingContext.parcelIds : selectedLiveParcelIds)
                    .map(id => id && id.toString ? id.toString() : String(id))
                    .filter(Boolean);
                // The parcels the drawing tool found, extended by every loaded cadastral parcel the
                // corridor polygon covers — including streets already under an applied road, which
                // the tool's live query skips (corridor pieces) but this road still takes.
                const roadCadastreParcelIds = typeof window.__cadastreAncestry?.declarationCoveringFootprint === 'function'
                    ? window.__cadastreAncestry.declarationCoveringFootprint({
                        cadastreParcelIds: liveFabric.cadastreIdsForParcelIds(selectedRoadParcelIds),
                        roadProposal: { definition: { polygon: roadDrawingContext.polygon } }
                    })
                    : liveFabric.cadastreIdsForParcelIds(selectedRoadParcelIds);

                const centerlinePoints = Array.isArray(roadDrawingContext.centerline)
                    ? roadDrawingContext.centerline
                        .map(segment => Array.isArray(segment)
                            ? segment.map(pt => {
                                if (!pt) return null;
                                const lat = Number(pt.lat !== undefined ? pt.lat : (Array.isArray(pt) ? pt[1] : null));
                                const lng = Number(pt.lng !== undefined ? pt.lng : (Array.isArray(pt) ? pt[0] : null));
                                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                                return { lat, lng };
                            }).filter(Boolean)
                            : null)
                        .filter(seg => Array.isArray(seg) && seg.length >= 2)
                    : [];

                const baseMetadata = (roadDrawingContext.metadata && typeof roadDrawingContext.metadata === 'object')
                    ? { ...roadDrawingContext.metadata }
                    : {};
                const resolvedMetadata = {
                    ...baseMetadata,
                    mode: baseMetadata.mode || 'draw',
                    type: baseMetadata.type || (isTrackContext ? 'track' : 'road'),
                    source: baseMetadata.source || 'road-drawing',
                    isTrack: isTrackContext,
                    isRoad: !isTrackContext, // tracks are NOT roads
                    isCorridor: true
                };
                const roadDefinition = {
                    points: centerlinePoints,
                    segments: centerlinePoints,
                    // Index-aligned with `segments`: identity survives a copy, so continuing a road in a
                    // later session extends the same segment instead of minting a new one.
                    segmentIds: Array.isArray(roadDrawingContext.segmentIds)
                        ? roadDrawingContext.segmentIds.slice(0, centerlinePoints.length)
                        : [],
                    // The cross-section. `width` below is its total, kept as a cache for the many
                    // consumers that only need the corridor's footprint.
                    profile: safeClone(roadDrawingContext.profile) || null,
                    width: Number.isFinite(roadDrawingContext.width) ? roadDrawingContext.width : (isTrackContext ? DEFAULT_CORRIDOR_WIDTHS.track : DEFAULT_CORRIDOR_WIDTHS.road),
                    sidewalkWidth: Number.isFinite(roadDrawingContext.sidewalkWidth) ? roadDrawingContext.sidewalkWidth : null,
                    tunnels: safeClone(roadDrawingContext.tunnels) || [],
                    gradeSeparations: safeClone(roadDrawingContext.gradeSeparations) || [],
                    segmentProfiles: safeClone(roadDrawingContext.segmentProfiles) || {},
                    polygon: roadDrawingContext.polygon ? safeClone(roadDrawingContext.polygon) : null,
                    metadata: resolvedMetadata
                };

                // The profile is the truth; if one is present the stored width must be its sum, or the
                // corridor polygon and its cross-section would disagree about the footprint.
                const profileWidth = (typeof corridorProfileWidth === 'function') ? corridorProfileWidth(roadDefinition.profile) : 0;
                if (profileWidth > 0) roadDefinition.width = profileWidth;

                if (roadDrawingContext.stats) {
                    const statsClone = safeClone(roadDrawingContext.stats);
                    roadDefinition.metadata.ownershipAndAcquisitionStats = statsClone;
                    proposal.ownershipAndAcquisitionStats = statsClone;
                }

                proposal.primaryType = isTrackContext ? 'Track' : 'Road';
                proposal.goal = 'road-track';
                proposal.isCorridor = true;
                proposal.cadastreParcelIds = roadCadastreParcelIds;

                proposal.roadProposal = {
                    definition: safeClone(roadDefinition),
                    mode: resolvedMetadata.mode,
                    isCorridor: true,
                    ownershipAndAcquisitionStats: roadDrawingContext.stats ? safeClone(roadDrawingContext.stats) : null
                };
            } else {
                if (!corridor) {
                    const tCorridor = getCorridorI18nHelper();
                    showProposalAlertMessage('corridor_missing', tCorridor('statusMissing', 'Open the constrained corridor tool and click Done before creating a road/track proposal.'));
                    return;
                }

                const selectedCorridorParcelIds = (Array.isArray(corridor.parcelIds) ? corridor.parcelIds : selectedLiveParcelIds)
                    .map(id => id && id.toString ? id.toString() : String(id))
                    .filter(Boolean);
                const corridorCadastreParcelIds = liveFabric.cadastreIdsForParcelIds(selectedCorridorParcelIds);
                const polygonGeometry = corridor.polygon || corridor.superGeometry || null;
                const centerlinePoints = Array.isArray(corridor.centerline)
                    ? corridor.centerline.map(pair => {
                        if (!Array.isArray(pair) || pair.length < 2) return null;
                        const lng = Number(pair[0]);
                        const lat = Number(pair[1]);
                        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                        return { lat, lng };
                    }).filter(Boolean)
                    : [];
                const fallbackWidth = corridor.type === 'track' ? DEFAULT_CORRIDOR_WIDTHS.track : DEFAULT_CORRIDOR_WIDTHS.road;
                const isTrackCorridor = corridor.type === 'track';
                const roadDefinition = {
                    points: centerlinePoints,
                    width: Number.isFinite(corridor.width) ? corridor.width : fallbackWidth,
                    polygon: polygonGeometry ? safeClone(polygonGeometry) : null,
                    metadata: {
                        mode: corridor.mode || 'draw',
                        type: corridor.type || 'road',
                        isTrack: isTrackCorridor,
                        isRoad: !isTrackCorridor, // tracks are NOT roads
                        isCorridor: true,
                        source: 'constrained-corridor'
                    }
                };

                proposal.primaryType = corridor.type === 'track' ? 'Track' : 'Road';
                proposal.goal = 'road-track';
                proposal.isCorridor = true;
                proposal.cadastreParcelIds = corridorCadastreParcelIds;

                proposal.roadProposal = {
                    definition: safeClone(roadDefinition),
                    mode: corridor.mode || 'draw',
                    isCorridor: true
                };

                // Clear the pending corridor so it isn't reused accidentally
                pendingConstrainedCorridor = null;
                if (typeof window !== 'undefined') {
                    window.pendingConstrainedCorridor = null;
                }
            }

            // Clear any consumed road drawing context
            pendingRoadDrawingProposal = null;
            if (typeof window !== 'undefined') {
                window.pendingRoadDrawingProposal = null;
            }
        }

        console.debug('[createProposal] Building proposal object complete, adding lens data');
        // Skip lens for ownership-transfer-from-me proposals
        const skipLens = selectedTool === 'ownership-transfer-from-me';
        const hasDraftLens = applyPublishingDraftApproval(proposal, publishingDraftFields);
        if (!skipLens && !hasDraftLens) {
            const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
            if (lensSnapshot.length) {
                proposal.lens = lensSnapshot;
            }
        }
        console.debug('[createProposal] Proposal object ready, shouldMintOnchain:', shouldMintOnchain);

        // Duplicate pre-check temporarily disabled (false positives were blocking creation)
        // try {
        //     if (proposalStorage && typeof proposalStorage._buildHashSeed === 'function' && typeof proposalStorage._findDuplicateBySeed === 'function') {
        //         const duplicateSeed = proposalStorage._buildHashSeed(proposal);
        //         const duplicate = proposalStorage._findDuplicateBySeed(duplicateSeed);
        //         if (duplicate) {
        //             hideWaitingPopupSafe();
        //             setProposalModalInteractivity(true);
        //             setProposalCreateButtonState(false);
        //             showProposalAlertMessage('this_exact_proposal_already_exists', 'This exact proposal already exists');
        //             return;
        //         }
        //     }
        // } catch (dupCheckError) {
        //     console.warn('Duplicate proposal pre-check failed', dupCheckError);
        // }

        if (proposalMainType === 'Reparcellization') {
            // A readjustment must still be on its selection; a subdivision (poolSource 'site') is
            // pooled from its site, whose parcels are its binding (none on open ground), so only its
            // site is compared (proposals/subdivision.js planCreateVerdict).
            const planVerdict = window.__subdivision.planCreateVerdict(pendingReparcelPlan, {
                selectedParcelIds: finalParcelIds.map(id => id && id.toString()),
                site: siteContext ? siteContext.site : null
            });
            if (!planVerdict.ok) {
                const refusals = {
                    missing: ['reparcellization_plan_is_missing_please_rerun_the_algorithm', 'Reparcellization plan is missing. Please rerun the algorithm.'],
                    'parcels-changed': ['selected_parcels_changed_after_running_reparcellization_please_rerun_the_algorithm', 'Selected parcels changed after running reparcellization. Please rerun the algorithm.'],
                    'site-missing': ['subdivision_site_missing', 'This subdivision has no site. Reopen it from its draft and save again.'],
                    'site-changed': ['subdivision_site_changed', 'The site changed after the plots were laid. Open the subdivision editor again and click Done.']
                };
                const [key, fallback] = refusals[planVerdict.reason];
                console.warn(`[${new Date().toISOString()}] [createProposal] reparcellization plan refused: ${planVerdict.reason}`);
                showProposalAlertMessage(key, fallback);
                return;
            }
            proposal.goal = 'reparcellization';
            proposal.reparcellization = JSON.parse(JSON.stringify(pendingReparcelPlan));
            delete proposal.reparcellization.parcelIds;
            delete proposal.reparcellization.agreementBatch;
        }

        // Building/urban-rule proposals: consume pendingBuildingProposalContext
        const pendingBuildingContext = (typeof window !== 'undefined' ? window.pendingBuildingProposalContext : null)
            || (typeof pendingBuildingProposalContext !== 'undefined' ? pendingBuildingProposalContext : null);
        if (selectedTool === 'buildings' || selectedTool === 'row' || selectedTool === 'parcelBased' || selectedTool === 'single') {
            if (!pendingBuildingContext || !pendingBuildingContext.parcelIds || !pendingBuildingContext.parcelIds.length) {
                showProposalAlertMessage('building_design_missing', 'Open the building/urban rule tool and click Done before creating this proposal.');
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }

            const safeClone = (value) => {
                if (!value) return value;
                try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
            };

            const rawBuildings = (pendingBuildingContext.buildings && pendingBuildingContext.buildings.length)
                ? pendingBuildingContext.buildings
                : (pendingBuildingContext.buildingFeature ? [pendingBuildingContext.buildingFeature] : []);
            const buildingFeatures = rawBuildings.map(safeClone).filter(f => f && f.geometry);

            if (!buildingFeatures.length) {
                showProposalAlertMessage('building_design_missing', 'Open the building/urban rule tool and click Done before creating this proposal.');
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }

            const resolvedTypology = (pendingBuildingContext.parameters && pendingBuildingContext.parameters.typology)
                ? String(pendingBuildingContext.parameters.typology)
                : (selectedTool === 'row' ? 'row' : (selectedTool === 'parcelBased' ? 'parcelBased' : 'block'));

            const designParcelIds = pendingBuildingContext.parcelIds.map(String).filter(Boolean);

            proposal.primaryType = 'Urban Rule';
            proposal.goal = selectedTool === 'single' ? 'single' : 'buildings';
            proposal.typologyType = resolvedTypology;
            // This is the complete authored selection, including block parcels where the rule did
            // not manage to place a building. addProposal projects it to one flat root
            // cadastreParcelIds declaration; output buildings must never redefine that scope.
            // A site design's parcels are synthetic (the site, or plots cut from it): its
            // declaration is the site's binding, never a projection of those ids.
            proposal.cadastreParcelIds = siteContext
                ? authoredCadastreParcelIds.slice()
                : liveFabric.cadastreIdsForParcelIds(designParcelIds);
            proposal.tags = ['buildings'];

            if (!proposal.geometry) proposal.geometry = {};
            proposal.geometry.buildings = buildingFeatures;
            // "Based on existing buildings" keeps each real footprint whole, and the server returns
            // any building at least half inside the block — so one can stand partly on a neighbour
            // or street parcel. That land is genuinely under the proposal: declare it.
            if (pendingBuildingContext.parameters?.mode === 'existing'
                && typeof window.__cadastreAncestry?.declarationCoveringFootprint === 'function') {
                proposal.cadastreParcelIds = window.__cadastreAncestry.declarationCoveringFootprint(proposal);
            }
            const blockMassing = resolvedTypology === 'block'
                ? safeClone(pendingBuildingContext.blockMassing)
                : null;
            if (blockMassing?.geometry) proposal.geometry.blockMassing = blockMassing;
            else delete proposal.geometry.blockMassing;
            // Freeform proposals may pave or green the parcel area around their buildings; no other
            // typology offers the choice, so its surround never travels with them.
            const groundSurface = selectedTool === 'single' ? safeClone(pendingBuildingContext.groundSurface) : null;
            if (groundSurface) proposal.geometry.groundSurface = groundSurface;
            else delete proposal.geometry.groundSurface;

            proposal.buildingProposal = {
                typologyType: resolvedTypology,
                createdFrom: resolvedTypology === 'row' ? 'rowHouse' : (resolvedTypology === 'parcelBased' ? 'parcelBased' : 'blockify'),
                blockName: pendingBuildingContext.blockName || formatParcelSelectionLabel(designParcelIds),
                parameters: safeClone(pendingBuildingContext.parameters) || {},
                ineligibleParcels: safeClone(pendingBuildingContext.ineligibleParcels) || [],
                // §15a: how a FREEFORM building forms its parcel — footprint parcel by default,
                // whole host parcels when the author chose so in the design modal.
                ...(selectedTool === 'single' && pendingBuildingContext.takeWholeParcels === true
                    ? { takeWholeParcels: true } : {})
            };

            // Clear the pending context so it isn't reused accidentally
            if (typeof window !== 'undefined') {
                window.pendingBuildingProposalContext = null;
                window.pendingBuildingFromBlockify = null;
            }
            if (typeof setPendingBuildingProposalContext === 'function') {
                setPendingBuildingProposalContext(null);
            }
        }

        if (publishingDraftId) {
            const validatedDraft = window.proposalDraftStore?.validateDraft?.(publishingDraftId);
            if (!validatedDraft?.validation?.valid) {
                const validationError = new Error('Draft validation failed before publishing.');
                validationError.code = 'DRAFT_VALIDATION_FAILED';
                validationError.validation = validatedDraft?.validation || null;
                markDraftPublishFailed(validationError);
                throw validationError;
            }
            window.proposalDraftStore.markPublishing(publishingDraftId);
        }

        if (separateAgreements) {
            const parts = window.ReparcellizationPlanUtils.splitPlanPerParcel(proposal.reparcellization, turf);
            await window.CadastralParcelRepository.ensureIds(authoredCadastreParcelIds);
            const cadastralParcels = authoredCadastreParcelIds.map(id => {
                const feature = window.CadastralParcelRepository.get(id);
                if (!feature) throw new Error(`Cadastral parcel ${id} is unavailable.`);
                return { id, feature };
            });
            const batch = window.ReparcellizationAgreements.buildBatch({
                proposal, parts, cadastralParcels,
                groupId: publishingDraftId || window.crypto.randomUUID(),
                titleForParcel: (name, parcel) => t('reparcellization.modal.perParcelProposalName', '{{name}} — parcel {{parcel}}', { name, parcel })
            }, turf);
            return await finishReparcellizationAgreementBatch(batch, publishingDraftId);
        }

        let hash = null;

        // Try to mint on-chain if blockchain is available and parcels have NFTs
        const recoveredPublish = publishingDraftId
            ? window.proposalDraftStore?.getDraft?.(publishingDraftId)?.publish
            : null;
        let onchainResult = recoveredPublish?.onchainResult || null;
        let mintedNow = false;
        if (onchainResult && recoveredPublish?.proposalOnchain) {
            proposal.onchain = { ...recoveredPublish.proposalOnchain };
            proposal.nft = recoveredPublish.proposalNft ? { ...recoveredPublish.proposalNft } : undefined;
            shouldMintOnchain = false;
            console.info('[createProposal] Reusing the persisted on-chain result for this draft publish operation.');
        }
        // walletManager already declared above
        let hasWalletProvider = (walletManager && walletManager.getProvider()) || isSolanaWalletConnected || cantonActive;

        // If blockchain is supported but wallet is not connected, prompt user to connect
        if (shouldMintOnchain && !hasWalletProvider) {
            if (walletManager && typeof walletManager.openConnectorModal === 'function') {
                updateStatus('Please connect your wallet to mint the proposal on blockchain...');

                // Open wallet connection modal and wait for connection
                walletManager.openConnectorModal();

                // Wait for wallet connection with a timeout
                const connectionPromise = new Promise((resolve) => {
                    let resolved = false;
                    const timeout = setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection timeout.');
                            resolve(false);
                        }
                    }, 60000); // 60 second timeout

                    const handleConnect = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connected! Proceeding with blockchain minting...');
                            resolve(true);
                        }
                    };

                    const handleError = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection cancelled.');
                            resolve(false);
                        }
                    };

                    const handleDisconnect = () => {
                        // If disconnected while waiting, treat as cancellation
                        handleError();
                    };

                    walletManager.on('connect', handleConnect);
                    walletManager.on('error', handleError);
                    walletManager.on('disconnect', handleDisconnect);
                });

                const connected = await connectionPromise;
                if (!connected) {
                    // User cancelled or timeout - cancel creation entirely, keep modal filled
                    updateStatus('Proposal creation cancelled.');
                    hideWaitingPopupSafe();
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    markDraftPublishFailed(Object.assign(new Error('Wallet connection was cancelled or timed out.'), { code: 'WALLET_CONNECTION_CANCELLED' }));
                    return;
                } else {
                    // Wallet connected - check provider again
                    hasWalletProvider = walletManager && walletManager.getProvider();
                }
            } else {
                // Fallback: ask (the shared confirm) if wallet manager is not available
                const walletPrompt = t('alerts.messages.blockchain_mint_wallet_prompt', 'Blockchain minting is available but no wallet is connected. Would you like to connect a wallet to mint this proposal on-chain?');
                const connectWallet = await window.CbDialog.confirm(walletPrompt);
                if (connectWallet && walletManager && typeof walletManager.openConnectorModal === 'function') {
                    walletManager.openConnectorModal();
                    markDraftPublishFailed(Object.assign(new Error('Connect the wallet, then retry publishing.'), { code: 'WALLET_CONNECTION_REQUIRED' }));
                    return; // User will need to click Create Proposal again after connecting
                }
            }
        }

        if (shouldMintOnchain && hasWalletProvider) {
            try {
                console.debug('[createProposal] Starting on-chain minting process');
                const mintStartTime = performance.now();
                updateStatus('Preparing proposal for blockchain minting...');

                // Get parcel features for screenshot generation
                console.debug('[createProposal] Loading parcel data for screenshot generation');
                const parcelDataStartTime = performance.now();
                updateStatus('Loading parcel data...');
                showProposalWaitingPopup('Loading parcel data...');
                waitingPopupVisible = true;
                setProposalModalDimmed(true);
                const parcelFeatures = [];
                const parcelPolygons = [];
                console.debug('[proposal-mint] Building parcel polygons for proposal', {
                    parcelIds: finalParcelIds.slice(0, 10),
                    parcelCount: finalParcelIds.length
                });

                const pushParcelPolygons = (coords) => {
                    if (!Array.isArray(coords) || !coords.length) return;
                    // Polygon: [rings]
                    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0]) && typeof coords[0][0][0] === 'number') {
                        parcelPolygons.push(coords);
                        return;
                    }
                    // MultiPolygon: [ [rings], [rings], ... ]
                    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
                        coords.forEach(poly => {
                            if (Array.isArray(poly) && poly.length) {
                                parcelPolygons.push(poly);
                            }
                        });
                    }
                };

                // Resolve every selected live parcel through its explicit cadastral provenance.
                // The ground service decides which ids are cached, in flight, absent, or require
                // transport; callers never infer provenance from generated id spelling.
                let cadastralIds = [];
                try {
                    if (!liveFabric || typeof liveFabric.cadastreIdsForParcelIds !== 'function') {
                        throw new Error('Live parcel fabric is unavailable.');
                    }
                    cadastralIds = liveFabric.cadastreIdsForParcelIds(finalParcelIds);
                } catch (error) {
                    console.warn('[proposal-mint] Unable to resolve cadastral provenance:', error);
                }
                if (cadastralIds.length) {
                    const ground = (typeof CadastralParcelRepository !== 'undefined' && CadastralParcelRepository)
                        ? CadastralParcelRepository
                        : ((typeof window !== 'undefined') ? window.CadastralParcelRepository : null);
                    try {
                        if (!ground || typeof ground.ensureIds !== 'function') {
                            throw new Error('Cadastral ground service is unavailable.');
                        }
                        await ground.ensureIds(cadastralIds);
                    } catch (err) {
                        console.warn('[proposal-mint] Unable to load proposal ground:', err);
                    }
                }

                for (const parcelId of finalParcelIds) {
                    const liveFeature = window.LiveParcelFabric?.get?.(parcelId) || null;
                    if (liveFeature) {
                        const normalizedFeature = ensureParcelIdOnFeature(liveFeature);
                        parcelFeatures.push(normalizedFeature);
                        // Extract coordinates for polygon
                        if (liveFeature.geometry && liveFeature.geometry.coordinates) {
                            pushParcelPolygons(liveFeature.geometry.coordinates);
                        }
                    } else {
                        console.warn('[proposal-mint] Missing live parcel feature for', parcelId);
                    }
                }

                console.debug('[createProposal] Parcel data loading took:', (performance.now() - parcelDataStartTime).toFixed(2), 'ms');
                console.debug('[proposal-mint] Parcel polygon collection result', {
                    parcelFeaturesCount: parcelFeatures.length,
                    parcelPolygonsCount: parcelPolygons.length,
                    firstPolygonSample: parcelPolygons[0]
                });

                // Mint from the browser's local metric geometry and immutable cadastral facts.
                // The complete record, site and source snapshot go to IPFS; no server preparation
                // or server signing key participates. A later server mirror reads this commitment.
                updateStatus(t('modal.createProposal.site.binding', 'Checking which parcels the site reaches into...'));
                const mintRecord = await window.__mintBinding.prepareForMint(proposal);
                window.__mintBinding.adoptMintRecord(proposal, mintRecord);
                const mintSite = mintRecord.site;
                if (mintSite) pushParcelPolygons(mintSite.coordinates);
                console.info(`[${new Date().toISOString()}] [createProposal] local mint record: ${proposal.cadastreParcelIds.length} parcel(s), coverage ${proposal.binding.coverage}`);

                // Nothing to draw or mint is an error to report, never a silent skip: the user
                // asked for an on-chain proposal and would otherwise get a local one unawares.
                if (parcelPolygons.length === 0) {
                    throw new Error(t('modal.createProposal.errors.noMintGeometry', 'This proposal has no site or parcel geometry to mint.'));
                }
                {
                    const parcelIdsForMinting = Array.isArray(proposal.cadastreParcelIds)
                        ? proposal.cadastreParcelIds.slice()
                        : [];

                    if (parcelIdsForMinting.length === 0 && !mintSite) {
                        throw new Error(t('modal.createProposal.errors.noMintParcels', 'This proposal names no parcels and has no site, so it cannot be minted.'));
                    } else {
                        // Verify required services are available
                        if (!window.MapScreenshot) {
                            throw new Error('Map screenshot capture is not available.');
                        }
                        if (!window.AssetService || typeof window.AssetService.uploadProposalAssets !== 'function') {
                            throw new Error('Asset upload service is not available.');
                        }

                        // Build combined polygon from all parcels for screenshot
                        console.debug('[createProposal] Preparing proposal geometry for screenshot');
                        const geometryStartTime = performance.now();
                        updateStatus('Preparing proposal geometry...');
                        showProposalWaitingPopup('Preparing proposal geometry...');
                        // Every polygon collected above (live fabric features, the site) is GeoJSON
                        // [lng, lat]; the combined outline keeps that order and says so to the capture.
                        // (It used to guess per point with |x| <= 90 => latitude, which reads Zagreb's
                        // longitude 15.97 as a latitude.)
                        const combinedPolygon = window.__thumbnailBbox.lngLatPointsOf(parcelPolygons);

                        if (combinedPolygon.length < 3) {
                            console.error('[proposal-mint] Unable to derive proposal polygon', {
                                parcelIds: finalParcelIds.slice(0, 10),
                                parcelPolygonsCount: parcelPolygons.length
                            });
                            throw new Error('Unable to derive proposal polygon for NFT metadata.');
                        }

                        const buildBoundsFromParcelPolygons = (polys, fallbackBounds) => {
                            if (fallbackBounds && typeof fallbackBounds.isValid === 'function' && fallbackBounds.isValid()) {
                                return fallbackBounds;
                            }
                            if (!Array.isArray(polys) || typeof L === 'undefined' || !L || typeof L.latLngBounds !== 'function') return null;
                            try {
                                const latLngs = [];
                                polys.forEach(poly => {
                                    const collect = (node) => {
                                        if (!Array.isArray(node)) return;
                                        if (node.length && Array.isArray(node[0]) && typeof node[0][0] === 'number' && typeof node[0][1] === 'number') {
                                            node.forEach(pair => {
                                                if (Array.isArray(pair) && pair.length >= 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
                                                    // GeoJSON order is [lng, lat]
                                                    latLngs.push(L.latLng(pair[1], pair[0]));
                                                }
                                            });
                                            return;
                                        }
                                        node.forEach(collect);
                                    };
                                    collect(poly);
                                });
                                return latLngs.length ? L.latLngBounds(latLngs) : null;
                            } catch (err) {
                                console.warn('[proposal-mint] Failed to derive bounds from parcel polygons', err);
                                return null;
                            }
                        };

                        const screenshotBounds = buildBoundsFromParcelPolygons(parcelPolygons, bounds);
                        // A road proposal's image is about the designed corridor, not the much larger
                        // set of cadastral parents it crosses. The modal preview already uses this
                        // geometry; keep the final stored/minted capture on the same source of truth.
                        const screenshotGeometry = resolveCorridorScreenshotGeometry(proposal, combinedPolygon, 'lnglat');
                        const screenshotPolygon = screenshotGeometry.polygon;
                        const screenshotPolygonOrder = screenshotGeometry.polygonOrder;
                        const screenshotFitToPolygonOnly = screenshotGeometry.fitToPolygonOnly;

                        console.debug('[createProposal] Geometry preparation took:', (performance.now() - geometryStartTime).toFixed(2), 'ms');

                        // Capture screenshot from the preview (stitched image runs in the background)
                        const tShare = typeof getShareI18nHelper === 'function' ? getShareI18nHelper() : null;
                        const processingImageMessage = tShare
                            ? tShare('processingImageForUpload', 'Processing image for upload...')
                            : 'Processing image for upload...';
                        const showProcessingImageMessage = () => {
                            updateStatus(processingImageMessage);
                            showProposalWaitingPopup(processingImageMessage);
                        };

                        showProcessingImageMessage();

                        let screenshotDataUrl = null;
                        let captureError = null;

                        const computeByteSize = (dataUrl) => {
                            if (!dataUrl || !dataUrl.startsWith('data:image/')) return 0;
                            const base64Part = dataUrl.split(',')[1];
                            return base64Part ? Math.ceil(base64Part.length * 3 / 4) : 0;
                        };

                        const attemptTileStitchCapture = async () => {
                            if (!window.MapScreenshot?.captureViaTileStitch) return null;
                            try {
                                const dataUrl = await window.MapScreenshot.captureViaTileStitch({
                                    polygon: screenshotPolygon,
                                    parcelPolygons: parcelPolygons,
                                    padding: 0.12,
                                    bounds: screenshotBounds,
                                    zoom: 19,
                                    badge: goalBadge,
                                    polygonOrder: screenshotPolygonOrder,
                                    parcelPolygonOrder: 'lnglat',
                                    fitToPolygonOnly: screenshotFitToPolygonOnly
                                });
                                const bytes = computeByteSize(dataUrl);
                                console.debug('[createProposal] Tile stitch capture size:', bytes, 'bytes');
                                if (bytes >= 5000) {
                                    return dataUrl;
                                }
                                console.warn('[createProposal] Tile stitch capture too small:', bytes, 'bytes');
                                return null;
                            } catch (err) {
                                console.error('[createProposal] Tile stitch capture failed:', err);
                                return null;
                            }
                        };

                        const awaitBackgroundStitch = async () => {
                            if (!proposalModalScreenshotPromise) return null;
                            showProcessingImageMessage();
                            try {
                                const dataUrl = await proposalModalScreenshotPromise;
                                return computeByteSize(dataUrl) >= 5000 ? dataUrl : null;
                            } catch (err) {
                                console.warn('[createProposal] Awaiting stitched screenshot failed:', err);
                                return null;
                            }
                        };

                        // Prefer the background-stitched image; if it's still processing, wait for it
                        screenshotDataUrl = await awaitBackgroundStitch();

                        // If no stitched image yet, kick off (or reuse) capture and await it
                        if (!screenshotDataUrl) {
                            const capturePromise = attemptTileStitchCapture();
                            if (capturePromise && typeof capturePromise.then === 'function') {
                                proposalModalScreenshotPromise = capturePromise;
                                showProcessingImageMessage();
                                screenshotDataUrl = await capturePromise;
                            }
                        }

                        if (!screenshotDataUrl) {
                            captureError = 'Tile stitch capture failed or produced a tiny image.';
                        }

                        // If the stitched attempts failed but we cached a good preview earlier, fall back to it
                        if ((!screenshotDataUrl || captureError) && proposalModalScreenshotDataUrl) {
                            screenshotDataUrl = proposalModalScreenshotDataUrl;
                            captureError = null;
                            console.debug('[createProposal] Using cached preview screenshot as fallback');
                        }

                        if (!screenshotDataUrl || !screenshotDataUrl.startsWith('data:image/')) {
                            const errorDetail = captureError ? `: ${captureError}` : '';
                            throw new Error(`Unable to capture proposal screenshot${errorDetail}`);
                        }

                        console.debug('[createProposal] Using screenshot:', { length: screenshotDataUrl.length });

                        // Store screenshot on proposal for later use (e.g., minting from share dialog)
                        proposal.screenshotDataUrl = screenshotDataUrl;

                        // The one mint every publish path uses (proposals/publish-mint.js): metadata,
                        // image upload, the active chain's mint, and the result on the record.
                        const lensEntriesForMint = getProposalLensEntries(proposal, { fallbackToGlobal: true });
                        const showMintStatus = message => {
                            updateStatus(message);
                            showProposalWaitingPopup(message);
                        };
                        const mintTxStartTime = performance.now();
                        waitingPopupVisible = true;
                        setProposalModalDimmed(true);
                        const minted = await window.ProposalPublishMint.mint(proposal, {
                            screenshotDataUrl,
                            lensEntries: lensEntriesForMint,
                            onStatus: showMintStatus
                        });
                        onchainResult = minted.onchainResult;
                        mintedNow = true;
                        console.debug('[createProposal] Blockchain minting took:', (performance.now() - mintTxStartTime).toFixed(2), 'ms');
                        console.debug('[createProposal] Total on-chain minting process took:', (performance.now() - mintStartTime).toFixed(2), 'ms');
                        hideWaitingPopupSafe();
                        updateStatus(`Proposal minted on blockchain! Transaction: ${String(onchainResult.transactionHash || '').substring(0, 10)}...`);
                    }
                }
            } catch (error) {
                hideWaitingPopupSafe();
                // The author declined what was prepared (slight intrusions, a shifted corridor):
                // nothing was signed, and nothing is published.
                if (error && error.publishCancelled) {
                    updateStatus(error.message);
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    markDraftPublishFailed(error);
                    return;
                }
                console.error('On-chain mint failed:', error);

                const isUserCancelled = (err) => {
                    const code = err && (err.code || err.error?.code || err.data?.code || err.info?.error?.code);
                    const rawMessage = err && (err.message || err.error?.message || err.data?.message || err.shortMessage || err.info?.error?.message || '');
                    const message = (rawMessage || '').toLowerCase();
                    return code === 4001
                        || code === 'ACTION_REJECTED'
                        || code === 'TRANSACTION_REJECTED'
                        || message.includes('user rejected')
                        || message.includes('user denied')
                        || message.includes('user canceled')
                        || message.includes('user cancelled')
                        || message.includes('rejected by user')
                        || message.includes('transaction was rejected')
                        || message.includes('transaction rejected')
                        || message.includes('request rejected');
                };

                if (isUserCancelled(error)) {
                    showProposalWaitingPopupTemporary('Transaction rejected', 2000);
                    updateStatus('Proposal creation cancelled.');
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    markDraftPublishFailed(error);
                    return;
                }

                const failureReason = error?.message
                    || error?.error?.message
                    || error?.data?.message
                    || error?.details
                    || t('modal.createProposal.onchainMintFailed.unknown', 'Unknown error');

                const decision = await showOnchainMintFailedModal(failureReason);
                if (decision !== 'memory') {
                    updateStatus('Proposal creation cancelled.');
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    markDraftPublishFailed(error);
                    return;
                }

                updateStatus('Creating in-memory proposal (on-chain mint skipped).');
                shouldMintOnchain = false;
                onchainResult = null;
            }
        }

        if (publishingDraftId && onchainResult && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.updateDraft(publishingDraftId, {
                publish: {
                    onchainResult: { ...onchainResult },
                    proposalOnchain: proposal.onchain ? { ...proposal.onchain } : null,
                    proposalNft: proposal.nft ? { ...proposal.nft } : null,
                    externalPersistenceComplete: true
                }
            }, { force: true, recordHistory: false, dirty: false });
        }

        // Dialog-created proposals have confirmed terms: the details panel shows "Proposal
        // details" instead of "Propose" until a later edit produces a fresh unproposed object.
        proposal.termsConfirmed = true;

        // Persist proposal after on-chain handling (or local-only)
        console.debug('[createProposal] Saving proposal to storage');
        const saveStartTime = performance.now();
        updateStatus('Saving proposal...');
        if (!waitingPopupVisible) {
            showProposalWaitingPopup('Saving proposal...');
            waitingPopupVisible = true;
            setProposalModalDimmed(true);
        }
        // An edit of one's own local record rewrites it in place, and takes what stands on ground
        // the edit changes off the map once the user agrees; every other save adds a new record.
        let proposalId = null;
        if (inPlaceSourceId) {
            const dependents = ProposalManager.findEditDependents(inPlaceSourceId, proposal);
            if (dependents.length && !(await window.confirmProposalEditDependents(dependents))) {
                hideWaitingPopupSafe();
                updateStatus(t('proposalDrafts.dependents.notSaved', 'The edit was not saved. The design has been reopened.'));
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }
            const updated = await ProposalManager.updateProposalInPlace(inPlaceSourceId, proposal, {
                unapplyIds: dependents.map(record => String(record.proposalId))
            });
            if (updated) proposalId = inPlaceSourceId;
        } else {
            proposalId = proposalStorage.addProposal(proposal);
        }
        console.debug('[createProposal] Proposal save took:', (performance.now() - saveStartTime).toFixed(2), 'ms');
        if (proposalId === null) {
            hideWaitingPopupSafe();
            updateStatus('Unable to save proposal.');
            setProposalModalInteractivity(true);
            setProposalCreateButtonState(false);
            markDraftPublishFailed(Object.assign(new Error('Unable to save the proposal.'), { code: 'PROPOSAL_STORAGE_FAILED' }));
            return;
        }
        const storedForOnchain = proposalStorage.getProposal(proposalId);
        const storedProposalId = storedForOnchain?.proposalId || proposal.proposalId || proposalId;
        // Every editor draft survives modal closes and failures. Only successful proposal
        // persistence consumes it, atomically recording a receipt for retry idempotency.
        if (publishingDraftId && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.consumeAfterPublish(publishingDraftId, storedProposalId);
        }

        // Update stored proposal with on-chain data if available
        if (onchainResult) {
            const stored = storedForOnchain;
            if (stored) {
                stored.onchain = { ...(stored.onchain || {}), ...(proposal.onchain || {}) };
                if (typeof proposalStorage._indexProposal === 'function') {
                    proposalStorage._indexProposal(stored);
                }
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }
        // A fresh mint is mirrored to the server for discovery and ENS, as every publish path does;
        // a failed mirror leaves the independent chain proposal intact.
        if (mintedNow && storedForOnchain) {
            try {
                await window.ProposalPublishMint.mirror(storedForOnchain);
            } catch (mirrorError) {
                console.error(`[${new Date().toISOString()}] [createProposal] server mirror after mint failed`, mirrorError);
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(t('modal.roadWidth.share.mintSavedChainOnly', 'Minted on-chain, but saving to the server failed — the ENS link may not resolve until you retry.'), 8000, 'error');
                }
            }
        }

        // Vote proposals need no special map handling: like every proposal, their geometry is
        // already on the map as the applied draft they were created from — nothing to re-apply.

        // Update the show proposals button count
        console.debug('[createProposal] Updating UI and logging user action');
        updateShowProposalsButton();
        // Log user action for proposal creation
        const userAgent = getCurrentUserAgent();
        if (userAgent && typeof addUserActionToGameLog === 'function') {
            const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
                ? proposalStorage.getProposal(proposalId)
                : null;
            const proposalIdForLog = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                ? String(storedProposal.proposalId)
                : String(storedProposalId);
            const proposalIdAttr = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                ? String(storedProposal.proposalId)
                : String(proposalId);
            // The links run script (the game log binds the -clickable hooks): cb-link buttons.
            const proposalLinkHtml = `<button type="button" data-proposal-id="${proposalIdAttr}" class="cb-link proposal-link-clickable">${proposalIdForLog}</button>`;
            const budgetCurrencyLabel = offerCurrency || 'USDT';
            const onchainNote = onchainResult ? ' (on-chain)' : '';
            addUserActionToGameLog(`<button type="button" data-agent-id="${userAgent.id}" class="cb-link agent-link-clickable">${userAgent.name}</button> created a ${proposalType} proposal${onchainNote} (${proposalLinkHtml}) for ${proposal.cadastreParcelIds.length} parcel(s) with budget ${offer} ${budgetCurrencyLabel}.`);

            // Update user agent's created proposals
            if (!userAgent.proposalsCreated) {
                userAgent.proposalsCreated = [];
            }
            if (!userAgent.proposalsCreated.includes(proposalId)) {
                userAgent.proposalsCreated.push(proposalId);
                agentStorage.updateAgent(userAgent.id, { proposalsCreated: userAgent.proposalsCreated });
            }
        }

        // Hide parcel info panel if needed
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // Close dialog
        closeProposalDialog();

        // Update proposal list if open
        updateProposalList();

        const statusMessage = onchainResult
            ? `Proposal "${proposalType}" created and minted on blockchain with ${proposal.cadastreParcelIds.length} parcels.`
            : `Proposal "${proposalType}" created successfully with ${proposal.cadastreParcelIds.length} parcels.`;
        updateStatus(statusMessage);

        if (proposalMainType === 'Reparcellization' && typeof window !== 'undefined') {
            window.pendingReparcellizationPlan = null;
        }

        if (typeof multiParcelSelection !== 'undefined') {
            if (createdFromMultiSelect && multiParcelSelection.isActive) {
                multiParcelSelection.toggle({ restoreSingleSelection: false });
            } else if (multiParcelSelection.selectedParcels) {
                multiParcelSelection.selectedParcels.clear();
                multiParcelSelection.lastSelectedParcelId = null;
                if (typeof multiParcelSelection.updateUI === 'function') {
                    multiParcelSelection.updateUI();
                }
            }
        }

        // Records are the only source of live fabric. The canonical apply path flips the snapshot
        // and derives the local tessellation once (an in-place save already stands applied).
        try {
            const applied = await ProposalManager.applyProposal(proposalId);
            if (!applied) throw new Error('The saved proposal could not be derived from the cadastral fabric.');
        } catch (replayError) {
            console.warn('[createProposal] Could not replay the saved proposal', replayError);
            updateStatus('Proposal saved, but it could not be applied to the cadastral fabric.');
        }

        const focusParcelId = selectedLiveParcelIds[0] || null;
        const openProposalDetails = () => {
            if (!waitingPopupVisible) {
                waitingPopupVisible = true;
                setProposalModalDimmed(true);
            }
            if (typeof selectAndHighlightProposal === 'function') {
                // Do not refocus map when opening details immediately after creation
                selectAndHighlightProposal(proposalId, focusParcelId, false, true);
            } else if (typeof showProposalDetailsModal === 'function') {
                showProposalDetailsModal(proposalId);
            }
            // Hide popup after a short delay to allow panel to render
            setTimeout(() => {
                hideWaitingPopupSafe();
            }, 500);
        };

        console.debug('[createProposal] All proposal creation steps complete, opening details. Total elapsed:', (performance.now() - startTime).toFixed(2), 'ms');
        if (onchainResult) {
            showProposalMintSuccessModal({
                proposalId: onchainResult.proposalId,
                proposalId: hash,
                txHash: onchainResult.transactionHash,
                chainId: onchainResult.chainId,
                onClose: openProposalDetails
            });
        } else {
            openProposalDetails();
        }

    } catch (error) {
        console.error('Error creating proposal:', error);
        markDraftPublishFailed(error);
        const fallback = t('alerts.messages.failed_to_create_proposal', 'Failed to create proposal.');
        const message = (error && error.message) ? error.message : fallback;
        if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
            window.showStyledAlert(message);
        } else {
            window.CbDialog.alert(message);
        }
    } finally {
        hideWaitingPopupSafe();
        setProposalModalInteractivity(true);
        setProposalCreateButtonState(false);
        refreshReparcellizationAgreementSubmit();
    }
}

function buildUploadReadyProposal(proposal) {
    if (!proposal) return null;
    // The published record carries the profile's CURRENT name when it is this profile's draft
    // (GuestPolicy.outgoingAuthor): stamped here, before the device-local authorAgentId is dropped
    // below, because callers (the share dialog's Upload) project first and upload the projection.
    stampCurrentAuthor(proposal);
    const uploadProposal = { ...proposal };
    // Publication supplies the authored proposalId. A downloaded record's database row id and
    // SQL column spelling are not creation fields; the receiving server assigns its own row id.
    delete uploadProposal.id;
    delete uploadProposal.proposal_id;
    // A fork of a draft that has been published since names the published record, so the original
    // can list it as a counterproposal (proposals/lineage.js).
    Object.assign(uploadProposal, window.ProposalLineage?.publishedSourceIds(proposal, id => proposalStorage.getProposal(id)) || {});

    // The complete selected cadastral scope was stamped at creation. Publishing never shrinks it to
    // the output geometry (a block may intentionally include parcels on which no building could be
    // generated), and refuses geometry lying on parcels outside it — except a corridor, which takes
    // every parcel its polygon covers (publishDeclaration).
    if (!window.__cadastreAncestry
        || typeof window.__cadastreAncestry.validateCadastreParcelIds !== 'function'
        || typeof window.__cadastreAncestry.publishDeclaration !== 'function') {
        throw new Error('Cannot publish: cadastral geometry resolution is unavailable.');
    }
    // A material proposal (not an act on parcels) publishes the SERVER binding of its site as its
    // declaration (PARCEL-OPTIONAL.md rule 3): uploadProposalToServer binds it first
    // (proposals/publish-binding.js), and that answer is published as is. Unbound material records
    // (a JSON download, the dialog's pre-check) keep their declaration here; the server decides.
    // Parcel acts keep the old strict client check of their named parcels.
    const siteApi = window.__siteBinding;
    const material = !!(siteApi && typeof siteApi.requiresParcels === 'function' && !siteApi.requiresParcels(uploadProposal));
    const serverBound = !!(window.__publishBinding && window.__publishBinding.isServerBinding(uploadProposal.binding));
    // A prepared record (POST /proposals/prepare) publishes its artifact's declaration exactly — the
    // server verified it, and any client re-derivation would contradict what was prepared.
    if (serverBound && (material || uploadProposal.preparation)) {
        uploadProposal.cadastreParcelIds = (uploadProposal.cadastreParcelIds || []).map(String);
    } else if (material) {
        uploadProposal.cadastreParcelIds = window.__cadastreAncestry.publishDeclaration(uploadProposal);
    } else {
        uploadProposal.cadastreParcelIds = window.__cadastreAncestry.validateCadastreParcelIds({
            ...uploadProposal,
            cadastreParcelIds: window.__cadastreAncestry.publishDeclaration(uploadProposal)
        });
    }
    // A client-preview binding never crosses the publish boundary; the server computes its own.
    if (uploadProposal.binding && !(window.__publishBinding && window.__publishBinding.isServerBinding(uploadProposal.binding))) {
        delete uploadProposal.binding;
    }

    // The ownership flow (§9/§12 step 2) and the frame it was measured against (D5), stamped at the
    // same moment and for the same reason as cadastreParcelIds. The effect hash is derived from the
    // stamped copy — footprint + per-parcel cession — and is what acceptances bind to (§11): a later
    // edit that changes the effect changes this hash and voids consent automatically. All additive:
    // none of these are in proposalContentFingerprint's allowlist, so share ids never move.
    try {
        if (window.__cadastreAncestry && typeof window.__cadastreAncestry.computeOwnershipFlow === 'function') {
            // Measured over the declaration being published (the server binding for material
            // proposals), not the local one it replaced.
            uploadProposal.ownershipFlow = window.__cadastreAncestry.computeOwnershipFlow(uploadProposal);
        }
        uploadProposal.cadastreFrame = { capturedAt: new Date().toISOString() };
        if (window.__ownershipFlow) {
            const effectHash = window.__ownershipFlow.effectFingerprintOf(uploadProposal);
            if (effectHash) uploadProposal.effectHash = effectHash;
        }
    } catch (error) {
        console.warn('[createProposal] ownership flow unavailable for upload', error);
    }

    // Ensure backend-required proposal.type is set using the proposal goal
    const rawType = uploadProposal.type ? String(uploadProposal.type).trim().toLowerCase() : '';
    const goalKey = resolveProposalGoalKey(uploadProposal, null);
    const derivedType = mapGoalToBackendType(goalKey);
    uploadProposal.type = derivedType || rawType || 'parcel';

    // Proposals created since the `city` stamp carry their own origin; older ones fall back to the
    // current city, which is only right if you upload from where you created it.
    uploadProposal.city = uploadProposal.city || getProposalCityId() || 'city';

    // "Applied" describes *this browser's* map, not the proposal. It is meaningless on the server,
    // where every client has its own map, so publishing must remove it even for Executed proposals.
    //
    // Nested proposals are replaced with copies rather than mutated: uploadProposal is a shallow
    // copy of the caller's stored proposal, so writing through them would un-apply the user's own
    // proposal on their own map.
    delete uploadProposal.applied;
    delete uploadProposal.appliedAt;
    // The author's local agent id only says which profile on THIS device owns the draft
    // (GuestPolicy.claimAuthorAgentId); the published record carries the author name.
    delete uploadProposal.authorAgentId;
    ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
        .forEach(key => {
            const nested = uploadProposal[key];
            if (!nested || typeof nested !== 'object') return;
            const sanitized = { ...nested };
            delete sanitized.applied;
            delete sanitized.appliedAt;
            uploadProposal[key] = sanitized;
        });

    // Runtime materialization never crosses the publish boundary. The proposal already carries
    // its one durable land declaration at root: cadastreParcelIds.
    if (uploadProposal.parentFeatures) {
        delete uploadProposal.parentFeatures;
    }
    if (uploadProposal.roadProposal) {
        if (uploadProposal.roadProposal.parentFeatures) {
            delete uploadProposal.roadProposal.parentFeatures;
        }
        // Runtime child pieces are regenerated by the receiver's live fabric.
        if (uploadProposal.roadProposal.childFeatures) {
            delete uploadProposal.roadProposal.childFeatures;
        }
    }

    // Dedup by CONTENT, not by the stable local proposalId: the server keys on the uploaded id, so
    // send a content fingerprint. A re-upload of UNCHANGED content reuses its serial (the server 409s
    // and we adopt it); any real edit produces a new fingerprint → a new record + new share url,
    // leaving the previously-shared version untouched at its old url. The local proposalId is
    // unchanged (uploadProposal is a shallow copy), so nothing on this browser's map is disturbed.
    const fingerprint = (typeof proposalContentFingerprint === 'function') ? proposalContentFingerprint(proposal) : null;
    if (fingerprint) {
        uploadProposal.proposalId = fingerprint;
        uploadProposal.hash = fingerprint;
    }

    // The publish gate verifies the canonical authored record. It does not flatten generated ids;
    // only the explicit migration is allowed to interpret legacy parcel declarations.
    const depthApi = typeof window !== 'undefined' ? window.__formationDepth : null;
    if (!depthApi || typeof depthApi.preparePublishRecord !== 'function') {
        throw new Error('Cannot publish: the authored-record projection is unavailable.');
    }
    const gate = depthApi.preparePublishRecord(uploadProposal);
    if (!gate.verdict.flat) {
        const detail = gate.verdict.violations
            .map(v => v.code + (v.id ? ` (${v.id})` : (Array.isArray(v.ids) ? ` (${v.ids.join(', ')})` : '')))
            .join('; ');
        throw new Error(`This proposal's record is not flat and cannot be published: ${detail}`);
    }
    return gate.proposal;
}

function handleCreateProposalHotkey(event) {
    if (!event) return;
    // Don't trigger if modifier keys are pressed
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Don't trigger if typing in an input field
    if (isEditableElement(event.target)) return;
    // Skip while any parcel drawing mode is active (drawing tools manage their own flows)
    if (typeof window !== 'undefined' && typeof window.isParcelDrawingModeActive === 'function' && window.isParcelDrawingModeActive()) return;
    // Only respond to 'C' key
    if (event.key !== 'c' && event.key !== 'C') return;

    // Check if a modal is already open (don't open another one)
    const existingModal = document.querySelector('.create-proposal-modal');
    if (existingModal) return;

    const commands = typeof window !== 'undefined' ? window.UiCommands : null;
    if (!commands || typeof commands.createBrowserContext !== 'function'
        || typeof commands.isAvailable !== 'function' || typeof commands.runCommand !== 'function') return;
    const commandContext = commands.createBrowserContext(window);
    const multi = typeof window !== 'undefined' ? window.multiParcelSelection : null;
    const commandId = multi && multi.isActive ? 'selection.propose' : 'parcel.propose';
    // Match the parcel menu or selection tray authoring capability. In model/photo views C has no effect.
    if (!commands.supportsMode(commandId, commandContext)) return;

    // Check if there are any parcels selected (single or multi-selection)
    const selection = getCurrentParcelSelectionContext();
    if (!selection || !selection.ids || selection.ids.length === 0) {
        // No parcels selected, show a status message
        if (typeof updateStatus === 'function') {
            const t = getProposalI18nHelper();
            const noParcelsMessage = t(
                'status.messages.please_select_at_least_one_parcel_to_create_a_proposal',
                'Please select at least one parcel to create a proposal.'
            );
            updateStatus(noParcelsMessage);
        }
        return;
    }

    if (!commands.isAvailable(commandId, commandContext)) return;

    // Dispatch the same canonical proposal palette as the selection tray.
    event.preventDefault();
    commands.runCommand(commandId, commandContext);
}

function attachCreateProposalHotkey() {
    if (createProposalHotkeyAttached) return;
    document.addEventListener('keydown', handleCreateProposalHotkey);
    createProposalHotkeyAttached = true;
}
