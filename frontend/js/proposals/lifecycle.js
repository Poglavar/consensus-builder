// proposals/lifecycle.js — proposal lifecycle helpers: expiry, decay/offer countdowns,
// lifecycle status (key/label/class), and offer-value format/parse. Extracted from proposals.js.
// Pure/leaf helpers; any cross-module calls resolve as runtime globals (all proposal scripts loaded).

function isProposalOpenSaleOffer(proposal) {
    if (!proposal) return false;
    const otp = proposal.ownershipTransferProposal || {};
    if (proposal.status === 'Executed' || otp.status === 'sold') return false;
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
    if (!proposal || !proposal.expiresAt) return false;
    const status = (proposal.status || '').toLowerCase();
    if (status === 'executed') return false; // Executed proposals no longer expire
    return new Date(proposal.expiresAt).getTime() <= Date.now();
}

function checkAndUpdateProposalExpiry(proposal) {
    if (!proposal) return proposal;
    if (isProposalExpired(proposal)) {
        const currentStatus = (proposal.status || '').toLowerCase();
        if (currentStatus !== 'expired' && currentStatus !== 'executed') {
            proposal.status = 'Expired';
            proposal.updatedAt = new Date().toISOString();
            if (proposal.proposalId && typeof proposalStorage !== 'undefined') {
                proposalStorage.updateProposalStatus(proposal.proposalId, 'Expired');
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

    // If proposal is executed, do not start countdown
    if (proposalId && typeof proposalStorage !== 'undefined') {
        const p = proposalStorage.getProposal(proposalId);
        const status = (p && p.status ? p.status : '').toLowerCase();
        if (status === 'executed') {
            return;
        }
    }

    const expiresAt = new Date(expiresAtStr).getTime();
    const timerEl = countdownEl.querySelector('.expiry-timer');
    const labelEl = countdownEl.querySelector('.expiry-label');

    function updateCountdown() {
        const now = Date.now();
        const remaining = expiresAt - now;

        if (remaining <= 0) {
            // Proposal has expired
            if (expiryCountdownInterval) {
                clearInterval(expiryCountdownInterval);
                expiryCountdownInterval = null;
            }

            // Update the countdown display to show expired
            countdownEl.classList.add('expired');
            countdownEl.style.background = '#f8d7da';
            countdownEl.style.borderColor = '#f5c6cb';
            if (labelEl) {
                labelEl.textContent = 'Proposal Expired';
                labelEl.style.color = '#721c24';
            }
            if (timerEl) {
                timerEl.style.display = 'none';
            }
            const iconEl = countdownEl.querySelector('i');
            if (iconEl) {
                iconEl.className = 'fas fa-clock';
                iconEl.style.color = '#721c24';
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

            // Change color to red when less than 1 minute remaining
            if (remaining < 60000) {
                countdownEl.style.background = '#f8d7da';
                countdownEl.style.borderColor = '#f5c6cb';
                if (labelEl) labelEl.style.color = '#721c24';
                if (timerEl) timerEl.style.color = '#721c24';
                const iconEl = countdownEl.querySelector('i');
                if (iconEl) iconEl.style.color = '#721c24';
            }
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
    const currencySymbol = proposal.offerCurrency === 'EUR' ? '€' : '';
    const currencySuffix = proposal.offerCurrency && proposal.offerCurrency !== 'EUR' ? ' ' + proposal.offerCurrency : '';

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
        if (amountEl) amountEl.textContent = currencySymbol + Math.round(currentOffer).toLocaleString('hr-HR') + currencySuffix;

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

function getProposalLifecycleKey(proposal) {
    if (!proposal) return 'active';
    // Check for ownership-transfer-from-me proposals which are accepted but not funded
    if (proposal.funded === false && proposal.ownershipTransferProposal?.direction === 'from-me') {
        return 'accepted-not-funded';
    }
    const lifecycleField = (proposal.lifecycleStatus || proposal.status || '').toLowerCase();
    if (lifecycleField === 'executed') return 'executed';
    if (lifecycleField === 'expired') return 'expired';
    if (PROPOSAL_INACTIVE_STATUSES.has(lifecycleField)) return 'inactive';
    return 'active';
}

function getProposalLifecycleLabel(key) {
    const t = getProposalI18nHelper();
    switch (key) {
        case 'executed':
            return t('panel.proposal.lifecycle.executed', 'Executed');
        case 'expired':
            return t('panel.proposal.lifecycle.expired', 'Expired');
        case 'inactive':
            return t('panel.proposal.lifecycle.inactive', 'Inactive');
        case 'accepted-not-funded':
            return t('panel.proposal.lifecycle.acceptedNotFunded', 'Accepted (Not funded)');
        default:
            return t('panel.proposal.lifecycle.active', 'Active');
    }
}

function getProposalLifecycleClass(key) {
    switch (key) {
        case 'executed':
            return 'executed';
        case 'expired':
            return 'expired';
        case 'inactive':
            return 'inactive';
        case 'accepted-not-funded':
            return 'accepted-not-funded';
        default:
            return 'active';
    }
}

// Offer formatting helpers
function formatProposalOfferValue(value) {
    if (value === undefined || value === null || value === '') return '';
    const cleanValue = value.toString().replace(/\D/g, '');
    if (!cleanValue) return '';
    const number = parseInt(cleanValue, 10);
    return number.toLocaleString('hr-HR');
}

function handleProposalOfferInput(input) {
    const originalValue = input.value;
    const formatted = formatProposalOfferValue(originalValue);

    if (input.value !== formatted) {
        input.value = formatted;
    }
}

function parseProposalOfferValue(value) {
    if (!value) return 0;
    const cleanValue = value.toString().replace(/\D/g, '');
    return parseInt(cleanValue, 10) || 0;
}
