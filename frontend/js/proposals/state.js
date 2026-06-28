// proposals/state.js — shared mutable state for the proposals subsystem.
// Extracted from proposals.js. Loaded FIRST (before all other proposal modules) so every module
// reads/writes these bindings by bare name via the shared classic-script global lexical scope.

let _parcelRecordWriteCache = null; // Map<parcelId, record> when caching is enabled

let currentProposalPreviewId = null;

let currentProposalDetailsContext = null;

let proposalLayer = null;

let originalOnParcelClick = null;

let proposalDetailsEscapeHandler = null;

let currentOwnershipTransferDirection = 'to-me';

let currentProposalTool = null;

let currentGeometryGoal = null;

let proposalGeometrySubmitted = false;

let proposalAcquisitionLabels = {
    full: 'Full acquisition',
    partial: 'Partial acquisition',
    partialPreferred: 'Partial acquisition preferred'
};

let currentOwnershipMode = 'multiple';

let proposalModalScreenshotDataUrl = null;

let proposalModalScreenshotPromise = null;

let proposalDialogOverrides = null;

let pendingRoadDrawingProposal = null;

let pendingConstrainedCorridor = null;

let constrainedCorridorState = null;

let proposalSingleParcelSelection = false; // Merge needs ≥2 parcels; set per dialog

let reparcellizationModulePromise = null;

let teardownProposalBalanceWatcher = null;

let proposalBalanceRequestSeq = 0;

let addressesJsonCache = null;

let addressesJsonPromise = null;

let expiryCountdownInterval = null;

let decayCountdownInterval = null;

let _proposalListFilterInputDebounceTimer = null;

let url3DModeHandled = false;

let singleProposalShareHandled = false;

let sharedProposalsHandled = false;

let proposalLoadOverlay = null;

let proposalLoadStatusEl = null;

let proposalLoadTitleEl = null;

let proposalLoadBytesEl = null;

let proposalLoadBytes = 0;

let proposalLoadProgressTextEl = null;

let proposalLoadProgressBarEl = null;

let proposalLoadProgressFillEl = null;

let proposalLoadProgressDone = 0;

let proposalLoadProgressTotal = 0;

let _proposalHighlightRefreshHandle = null;

let createProposalHotkeyAttached = false;
