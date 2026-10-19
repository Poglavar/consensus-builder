// proposals/lifecycle.js — proposal lifecycle helpers: expiry, decay/offer countdowns,
// lifecycle status (key/label/class), and offer-value format/parse. Extracted from proposals.js.
// Pure/leaf helpers; any cross-module calls resolve as runtime globals (all proposal scripts loaded).

// The canonical lifecycle accessor from proposals/status.js — a global in the browser (status.js
// loads first), required directly in node tests. `typeof` on an undeclared name is safe.
const lifecyclePhaseOf = (typeof getLifecycleStatus === 'function')
    ? getLifecycleStatus
    : require('./status.js').getLifecycleStatus;

function isProposalOpenSaleOffer(proposal) {
    if (!proposal || proposal.localPurchaseSimulation) return false;
    const otp = proposal.ownershipTransferProposal || {};
    if (lifecyclePhaseOf(proposal) !== 'Active' || isProposalExpired(proposal)
        || isNonBindingProposal(proposal) || otp.status === 'sold') return false;
    return ((proposal.facets || {}).ownership === 'third-party' && otp.recipientScope === 'any')
        || otp.direction === 'from-me';
}

function toggleExpiryInput() {
    const checkbox = document.getElementById('proposalExpireCheckbox');
    const timeInput = document.getElementById('proposalExpiryTime');
    if (checkbox && timeInput) {
        timeInput.disabled = !checkbox.checked;
        if (checkbox.checked) {
            timeInput.focus();
            timeInput.select();
        }
    }
}

function toggleDecayInput() {
    const checkbox = document.getElementById('proposalDecayCheckbox');
    const percentInput = document.getElementById('proposalDecayPercent');
    const timeInput = document.getElementById('proposalDecayTime');
    if (checkbox && percentInput && timeInput) {
        const enabled = checkbox.checked;
        percentInput.disabled = !enabled;
        timeInput.disabled = !enabled;
        if (enabled) {
            percentInput.focus();
            percentInput.select();
        }
    }
}

function calculateDecayedOffer(proposal) {
    if (!proposal || !proposal.offer) return proposal?.offer || 0;
    if (!proposal.decayEnabled || !proposal.decayPercent || !proposal.decayDurationMs) {
        return proposal.offer;
    }

    const createdAt = new Date(proposal.createdAt).getTime();
    const now = Date.now();
    const elapsed = now - createdAt;

    if (elapsed <= 0) return proposal.offer;
    if (elapsed >= proposal.decayDurationMs) {
        // Decay complete - return minimum amount
        const decayAmount = (proposal.offer * proposal.decayPercent) / 100;
        return proposal.offer - decayAmount;
    }

    // Linear decay over time
    const progress = elapsed / proposal.decayDurationMs;
    const decayAmount = (proposal.offer * proposal.decayPercent * progress) / 100;
    return proposal.offer - decayAmount;
}

function getDecayProgress(proposal) {
    if (!proposal || !proposal.decayEnabled || !proposal.decayDurationMs) {
        return 0;
    }

    const createdAt = new Date(proposal.createdAt).getTime();
    const now = Date.now();
    const elapsed = now - createdAt;

    if (elapsed <= 0) return 0;
    if (elapsed >= proposal.decayDurationMs) return 1;

    return elapsed / proposal.decayDurationMs;
}

function parseExpiryTime(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.match(/^(\d{1,2})h:(\d{1,2})m:(\d{1,2})s$/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10) || 0;
    const minutes = parseInt(match[2], 10) || 0;
    const seconds = parseInt(match[3], 10) || 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function isProposalExpired(proposal) {
    const phase = lifecyclePhaseOf(proposal);
    if (phase === 'Expired') return true;
    // Only an Active proposal can expire; a deadline cannot fill unknown lifecycle evidence.
    if (phase !== 'Active' || !proposal.expiresAt) return false;
    return new Date(proposal.expiresAt).getTime() <= Date.now();
}

function checkAndUpdateProposalExpiry(proposal) {
    if (!proposal) return proposal;
    if (isProposalExpired(proposal)) {
        const currentPhase = lifecyclePhaseOf(proposal);
        if (currentPhase !== 'Expired' && currentPhase !== 'Executed') {
            proposal.lifecycleStatus = 'Expired';
            proposal.updatedAt = new Date().toISOString();
            if (proposal.proposalId && typeof proposalStorage !== 'undefined') {
                if (typeof proposalStorage.setProposalLifecycleStatus === 'function') {
                    proposalStorage.setProposalLifecycleStatus(proposal.proposalId, 'Expired');
                }
                proposalStorage.save();
            }
        }
    }
    return proposal;
}

function initializeExpiryCountdown() {
    // Clear any existing interval
    if (expiryCountdownInterval) {
        clearInterval(expiryCountdownInterval);
        expiryCountdownInterval = null;
    }

    const countdownEl = document.querySelector('.proposal-expiry-countdown[data-expires-at]');
    if (!countdownEl) return;

    const expiresAtStr = countdownEl.getAttribute('data-expires-at');
    const proposalId = countdownEl.getAttribute('data-proposal-id');
    if (!expiresAtStr) return;

    // Only Active proposals have a running expiry countdown.
    if (proposalId && typeof proposalStorage !== 'undefined') {
        const p = proposalStorage.getProposal(proposalId);
        if (lifecyclePhaseOf(p) !== 'Active') {
            return;
        }
    }

    const expiresAt = new Date(expiresAtStr).getTime();
    const timerEl = countdownEl.querySelector('.expiry-timer');
    const labelEl = countdownEl.querySelector('.expiry-label');

    function updateCountdown() {
        if (proposalId && typeof proposalStorage !== 'undefined'
            && lifecyclePhaseOf(proposalStorage.getProposal(proposalId)) !== 'Active') {
            clearInterval(expiryCountdownInterval);
            expiryCountdownInterval = null;
            countdownEl.remove();
            return;
        }
        const now = Date.now();
        const remaining = expiresAt - now;

        if (remaining <= 0) {
            // Proposal has expired
            if (expiryCountdownInterval) {
                clearInterval(expiryCountdownInterval);
                expiryCountdownInterval = null;
            }

            // Update the countdown display to show expired (the look, and hiding the timer, is the
            // expired class's: css/proposal-details.css).
            countdownEl.classList.add('expired');
            if (labelEl) {
                const t = getProposalI18nHelper();
                labelEl.textContent = t('panel.proposal.expiry.expired', 'Proposal expired');
            }
            const iconEl = countdownEl.querySelector('i');
            if (iconEl) {
                iconEl.className = 'fas fa-clock';
            }

            // Update proposal status in storage
            if (proposalId && typeof proposalStorage !== 'undefined') {
                const proposal = proposalStorage.getProposal(proposalId);
                if (proposal) {
                    checkAndUpdateProposalExpiry(proposal);
                    // Refresh the UI
                    updateProposalList();
                    // Re-render the proposal info to update buttons
                    showProposalInfo(proposal);
                }
            }
        } else {
            // Update the timer display
            if (timerEl) {
                timerEl.textContent = formatRemainingTime(remaining);
            }

            // The danger tone in the last minute (is-urgent, css/proposal-details.css).
            countdownEl.classList.toggle('is-urgent', remaining < 60000);
        }
    }

    // Run immediately and then every second
    updateCountdown();
    expiryCountdownInterval = setInterval(updateCountdown, 1000);
}

function initializeDecayCountdown() {
    // Clear any existing interval
    if (decayCountdownInterval) {
        clearInterval(decayCountdownInterval);
        decayCountdownInterval = null;
    }

    const offerBar = document.querySelector('.proposal-offer-bar.with-decay[data-proposal-id]');
    if (!offerBar) return;

    const proposalId = offerBar.getAttribute('data-proposal-id');
    const originalOffer = parseFloat(offerBar.getAttribute('data-original-offer'));
    const decayPercent = parseFloat(offerBar.getAttribute('data-decay-percent'));
    const decayDurationMs = parseFloat(offerBar.getAttribute('data-decay-duration'));
    const createdAtStr = offerBar.getAttribute('data-created-at');

    if (!originalOffer || !decayPercent || !decayDurationMs || !createdAtStr) return;

    const createdAt = new Date(createdAtStr).getTime();
    const proposal = proposalId && typeof proposalStorage !== 'undefined'
        ? proposalStorage.getProposal(proposalId)
        : { offer: originalOffer, decayEnabled: true, decayPercent, decayDurationMs, createdAt: createdAtStr, offerCurrency: 'USDT' };

    const remainingBar = offerBar.querySelector('.offer-bar-remaining');
    const decayedBar = offerBar.querySelector('.offer-bar-decayed');
    const amountEl = offerBar.querySelector('.offer-amount');
    // Amount then code ("431,000 USDT") in the offer's own currency, else the city's display currency.
    const offerCurrency = proposal.offerCurrency
        || window.CityConfigManager?.getCurrentCityConfig?.()?.currency?.code
        || 'EUR';

    function updateDecay() {
        const now = Date.now();
        const elapsed = now - createdAt;

        let progress = 0;
        if (elapsed >= decayDurationMs) {
            progress = 1;
        } else if (elapsed > 0) {
            progress = elapsed / decayDurationMs;
        }

        const decayedPercent = decayPercent * progress;
        const remainingPercent = 100 - decayedPercent;
        const currentOffer = originalOffer - (originalOffer * decayedPercent / 100);

        if (remainingBar) remainingBar.style.width = remainingPercent + '%';
        if (decayedBar) decayedBar.style.width = decayedPercent + '%';
        if (amountEl) amountEl.textContent = CbFormat.formatMoney(currentOffer, offerCurrency);

        // Stop interval once fully decayed
        if (progress >= 1 && decayCountdownInterval) {
            clearInterval(decayCountdownInterval);
            decayCountdownInterval = null;
        }
    }

    // Run immediately and then every second
    updateDecay();
    decayCountdownInterval = setInterval(updateDecay, 1000);
}

// The kind (proposals/proposal-kind.js) is chosen at publish and says who decides
// (proposal-kinds.md). An owner vote is the one where owners cast yes-votes instead of binding
// acceptances; a community vote has no owner action at all. Neither ever executes or transfers.
const proposalKindApiForLifecycle = (typeof ProposalKind === 'object' && ProposalKind)
    ? ProposalKind
    : require('./proposal-kind.js');

function isVoteProposal(proposal) {
    return proposalKindApiForLifecycle.isOwnerVote(proposal);
}

function isNonBindingProposal(proposal) {
    return proposalKindApiForLifecycle.isNonBinding(proposal);
}

// Status label for a vote proposal: "Open for voting" until the expiry deadline, then "Vote concluded".
function getProposalVoteStatusLabel(proposal) {
    const t = getProposalI18nHelper();
    if (isProposalExpired(proposal)) {
        return t('panel.proposal.voting.concluded', 'Vote concluded');
    }
    return t('panel.proposal.voting.open', 'Open for voting');
}

function getProposalLifecycleKey(proposal) {
    const lifecycleField = lifecyclePhaseOf(proposal).toLowerCase();
    if (['unknown', 'draft', 'cancelled', 'executed'].includes(lifecycleField)) return lifecycleField;
    // Known voting records read "Open for voting" until the deadline, then "Vote concluded".
    // Missing evidence and explicit draft/terminal states are preserved above.
    if (isNonBindingProposal(proposal)) {
        return isProposalExpired(proposal) ? 'vote-concluded' : 'vote-open';
    }
    if (lifecycleField === 'expired') return 'expired';
    if (isProposalExpired(proposal)) return 'expired';
    // Funding readiness does not establish owner consent and cannot override a terminal state.
    if (proposal.funded === false && proposal.ownershipTransferProposal?.direction === 'from-me') {
        return 'awaiting-funding';
    }
    return 'active';
}

function getProposalLifecycleLabel(key) {
    const t = getProposalI18nHelper();
    switch (key) {
        case 'vote-open':
            return t('panel.proposal.voting.open', 'Open for voting');
        case 'vote-concluded':
            return t('panel.proposal.voting.concluded', 'Vote concluded');
        case 'executed':
            return t('panel.proposal.lifecycle.executed', 'Execution recorded');
        case 'expired':
            return t('panel.proposal.lifecycle.expired', 'Expired');
        case 'cancelled':
            return t('panel.proposal.lifecycle.cancelled', 'Withdrawn');
        case 'awaiting-funding':
            return t('panel.proposal.lifecycle.awaitingFunding', 'Awaiting funding');
        case 'draft':
            return t('common.lifecycle.draft', 'Draft');
        case 'active':
            return t('panel.proposal.lifecycle.active', 'Active');
        default:
            return t('panel.proposal.lifecycle.unknown', 'Status unknown');
    }
}

function getProposalLifecycleClass(key) {
    switch (key) {
        case 'vote-open':
            return 'active';
        case 'vote-concluded':
            return 'expired';
        case 'executed':
            return 'executed';
        case 'expired':
            return 'expired';
        case 'cancelled':
            return 'cancelled';
        case 'awaiting-funding':
            return 'active';
        case 'unknown':
            return 'unknown';
        case 'draft':
            return 'draft';
        default:
            return 'active';
    }
}

// Offer formatting helpers. An offer may be a fraction (0.5 ETH); it is read and shown in the UI
// language (CbFormat.parseDecimal / formatNumber), and regrouped only once the field is left, so
// typing a decimal point is never undone mid-number.
const offerFormat = () => (typeof CbFormat !== 'undefined' ? CbFormat : require('../format.js'));
const OFFER_MAX_FRACTION_DIGITS = 8;

function formatProposalOfferValue(value) {
    if (value === undefined || value === null || value === '') return '';
    const number = offerFormat().parseDecimal(value);
    if (!Number.isFinite(number)) return String(value);
    return offerFormat().formatNumber(number, { maxFractionDigits: OFFER_MAX_FRACTION_DIGITS });
}

// While typing: digits, separators and spaces only.
function handleProposalOfferInput(input) {
    const cleaned = input.value.replace(/[^\d.,\s\u00a0\u202f]/g, '');
    if (input.value !== cleaned) input.value = cleaned;
}

// On leaving the field: grouped in the UI language.
function formatProposalOfferInput(input) {
    input.value = formatProposalOfferValue(input.value);
}

// Empty is 0; text that is not a number is NaN, which the create dialog refuses.
function parseProposalOfferValue(value) {
    const number = offerFormat().parseDecimal(value);
    return number === null ? 0 : number;
}

// Export the pure classification helper for headless unit tests (browser leaves `module` undefined,
// so this is a no-op there and the functions remain plain globals).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isVoteProposal,
        isNonBindingProposal,
        isProposalExpired,
        checkAndUpdateProposalExpiry,
        parseExpiryTime,
        formatProposalOfferValue,
        parseProposalOfferValue
    };
}
