// Owner decisions on a proposed agreement (plan-design-agreement.md, M2): the "Owner decisions" card
// of the agreement panel (agreement-panel.js), the "Act for an owner" dialog (a lens member confirms
// which owners the connected wallet may act for) and the "Accept as Owner X" review, which shows what
// that owner puts in and how far the rule is from passing before the wallet signs the agreement's CID,
// then becomes the receipt. The same review opens read-only for anyone from the card's owner row.
// Decisions are taken on the agreement-like object approval-runtime.js takes, built here from the
// stored agreement; receipts are relayed at /agreements/<cid>/decisions (approval-relay.js) and every
// browser counts only those that verify. Rules and counting live in approval.js and
// approval-review.js; this file only renders.
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
    const runtime = () => root.ProposalApprovalRuntime;
    const actor = () => (typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null) || null;
    const wallet = () => root.ProposalApprovalLensAuthority.browserWallet();
    const log = (message, ...rest) => console.log(`[${new Date().toISOString()}] [ProposalApprovalPanel] ${message}`, ...rest);

    // Per agreement CID: the object decisions are taken on. Its receipts live for the session; the
    // relay keeps them for every browser.
    const subjects = new Map();
    const syncing = new Map();

    // The agreement-like object of a proposed owner agreement: the engine's subject, its CID, its
    // deadline (the review's "open until"), the server's status and the receipts known so far.
    function subjectFor(agreementId) {
        const agreement = root.AgreementStore.get(agreementId);
        if (!agreement || !agreement.published || !agreement.rule || agreement.rule.electorate !== 'owners') return null;
        const cid = agreement.published.cid;
        let subject = subjects.get(cid);
        if (!subject) {
            subject = { agreementCid: cid, ownerApprovals: {}, ownerApprovalHistory: [] };
            subjects.set(cid, subject);
        }
        Object.assign(subject, root.AgreementRecord.approvalSubject(agreement), { agreementId: agreement.id, expiresAt: agreement.deadline });
        return subject;
    }

    // Terminal agreements show their recorded decisions without offering new owner actions.
    function setStatus(agreementId, status) {
        const subject = subjectFor(agreementId);
        if (!subject) return;
        const terminal = { executed: 'Executed', cancelled: 'Cancelled', expired: 'Expired' };
        if (terminal[status]) subject.lifecycleStatus = terminal[status];
        else delete subject.lifecycleStatus;
    }

    function labels(subject) {
        const rights = runtime().inspect(subject);
        return id => runtime().label(id, rights);
    }
    const list = names => names.join(', ');
    // The cadastral number people know ("1236"), as the rest of the app shows it.
    function parcelName(id) {
        // A parcel a parcel layout replaced is gone from the live fabric; the cadastre still has it.
        const properties = root.LiveParcelFabric?.get?.(id)?.properties || root.CadastralParcelRepository?.get?.(id)?.properties;
        const number = root.ProposalDisplayText.parcelLabel(getParcelDisplayNumberFromProperties(properties, id));
        return t('panel.proposal.parcels.label', 'Parcel {{id}}', { id: number });
    }
    const words = () => root.ProposalApprovalText;
    const ruleText = (policy, regime) => words().rulesText(policy, t, regime);

    // The signer the installed providers would use for this owner right now (a wallet, a profile).
    function signerFor(subject, ownerId) {
        const current = actor();
        return current ? root.ProposalApprovalAuthorities.resolve(subject, ownerId, current)?.actorId || null : null;
    }

    const acceptedIds = subject => runtime().validIds(subject);

    // ---- relay --------------------------------------------------------------------------------

    // Any installed provider's receipt, checked from its own evidence and signatures.
    const verifyAny = (subject, receipt) => root.ProposalApproval.evidenceAllows(subject, receipt?.ownerId, receipt?.actorId, receipt?.evidence)
        && root.ProposalApprovalAuthorities.verifyReceipt(subject, receipt);

    // Reads the relay's decisions on the agreement (each re-verified here before it counts) and sends
    // the ones only this browser holds. The agreement panel runs it when it opens the agreement.
    function sync(agreementId) {
        const subject = subjectFor(agreementId);
        if (!subject || !root.ProposalApprovalRelay) return Promise.resolve(null);
        const cid = subject.agreementCid;
        if (syncing.has(cid)) return syncing.get(cid);
        const run = root.ProposalApprovalRelay.sync(subject, { verify: verifyAny }).then(result => {
            if (result.changed || result.sent) renderCards();
            log(`${cid}: ${result.synced ? `synced (${result.sent || 0} sent)` : 'the relay is unreachable'}`);
            return result;
        }).catch(error => {
            console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] relay sync failed for ${cid}`, error);
            return null;
        }).finally(() => syncing.delete(cid));
        syncing.set(cid, run);
        return run;
    }

    function sharedText(shared) {
        return shared?.shared
            ? t('proposalApproval.relay.shared', 'Shared: other browsers can verify and count this decision.')
            : t('agreement.publish.decisionKept', 'Not shared yet: the server did not take the decision. It is sent again when this agreement’s decisions are next read in this session.');
    }

    // One signed decision on the agreement's CID, then sent to the relay. Null when nothing was signed.
    async function decide(agreementId, parcelId, ownerId, withdraw) {
        const subject = subjectFor(agreementId);
        if (!subject) return null;
        const result = await runtime().decide(subject, parcelId, ownerId, actor(), withdraw === true);
        if (!result || result.error) {
            const code = result && result.error;
            console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] decision on ${subject.agreementCid} refused: ${code}`);
            showEphemeralMessage(code === 'agreement-closed'
                ? t('agreement.publish.decisionClosed', 'This agreement no longer takes decisions.')
                : t('proposalApproval.approvalUnavailable', 'The selected lens has not established these rights and your authority to act for this owner.'), 7000, 'error');
            return null;
        }
        const receipt = withdraw ? (subject.ownerApprovalHistory || []).at(-1) : subject.ownerApprovals?.[result.ownerId];
        const shared = receipt ? await root.ProposalApprovalRelay.push(subject, receipt) : { shared: false, code: 'no-receipt' };
        if (!shared.shared) console.info(`[${new Date().toISOString()}] [ProposalApprovalPanel] decision for ${result.ownerId} kept in this browser: ${shared.code}`);
        return { ...result, shared };
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
        if (progress.participants) {
            const p = progress.participants;
            html.push(meter('participants', t('proposalApproval.meterDistinctOwners', 'Distinct approving owners'),
                t('proposalApproval.ownersCount', '{{accepted}} of {{total}} accepted', { accepted: p.support, total: p.total }),
                p.support, Math.max(p.total, p.needed), needText(p, false)));
        }
        if (!counts('headcount', 'owners') && !progress.participants) {
            html.push(meter('owners', t('proposalApproval.meterOwners', 'Owners'),
                t('proposalApproval.ownersCount', '{{accepted}} of {{total}} accepted', { accepted: progress.acceptedOwners, total: progress.totalOwners }),
                progress.acceptedOwners, progress.totalOwners, t('proposalApproval.rules.heard', 'Heard, not counted')));
        }
        // Area may be absent from a rights registry even when the agreement's land is measured.
        // It is a missing requirement only for a rule that counts area (handled above).
        if (!counts('area', 'owners') && progress.totalAreaM2 != null) {
            html.push(meter('area', t('proposalApproval.meterArea', 'Area'),
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

    function progressHtml(progress, label) {
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

    // The named scheme, if any: its name, decision family and stage.
    function regimeHtml(progress) {
        const template = words().regimeOf(progress.regime);
        if (!template) return '';
        return `<p class="approval-card__regime" data-approval-regime="${esc(template.id)}"><strong>${esc(words().regimeName(progress.regime, t))}</strong>
            <small>${esc(words().familyText(template, t))} · ${esc(words().stageText(template, t))}</small></p>`;
    }

    function youHtml(subject, label, accepted) {
        const current = actor();
        const mine = current ? runtime().authorizedOwnerIds(subject, current) : [];
        const connected = wallet();
        const closed = ['Executed', 'Cancelled', 'Expired'].includes(subject.lifecycleStatus);
        let html = '';
        if (mine.length && !closed) {
            const names = list(mine.map(label));
            html += `<p class="approval-card__you-line" data-approval-you>${esc(connected && mine.some(id => signerFor(subject, id) === connected.address)
                ? t('proposalApproval.walletActsFor', 'Your wallet {{wallet}} can act for {{owners}}.', { wallet: root.LensCore.shortKey(connected.address), owners: names })
                : t('proposalApproval.youActFor', 'You can act for {{owners}}.', { owners: names }))}</p>`;
            html += '<div class="approval-card__actions">' + mine.map(id => {
                if (!accepted.includes(id)) {
                    return `<button type="button" class="btn btn-success btn-sm" data-approval-action="review" data-owner-id="${esc(id)}">${esc(t('proposalApproval.reviewAndAccept', 'Review and accept as {{owner}}', { owner: label(id) }))}</button>`;
                }
                const mayWithdraw = subject.ownerApprovals?.[id]?.actorId === signerFor(subject, id);
                return `<span class="approval-card__accepted" data-approval-accepted="${esc(id)}"><i class="fas fa-check" aria-hidden="true"></i> ${esc(t('proposalApproval.acceptedAs', 'Accepted as {{owner}}', { owner: label(id) }))}</span>`
                    + (mayWithdraw ? `<button type="button" class="btn btn-danger btn-sm" data-approval-action="withdraw" data-owner-id="${esc(id)}">${esc(t('proposalApproval.withdraw', 'Withdraw acceptance'))}</button>` : '');
            }).join('') + '</div>';
        }
        if (closed) {
            html += `<p class="approval-card__note" data-approval-closed>${esc(t('agreement.publish.decisionClosed', 'This agreement no longer takes decisions.'))}</p>`;
        } else {
            html += `<div class="approval-card__verify">
            <button type="button" class="btn btn-sm" data-approval-action="verify">${esc(t('proposalApproval.actForOwner', 'Act for an owner'))}</button>
            <small>${esc(t('agreement.publish.actForOwnerHint', 'A member of this agreement’s lens confirms which owners your wallet may act for. Nothing is accepted until you review and sign.'))}</small>
        </div>`;
        }
        return `<div class="approval-card__you">${html}</div>`;
    }

    // Every owner's position, for anyone: what they put in and what they get, without a wallet.
    function dealsHtml(subject, label, accepted) {
        const state = runtime().inspect(subject);
        const ids = [...state.ownerIds, ...state.leaseholderIds.filter(id => !state.ownerIds.includes(id))];
        if (!ids.length) return '';
        return `<div class="approval-card__deals" data-approval-deals>
            <p class="approval-card__deals-title">${esc(t('proposalApproval.deals.title', 'Proposed owner contributions and allocations'))}</p>
            <div class="approval-card__actions">${ids.map(id => `<button type="button" class="btn btn-sm" data-approval-action="inspect" data-owner-id="${esc(id)}"${accepted.includes(id) ? ' data-approval-deal-accepted' : ''}>${accepted.includes(id) ? '<i class="fas fa-check" aria-hidden="true"></i> ' : ''}${esc(label(id))}</button>`).join('')}</div>
        </div>`;
    }

    // The tally of the agreement's owner decisions and what the current profile may do.
    function cardHtml(subject) {
        const accepted = acceptedIds(subject);
        const progress = root.ProposalApprovalReview.progress(subject, accepted);
        const titleId = `approval-card-title-${String(subject.agreementId || 'agreement').replace(/[^A-Za-z0-9_-]/g, '_')}`;
        const heading = `<h4 id="${titleId}" class="approval-card__title">${esc(t('agreement.publish.tallyHeading', 'Owner decisions'))}</h4>`;
        if (!progress.ready) {
            return `<section class="approval-card" data-approval-card aria-labelledby="${titleId}">
                <div class="approval-card__head">${heading}
                <span class="cb-badge approval-card__status approval-card__status--unresolved">${esc(t('proposalApproval.status.unresolved', 'Ownership unresolved'))}</span></div>
                <p class="approval-card__note">${esc(t('agreement.publish.ownershipUnresolved', 'Ownership unresolved: the owners’ decision needs a complete rights snapshot in the agreement’s rule.'))}</p>
            </section>`;
        }
        const label = labels(subject);
        const status = progress.passed
            ? `<span class="cb-badge approval-card__status approval-card__status--passed">${esc(t('proposalApproval.status.passed', 'Configured approval rules met'))}</span>`
            : progress.supportMet
                ? `<span class="cb-badge approval-card__status approval-card__status--pending" data-approval-awaiting-authority>${esc(t('proposalApproval.status.authorityPending', 'Required authority decision pending'))}</span>`
                : `<span class="cb-badge approval-card__status approval-card__status--pending">${esc(t('proposalApproval.status.pending', 'Configured approval rules not met'))}</span>`;
        return `<section class="approval-card" data-approval-card aria-labelledby="${titleId}">
            <div class="approval-card__head">${heading}${status}</div>
            ${regimeHtml(progress)}
            <p class="approval-card__rule">${esc(ruleText(progress.policy, progress.regime))}</p>
            ${progressHtml(progress, label)}
            ${dealsHtml(subject, label, accepted)}
            ${youHtml(subject, label, accepted)}
        </section>`;
    }

    function render(slot, agreementId) {
        const subject = subjectFor(agreementId);
        if (!slot || !subject) return;
        slot.dataset.agreementId = String(agreementId);
        slot.innerHTML = cardHtml(subject);
        if (slot.dataset.approvalBound) return;
        slot.dataset.approvalBound = 'true';
        slot.addEventListener('click', event => {
            const control = event.target.closest('[data-approval-action]');
            if (!control || !slot.contains(control)) return;
            event.preventDefault();
            event.stopPropagation();
            const id = slot.dataset.agreementId;
            const ownerId = control.dataset.ownerId || null;
            if (control.dataset.approvalAction === 'verify') openVerify(id);
            else if (control.dataset.approvalAction === 'review') openReview(id, ownerId);
            else if (control.dataset.approvalAction === 'inspect') openReview(id, ownerId, null, { inspect: true });
            else if (control.dataset.approvalAction === 'withdraw') withdraw(id, ownerId);
        });
    }

    // Every mounted card.
    function renderCards() {
        doc.querySelectorAll('[data-approval-card-slot]').forEach(slot => {
            if (slot.dataset.agreementId) render(slot, slot.dataset.agreementId);
        });
    }
    const refreshAll = renderCards;

    function firstParcelOf(subject, ownerId) {
        return runtime().inspect(subject).parcels.find(parcel => parcel.owners.some(owner => owner.ownerId === ownerId))?.parcelId || null;
    }

    // An owner withdraws from one of their parcels; a leaseholder or an authority has none.
    async function withdraw(agreementId, ownerId) {
        const subject = subjectFor(agreementId);
        if (!subject) return;
        try {
            const result = await decide(agreementId, firstParcelOf(subject, ownerId), ownerId, true);
            if (result) showEphemeralMessage(sharedText(result.shared), 5000, result.shared?.shared ? 'success' : 'warning');
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ProposalApprovalPanel] the withdrawal was not signed`, error);
            showEphemeralMessage(t('proposalApproval.review.notSigned', 'The wallet did not sign, so nothing was accepted.'), 6000, 'error');
        }
        renderCards();
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

    // Lens members of this agreement with the directory's names and service addresses.
    async function lensMembers(subject) {
        const keys = root.ProposalApproval.lensKeys(subject);
        const directory = await root.LensPicker.loadDirectory();
        const members = directory.members || [];
        return keys.map(key => {
            const entry = members.find(member => member.key === key);
            return { key, label: root.LensCore.memberLabel(key, members), serviceUrl: entry?.serviceUrl || null };
        });
    }

    async function openVerify(agreementId, { thenReviewOwnerId = null } = {}) {
        const subject = subjectFor(agreementId);
        if (!subject) return;
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
        const members = await lensMembers(subject);
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
                const result = await root.ProposalApprovalLensAuthority.instance.verifyOwner(subjectFor(agreementId) || subject,
                    { memberKey: member.key, serviceUrl: member.serviceUrl });
                const label = labels(subject);
                status.textContent = t('proposalApproval.walletActsFor', 'Your wallet {{wallet}} can act for {{owners}}.', {
                    wallet: root.LensCore.shortKey(result.wallet), owners: list(result.ownerIds.map(label))
                });
                status.setAttribute('data-approval-verified', result.ownerIds.join(' '));
                renderCards();
                parts.footer.replaceChildren();
                const next = thenReviewOwnerId && result.ownerIds.includes(thenReviewOwnerId) ? thenReviewOwnerId
                    : result.ownerIds.length === 1 ? result.ownerIds[0] : null;
                if (next && !acceptedIds(subject).includes(next)) {
                    parts.footer.append(button('btn', t('common.close', 'Close'), close),
                        button('btn btn-success', t('proposalApproval.reviewAndAccept', 'Review and accept as {{owner}}', { owner: label(next) }),
                            () => openReview(agreementId, next)));
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
                share: share => t('proposalApproval.review.yourShare', 'Your share {{share}}', { share }),
                withAcceptance: progress => t('proposalApproval.review.withYou', 'With your acceptance: {{progress}}', { progress }),
                passes: t('proposalApproval.review.passesWithYou', 'Your acceptance would meet the configured approval rules.'),
                needsMore: t('proposalApproval.review.needsMore', 'Further decisions would still be needed under the configured approval rules.')
            };
        }
        return {
            inspect: true,
            title: t('proposalApproval.deals.dealOf', '{{owner}}’s deal', { owner }),
            contributes: t('proposalApproval.deals.contributes', 'Proposed contribution from {{owner}}', { owner }),
            share: share => t('proposalApproval.deals.share', 'Share {{share}}', { share }),
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
    function planHtml(subject, review) {
        const state = runtime().inspect(subject);
        const facts = [
            [t('proposalDrafts.review.parcels', 'Parcels'), state.parcels.length],
            [t('proposalApproval.meterOwners', 'Owners'), state.ownerIds.length],
            ...(state.leaseholderIds.length ? [[t('proposalApproval.rules.meter.headcount-leaseholders-all', 'Leaseholders'), state.leaseholderIds.length]] : []),
            ...(review.progressWithout.totalAreaM2 != null ? [[t('proposalApproval.meterArea', 'Area'), area(review.progressWithout.totalAreaM2)]] : [])
        ];
        return `<dl class="approval-review__facts" data-approval-plan>${facts.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
    }

    function conditionsHtml(review, members, voice) {
        const c = review.conditions;
        const template = words().regimeOf(c.regime);
        const lines = [ruleText(c.policy, c.regime)];
        if (template) {
            lines.push(`${words().regimeName(c.regime, t)} — ${words().stageText(template, t)}`, ...words().allocationLines(template, t));
        }
        lines.push(c.expiresAt
            ? t('proposalApproval.review.openUntil', 'Open until {{date}}', { date: format().formatDateTime(c.expiresAt) })
            : t('proposalApproval.review.noDeadline', 'No deadline'));
        lines.push(...words().reviewBasisLines(c, t, key => root.LensCore.memberLabel(key, members)));
        return `<ul class="approval-review__conditions">${lines.map(line => `<li>${esc(line)}</li>`).join('')}</ul>
            ${voice.inspect ? '' : `<p class="approval-review__sign-note">${esc(t('agreement.publish.signNote', 'Your wallet signs this agreement’s identity (its CID), which fixes its designs, land, allocations, money and rule.'))}</p>`}`;
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
        const minimum = progress.participants
            ? [t('proposalApproval.review.minimumOwners', '{{count}} distinct owner approvals needed', { count: progress.participants.needed })] : [];
        return [base, ...others, ...minimum, ...authority].join('; ');
    }

    function reviewProgressHtml(review, voice) {
        if (review.alreadyAccepted) {
            return `<p data-approval-progress-now>${esc(t('proposalApproval.review.alreadyAccepted', 'This owner has already accepted these terms.'))}</p>`;
        }
        return `<p data-approval-progress-now>${esc(t('proposalApproval.review.now', 'Now: {{progress}}', { progress: progressLine(review.progressWithout) }))}</p>
            <p data-approval-progress-with>${esc(voice.withAcceptance(progressLine(review.progressWith)))}</p>
            <p class="approval-review__verdict">${esc(review.progressWith.passed ? voice.passes : voice.needsMore)}</p>`;
    }

    // Accepting always goes through this review: the owner sees what they give first.
    // { inspect: true } opens the same review read-only for anyone (the card's owner row).
    async function openReview(agreementId, ownerId, parcelId = null, { inspect = false } = {}) {
        const subject = subjectFor(agreementId);
        if (!subject) return;
        const label = labels(subject);
        const review = root.ProposalApprovalReview.ownerReview(subject, ownerId, { acceptedOwnerIds: acceptedIds(subject) });
        if (!review) {
            showProposalAlertMessage('abstract_approval_unavailable', t('proposalApproval.approvalUnavailable',
                'The selected lens has not established these rights and your authority to act for this owner.'));
            return;
        }
        const members = (await root.LensPicker.loadDirectory()).members || [];
        const voice = reviewVoice(inspect, label(ownerId), review.kind);
        const parts = mount(voice.title, 'cb-dialog--lg');
        parts.dialog.setAttribute(inspect ? 'data-approval-deal' : 'data-approval-review', ownerId);
        const leaseNote = review.kind === 'leaseholder'
            ? `<p class="approval-card__note" data-approval-lease-note>${esc(t('proposalApproval.review.leaseNote', 'The plan reallocates ownership. A lease counts toward the approval rules but gets no plot from this plan’s ledger.'))}</p>` : '';
        parts.body.innerHTML = (review.kind === 'authority'
            ? section(t('proposalApproval.review.planTitle', 'The plan to decide on'), planHtml(subject, review))
            : section(voice.contributes, contributesHtml(review, label, voice) + leaseNote))
            + section(t('proposalApproval.review.conditions', 'Conditions'), conditionsHtml(review, members, voice))
            + section(t('proposalApproval.review.progress', 'Progress'), reviewProgressHtml(review, voice))
            + '<p class="approval-dialog__status" role="status" aria-live="polite" data-approval-review-status></p>';
        const status = parts.body.querySelector('[data-approval-review-status]');
        const cancel = button('btn', t('common.cancel', 'Cancel'), close);
        if (inspect) {
            // Read-only: the owner (or whoever acts for them) goes on to the signing review.
            parts.footer.append(button('btn', t('common.close', 'Close'), close));
            if (!review.alreadyAccepted && !['Executed', 'Cancelled', 'Expired'].includes(subject.lifecycleStatus)) {
                const acceptAs = button('btn btn-success', t('proposalApproval.deals.acceptAsOwner', 'I am {{owner}} — review and accept', { owner: label(ownerId) }),
                    () => openReview(agreementId, ownerId));
                acceptAs.setAttribute('data-approval-deal-accept', ownerId);
                parts.footer.append(acceptAs);
            }
            return;
        }
        if (review.alreadyAccepted) {
            parts.footer.append(button('btn btn-primary', t('common.close', 'Close'), close));
            return;
        }
        if (!signerFor(subject, ownerId)) {
            status.textContent = t('proposalApproval.review.verifyFirst', 'To accept, first confirm with a lens member that your wallet may act for this owner.');
            parts.footer.append(cancel, button('btn btn-primary', t('proposalApproval.actForOwner', 'Act for an owner'),
                () => openVerify(agreementId, { thenReviewOwnerId: ownerId })));
            return;
        }
        const accept = button('btn btn-success', voice.title, async () => {
            accept.disabled = true;
            cancel.disabled = true;
            status.textContent = t('panel.proposal.lens.awaitingSignature', 'Waiting for your wallet signature…');
            // An owner decides from one of their parcels; a leaseholder or an authority from none.
            const parcel = parcelId && review.contributes.some(row => row.parcelId === String(parcelId)) ? String(parcelId) : firstParcelOf(subject, ownerId);
            let result = null;
            try {
                result = await decide(agreementId, parcel, ownerId, false);
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
            renderCards();
            showReceipt(parts, subject, ownerId, label, result.shared);
        });
        accept.setAttribute('data-approval-accept', ownerId);
        parts.footer.append(cancel, accept);
    }

    // After the wallet signs, the dialog is the receipt: what was signed, by whom, and the new tally.
    function showReceipt(parts, subject, ownerId, label, shared) {
        const receipt = subject.ownerApprovals?.[ownerId];
        const progress = root.ProposalApprovalReview.progress(subject, acceptedIds(subject));
        parts.heading.textContent = t('proposalApproval.acceptedAs', 'Accepted as {{owner}}', { owner: label(ownerId) });
        parts.dialog.setAttribute('data-approval-receipt', ownerId);
        parts.body.innerHTML = `<p data-approval-receipt-signer>${esc(t('proposalApproval.receipt.signed', 'Signed by {{signer}} on {{date}}.', {
            signer: root.LensCore.isBase58Pubkey(receipt?.actorId) ? root.LensCore.shortKey(receipt.actorId) : String(receipt?.actorId || ''),
            date: format().formatDateTime(receipt?.decidedAt)
        }))}</p>
            <p data-approval-receipt-progress>${esc(t('proposalApproval.review.now', 'Now: {{progress}}', { progress: progressLine(progress) }))}</p>
            <p class="approval-review__verdict">${esc(progress.passed
                ? t('agreement.publish.receiptPassed', 'The verified decisions meet this agreement’s rule.')
                : t('agreement.publish.receiptPending', 'Further decisions are needed to meet this agreement’s rule.'))}</p>
            <p class="approval-card__note" data-approval-receipt-shared="${shared?.shared ? 'yes' : 'no'}">${esc(sharedText(shared))}</p>`;
        parts.footer.replaceChildren(button('btn btn-primary', t('proposalApproval.done', 'Done'), close));
        parts.footer.querySelector('button').focus();
    }

    root.solanaWalletManager.on('stateChanged', () => renderCards());
    root.ProposalApprovalPanel = { cardHtml, render, renderCards, refreshAll, openVerify, openReview, sync, setStatus };
})();
