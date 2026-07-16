/*
    proposals/bootstrap.js — initialization & wiring for the proposals subsystem.

    The proposals code was split out of a single ~26k-line proposals.js into cohesive
    classic-script modules under js/proposals/ (state, data, storage, server-sync, parcel-id,
    geometry, chain, execution, layer-render, urban-rules, roads, reparcel, list-ui, lifecycle,
    details-panel, create, dialog-create/upload/share, sharing-routes, core).

    This file is loaded LAST and contains only the top-level init side-effects — event wiring,
    URL share-route bootstrapping, and contiguity/UI guards — that must run after every module's
    definitions are in place. All shared mutable state lives in state.js; data/config + the
    proposalStorage / multiParcelSelection singletons live in data.js.
*/













// Check contiguity and disable buttons that require contiguous parcels
// This applies to: Urban Rule's Block/Row buttons and Purchase's Park/Square/Lake buttons























// --- Translation hydration (pulls from JSON source to avoid hardcoding strings) ---

// Cache parcel areas per proposal to avoid repeated lookups/hydration



/**
 * Check if current user is a guest and needs to personalize their profile.
 * If guest, shows welcome modal and returns true; otherwise returns false.
 * Use this to gate functionality that requires a personalized profile.
 */

// PERFORMANCE: Write cache to batch localStorage operations
// When enabled, writes go to cache instead of storage, then flush at once




/**
 * Check if a parcel is a parent that was replaced by child parcels from an applied proposal.
 * Returns true if the parcel should be hidden (replaced by children), false if it should be visible.
 * This replaces the removedByProposal flag with logic based on parent/child relationships.
 */
/**
 * True if this parcel is hidden because an applied proposal replaced it with descendants.
 *
 * Contract: "applied + rule replaces parents + parcel listed as ancestor" → hide. We do NOT
 * gate on whether descendant geometries currently exist on the map; the apply contract is
 * authoritative. If a parcel is missing from the map after this returns true, the descendants
 * either exist in PersistentStorage or will be re-derived from the proposal's definition on
 * the next apply pass — we should never reveal a stale parent under a hole as a workaround.
 *
 * Hot path: called per parcel during ingest and pan, so backed by the proposalStorage
 * ancestor index (O(1) lookup, rebuilt lazily after any proposal mutation).
 */




if (typeof window !== 'undefined') {
    window.readPersistedParcelRecord = readPersistedParcelRecord;
    window.writePersistedParcelRecord = writePersistedParcelRecord;
    window.clearPersistedParcelRecord = clearPersistedParcelRecord;
    window._startParcelWriteCache = _startParcelWriteCache;
    window._flushParcelWriteCache = _flushParcelWriteCache;
    window._discardParcelWriteCache = _discardParcelWriteCache;
    window.withParcelWriteBatch = withParcelWriteBatch;
    window.isParcelWriteBatchActive = isParcelWriteBatchActive;
}







// On execution, move authoritative parcel ownership (parcel_<id>_owner) to the proposal's
// recipient. Merge/Readjust assign per-child owners in their appliers; every other goal
// (park/square/lake/road/building + pure ownership transfer) transfers the still-real parent
// parcels here. Open sale (Third party · Anyone) has no recipient yet → handled by the buyer claim.

// Tier 2.2 — recipient consent ("no force-gift"). Opt-in via window.PROPOSAL_REQUIRE_RECIPIENT_CONSENT
// so it doesn't block the demo by default; when on, a directed third-party transfer needs the
// named recipient to have consented (recordRecipientConsent). City/sale/to-me don't need it.


// Tier 2.1 — a buyer claims an open sale offer (Ownership: Third party · Anyone). Binds the buyer
// as recipient, marks it sold, and transfers the offered parcels to them. (Payment/settlement is
// a Tier-3 piece; this is the local "it actually executes" step.)

// Is this proposal an open offer to sell (Ownership: Third party · Anyone)?

// For a directed external recipient (to-city / third-party·specific) return {label, accepted}
// so the details dialog can show the recipient as a consent line item. null otherwise.

// Recipient accepts (records consent) and re-renders the open details dialog.

if (typeof window !== 'undefined') {
    window.claimSaleOffer = claimSaleOffer;
    window.recordRecipientConsent = recordRecipientConsent;
    window.isProposalOpenSaleOffer = isProposalOpenSaleOffer;
    window.acceptAsRecipient = acceptAsRecipient;
}




// Deterministic, order-insensitive hash (cyrb53) to produce stable proposal ids across clients.

























// Global flag to suppress camera movements during certain flows (e.g., shared apply)



// Cache proposal-provided parcel features to avoid re-hydrating from the map layer





/**
 * Resolve proposal-related parcel features for the current viewport only.
 *
 * Same code path for 3 ancestors and 3,000: instead of iterating the proposal's id list,
 * we walk the parcel-layer spatial index restricted to the current map bounds and pick out
 * those whose id appears in the proposal's id set. Cost is O(viewport tile count), bounded
 * by what the user can actually see — proposal size has no effect on this loop.
 *
 * Off-screen parcel outlines are intentionally not drawn: they cannot be visible anyway,
 * and primary geometry (road corridor, structure polygon) keeps drawing regardless.
 */
/**
 * Walk the parcel-layer spatial index restricted to the current viewport and invoke
 * `callback(layer, idStr)` for every layer whose id is in `proposalIdSet`.
 *
 * This is the hot path for proposal highlights: for a road proposal with 1438 descendants
 * the old implementation called `multiParcelSelection.findParcelById` + `layer.toGeoJSON()`
 * per match — ~1400 redundant lookups and deep clones — then handed the features back to
 * `L.geoJSON` overlay creation. Walking the viewport index once and mutating existing
 * layers in place is orders of magnitude cheaper (we already HAVE each layer).
 */

/**
 * Legacy shim: some paths still want Feature objects (e.g. overlay construction for
 * non-parcel primary geometry). Uses forEachProposalParcelInViewport + toGeoJSON on
 * the hit layers; callers that just need setStyle should call forEachProposalParcelInViewport
 * directly and avoid the toGeoJSON clone.
 */

/**
 * Build the set of parcel ids a proposal wants highlighted (parents + road descendants).
 * The in-place style path walks the viewport spatial index once against this set and
 * mutates matching layers directly — no feature extraction, no overlay layer creation.
 */




/**
 * Parcel-layer style override registry for proposal highlights.
 *
 * Proposal highlights used to create a duplicate L.geoJSON overlay layer per parcel on a
 * dedicated highlight pane. For road proposals with hundreds/thousands of descendant
 * slivers this meant adding hundreds of new Leaflet layers on every repaint — expensive
 * enough to bog the UI down completely.
 *
 * The new approach: never create overlay layers for parcel-shaped highlights. Instead,
 * walk the parcel layers that are already in parcelLayerById and call setStyle() on them
 * directly. Leaflet mutates the existing SVG paths in place — cheap, and the parcels
 * remain clickable because interactivity is unchanged. We stash each layer's
 * pre-highlight style so clear can restore it.
 *
 * _stash is a Map<Layer, { stashedStyle }>. Using a Map (not WeakMap) because we need
 * to iterate it on restore; Leaflet layers live as long as the parcel is on the map.
 */

// Expose so selection.js can query/restore proposal highlights without importing this module.
if (typeof window !== 'undefined') {
    window.proposalHighlightStyleOverride = proposalHighlightStyleOverride;
}

/**
 * Highlight a parcel feature by mutating its existing Leaflet layer in place.
 * Returns true if the style was applied, false if the parcel layer could not be
 * resolved — in which case the caller may fall back to creating an overlay layer
 * (for the rare case where a feature was resolved from PersistentStorage but has
 * not yet been ingested into parcelLayerById).
 */







// Multi-parcel selection state


// Proposal layer management

// --- Proposal Color Palette ---

// With no separate proposal mode, this becomes a no-op kept for compatibility.

// Refresh the proposals layer (called when proposals are updated)

// Lightweight function to refresh proposal data without rebuilding visual layers

// Handle clicks on road proposals

// Handle clicks on proposal parcels
// Proposal highlighting state
window.currentlyHighlightedProposal = null;
window.selectedParcelInProposal = null;
window.isApplyingProposalHighlights = false;

// Apply proposal highlights (can be called repeatedly)

// Clear proposal highlights

// Function to re-apply highlights after parcel layer updates

/** Bounds from road centerline / stored polygon — avoids hundreds of findParcelById calls for huge parent lists. */


// Unified function to select and highlight a proposal with proper sequencing

/**
 * Single-path proposal opener — same code for 3 ancestors and 3,000.
 *
 * Contract:
 *   1. The details panel + highlights paint immediately, using whatever bounds we can derive
 *      from proposal metadata (road definition / structure geometry / stored bounds / in-memory
 *      ancestor parcels). We never await parcel hydration before showing the panel.
 *   2. Ancestor parcels load in the background (fire-and-forget). As tiles arrive, the
 *      parcelDataLoaded → scheduleHighlightRefresh path repaints highlights and fills in the
 *      lazy ancestor list. The proposal becomes visually complete progressively, without
 *      blocking the main thread.
 *
 * This means there is no "mega proposal" branch — proposal size only changes how much data
 * the background fetch pulls, not which functions run.
 */


window.openProposalFromList = openProposalFromList;




if (typeof window !== 'undefined') {
    window.normalizeProposalGoalKey = normalizeProposalGoalKey;
    window.resolveProposalGoalKey = resolveProposalGoalKey;
}




window.focusProposalDetails = focusProposalDetails;
window.applyProposalToMap = applyProposalToMap;
window.removeProposalFromMap = removeProposalFromMap;



// Override the parcel click when proposals are shown


/**
 * Returns the correct parcel click handler based on the current UI state.
 * This is the single source of truth for parcel click behavior.
 */

/**
 * A robust click handler that is aware of the proposal mode.
 * It checks if a clicked parcel is part of a proposal and routes
 * the click to the appropriate handler.
 * @param {L.LeafletEvent} e The Leaflet click event.
 */

// Show proposal info panel
// NOTE: This is a pure display function. It expects the proposal to contain all necessary data
// (parentFeatures, childFeatures, parcelIds). No data fetching should happen here.
// Proposals are created from loaded parcels, so all data should already be present.





















// Make returnToParcelInfo globally available
window.returnToParcelInfo = returnToParcelInfo;

/**
 * Hide the proposal details panel
 */




// Make hideProposalDetailsPanel globally available
window.hideProposalDetailsPanel = hideProposalDetailsPanel;
window.toggleProposalDetailsPanelMinimized = toggleProposalDetailsPanelMinimized;



// Track ownership transfer direction: 'to-me' or 'from-me'
// Stored screenshot data URL captured when proposal modal opens





// Goals that don't have meaningful map geometry, so a screenshot would just be a placeholder.
// Note: decide-later and reparcellization are intentionally NOT in this set — they have parent
// parcels (or per-slice geometry) we can frame.

if (typeof window !== 'undefined') {
    window.shouldSkipProposalScreenshot = shouldSkipProposalScreenshot;
}

// When a proposal's screenshot URL is set or replaced (the mint flow puts the on-chain image URL on
// it), upgrade any placeholder thumbnails in the DOM without re-rendering the whole list.
if (typeof document !== 'undefined') {
    document.addEventListener('proposalScreenshotUpdated', (event) => {
        const detail = event && event.detail ? event.detail : {};
        const { proposalId } = detail;
        const imageSrc = detail.screenshotUrl || detail.screenshotDataUrl;
        if (!proposalId || !imageSrc) return;
        const sel = `.proposal-thumb[data-proposal-id="${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(proposalId)) : String(proposalId)}"]`;
        document.querySelectorAll(sel).forEach(node => {
            node.classList.remove('proposal-thumb-empty');
            node.classList.add('proposal-thumb-has-image');
            node.removeAttribute('title');
            node.innerHTML = `
                <img class="proposal-thumb-img" src="${imageSrc}" alt="" loading="lazy">
                <div class="proposal-thumb-large"><img src="${imageSrc}" alt=""></div>
            `;
        });
    });
}











if (typeof window !== 'undefined') {
    window.openRoadDesignationModal = openRoadDesignationModal;
}








// ---- Proposal facets: Land use / Parcels / Ownership ----------------------
// The create-proposal dialog exposes three persistent, independent facets, all
// visible until "Create" is clicked. They are mapped onto the existing goal-key
// machinery (setProposalType / updateGoalDependentSections / geometry / submit)
// so the rest of the flow is unchanged. See feature-proposal-goals.md.


// Set the Parcels radio + state. lock => disable the other options (intrinsic to
// the land use); unlock => re-enable all (per-slice stays gated to Readjust).
// The localized pill label for a facet value (read from its rendered pill).

// Shared lock UI: when a facet is forced by another choice, hide its pill group and
// show a quiet static line ("🔒 <value> · <reason>") instead of dead/disabled pills.



// The address field only applies to a Specific third-party recipient (not Anyone).


// Name/description "type" reflecting the chosen ownership recipient (so the auto title
// isn't always "Ownership transfer to me"). Distinct from the to-me/from-me mechanic.




// Move the geometry control (and, for Urban Rule, the typology selector) inline, right
// after the section that requires it — so "Edit" appears next to Building/Road/Urban Rule
// in Land use, or next to Readjust in Parcels — instead of far down the form.

// Land-use selection applies the constraint matrix (lock the hard ones, default
// the soft ones), then resyncs the derived goal.



// Collapse the three facets into the legacy goal key that drives geometry + submit.


// Initialize the three facets, optionally from an override goal (e.g. a road draw).



















if (typeof window !== 'undefined') {
    window.areParcelsContiguous = areParcelsContiguous;
}



// Backward compatibility alias









// Collapse the proposal-goal grid down to the selected goal (a chevron bar the
// user clicks to re-expand). Expanding shows all goals again.


// When collapsed, a click on the selected goal re-expands the grid instead of
// re-launching the tool. Capture-phase so it pre-empts the button's onclick.
if (typeof document !== 'undefined' && !window.__proposalGoalCollapseInstalled) {
    document.addEventListener('click', (e) => {
        const group = document.getElementById('proposalGoalGroup');
        if (!group || !group.classList.contains('is-collapsed') || !group.contains(e.target)) return;
        const btn = e.target.closest('.proposal-type-button[data-proposal-tool]');
        if (btn && btn.classList.contains('selected')) {
            e.stopPropagation();
            e.preventDefault();
            expandProposalGoalGroup();
        }
    }, true);
    window.__proposalGoalCollapseInstalled = true;
}











// Show proposal creation dialog

// Close proposal dialog

// Toggle expiry time input when checkbox is changed

// Toggle decay inputs when checkbox is changed

// Toggle deposit input when checkbox is changed

// Calculate current offer amount considering decay

// Get decay progress (0 to 1) for visual representation

// Parse expiry time string (format: XXh:YYm:ZZs) and return milliseconds

// Check if a proposal has expired based on its expiresAt timestamp

// Update proposal status to Expired if it has expired

// Store the interval ID for the expiry countdown so we can clear it

// Format remaining time as XXh:YYm:ZZs

// Initialize expiry countdown timer in the proposal details panel

// Interval for decay countdown

// Initialize decay countdown animation for the offer bar

// Utilities for random names

// Show proposal dialog for structures (Park/Square) with provided parcelIds and geometry





// Expose helpers
window.showStructureProposalDialog = showStructureProposalDialog;
window.handleProposalToolButton = handleProposalToolButton;
window.selectLandUse = selectLandUse;
window.onProposalLandUseChange = onProposalLandUseChange;
window.onProposalParcelsChange = onProposalParcelsChange;
window.onProposalOwnershipChange = onProposalOwnershipChange;
window.onProposalRecipientScopeChange = onProposalRecipientScopeChange;
window.setProposalType = setProposalType;
window.setProposalMainType = setProposalMainType;
window.setProposalAcquisitionMode = setProposalAcquisitionMode;
window.setProposalBoundaryMode = setProposalBoundaryMode;
window.handleUrbanRuleMainTypeClick = handleUrbanRuleMainTypeClick;
window.handleUrbanRuleTypologyClick = handleUrbanRuleTypologyClick;
window.handleReparcellizationAlgorithmClick = handleReparcellizationAlgorithmClick;
window.applyContiguityConstraints = applyContiguityConstraints;
window.populateProposalAuthorUI = populateProposalAuthorUI;
window.getProposalAuthorValue = getProposalAuthorValue;
window.getSelectedProposalTool = getSelectedProposalTool;
window.buildGeometryFromParcels = buildGeometryFromParcels;
window.getCurrentParcelSelectionContext = getCurrentParcelSelectionContext;

document.addEventListener('blockifyModalOpened', () => setProposalModalDimmed(true));
document.addEventListener('blockifyModalClosed', () => setProposalModalDimmed(false));
document.addEventListener('urbanRuleModalOpened', () => setProposalModalDimmed(true));
document.addEventListener('urbanRuleModalClosed', () => setProposalModalDimmed(false));

/**
 * Find the visible descendant proposal by traversing down from a proposal
 * until we find one whose child parcels are actually visible on the map
 * (i.e., they have no further descendant proposal markers).
 * 
 * @param {string} proposalId - The starting proposal ID
 * @returns {string|null} - The proposal ID whose children are visible, or the original if none found
 */

/**
 * Calculate and return bounds for the visible descendant of a proposal.
 * Simply uses the child parcels of the visible descendant - no recursive collection.
 * @param {string} proposalId - The proposal ID to calculate bounds for
 * @returns {L.LatLngBounds|null} Leaflet bounds or null
 */



// Check if parcels have NFTs on Solana

// Check if parcels have NFTs on-chain

// Show modal for wallet not connected

// Show modal for missing parcel NFTs

// Show modal when on-chain minting fails and ask whether to proceed in-memory

// Create proposal from dialog






















// Backwards compatibility for existing helpers


if (typeof window !== 'undefined') {
    window.resolveStructureProposal = resolveStructureProposal;
}















if (typeof window !== 'undefined') {
    window.getProposalLifecycleKey = getProposalLifecycleKey;
    window.getProposalLifecycleLabel = getProposalLifecycleLabel;
    window.getProposalLifecycleClass = getProposalLifecycleClass;
    window.getParcelAreaById = getParcelAreaById;
}









// Build the small thumbnail markup shown on each proposal card. Returns '' when the proposal's goal
// has no meaningful map screenshot (urban-rule, ownership-transfer, decide-later, etc.).

if (typeof window !== 'undefined') {
    window.buildProposalThumbHtml = buildProposalThumbHtml;
}



// Debounce filter input renders so typing doesn't drop input focus mid-keystroke.






// Show proposal list dialog

// Switch between proposal tabs (legacy helper retained for backwards compatibility)

// Close proposal list dialog

// Update proposal list (if open)

// Update the "Proposals List" button text with current count

// Proposals section no longer has a checkbox - this function is kept for compatibility
// but does nothing since proposals are always shown





// Determine if proposal-specific UI is active (Proposal List open or Parcel Details showing a proposal)

// Expose helper
window.isProposalUIActive = isProposalUIActive;

// Delete a single proposal

// Center map on proposal (unified function)

// Clear all proposals from PersistentStorage


if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseProposalStorage);
} else {
    initialiseProposalStorage();
}

// Re-render proposal list when language or translations load so modal text updates live

try {
    if (typeof window !== 'undefined') {
        if (window.i18n && typeof window.i18n.onChange === 'function') {
            window.i18n.onChange(rerenderProposalListIfOpen);
        }
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('i18n:translationsLoaded', rerenderProposalListIfOpen);
        }
    }
} catch (_) { }

/**
 * Handle multi-select checkbox change with mutual exclusivity
 */

/**
 * Handle show proposals checkbox change with mutual exclusivity
 */

/**
 * Helper function to enable show proposals mode and clear multi-selection
 * This ensures consistent behavior across all places that enable show proposals
 */

// Sharing constants (SHARE_URL_MAX_LENGTH, SHARE_PAYLOAD_VERSION, etc.)
// are defined in proposals/sharing.js which is loaded after this file.
















if (typeof window !== 'undefined') {
    window.checkParcelsOriginal = checkParcelsOriginal;
}


/**
 * Get the serial ID (numeric database ID) for a proposal, if available.
 * Returns null if only a hash is available (hashes should not be used in share links).
 */





// Share helper for Proposal Details: always prefer the proposal currently shown
window.shareProposalFromDetails = shareProposalFromDetails;

// Focused dialog used as a gate before the 3D walk-mode launcher: lists every
// applied proposal that does not yet have a numeric server-side ID, lets the
// user upload one-by-one or all-at-once, and auto-closes + fires `onComplete`
// the moment the list is empty so the walk pick can start without an extra click.

if (typeof window !== 'undefined') {
    window.showWalkUploadGateModal = showWalkUploadGateModal;
}


/**
 * True only when a proposal is marked applied AND its listed descendants are actually on the map.
 *
 * This matters for the /proposals/:id deep-link flow: a proposal can sit in localStorage with
 * status=applied from a prior session, but on a fresh page load parcelLayerById starts empty
 * and the descendants exist only as ids in the stored proposal. In that state, treating the
 * proposal as "already applied" causes handleSharedPlanRoute to skip apply entirely — the
 * descendants never materialize. Callers on the apply-gating path should use this helper
 * instead of isProposalCurrentlyApplied so the short-circuit only fires when there is
 * actually nothing to do.
 */





// Note: Do not normalize parcel IDs here; suffixes carry semantic meaning in this dataset

// Simple HTML escape to safely insert dynamic strings into innerHTML

// PARCEL_NUMBER_PROPERTY_CANDIDATES is defined in proposals/sharing.js





















// URL-driven 3D mode (e.g. ?mode3d or ?3d=1). We keep it here (near share/deep-link handlers)
// so proposal-loading flows can enter 3D after the map has been focused.





















// Show a modal that displays the fully decoded shared payload and allows selecting proposals to apply




// Intentionally a no-op to avoid camera movement during shared apply




/**
 * Ensures ancestor parcels are fetched and available for a proposal.
 * This is needed for ALL proposal types, not just roads.
 * Returns the list of ancestor parcel IDs that were fetched.
 */

/**
 * Ensures parentParcelIds are set on road proposals.
 * The geometries will be fetched by ID when needed by the reconstruction algorithm.
 */





// Make functions available globally
window.requirePersonalizedUser = requirePersonalizedUser;
window.showProposalDialog = showProposalDialog;
window.closeProposalDialog = closeProposalDialog;
window.createProposal = createProposal;
window.showAllProposalsModal = showAllProposalsModal;
window.switchProposalTab = switchProposalTab;
window.closeProposalList = closeProposalList;
window.showProposalDetailsModal = showProposalDetailsModal;
window.updateShowProposalsButton = updateShowProposalsButton;
window.updateProposalLayer = updateProposalLayer;
window.toggleExpiryInput = toggleExpiryInput;
window.toggleDecayInput = toggleDecayInput;
window.calculateDecayedOffer = calculateDecayedOffer;
window.getDecayProgress = getDecayProgress;
window.initializeDecayCountdown = initializeDecayCountdown;
window.isProposalExpired = isProposalExpired;
window.checkAndUpdateProposalExpiry = checkAndUpdateProposalExpiry;
window.initializeExpiryCountdown = initializeExpiryCountdown;
window.clearLocalProposalData = clearLocalProposalData;
window.centerOnProposal = centerOnProposal;
window.reapplyProposalHighlights = reapplyProposalHighlights;
window.selectProposalFromList = selectProposalFromList;
window.cancelMultiParcelSelection = cancelMultiParcelSelection;
window.deleteProposal = deleteProposal;
window.handleMultiSelectChange = handleMultiSelectChange;
window.handleShowProposalsChange = handleShowProposalsChange;
window.enableShowProposalsMode = enableShowProposalsMode;
window.refreshProposalData = refreshProposalData;
window.selectAndHighlightProposal = selectAndHighlightProposal;
window.calculateProposalBounds = calculateProposalBounds;
window.shareAppliedProposals = shareAppliedProposals;













window.addEventListener('load', () => {
    // A ?city= link is simply obeyed now (each city has its own local store, so nothing is lost),
    // which means the map on screen already matches the link. A proposal that belongs to a
    // *different* city is caught inside handleSharedPlanRoute, from the proposal's own city field.
    setTimeout(() => handleProposalRouteFromUrl(), 100);
    setTimeout(() => handleSingleProposalShareFromUrl(), 200);
    setTimeout(() => handleSharedProposalsFromUrl(), 250);
    setTimeout(() => handleStandalone3DModeFromUrl(), 500);
    // Initialize proposals indicator at startup
    setTimeout(() => { try { syncProposalsIndicator(); } catch (_) { } }, 300);
});

// Handle selection of a proposal from the multiple proposals list

// Cancel multi-parcel selection

/**
 * Coalesced repaint of the currently-selected proposal's highlights. Used by every event
 * that can change which parcels need to be drawn or which descendants now exist on the map:
 * pan/zoom (moveend/zoomend), and parcel ingest completion (parcelDataLoaded). One handle
 * for all sources, so a burst of events causes one repaint, not N.
 */


// Set up map event listeners to reapply multi-parcel highlights AND proposal highlights after move/zoom.
// Same handler for both — a single coalesced repaint of whatever overlay is currently active.

// Try to set up listeners immediately, or retry until map is available
if (!setupMultiParcelHighlightListeners()) {
    document.addEventListener('DOMContentLoaded', function () {
        let attempts = 0;
        const maxAttempts = 20;
        const interval = setInterval(() => {
            if (setupMultiParcelHighlightListeners() || ++attempts > maxAttempts) {
                clearInterval(interval);
            }
        }, 200);
    });
}

// Accept proposal function (for specific parcel) - pure data function


// Accept proposal function (for specific parcel)

// Reject proposal function (for specific parcel)


// Ensure this runs after the main DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Proposals are always shown now, no checkbox event listener needed

    // Initialize the show proposals button count
    updateShowProposalsButton();
});

// Helper function to check if the active element is an editable field (input, textarea, etc.)

// Keyboard shortcut handler for 'C' key to open Create Proposal modal



// Attach the 'C' key shortcut on DOM ready
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachCreateProposalHotkey, { once: true });
    } else {
        attachCreateProposalHotkey();
    }
}

// Make objects globally available
window.proposalStorage = proposalStorage;
window.multiParcelSelection = multiParcelSelection;
window.getProposalOwnerAcceptanceState = getProposalOwnerAcceptanceState;
window.buildOwnerAcceptanceSectionHtml = buildOwnerAcceptanceSectionHtml;
window.handleUserRejectProposal = handleUserRejectProposal;
window.handleProposalParcelClick = handleProposalParcelClick;
window.openProposalBoostDialog = openProposalBoostDialog;
window.submitProposalBoost = submitProposalBoost;
window.closeProposalBoostDialog = closeProposalBoostDialog;

// Ensure count is correct once DOM is ready
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
    });
}

// --- Cross-module coordination ---
// When fresh parcel data arrive, restore whichever visual layers are currently active
window.addEventListener('parcelDataLoaded', async () => {
    // Background hydration finished a chunk — repaint the currently-selected proposal so any
    // newly-arrived ancestor parcels show up in highlights / lazy ancestor list. Coalesced.
    scheduleHighlightRefresh('parcels-loaded');

    // 1) Auto-apply executed and applied proposals to ensure parent parcels are removed and child parcels are clickable
    // This is critical: without this, parent parcels remain on the map and block child parcel clicks
    // applyProposal is idempotent - it checks the roadProposal's applied flag and returns early if already applied
    if (typeof proposalStorage !== 'undefined' && typeof ProposalManager !== 'undefined' && typeof ProposalManager.applyProposal === 'function') {
        try {
            const allProposals = proposalStorage.getAllProposals();
            const isAppliedLike = (p) => {
                if (!p) return false;
                if (isApplied(p)) return true;
                return ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
                    .some(key => p[key] && isApplied(p, p[key]));
            };

            // Filter for both executed and applied proposals (roads, buildings, structures, reparcellizations, etc.)
            const proposalsToRestore = allProposals.filter(isAppliedLike);

            // Drop ancestor proposals when any of their children are already applied/executed in the same restore set
            const proposalsById = new Map();
            proposalsToRestore.forEach(p => {
                const key = getProposalKey(p);
                if (!key) return;
                proposalsById.set(String(key), p);
            });

            const restoreCandidates = proposalsToRestore.filter(p => {
                const id = getProposalKey(p);
                if (!id) return false;
                const children = Array.isArray(p.childProposalIds)
                    ? p.childProposalIds.map(c => String(c)).filter(c => proposalsById.has(c))
                    : [];
                const hasAppliedChild = children.some(childId => {
                    const child = proposalsById.get(childId);
                    return child && isAppliedLike(child);
                });
                return !hasAppliedChild;
            });

            const toposortAppliedProposals = (list) => {
                const proposalMap = new Map();
                const indegree = new Map();
                const edges = new Map();

                list.forEach(p => {
                    const key = getProposalKey(p);
                    if (!key) return;
                    const id = String(key);
                    proposalMap.set(id, p);
                    if (!indegree.has(id)) indegree.set(id, 0);
                });

                // Skip ancestors that already have an applied/executed descendant in the same set
                const idSet = new Set(proposalMap.keys());
                const memoHasDesc = new Map();
                const hasAppliedDescendant = (id, visiting = new Set()) => {
                    if (!id || visiting.has(id)) return false;
                    if (memoHasDesc.has(id)) return memoHasDesc.get(id);
                    visiting.add(id);
                    const proposal = proposalMap.get(id);
                    const children = Array.isArray(proposal?.childProposalIds)
                        ? proposal.childProposalIds.map(c => String(c)).filter(c => idSet.has(c))
                        : [];
                    const result = children.some(childId => isAppliedLike(proposalMap.get(childId))
                        || hasAppliedDescendant(childId, visiting));
                    visiting.delete(id);
                    memoHasDesc.set(id, result);
                    return result;
                };

                Array.from(proposalMap.keys()).forEach(id => {
                    if (hasAppliedDescendant(id)) {
                        proposalMap.delete(id);
                        indegree.delete(id);
                    }
                });

                proposalMap.forEach((proposal, id) => {
                    const children = Array.isArray(proposal.childProposalIds)
                        ? proposal.childProposalIds.map(c => String(c)).filter(c => proposalMap.has(c))
                        : [];
                    edges.set(id, children);
                    children.forEach(child => indegree.set(child, (indegree.get(child) || 0) + 1));
                });

                const queue = Array.from(indegree.entries())
                    .filter(([, deg]) => deg === 0)
                    .map(([id]) => id);
                const orderedIds = [];

                while (queue.length) {
                    const id = queue.shift();
                    orderedIds.push(id);
                    (edges.get(id) || []).forEach(child => {
                        const next = (indegree.get(child) || 0) - 1;
                        indegree.set(child, next);
                        if (next === 0) queue.push(child);
                    });
                }

                const unresolved = Array.from(proposalMap.keys()).filter(id => !orderedIds.includes(id));
                const finalOrder = orderedIds.concat(unresolved);
                return finalOrder.map(id => proposalMap.get(id)).filter(Boolean);
            };

            const orderedProposals = toposortAppliedProposals(restoreCandidates);

            // Precondition: don't try to apply a proposal if its prerequisite parcels aren't loaded.
            // For road proposals especially, applying with missing parents emits a wall of
            // `Invalid inputs to calculateChildFeatures` / `expected N child parcels but generated 0`
            // errors. We'd rather skip silently and let the proposal apply later when parents arrive,
            // or stay unapplied until the user explicitly retries.
            const arePrerequisitesAvailable = (proposal) => {
                const parentIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
                if (parentIds.length === 0) return true; // nothing to check (e.g. Decide later with no parents)
                if (typeof parcelLayer === 'undefined' || !parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
                    return false;
                }
                const found = new Set();
                parcelLayer.eachLayer(layer => {
                    const id = (typeof getParcelIdFromFeature === 'function')
                        ? getParcelIdFromFeature(layer && layer.feature)
                        : null;
                    if (id) found.add(String(id));
                });
                // All parents must be on the map. Partial availability still produces the noisy
                // `expected N but generated <N` failure, so require complete parent presence.
                return parentIds.every(id => found.has(String(id)));
            };

            let appliedCount = 0;
            let skippedForMissingPrereqs = 0;
            for (const proposal of orderedProposals) {
                if (!proposal || !proposal.proposalId) continue;
                if (!arePrerequisitesAvailable(proposal)) {
                    skippedForMissingPrereqs++;
                    continue;
                }
                try {
                    // This will remove parent parcels if they exist and add child parcels, ensuring everything is restored correctly
                    const result = await ProposalManager.applyProposal(proposal.proposalId);
                    if (result !== false) {
                        appliedCount++;
                    }
                } catch (error) {
                    console.warn('Failed to auto-apply proposal on parcel data load:', proposal.proposalId, error);
                }
            }
            if (skippedForMissingPrereqs > 0) {
                console.debug(`[parcelDataLoaded] Skipped ${skippedForMissingPrereqs} proposal(s) — parent parcels not (yet) on the map.`);
            }

            // Restored roads are corridor parcels again; redraw their cross-sections over them.
            if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh();

            if (appliedCount > 0) {
                setTimeout(() => {
                    if (typeof parcelLayer !== 'undefined' && parcelLayer) {
                        parcelLayer.eachLayer(layer => {
                            if (!layer || !layer.feature || !layer.feature.properties) return;
                            const parcelId = getParcelIdFromFeature(layer.feature);
                            if (!parcelId) return;

                            const hasClickHandler = layer._events && layer._events.click && layer._events.click.length > 0;
                            if (!hasClickHandler && typeof window.onEachFeature === 'function') {
                                try {
                                    window.onEachFeature(layer.feature, layer);
                                } catch (error) {
                                    console.warn('Failed to attach handlers to parcel after proposal apply:', parcelId, error);
                                }
                            }

                            if (layer.options) {
                                layer.options.interactive = true;
                            }
                            if (typeof layer.setInteractive === 'function') {
                                layer.setInteractive(true);
                            }
                            if (typeof layer.bringToFront === 'function') {
                                layer.bringToFront();
                            }
                        });

                        if (typeof parcelLayer.bringToFront === 'function') {
                            parcelLayer.bringToFront();
                        }
                    }
                }, 100);
            }
        } catch (error) {
            console.warn('Error auto-applying executed proposals on parcel data load:', error);
        }
    }

    // 2) Proposals are always shown now, so always update proposal layer
    if (typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    // 3) If a single parcel is selected (parcel mode), restore its highlight
    if (window.selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
        const layer = parcelLayer.getLayers().find(l => {
            const candidateId = getParcelIdFromFeature(l?.feature);
            return candidateId && candidateId.toString() === window.selectedParcelId.toString();
        });
        if (layer) {
            const isTrackSelected = (layer?.feature?.properties?.isTrack === true) || Boolean(layer?._trackStyle);
            if (isTrackSelected) {
                const styleFn = typeof getParcelStyle === 'function' ? getParcelStyle : getParcelBaseStyle;
                const trackStyle = styleFn ? styleFn(window.selectedParcelId, layer, { isTrack: true }) : (trackStyle || {});
                layer.setStyle({ ...trackStyle, weight: 4 });
            } else if (typeof selectedParcelStyle !== 'undefined') {
                layer.setStyle(selectedParcelStyle);
            }
            layer.bringToFront();
        }
    }

    // 4) If block layer logic needs refresh it can listen separately; we keep focus on proposals/selection here
});




window.formatProposalOfferValue = formatProposalOfferValue;
window.handleProposalOfferInput = handleProposalOfferInput;
window.parseProposalOfferValue = parseProposalOfferValue;
