// ui/commands.js — the command registry: one named entry per capability the map UI offers (what the
// old sidebar held, and later the parcel menu, selection tray and command palette). Each command
// says where it appears (surfaces), when it is available (when) and what it does (run, which calls
// the existing globals or drives the rehoused control). UMD, and no DOM access at module level, so
// backend/test/frontend-ui-commands.test.js can load it headlessly.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UiCommands = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const SURFACES = Object.freeze([
        'layers', 'tools', 'proposals', 'activity', 'settings', 'parcel-menu', 'selection-tray', 'palette', 'ground-menu'
    ]);

    // Every control id the old sidebar held that still exists (rehoused into a sheet). Existing code finds these by id, so the test fails if index.html loses one.
    const REHOUSED_CONTROL_IDS = Object.freeze([
        // Settings sheet
        'dev-badge', 'debug-badge', 'version-badge',
        'data-source-select', 'tile-source-select', 'wipeLocalDataButton',
        'showParcelCoverageButton', 'refreshParcelDataButton',
        'debugModeCheckbox',
        // Activity sheet: the explorer buttons and the Simulation section
        'activity-explorer-button', 'activity-agents-button',
        'gameCheckbox', 'game-datetime', 'game-turns', 'turn-interval-slider', 'turn-interval-value',
        'turn-progress-fill', 'turn-progress-time', 'game-play-pause-btn',
        // Proposals sheet
        'showProposalsButton', 'planStatsButton', 'roosterScoreButton', 'mintedProposalsButton',
        'shareAppliedProposalsButton',
        // Layers sheet: parcels
        'parcelsCheckbox', 'showAdParcelsCheckbox', 'showParcelNumbers', 'showOwnerCounts',
        'showProposalCounts', 'showClaimsCounts', 'markMintedCheckbox',
        'highlightOwnershipGovernment', 'highlightOwnershipInstitution', 'highlightOwnershipCompany',
        'highlightOwnershipPrivate',
        'parcels-in-view',
        // Layers sheet: blocks, buildings, roads
        'parcelBlocksCheckbox', 'showBlockNames', 'showParksCheckbox', 'showSquaresCheckbox',
        'showBuildings', 'showBuildingsDgu', 'showBuildingsOsm', 'showProposedBuildings',
        'showGovernmentRoadPlan', 'showOSMRoadLines', 'showGUPRoadLines', 'showWFSPolygons',
        'showLegacyRoadCenterlines',
        // Tools sheet
        'measureButton', 'pinpointButton', 'clearMeasurementsButton',
        'showBlockListButton', 'blocks-list-container', 'blocks-content', 'parcels-counted',
        'station-placement-status',
        'detectExistingRoadsButton', 'applyGovernmentRoadPlanButton', 'progressContainer', 'progressFill',
        'progressText', 'analyzeAllRoadsButton', 'road-analysis-toggle', 'toggleRoadAnalysisResults',
        'road-legend-title', 'road-legend',
        'legend-min-0', 'legend-max-0', 'legend-min-1', 'legend-max-1', 'legend-min-2', 'legend-max-2',
        'legend-min-3', 'legend-max-3', 'legend-min-4', 'legend-max-4', 'legend-min-5',
        'amCityPlanToggle', 'amCityPlanLabel', 'areaMonitorDrawButton', 'areaMonitorFromPlanButton',
        'areaMonitorUploadButton', 'areaMonitorListButton',
        // Activity sheet + toast
        'status', 'status-log-expanded', 'floating-status', 'floating-status-text'
    ]);

    // ---- run/when helpers. They only touch the DOM through ctx, and only when called. ----

    // Call a page global by name. A missing global is a wiring bug, so it throws rather than no-ops.
    // `run.calls` names the global, so the coverage test can match commands to inline handlers.
    function callGlobal(name, ...args) {
        const run = ctx => {
            const fn = ctx && ctx.global ? ctx.global[name] : undefined;
            if (typeof fn !== 'function') throw new Error(`UiCommands: global ${name}() is not defined`);
            return fn(...args);
        };
        run.calls = name;
        return run;
    }

    // The parcel-data clear lives on window.Parcels.fetch when the parcels modules are loaded, and
    // as a bare global otherwise — the same lookup the button's inline handler does.
    function clearLocalParcelData(ctx) {
        const parcelsFetch = ctx.global.Parcels && ctx.global.Parcels.fetch;
        const fn = (parcelsFetch && parcelsFetch.clearLocalParcelData) || ctx.global.clearLocalParcelData;
        if (typeof fn !== 'function') throw new Error('UiCommands: clearLocalParcelData() is not defined');
        return fn();
    }
    clearLocalParcelData.calls = 'clearLocalParcelData';

    // Click the rehoused control, so the command does exactly what the control does (its inline
    // handler, its listeners, its own disabled state).
    const clickControl = id => ctx => ctx.clickControl(id);
    // Focus an input the palette cannot operate on its own behalf (a select, a slider, a text box):
    // opens the sheet holding it and puts the caret there.
    const revealControl = id => ctx => ctx.revealControl(id);
    const controlAvailable = id => ctx => !ctx || typeof ctx.isControlAvailable !== 'function' || ctx.isControlAvailable(id);

    // Call a method of the map search box (js/ui/map-search.js, window.MapSearch).
    function callSearch(method, ...args) {
        const run = ctx => {
            const api = ctx && ctx.global ? ctx.global.MapSearch : undefined;
            if (!api || typeof api[method] !== 'function') throw new Error(`UiCommands: MapSearch.${method}() is not available`);
            return api[method](...args);
        };
        run.calls = `MapSearch.${method}`;
        return run;
    }

    function detectNearestCity(ctx) {
        const manager = ctx && ctx.global ? ctx.global.CityConfigManager : undefined;
        if (!manager || typeof manager.detectNearestCity !== 'function') {
            throw new Error('UiCommands: CityConfigManager.detectNearestCity() is not defined');
        }
        return manager.detectNearestCity();
    }
    detectNearestCity.calls = 'CityConfigManager.detectNearestCity';

    // A command backed by a rehoused control: available while the control is present, enabled and
    // not hidden by the city config; runs by clicking (toggles, buttons) or revealing (inputs).
    function control(id, spec) {
        return Object.assign({
            control: id,
            when: controlAvailable(id),
            run: spec.kind === 'input' ? revealControl(id) : clickControl(id)
        }, spec);
    }

    // Every command also appears in the palette; `surfaces` lists the other places.
    function command(spec) {
        const surfaces = Array.isArray(spec.surfaces) ? spec.surfaces.slice() : [];
        if (spec.palette !== false && !surfaces.includes('palette')) surfaces.push('palette');
        const out = Object.assign({ when: () => true }, spec, { surfaces });
        delete out.palette;
        return Object.freeze(out);
    }

    // ---- Parcel menu and selection tray ----
    // Which parcel-menu actions apply is decided by ui/parcel-menu-model.js (a page global; a
    // require in node). ctx.parcel is that parcel's facts (ui/parcel-menu.js), absent when no
    // single parcel is in hand — then every parcel command is unavailable, in the palette too.
    function parcelMenuModel() {
        if (typeof globalThis !== 'undefined' && globalThis.ParcelMenuModel) return globalThis.ParcelMenuModel;
        if (typeof require === 'function') return require('./parcel-menu-model.js');
        throw new Error('UiCommands: ParcelMenuModel is not loaded');
    }

    function parcelCommand(action, spec) {
        const run = ctx => {
            const menu = ctx && ctx.global ? ctx.global.ParcelMenu : undefined;
            if (!menu || typeof menu.runAction !== 'function') throw new Error('UiCommands: ParcelMenu.runAction() is not available');
            return menu.runAction(action, ctx.parcel);
        };
        run.calls = `ParcelMenu.runAction:${action}`;
        return Object.assign({
            id: `parcel.${action}`, group: 'parcel', surfaces: ['parcel-menu'],
            when: ctx => !!(ctx && ctx.parcel) && parcelMenuModel().isActionAvailable(action, ctx.parcel),
            run
        }, spec);
    }

    // ---- Ground menu (ui/ground-menu.js) and the site tool (js/site-drawing.js) ----
    // ctx.ground is the ground menu's facts ({ kind, roadToolsEnabled, stationsEnabled }), absent
    // when it is closed — its commands are then unavailable, in the palette too.
    function groundMenuModel() {
        if (typeof globalThis !== 'undefined' && globalThis.GroundMenuModel) return globalThis.GroundMenuModel;
        if (typeof require === 'function') return require('./ground-menu-model.js');
        throw new Error('UiCommands: GroundMenuModel is not loaded');
    }

    function groundCommand(action, spec) {
        const run = ctx => {
            const menu = ctx && ctx.global ? ctx.global.GroundMenu : undefined;
            if (!menu || typeof menu.runAction !== 'function') throw new Error('UiCommands: GroundMenu.runAction() is not available');
            return menu.runAction(action, ctx.ground);
        };
        run.calls = `GroundMenu.runAction:${action}`;
        return Object.assign({
            id: `ground.${action}`, group: 'ground', surfaces: ['ground-menu'], palette: false,
            when: ctx => !!(ctx && ctx.ground) && groundMenuModel().isActionAvailable(action, ctx.ground),
            run
        }, spec);
    }

    // The site tool is idle (not drawing or editing a site) and loaded.
    const siteToolIdle = ctx => {
        const tool = ctx && ctx.global ? ctx.global.SiteTool : undefined;
        return !!(tool && typeof tool.isActive === 'function' && !tool.isActive());
    };

    // ctx.selection = { active, count } of the multi-parcel selection.
    const selectionActive = ctx => !!(ctx && ctx.selection && ctx.selection.active);
    const selectionNonEmpty = ctx => selectionActive(ctx) && ctx.selection.count > 0;

    const DEFINITIONS = [
        // ---- Layers sheet: parcels ----
        control('parcelsCheckbox', { id: 'layers.parcels', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.parcels.showParcels', fallbackLabel: 'Show parcels', icon: 'fas fa-border-all' }),
        control('showAdParcelsCheckbox', { id: 'layers.adParcels', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.parcels.showAdParcels', fallbackLabel: 'Show ad parcels', icon: 'fas fa-bullhorn' }),
        control('showParcelNumbers', { id: 'layers.parcelIds', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.parcels.showParcelNumbers', fallbackLabel: 'Show parcel ids', icon: 'fas fa-hashtag' }),
        control('showOwnerCounts', { id: 'layers.ownerCounts', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.parcels.showOwnerCounts', fallbackLabel: 'Show number of owners (O)', icon: 'fas fa-users' }),
        control('showProposalCounts', { id: 'layers.proposalCounts', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.parcels.showProposalCounts', fallbackLabel: 'Show proposals count (P)', icon: 'fas fa-comment-dots' }),
        control('markMintedCheckbox', { id: 'layers.markMinted', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.parcels.markMinted', fallbackLabel: 'Mark minted', icon: 'fas fa-certificate' }),
        control('highlightOwnershipGovernment', { id: 'layers.ownership.government', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'mapShell.commands.highlightGovernment', fallbackLabel: 'Highlight government parcels', icon: 'fas fa-landmark' }),
        control('highlightOwnershipInstitution', { id: 'layers.ownership.institution', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'mapShell.commands.highlightInstitution', fallbackLabel: 'Highlight institution parcels', icon: 'fas fa-building-columns' }),
        control('highlightOwnershipCompany', { id: 'layers.ownership.company', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'mapShell.commands.highlightCompany', fallbackLabel: 'Highlight company parcels', icon: 'fas fa-briefcase' }),
        control('highlightOwnershipPrivate', { id: 'layers.ownership.private', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'mapShell.commands.highlightPrivate', fallbackLabel: 'Highlight privately owned parcels', icon: 'fas fa-user' }),
        // The search box finds parcels by id (it took over the old Locate input). Parcel-data upkeep
        // (coverage, refresh, clear) is in the Settings sheet's Data & maintenance section, like the
        // other local-storage clears below (blocks, roads, proposals); they keep their group so a
        // city that hides the section hides them.
        { id: 'parcels.locate', group: 'parcels', surfaces: [], run: callSearch('focus'),
            labelKey: 'mapShell.commands.locateParcel', fallbackLabel: 'Locate a parcel by id', icon: 'fas fa-magnifying-glass-location' },
        control('showParcelCoverageButton', { id: 'parcels.coverage', group: 'parcels', surfaces: ['settings'],
            labelKey: 'sidebar.parcels.coverageButton', fallbackLabel: 'Show loaded parcels cover', icon: 'fas fa-table-cells' }),
        control('refreshParcelDataButton', { id: 'parcels.refresh', group: 'parcels', surfaces: ['settings'],
            labelKey: 'sidebar.parcels.refreshButton', fallbackLabel: 'Refresh Parcel Data', icon: 'fas fa-rotate' }),
        { id: 'parcels.clearLocal', group: 'parcels', surfaces: ['settings'], debugOnly: true,
            labelKey: 'sidebar.parcels.clearButton', fallbackLabel: 'Clear Parcel Data From Local Storage', icon: 'fas fa-trash',
            run: clearLocalParcelData },

        // ---- Layers sheet: blocks, buildings, roads ----
        control('parcelBlocksCheckbox', { id: 'layers.blocks', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.blocks.showBlocks', fallbackLabel: 'Show parcel blocks', icon: 'fas fa-th-large' }),
        control('showBlockNames', { id: 'layers.blockNames', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.blocks.showNames', fallbackLabel: 'Block names', icon: 'fas fa-tag' }),
        control('showParksCheckbox', { id: 'layers.parks', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.blocks.showParks', fallbackLabel: 'Parks', icon: 'fas fa-tree' }),
        control('showSquaresCheckbox', { id: 'layers.squares', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.blocks.showSquares', fallbackLabel: 'Squares', icon: 'fas fa-square' }),
        control('showBuildings', { id: 'layers.buildings', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.buildings.showGdi', fallbackLabel: 'GDI buildings (3D model)', icon: 'fas fa-building' }),
        control('showBuildingsDgu', { id: 'layers.buildingsDgu', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.buildings.showDgu', fallbackLabel: 'DGU cadastre (legal reference)', icon: 'fas fa-building' }),
        control('showBuildingsOsm', { id: 'layers.buildingsOsm', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.buildings.showOsm', fallbackLabel: 'OSM buildings (matches the map)', icon: 'fas fa-building' }),
        control('showProposedBuildings', { id: 'layers.proposedBuildings', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.buildings.showProposed', fallbackLabel: 'Show Proposed Buildings', icon: 'fas fa-city' }),
        control('showGovernmentRoadPlan', { id: 'layers.governmentRoadPlan', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.roads.govPlanToggle', fallbackLabel: 'Government road plan', icon: 'fas fa-map' }),
        control('showOSMRoadLines', { id: 'layers.osmRoadLines', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.roads.osmLinesToggle', fallbackLabel: 'OSM road lines', icon: 'fas fa-road' }),
        control('showGUPRoadLines', { id: 'layers.gupRoadLines', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.roads.gupLinesToggle', fallbackLabel: 'GUP road lines', icon: 'fas fa-road' }),
        control('showWFSPolygons', { id: 'layers.dguUsagePolygons', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.roads.dguPolygonsToggle', fallbackLabel: 'DGU usage polygons', icon: 'fas fa-draw-polygon' }),
        control('showLegacyRoadCenterlines', { id: 'layers.roadCentrelines', group: 'layers', kind: 'toggle', surfaces: ['layers'],
            labelKey: 'sidebar.roads.centerlinesToggle', fallbackLabel: 'Existing road centrelines', icon: 'fas fa-grip-lines' }),
        control('toggleRoadAnalysisResults', { id: 'layers.roadAnalysis', group: 'layers', kind: 'toggle', surfaces: ['tools'],
            labelKey: 'sidebar.roads.analysisToggle', fallbackLabel: 'Show road analysis results', icon: 'fas fa-chart-line' }),

        // ---- Tools sheet ----
        control('measureButton', { id: 'tools.measure', group: 'tools', surfaces: ['tools'],
            labelKey: 'sidebar.measurement.measureButton', fallbackLabel: 'Measure', icon: 'fas fa-ruler' }),
        control('pinpointButton', { id: 'tools.pinpoint', group: 'tools', surfaces: ['tools'],
            labelKey: 'sidebar.measurement.pinpointButton', fallbackLabel: 'Pinpoint', icon: 'fas fa-location-crosshairs' }),
        control('clearMeasurementsButton', { id: 'tools.clearMeasurements', group: 'tools', surfaces: ['tools'],
            labelKey: 'sidebar.measurement.clearButton', fallbackLabel: 'Clear Measurements', icon: 'fas fa-eraser' }),
        { id: 'blocks.reform', group: 'blocks', surfaces: ['tools'], run: callGlobal('countBlocks'),
            labelKey: 'sidebar.blocks.reformButton', fallbackLabel: '(Re)form Blocks', icon: 'fas fa-shapes' },
        { id: 'blocks.fromSelected', group: 'blocks', surfaces: ['tools', 'selection-tray'],
            // An empty multi-selection has no parcel to grow a block from.
            when: ctx => !(ctx && ctx.selection && ctx.selection.active && ctx.selection.count === 0),
            run: callGlobal('animateFloodfillFromSelected'),
            labelKey: 'mapShell.commands.blockFromSelected', fallbackLabel: 'Detect block from the selected parcel', icon: 'fas fa-fill-drip' },
        control('showBlockListButton', { id: 'blocks.list', group: 'blocks', surfaces: ['tools'],
            labelKey: 'sidebar.blocks.showListButton', fallbackLabel: 'Show Block List', icon: 'fas fa-list' }),
        { id: 'blocks.clear', group: 'blocks', surfaces: ['settings'], debugOnly: true, run: callGlobal('clearBlocks'),
            labelKey: 'sidebar.blocks.clearButton', fallbackLabel: 'Clear Blocks From Local Storage', icon: 'fas fa-trash' },
        { id: 'stations.bus', group: 'stations', surfaces: ['tools'], run: callGlobal('startTransitStationPlacement', 'bus'),
            labelKey: 'sidebar.stations.bus', fallbackLabel: 'Bus station', icon: 'fas fa-bus' },
        { id: 'stations.tram', group: 'stations', surfaces: ['tools'], run: callGlobal('startTransitStationPlacement', 'tram'),
            labelKey: 'sidebar.stations.tram', fallbackLabel: 'Tram station', icon: 'fas fa-train-tram' },
        { id: 'stations.underground', group: 'stations', surfaces: ['tools'], run: callGlobal('startTransitStationPlacement', 'underground'),
            labelKey: 'sidebar.stations.underground', fallbackLabel: 'Underground station', icon: 'fas fa-train-subway' },
        { id: 'stations.elevated', group: 'stations', surfaces: ['tools'], run: callGlobal('startTransitStationPlacement', 'elevated'),
            labelKey: 'sidebar.stations.elevated', fallbackLabel: 'Elevated train station', icon: 'fas fa-train' },
        { id: 'stations.cancel', group: 'stations', surfaces: ['tools'], run: callGlobal('cancelTransitStationPlacement'),
            labelKey: 'sidebar.stations.cancel', fallbackLabel: 'Cancel placement', icon: 'fas fa-xmark' },
        control('detectExistingRoadsButton', { id: 'roads.detectExisting', group: 'roads', surfaces: ['tools'],
            labelKey: 'sidebar.roads.detectExisting', fallbackLabel: 'Detect Existing Roads', icon: 'fas fa-road' }),
        { id: 'roads.drawOsm', group: 'roads', surfaces: ['tools'], run: callGlobal('drawOSMRoads'),
            labelKey: 'sidebar.roads.drawOsm', fallbackLabel: 'Draw Roads from OSM', icon: 'fas fa-road' },
        { id: 'roads.detectOsm', group: 'roads', surfaces: ['tools'], run: callGlobal('detectRoadsFromOSM'),
            labelKey: 'sidebar.roads.detectOsm', fallbackLabel: 'Detect Roads from OSM', icon: 'fas fa-road' },
        { id: 'roads.drawGup', group: 'roads', surfaces: ['tools'], run: callGlobal('drawGUPRoads'),
            labelKey: 'sidebar.roads.drawGup', fallbackLabel: 'Draw Roads from GUP', icon: 'fas fa-road' },
        { id: 'roads.detectGup', group: 'roads', surfaces: ['tools'], run: callGlobal('detectRoadsFromGUP'),
            labelKey: 'sidebar.roads.detectGup', fallbackLabel: 'Detect Roads from GUP', icon: 'fas fa-road' },
        { id: 'roads.drawDgu', group: 'roads', surfaces: ['tools'], run: callGlobal('drawWFSRoadParcels'),
            labelKey: 'sidebar.roads.drawDgu', fallbackLabel: 'Draw roads from DGU', icon: 'fas fa-road' },
        { id: 'roads.detectDgu', group: 'roads', surfaces: ['tools'], run: callGlobal('detectRoadsFromWFS'),
            labelKey: 'sidebar.roads.detectDgu', fallbackLabel: 'Detect roads from DGU', icon: 'fas fa-road' },
        { id: 'roads.clear', group: 'roads', surfaces: ['settings'], debugOnly: true, run: callGlobal('clearDetectedRoads'),
            labelKey: 'sidebar.roads.clearButton', fallbackLabel: 'Clear Roads from Local Storage', icon: 'fas fa-trash' },
        control('applyGovernmentRoadPlanButton', { id: 'roads.applyGovernmentPlan', group: 'roads', surfaces: ['tools'],
            labelKey: 'sidebar.roads.applyGovPlan', fallbackLabel: 'Apply Government Road Plan', icon: 'fas fa-map-location-dot' }),
        control('analyzeAllRoadsButton', { id: 'roads.analyzeOsm', group: 'roads', surfaces: ['tools'],
            labelKey: 'sidebar.roads.analyzeOsm', fallbackLabel: 'Analyze Roads OSM', icon: 'fas fa-chart-line' }),
        control('amCityPlanToggle', { id: 'areaMonitor.cityPlan', group: 'areaMonitor', kind: 'toggle', surfaces: ['tools'],
            labelKey: 'mapShell.commands.areaMonitorCityPlan', fallbackLabel: 'Area monitor: show the city road plan', icon: 'fas fa-map' }),
        control('areaMonitorDrawButton', { id: 'areaMonitor.draw', group: 'areaMonitor', surfaces: ['tools'],
            labelKey: 'mapShell.commands.areaMonitorDraw', fallbackLabel: 'Draw a monitored area', icon: 'fas fa-draw-polygon' }),
        control('areaMonitorFromPlanButton', { id: 'areaMonitor.fromPlan', group: 'areaMonitor', surfaces: ['tools'],
            labelKey: 'mapShell.commands.areaMonitorFromPlan', fallbackLabel: 'Draw a monitored area from the plan', icon: 'fas fa-draw-polygon' }),
        control('areaMonitorListButton', { id: 'areaMonitor.list', group: 'areaMonitor', surfaces: ['tools'],
            labelKey: 'sidebar.areaMonitor.listButton', fallbackLabel: 'List monitored areas', icon: 'fas fa-list' }),

        // ---- Proposals sheet ----
        { id: 'proposals.list', group: 'proposals', surfaces: ['proposals'], run: callGlobal('showAllProposalsModal'),
            labelKey: 'mapShell.commands.proposalsList', fallbackLabel: 'Open the proposals list', icon: 'fas fa-list-ul' },
        control('planStatsButton', { id: 'proposals.planStats', group: 'proposals', surfaces: ['proposals'],
            labelKey: 'sidebar.proposals.planStats.buttonLabel', fallbackLabel: 'Plan Stats', icon: 'fas fa-chart-pie' }),
        control('roosterScoreButton', { id: 'proposals.grainScore', group: 'proposals', surfaces: ['proposals'],
            labelKey: 'sidebar.proposals.grainScore.buttonLabel', fallbackLabel: 'Summon the urbanist rooster', icon: 'fas fa-crow' }),
        control('mintedProposalsButton', { id: 'proposals.minted', group: 'proposals', surfaces: ['proposals'],
            labelKey: 'sidebar.proposals.mintedButton', fallbackLabel: 'Minted Proposals', icon: 'fas fa-certificate' }),
        control('shareAppliedProposalsButton', { id: 'proposals.sharePlan', group: 'proposals', surfaces: ['proposals'],
            labelKey: 'sidebar.proposals.shareButton', fallbackLabel: 'Share entire plan (all proposals)', icon: 'fas fa-share-alt' }),
        { id: 'proposals.clearLocal', group: 'proposals', surfaces: ['settings'], debugOnly: true, run: callGlobal('clearLocalProposalData'),
            labelKey: 'sidebar.proposals.clearButton', fallbackLabel: 'Clear Proposals From Local Storage', icon: 'fas fa-trash' },

        // ---- Activity sheet: the explorer, and the Simulation section (group 'game', so a city
        // config hiding the game section takes the simulation commands with it, not the explorer) ----
        { id: 'activity.explorer', group: 'activity', surfaces: ['activity'], run: callGlobal('showGameLogDialog'),
            labelKey: 'mapShell.commands.activityExplorer', fallbackLabel: 'Open activity explorer', icon: 'fas fa-wave-square' },
        { id: 'activity.agents', group: 'activity', surfaces: ['activity'], run: callGlobal('showGameLogDialog', { view: 'actors' }),
            labelKey: 'sidebar.game.showAgents', fallbackLabel: 'Show Agents', icon: 'fas fa-robot' },
        control('gameCheckbox', { id: 'game.enable', group: 'game', kind: 'toggle', surfaces: ['activity'],
            labelKey: 'sidebar.game.enable', fallbackLabel: 'Enable game mode', icon: 'fas fa-gamepad' }),
        { id: 'game.playPause', group: 'game', surfaces: ['activity'], run: callGlobal('toggleGamePlayPause'),
            labelKey: 'mapShell.commands.gamePlayPause', fallbackLabel: 'Play / pause the game', icon: 'fas fa-play' },
        control('turn-interval-slider', { id: 'game.interval', group: 'game', kind: 'input', surfaces: ['activity'],
            labelKey: 'mapShell.commands.gameInterval', fallbackLabel: 'Turn interval', icon: 'fas fa-stopwatch' }),
        { id: 'game.new', group: 'game', surfaces: ['activity'], run: callGlobal('resetGameState', true),
            labelKey: 'sidebar.game.newGame', fallbackLabel: 'New Game', icon: 'fas fa-rotate-left' },

        // ---- Activity: the status log ----
        { id: 'activity.statusLog', group: 'activity', surfaces: [], run: callGlobal('openStatusLogDialog'),
            labelKey: 'mapShell.commands.statusLog', fallbackLabel: 'Open the status log', icon: 'fas fa-terminal' },

        // ---- Parcel menu (ui/parcel-menu.js), in menu order ----
        parcelCommand('propose', { labelKey: 'parcelMenu.actions.propose', fallbackLabel: 'Propose here', icon: 'fas fa-pen-ruler' }),
        parcelCommand('selectMore', { labelKey: 'parcelMenu.actions.selectMore', fallbackLabel: 'Select more', icon: 'fas fa-object-group' }),
        parcelCommand('details', { labelKey: 'parcelMenu.actions.details', fallbackLabel: 'Details', icon: 'fas fa-circle-info' }),
        parcelCommand('history', { labelKey: 'parcelMenu.actions.history', fallbackLabel: 'History', icon: 'fas fa-clock-rotate-left' }),
        parcelCommand('tools', { labelKey: 'parcelMenu.actions.tools', fallbackLabel: 'Tools', icon: 'fas fa-screwdriver-wrench' }),
        parcelCommand('offer', { labelKey: 'parcelMenu.actions.offer', fallbackLabel: 'Offer my land', icon: 'fas fa-handshake' }),
        parcelCommand('view3d', { labelKey: 'parcelMenu.actions.view3d', fallbackLabel: 'View in 3D', icon: 'fas fa-cube' }),
        parcelCommand('detectBlock', { labelKey: 'parcelMenu.actions.detectBlock', fallbackLabel: 'Detect block', icon: 'fas fa-fill-drip' }),
        parcelCommand('useAsSite', { labelKey: 'parcelMenu.actions.useAsSite', fallbackLabel: 'Use as site', icon: 'fas fa-draw-polygon' }),

        // ---- Ground menu (a click where there is no parcel), in menu order ----
        groundCommand('drawSite', { labelKey: 'groundMenu.actions.drawSite', fallbackLabel: 'Draw a site here', icon: 'fas fa-draw-polygon' }),
        groundCommand('road', { labelKey: 'panel.parcel.build.road', fallbackLabel: 'Road', icon: 'fas fa-road' }),
        groundCommand('track', { labelKey: 'panel.parcel.build.track', fallbackLabel: 'Track', icon: 'fas fa-train' }),
        groundCommand('busStation', { labelKey: 'panel.parcel.build.busStation', fallbackLabel: 'Bus station', icon: 'fas fa-bus' }),
        groundCommand('tramStation', { labelKey: 'panel.parcel.build.tramStation', fallbackLabel: 'Tram station', icon: 'fas fa-tram' }),
        groundCommand('undergroundStation', { labelKey: 'panel.parcel.build.undergroundStation', fallbackLabel: 'Metro station', icon: 'fas fa-train-subway' }),
        groundCommand('elevatedStation', { labelKey: 'panel.parcel.build.elevatedStation', fallbackLabel: 'Elevated station', icon: 'fas fa-train' }),
        // The site tool from anywhere (the palette): draw a site with nothing selected.
        { id: 'site.draw', group: 'site', surfaces: [], when: siteToolIdle,
            run: ctx => ctx.global.SiteTool.start(),
            labelKey: 'siteTool.commands.draw', fallbackLabel: 'Draw site', icon: 'fas fa-draw-polygon' },

        // ---- Selection tray (ui/selection-tray.js); Detect block is blocks.fromSelected above ----
        { id: 'selection.propose', group: 'selection', surfaces: ['selection-tray'], when: selectionNonEmpty,
            run: ctx => ctx.global.SelectionTray.propose(),
            labelKey: 'selectionTray.actions.propose', fallbackLabel: 'Propose', icon: 'fas fa-pen-ruler' },
        // The selection's union as an editable site (the site tool), for designs that should not
        // follow the parcel edges exactly.
        { id: 'selection.useAsSite', group: 'selection', surfaces: ['selection-tray'],
            when: ctx => selectionNonEmpty(ctx) && siteToolIdle(ctx),
            run: ctx => ctx.global.SiteTool.startFromSelection(),
            labelKey: 'selectionTray.actions.useAsSite', fallbackLabel: 'Use as site', icon: 'fas fa-draw-polygon' },
        { id: 'selection.clear', group: 'selection', surfaces: ['selection-tray'], when: selectionNonEmpty,
            run: ctx => ctx.global.multiParcelSelection.clearSelection(),
            labelKey: 'selectionTray.actions.clear', fallbackLabel: 'Clear selection', icon: 'fas fa-eraser' },
        { id: 'selection.done', group: 'selection', surfaces: ['selection-tray'], when: selectionActive,
            run: callGlobal('cancelMultiParcelSelection'),
            labelKey: 'selectionTray.actions.done', fallbackLabel: 'Done selecting', icon: 'fas fa-check' },

        // ---- Settings sheet ----
        // The city list and "Use my location" live in the search box (city chip, Cities group).
        { id: 'settings.city', group: 'settings', surfaces: [], run: callSearch('showCities'),
            labelKey: 'mapShell.commands.chooseCity', fallbackLabel: 'Choose a city', icon: 'fas fa-city' },
        { id: 'settings.detectCity', group: 'settings', surfaces: [], run: detectNearestCity,
            labelKey: 'sidebar.city.detectTooltip', fallbackLabel: 'Use my location to pick the closest city', icon: 'fas fa-crosshairs' },
        // The globe (js/ui/world-entry.js): choose a city, or explore a place without parcels.
        control('world-view-button', { id: 'world.open', group: 'settings', surfaces: ['settings'],
            labelKey: 'mapShell.commands.worldView', fallbackLabel: 'World view', icon: 'fas fa-earth-europe' }),
        // Opens the palette itself, so it is not listed in it.
        control('command-palette-button', { id: 'settings.commandPalette', group: 'settings', surfaces: ['settings'], palette: false,
            labelKey: 'commandPalette.open', fallbackLabel: 'Command palette', icon: 'fas fa-terminal' }),
        control('data-source-select', { id: 'settings.dataSource', group: 'settings', kind: 'input', surfaces: ['settings'],
            labelKey: 'mapShell.commands.dataSource', fallbackLabel: 'Data source', icon: 'fas fa-database' }),
        control('tile-source-select', { id: 'settings.baseMap', group: 'settings', kind: 'input', surfaces: ['settings'],
            labelKey: 'mapShell.commands.baseMap', fallbackLabel: 'Base map', icon: 'fas fa-map' }),
        control('wipeLocalDataButton', { id: 'settings.wipeLocalData', group: 'settings', surfaces: ['settings'],
            labelKey: 'sidebar.info.wipeDataButton', fallbackLabel: 'Wipe ALL Local Data', icon: 'fas fa-skull-crossbones' }),
        control('debugModeCheckbox', { id: 'settings.debugMode', group: 'settings', kind: 'toggle', surfaces: ['settings'],
            labelKey: 'sidebar.info.debugToggle', fallbackLabel: 'Enable debug mode', icon: 'fas fa-bug' }),
        { id: 'settings.siteIntro', group: 'settings', surfaces: ['settings'],
            run: ctx => ctx.clickSelector('[data-site-intro-open]'),
            labelKey: 'modal.siteIntro.open', fallbackLabel: 'How Consensus Builder works', icon: 'fas fa-map' }
    ];

    const COMMANDS = Object.freeze(DEFINITIONS.map(command));
    const BY_ID = new Map(COMMANDS.map(entry => [entry.id, entry]));

    function listCommands() {
        return COMMANDS.slice();
    }

    function findCommand(id) {
        return BY_ID.get(id) || null;
    }

    // The sheet section each command group lives in. A city config that hides the section
    // (sidebar.disabledSections: Belgrade's blocks and roads, everything parcel-bound in the explore
    // city) takes its commands with it, including those that call a global rather than a control.
    const GROUP_SECTIONS = Object.freeze({
        parcels: 'parcels', blocks: 'blocks', stations: 'stations', roads: 'roads',
        proposals: 'proposals', game: 'game', areaMonitor: 'areaMonitor'
    });

    function sectionHiddenForCity(entry, ctx) {
        const section = GROUP_SECTIONS[entry.group];
        if (!section || !ctx || typeof ctx.isSectionHidden !== 'function') return false;
        try {
            return !!ctx.isSectionHidden(section);
        } catch (_) {
            return false;
        }
    }

    // The per-dataset local-storage clears are `.btn-danger` in the Settings sheet, shown only in
    // debug mode (as in the sidebar). `debugOnly` keeps the palette and search in step with that:
    // without it they offered the clears that the sheet hides.
    function hiddenOutsideDebug(entry, ctx) {
        if (!entry.debugOnly) return false;
        if (!ctx || typeof ctx.isDebugMode !== 'function') return true;
        try {
            return !ctx.isDebugMode();
        } catch (_) {
            return true;
        }
    }

    function isAvailable(entry, ctx) {
        if (sectionHiddenForCity(entry, ctx)) return false;
        if (hiddenOutsideDebug(entry, ctx)) return false;
        try {
            return !!entry.when(ctx);
        } catch (error) {
            console.warn(`[UiCommands] when() failed for ${entry.id}`, error);
            return false;
        }
    }

    function commandsFor(surface, ctx) {
        return COMMANDS.filter(entry => entry.surfaces.includes(surface) && isAvailable(entry, ctx));
    }

    // The label a person sees: the translation when there is one, else the English fallback.
    // i18n.t returns the key itself when a translation is missing.
    function labelOf(entry, t) {
        if (typeof t === 'function') {
            const translated = t(entry.labelKey);
            if (typeof translated === 'string' && translated && translated !== entry.labelKey) return translated;
        }
        return entry.fallbackLabel;
    }

    const normalize = value => String(value || '')
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');

    // Lower is better; null = no match. Label matches beat id matches, and earlier/whole-word
    // matches beat ones buried in the middle of a word.
    // Lower is better. A word of the command's group ("lay" → Layers) beats a mid-word hit in a
    // label ("Play"), so typing a sheet's name lists that sheet's commands first.
    function matchRank(label, id, query, group = '') {
        const startsAWord = text => text.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(query));
        if (label === query) return 0;
        if (label.startsWith(query)) return 1;
        if (startsAWord(label)) return 2;
        if (group && startsAWord(group)) return 3;
        if (label.includes(query)) return 4;
        if (id.includes(query)) return 5;
        return null;
    }

    // Why an unavailable command is unavailable, as a reason key (commandPalette.reason.<key>), or
    // null when the registry cannot say. Only control-backed commands know: the ctx reports why
    // their control is off (3D lock, a busy section, hidden for this city, plain disabled).
    function unavailableReason(entry, ctx) {
        if (sectionHiddenForCity(entry, ctx)) return 'hiddenForCity';
        if (hiddenOutsideDebug(entry, ctx)) return 'debugOnly';
        if (!entry.control || !ctx || typeof ctx.controlUnavailableReason !== 'function') return null;
        try {
            return ctx.controlUnavailableReason(entry.control) || null;
        } catch (_) {
            return null;
        }
    }

    // Every palette command matching the query, best first, available or not:
    // [{ entry, label, rank, available, reason }]. The palette shows the unavailable ones greyed.
    function rankCommands(query, ctx, t) {
        const needle = normalize(query).trim();
        const scored = COMMANDS.filter(entry => entry.surfaces.includes('palette')).map(entry => {
            const label = labelOf(entry, t);
            const groupKey = `commandPalette.groups.${entry.group}`;
            const translated = typeof t === 'function' ? t(groupKey, entry.group) : null;
            const groupLabel = translated && translated !== groupKey ? translated : '';
            const rank = needle ? matchRank(normalize(label), normalize(entry.id), needle, normalize(`${entry.group} ${groupLabel}`)) : 0;
            const available = isAvailable(entry, ctx);
            return { entry, label, rank, available, reason: available ? null : unavailableReason(entry, ctx) };
        }).filter(item => item.rank !== null);
        scored.sort((a, b) => (a.rank - b.rank) || a.label.localeCompare(b.label));
        return scored;
    }

    function searchCommands(query, ctx, t) {
        return rankCommands(query, ctx, t).filter(item => item.available).map(item => item.entry);
    }

    // The ctx the browser passes to when()/run(). Everything DOM-shaped goes through here, so a
    // test can hand the registry a fake instead.
    // `extra.parcel` pins the parcel the commands act on (the parcel menu passes its own).
    function createBrowserContext(win, extra = {}) {
        const doc = win.document;
        const element = id => doc.getElementById(id);
        // Hidden by the city config (inline display:none on the control or a section around it) or
        // by the feature flags — not merely inside a closed sheet.
        const hiddenByConfig = el => {
            for (let node = el; node && node !== doc.body; node = node.parentElement) {
                if (node.classList && node.classList.contains('map-sheet')) return false;
                if (node.style && node.style.display === 'none') return true;
                if (node.getAttribute && node.getAttribute('data-feature-hidden') === 'true') return true;
            }
            return false;
        };
        const shell = () => win.MapShell;
        const ctx = {
            global: win,
            document: doc,
            isDebugMode() {
                return !!(doc.body && doc.body.classList.contains('debug-mode'));
            },
            isControlAvailable(id) {
                const el = element(id);
                return !!el && !el.disabled && !hiddenByConfig(el);
            },
            // Every wrapper of the section hidden by the city config (applySidebarConfiguration).
            isSectionHidden(section) {
                const wrappers = Array.from(doc.querySelectorAll(`.accordion-section[data-section="${section}"]`));
                return wrappers.length > 0 && wrappers.every(wrapper => wrapper.style.display === 'none');
            },
            controlUnavailableReason(id) {
                const el = element(id);
                if (!el) return 'missing';
                if (hiddenByConfig(el)) {
                    // A section the city config hid (or a feature flag) vs a control that is
                    // simply not shown right now (e.g. Clear Measurements with nothing measured).
                    const byCity = el.closest('[data-feature-hidden="true"]')
                        || Array.from(doc.querySelectorAll('.accordion-section[data-section]'))
                            .some(section => section.style.display === 'none' && section.contains(el));
                    return byCity ? 'hiddenForCity' : 'disabled';
                }
                if (!el.disabled) return null;
                if (el.hasAttribute('data-three-disabled')) return 'disabledIn3D';
                if (el.hasAttribute('data-busy-prev-disabled')) return 'busy';
                return 'disabled';
            },
            clickControl(id) {
                const el = element(id);
                if (!el) throw new Error(`UiCommands: control #${id} is missing`);
                el.click();
            },
            clickSelector(selector) {
                const el = doc.querySelector(selector);
                if (!el) throw new Error(`UiCommands: nothing matches ${selector}`);
                el.click();
            },
            revealControl(id) {
                if (!shell() || typeof shell().revealControl !== 'function') {
                    throw new Error('UiCommands: MapShell.revealControl is not available');
                }
                shell().revealControl(id);
            }
        };
        // Read when a when()/run() asks, so a context made once stays current.
        Object.defineProperty(ctx, 'parcel', {
            enumerable: true,
            get: () => ('parcel' in extra ? extra.parcel
                : (win.ParcelMenu && typeof win.ParcelMenu.contextFacts === 'function' ? win.ParcelMenu.contextFacts() : null))
        });
        Object.defineProperty(ctx, 'ground', {
            enumerable: true,
            get: () => ('ground' in extra ? extra.ground
                : (win.GroundMenu && typeof win.GroundMenu.contextFacts === 'function' ? win.GroundMenu.contextFacts() : null))
        });
        Object.defineProperty(ctx, 'selection', {
            enumerable: true,
            get: () => {
                const multi = win.multiParcelSelection;
                if (!multi) return null;
                return { active: !!multi.isActive, count: multi.selectedParcels ? multi.selectedParcels.size : 0 };
            }
        });
        return ctx;
    }

    function runCommand(id, ctx) {
        const entry = findCommand(id);
        if (!entry) throw new Error(`UiCommands: unknown command ${id}`);
        return entry.run(ctx);
    }

    return {
        SURFACES,
        GROUP_SECTIONS,
        REHOUSED_CONTROL_IDS,
        listCommands,
        findCommand,
        commandsFor,
        searchCommands,
        rankCommands,
        labelOf,
        runCommand,
        createBrowserContext
    };
});
