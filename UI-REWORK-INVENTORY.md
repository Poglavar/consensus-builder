# Sidebar inventory (baseline for the new-ui rework)

Snapshot of what the left sidebar wires, taken before the rework (line numbers are from that
snapshot and drift). Read with `UI-REWORK.md`.

Key facts:
- Nearly all sidebar controls use inline onclick/onchange calling globals; JS finds elements by id.
  Moving a control is safe if it keeps its id, EXCEPT: `.ownership-type-checkbox` (by class),
  `[data-site-intro-open]`, `button[onclick="countBlocks()"]`-style selectors in
  `updateBlockButtonStates`, and `.accordion-section[data-section=…]` (city disabledSections,
  game.js:571, three-mode.js:5978, area-monitor/routing.js:100, proposals/server-sync.js:275).
- City switch is always a full reload (`navigateToCity` sets ?city= and assigns location.href).
- Sidebar open/closed = `#sidebar.collapsed` + `body.sidebar-collapsed`; never persisted; <768px
  starts collapsed. ~20 readers (below).
- No address search/geocoder exists. Searches: parcel Locate box, proposal list filter, activity filter.

## 1. Sidebar contents (index.html #sidebar)

Sidebar logic: js/sidebar-management.js — toggleAccordion, updateSectionControlsState,
toggleSectionExpansion, toggleButtonAccordion, toggleSidebar, updateSidebarToggleButtonPosition,
setSidebarDisabled, toggleDebugMode, wipeLocalData, toggleBlocksVisibility, toggleLayer,
updateBlockButtonStates, initializeSidebar (called from index.html boot), updateParcelsCheckboxByZoom,
a DOMContentLoaded handler (auto-collapse <768px, forces showProposedBuildings on).

- Header: logo/title, AI badge, avatars (static). #toggle-sidebar-mobile → toggleSidebar().
  Badges #dev-badge #debug-badge #version-badge: environment.js updateBadgeVisibility; .sidebar-badge-bar
  hidden unless body.debug-mode. No click handlers.
- City row: #city-select (city-config.js populateCitySelect → handleCitySelectChange → switchCity;
  buildCityDropdown inserts a custom .city-dropdown before the hidden native select);
  #detect-city-button (setupDetectCityButton: geolocation → findNearestCity → setStoredCityId → reload).
- Data (data-section="data"): #data-source-select (data-source.js initDataSourceUI; confirm+wipe;
  PersistentStorage cb_data_source); #tile-source-select (basemap.js initBasemapSelector via
  map-core.js; cb_base_map; label hard-coded "Base map:"); #wipeLocalDataButton → wipeLocalData().
- Game (#game-section, data-section="game"): #gameCheckbox (data-layer="game", toggleAccordion; stops
  loop), #game-datetime, #game-turns (gameState.updateGameUI), #turn-interval-slider/#turn-interval-value
  (updateTurnInterval/updateTurnIntervalDisplay), #turn-progress-fill/#turn-progress-time
  (updateProgressBar), #game-play-pause-btn (toggleGamePlayPause), New Game button (resetGameState(true)),
  #show-game-log-btn (showGameLogDialog()), #show-agents-btn (showGameLogDialog({view:'actors'}),
  label by updateAgentsButton). Title by updateGameSectionTitle (queries .accordion-section[data-section="game"]).
- Proposals (data-section="proposals"): #showProposalsButton (showAllProposalsModal, count via
  list-ui.js updateShowProposalsButton and server-sync.js), #planStatsButton (plan-stats.js listener),
  #roosterScoreButton (grain-score.js listener), #mintedProposalsButton (openMintedProposalsModal; shown
  only with wallet), #shareAppliedProposalsButton (shareAppliedProposals; busy spinner; disabled when
  nothing applied), Clear Proposals (clearLocalProposalData). server-sync.js syncProposalsIndicator reads
  the section.
- Parcels (data-section="parcels"): #locateParcelInput/#locateParcelButton/#locateParcelError
  (parcels/ui/locate.js), #parcelsCheckbox (data-layer="parcels"; zoom-gated by
  updateParcelsCheckboxByZoom from map-core), #showAdParcelsCheckbox, #showParcelNumbers,
  #showOwnerCounts, #showProposalCounts, #showClaimsCounts (disabled), #markMintedCheckbox, ownership
  highlight checkboxes (#highlightOwnershipGovernment/Institution/Company/Private, found by class
  .ownership-type-checkbox + data-ownership-type; their swatches are the legend), #parcels-in-view,
  #showParcelCoverageButton, #refreshParcelDataButton, Clear parcel data (clearLocalParcelData).
- Blocks (data-section="blocks"): #parcelBlocksCheckbox (toggleBlocksVisibility; read widely:
  building-blocks, parcel-blocks, parcels/styles, map-refresh, parcel-selection, parcels/selection,
  details-panel), #showBlockNames, #showParksCheckbox, #showSquaresCheckbox; buttons countBlocks,
  animateFloodfillFromSelected, #showBlockListButton (showBlocksList), clearBlocks (updateBlockButtonStates
  finds them by onclick selector); #blocks-list-container/#blocks-content; #parcels-counted.
- Stations (data-section="stations"): buttons data-station-type → startTransitStationPlacement(type),
  Cancel → cancelTransitStationPlacement; #station-placement-status. Duplicated in the parcel build palette.
- Buildings (data-section="buildings"): #showBuildings, #showBuildingsDgu, #showBuildingsOsm,
  #showProposedBuildings → toggleLayer(...). Read by map-core, parcels/controller, three-mode,
  road-drawing (switches off/restores while drawing), building-blocks, proposals/apply/buildings.
- Roads (data-section="roads"): #detectExistingRoadsButton → detectExistingRoads (setSidebarDisabled);
  drawOSMRoads, detectRoadsFromOSM, drawGUPRoads, detectRoadsFromGUP, drawWFSRoadParcels,
  detectRoadsFromWFS, clearDetectedRoads; detectRoadsUsingAI()/algorithmicRoads() DO NOT EXIST (buttons
  permanently disabled); #showGovernmentRoadPlan, #applyGovernmentRoadPlanButton (government-roads.js;
  area-monitor/ui.js reads the checkbox); line toggles #showOSMRoadLines, #showGUPRoadLines,
  #showWFSPolygons, #showLegacyRoadCenterlines; #progressContainer/#progressFill/#progressText;
  #analyzeAllRoadsButton → analyzeAllOSMRoadSegmentsInView (reveals #road-analysis-toggle/
  #toggleRoadAnalysisResults, #road-legend-title/#road-legend, opens #osm-road-segment-list-popup);
  #legend-min-0..5/#legend-max-0..4 read by getLegendValue.
- Area monitor (data-section="areaMonitor", button accordion header): #amCityPlanToggle/#amCityPlanLabel,
  #areaMonitorDrawButton, #areaMonitorFromPlanButton, #areaMonitorUploadButton (disabled),
  #areaMonitorListButton. area-monitor/routing.js expandAreaMonitorSection opens it (only when sidebar open).
- Measurement: #measureButton (toggleMeasureTool), #pinpointButton (togglePinpointTool),
  #clearMeasurementsButton (clearAllMeasurements).
- Information: contact/about links (sidebar.info.*, some data-i18n-attr="html"), [data-site-intro-open]
  (site-intro.js), #debugModeCheckbox (toggleDebugMode; default on in development; building-blocks reads
  it; debug mode adds body.debug-mode, shows badges, floating-status (only when sidebar collapsed),
  .debug-only-control).
- Status bar: #status (updateStatus in ui-helpers.js mirrors into #floating-status-text; written directly
  by road-analysis, road-detection, road-drawing; MutationObserver on #status), #status-log-expanded
  (click .status-bar → toggleStatusExpanded; Copy all / Open log → #status-log-modal).
- #toggle-sidebar-desktop (outside #sidebar) → toggleSidebar(); left 10px/330px.

Per-city `sidebar.disabledSections` (city-config.js): zagreb none; split, sibenik, belgrade,
buenos_aires, colorado, new_york ['parcelBlocks','buildings','roads','areaMonitor']; ljubljana
['buildings','roads','areaMonitor']. applySidebarConfiguration() runs from initializeSidebar and on
every sidebar expand: parcelBlocks unchecks+disables #parcelBlocksCheckbox and hides the blocks section;
others hide .accordion-section[data-section=<name>]. getFeatureConfig/SECTION_TO_FEATURE_MAP;
applyFeatureVisibility hides [data-feature] (none exist). isFeatureEnabled('roadTools') used by
parcels/ui/proposal-actions.js (hides Road/Track in the build palette).

Sidebar-state readers: map.css --map-mode-stack-left (330px / 10px) and --map-mode-strip drive mode
buttons, scale bar, ai-scene.css, photoreal-mode.css, utilities.css; sidebar.css
`#sidebar:not(.collapsed) ~ #map-container .leaflet-top.leaflet-left { left:350px }`; mobile username
and Leaflet controls (sidebar.css, game.css); floating status (utilities.css); proposals.css
body.share-plan-mode #sidebar inert; sidebar.css body.app-loading boot gate. JS: agent-bubbles.js
(subtracts 320px; also calls toggleSidebar), game.js, three-mode.js disableSidebarFor3D/
enableSidebarAfter3D and enter3D collapse, map-core.js (wraps window.toggleSidebar →
updateMapDimensions subtracting 320px), road-drawing.js, area-monitor/routing.js + ui.js,
proposals/core.js (collapseSidebar option), proposals/dialog-share.js, grain-score.js, list-ui.js,
road-detection.js setSidebarDisabled, government-roads.js (commented out).

## 3. Floating UI already on the map

Mode buttons (index.html ~1023; fixed slot table map.css; test map-mode-stack.test.js enforces unique
slots; lazy 3D shim loads the 3D stack on first click): #mode-2d-toggle/#mode-3d-toggle (three-mode.js),
#mode-realistic-toggle (photoreal-mode.js), #mode-ai-toggle (ai-scene.js; 3D only), #mode-walk-toggle
(hidden unless city walk.url). #cadastre-view-toggle (proposals/claims-ui.js; body.cadastre-view).
#floating-status (shown only in debug mode with sidebar collapsed). #username-display
(user-management.js; welcome modal / agent dialog).
#parcel-info-panel (right dock): showParcelInfoPanel parcels/ui/parcel-panel.js / hideParcelInfoPanel;
tabs via switchParcelTab: Info (#multiSelectCheckboxInfo, Detect block, #info-content), Proposals
(#proposals-content → #parcel-proposal-primary-actions = the build palette rendered by
renderParcelProposalActions in parcels/ui/proposal-actions.js: Reparcel; Urban rules Block/Row/Detached;
Structures Freeform/Park/Square/Lake; Transport Road/Track/bus/tram/metro/elevated; Ownership Offer),
Tools (#parcelMintStatus, #mintAndClaimButton, #claimButton, #parcelBuilderButton, #visualizeButton,
#neighboursButton, #verticesButton, #analyzeRoadButton, #measureAsRoadButton).
#proposal-details-panel (showProposalInfo via selectAndHighlightProposal). #block-info-panel
(showBlockInfo/hideBlockInfo). #road-info-panel (road-drawing.js). #road-analysis-panel.
#osm-road-segment-list-popup. Proposal browse list = .proposal-list-modal from showAllProposalsModal
(dialog-share.js; sets window.proposalListBrowseMode; collapses sidebar; filters
#proposal-filter-author/#proposal-filter-search). Share-plan panel (body.share-plan-mode). Drill panel
(window.__drillUi). Modals: #site-intro-modal, #version-modal, #welcome-modal, #logout-modal,
#track-speed-modal, #parcel-coverage-modal, #status-log-modal (#locate-parcel-modal looks unused).
JS dialogs: .game-log-modal (activity explorer), plan stats, grain score, minted proposals, area monitor
list, showProposalDialog (dialog-create.js), agent dialog, .cb-confirm-overlay (showStyledConfirm/
Alert/Choice in city-config.js), city-switch dialog.

## 4. Parcel click chain

parcels/selection.js onEachFeature binds click → window.onParcelClick (parcels/ui/parcel-selection.js):
early returns for measure mode, parcel drawing, edit lock, structure editor, area-monitor paint, stale
layer; sharePlanMode → __sharePlanPickProposal; proposalListBrowseMode → selectAndHighlightProposal;
hides open proposal-details; Shift+click enables multi-select (seed = current parcel); while
multi-select active → multiParcelSelection.toggleParcel(layer); Escape exits. Then
__drillUi.handleParcelClick (proposal on top wins). Then showParcelInfoPanel(feature); sets
window.selectedParcelId, window.currentParcel; blocks checkbox → highlightAndCenterBlock; applied
non-road proposal on the parcel → selectAndHighlightProposal(..., collapsed details).
Map background: drill-ui.js onMapClick, map-core.js. multiParcelSelection (proposals/data.js): toggle,
clearSingleParcelSelection, toggleParcel, clearSelection, findParcelById, reconcileWithFabric, updateUI,
showMultiParcelInfo (writes into the parcel panel), hideParcelInfo, updateCreateProposalButton (targets a
removed #createProposalButton), selectBlockLayers. Proposal creation starts only from the build palette:
startParcelBuildTool, startParcelTransportTool, offer → showProposalDialog({ownershipOnly:true}).

## 5. City

city-config.js: DEFAULT_CITY_ID='new_york'; determineCurrentCityId: ?city= (codes ba, bg, zg, st, si,
lj, co, ny or full id) → localStorage cb_current_city (PersistentStorage fallback) → default; ?city=
is persisted. PersistentStorage.setScope(cityId) = separate IndexedDB per city. City default language
applied unless stored or ?lang=. maybeApplyGeoDefaultCity disabled. switchCity(id,{requireConfirmation})
flushes drafts, confirms, navigateToCity(id) → reload. setCurrentCityId/setStoredCityId dispatch
cityChanged. Shared links: proposals/core.js ensurePlanCity; sharing-routes.js;
city-switch-prompt.js promptCityMismatchForProposal; /parcel/<id> routes (parcels/route.js); area
monitor routing. Cities: zagreb, split, sibenik, belgrade, ljubljana, buenos_aires, colorado, new_york.

## 6. Search

Locate: parcels/ui/locate.js → CadastralParcelRepository.ensureIds([value]) → selectParcel(id);
transport parcels/fetch.js fetchByIds (HR backend /parcels/parcelIds?ids=, OSS WFS, per-city
/parcel-ba?smp=, /parcel-bg, /parcel-co, /parcel-lj, /parcel-nyc). Proposals: client filter in the
browse list; server GET /proposals/summary?limit&offset&q= (ILIKE name/title/author). Activity:
search in the game-log dialog. No geocoder.

## 7. Game (js/game.js)

gameState (isRunning, currentDateTime +1 week/turn, currentTurn, gameLog, turnIntervalSeconds,
turnStartTime; PersistentStorage consensus_game_state). Globals: initializeGame, startGameLoop,
stopGameLoop, executeGameTurn, toggleGamePlayPause, resetGameState (native confirm), showGameLogDialog
({view, filter}), closeGameLogDialog, setActivityFilter, setActivityView, updateTurnInterval,
updateTurnIntervalDisplay, updateProgressBar, updateAgentsButton, updateGameSectionTitle,
dispatchAgentAction. Activity explorer .game-log-modal: events/actors views, filters, live feed,
?activity= deep links, [data-activity-scope] click handler.

## 8. CSS

css/sidebar.css (#sidebar absolute 320px z 900; .collapsed left -320px; mobile 100vw z 4000; boot
gate). body flex row (layout.css), column <768px. #map-container flex:1 full width; #map inset 0 → the
map is always full width, sidebar overlays it. Sidebar-dependent rules also in map.css, game.css,
utilities.css, panels.css (right dock --right-dock-width), proposals.css. Breakpoint mostly 768px.

## 9. Tests touching the sidebar (backend/test/)

sidebar-zoom-gating, apply-status-announcements, mobile-layout-contract, grain-score-wiring,
plan-stats-wiring, share-plan-spinner, share-plan-panel-contract, proposal-count-union, status-log-ui,
pinpoint-tool, ownership-palette-single-source, i18n-locale-coverage; index.html script-order tests:
analytics-boot-boundary, frontend-duplicate-globals, ground-sweep, map-mode-stack, map-mode-transition,
proposal-details-readonly, proposal-ground-service, publish-gap, road-finalization-contract,
share-plan-ready-signal, three-building-display, three-keyboard-context, transit-alignments,
hackathon-deck; city: parcel-deep-link-city, plan-city-routing, city-parcel-membership,
data-source-backend-override, frontend-mobile-lang-canton; others: parcel-build-block-suggestion,
transit-stations, ui-copy-feedback, road-drawing-undo-shortcut.

## 10. Script loading

index.html: inline cache-bust bootstrap (writeVersionedLocalScripts appends ?build=<token> via
document.write; CSS gets ?v=), build-info.js, CSS list (base, layout, sidebar, map, panels, modals,
proposals, …, ai-scene), leaflet, reduced-motion.js, proj4, turf, viewport-safe-area, analytics; body;
then shared-utils, persistent-storage, i18n, …, environment, wipe-local-data, city-config.js,
city-switch-prompt, ens; pako; ensureWalletVendors; ~190 app scripts (map-core, user-management,
site-intro, sidebar-management, parcels/*, proposals/*, ui-helpers, …, game, structures, transit-*);
inline DOMContentLoaded boot (after PersistentStorage.ready: initializeUser, initializeNotifications,
initializeSidebar, initializeMapCore, gameState.updateGameUI, initializeVersionHistory,
initBlockchainSync); road/corridor scripts; import map (three 0.184.0 jsDelivr, 3d-tiles-renderer
esm.sh) + window.whenThreeReady(); more scripts; lazy 3D stack loader (__ensure3DModeStack) + mode
shim; area-monitor/*, unsaved-work-guard, boot-ready.js (removes body.app-loading).

## 11. three.js

Not vendored: import map → jsDelivr three@0.184.0. window.whenThreeReady() dynamically imports three,
OrbitControls, GLTFLoader, sets window.THREE, fires threeReady, resolves true/false.
