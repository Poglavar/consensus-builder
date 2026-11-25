// Load rarely used editor and analysis tools on their first command. The app uses classic scripts
// because many modules expose globals; keep each file separate and in its original order.
(function (global, doc) {
    'use strict';

    const travel = ['js/proposals/critic-tour.js', 'js/proposals/active-travel-network.js', 'js/proposals/active-travel-panel.js'];
    const groups = {
        roadAnalysis: ['js/road-analysis.js'],
        roadDetection: ['js/osm-roads-source.js', 'js/osm-road-coverage.js', 'js/road-detection.js'],
        singleBuilding: ['js/single-building.js'],
        designDuplication: ['js/design-duplication.js'],
        designMemberships: ['js/design-memberships.js?v=20261121-critic-tour'],
        rowHouse: ['js/row-house.js'],
        parcelBased: ['js/parcel-based.js'],
        buildingUpload: ['js/single-building.js', 'js/building-model-geometry.js', 'js/building-upload.js'],
        // Parsing, summarizing and uploading a glTF: the upload dialog and the structure editor's furniture models.
        modelUpload: ['js/model-upload.js'],
        // CityGML and CityJSON: footprint import, Upload model, and plan and design import in Lists.
        cityModel: ['js/city-model-reader.js'],
        // IFC building models for Upload model; web-ifc itself loads from the CDN on the first IFC file.
        ifcModel: ['js/city-model-reader.js', 'js/ifc-model-reader.js'],
        // CityJSON plan and design download, and reading such a file back.
        cityJson: ['js/city-model-reader.js', 'js/city-json-export.js'],
        chat: ['js/chat/chat-transcript.js', 'js/chat/chat-context.js', 'js/chat/chat-navigation.js', 'js/chat/chat-client.js', 'js/chat/chat-panel.js'],
        // Road → Import's file readers (corridor-import.js), loaded when a file is imported.
        // The OSM reader reads XML with the OpenDRIVE module's parser.
        roadImportOsm: ['js/corridor-import-opendrive.js', 'js/corridor-import-osm.js'],
        roadImportOpenDrive: ['js/corridor-import-opendrive.js'],
        roadDrawing: ['js/road-drawing.js'],
        buildingBlockEditor: ['js/building-block-editor.js'],
        rooster: ['js/proposals/grain-score-rules.js', 'js/proposals/grain-score.js'],
        cat: ['js/proposals/critic-tour.js', 'js/proposals/square-enclosure.js', 'js/proposals/square-critic.js'],
        beaver: ['js/proposals/critic-tour.js', 'js/proposals/beaver-buildout.js', 'js/proposals/beaver-critic.js'],
        dog: [...travel, 'js/proposals/dog-walkability.js', 'js/proposals/dog-critic.js'],
        hare: [...travel, 'js/proposals/hare-cycling.js', 'js/proposals/hare-critic.js']
    };
    const styles = {
        rooster: ['css/grain-score.css'],
        cat: ['css/critic-tour.css', 'css/square-critic.css'],
        beaver: ['css/critic-tour.css', 'css/beaver-critic.css'],
        dog: ['css/critic-tour.css', 'css/active-travel-critic.css'],
        hare: ['css/critic-tour.css', 'css/active-travel-critic.css']
    };
    const loaded = new Set();
    const inFlight = new Map();
    const pending = new Map();
    const reportedErrors = new WeakSet();

    function observeFailure(promise) {
        promise.catch(error => {
            const trackable = error !== null && (typeof error === 'object' || typeof error === 'function');
            if (trackable) {
                if (reportedErrors.has(error)) return;
                reportedErrors.add(error);
            }
            try { global.console?.error?.('Optional tool failed to load', error); } catch (_) { /* keep rejection observable */ }
            try {
                const key = 'optionalTools.loadFailed';
                const translated = global.i18n && typeof global.i18n.t === 'function'
                    ? global.i18n.t(key)
                    : null;
                const message = translated && translated !== key
                    ? translated
                    : 'Could not load this tool. Please try again.';
                if (typeof global.updateStatus === 'function') global.updateStatus(message);
            } catch (_) { /* reporting must not replace the original rejection */ }
        });
        return promise;
    }

    function loadAsset(path) {
        if (loaded.has(path)) return Promise.resolve();
        if (inFlight.has(path)) return inFlight.get(path);
        let resolveLoad;
        let rejectLoad;
        const promise = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
        inFlight.set(path, promise);
        const css = path.endsWith('.css');
        const src = global.__CSS_ASSETS?.[path] || (global.appendBuildToken ? global.appendBuildToken(path) : path);
        const asset = doc.createElement(css ? 'link' : 'script');
        if (css) { asset.rel = 'stylesheet'; asset.href = src; }
        else { asset.src = src; asset.async = false; }
        asset.onload = () => {
            loaded.add(path);
            inFlight.delete(path);
            resolveLoad();
        };
        asset.onerror = () => {
            inFlight.delete(path);
            asset.remove?.();
            rejectLoad(new Error(`Could not load optional tool: ${path}`));
        };
        doc.head.appendChild(asset);
        return promise;
    }

    function ensure(group) {
        const paths = groups[group];
        if (!paths) return Promise.reject(new Error(`Unknown optional tool group: ${group}`));
        if (pending.has(group)) return pending.get(group);
        const scripts = loadAsset(paths[0])
            .then(() => paths.slice(1).reduce((chain, path) => chain.then(() => loadAsset(path)), Promise.resolve()));
        const promise = Promise.all([scripts, ...(styles[group] || []).map(loadAsset)])
            .catch(error => {
                // Keep successfully loaded files marked. A retry resumes at the failed file and
                // never re-evaluates a classic script with top-level lexical declarations.
                pending.delete(group);
                throw error;
            });
        pending.set(group, promise);
        return promise;
    }

    function forward(group, name, options = {}) {
        const facade = function optionalToolFacade(...args) {
            if (options.noLoad && !loaded.has(options.loadedPath || groups[group][0])) return undefined;
            const mapModeAtCall = options.guardMapMode ? global.__mapModeState : undefined;
            const promise = ensure(group).then(() => {
                if (mapModeAtCall !== undefined && mapModeAtCall !== global.__mapModeState) return false;
                const implementation = global[name];
                if (typeof implementation !== 'function' || implementation === facade) {
                    throw new Error(`Optional tool did not expose ${name}`);
                }
                return implementation.apply(this, args);
            });
            return observeFailure(promise);
        };
        global[name] = facade;
        return facade;
    }

    global.ensureOptionalTool = ensure;
    forward('rooster', 'summonUrbanistRooster');
    for (const [name, group] of Object.entries({ SquareCritic: 'cat', BeaverCritic: 'beaver', DogCritic: 'dog', HareCritic: 'hare' })) {
        const facade = { async open(...args) {
            await ensure(group);
            if (global[name] === facade) throw new Error(`Could not initialize ${name}`);
            return global[name].open(...args);
        } };
        global[name] = facade;
    }
    for (const name of ['requestRoadDrawTool', 'requestTrackDrawTool', 'requestCorridorDrawingTool',
        'toggleRoadDrawTool', 'startSeededCorridorDrawing', 'updateLocalCorridorGeometry']) forward('roadDrawing', name, { guardMapMode: true });
    forward('designDuplication', 'startDesignDuplication', { guardMapMode: true });
    forward('designMemberships', 'loadDesignMemberships', { guardMapMode: true });

    // Opening a panel or running an analysis is the explicit entry point. Close/cleanup calls
    // from mode switches remain no-ops until that panel has ever been opened.
    [
        'showRoadAnalysisPanel', 'analyzeAllRoadsInView', 'analyzeAllOSMRoadSegmentsInView',
        'focusOnRoadAnalysis', 'clearRoadAnalysisVisualization', 'hideOSMRoadSegmentListPopup',
        'toggleRoadAnalysisVisibility'
    ].forEach(name => forward('roadAnalysis', name, {
        noLoad: ['clearRoadAnalysisVisualization', 'hideOSMRoadSegmentListPopup'].includes(name)
    }));
    forward('roadAnalysis', 'hideRoadAnalysisPanel', { noLoad: true });
    forward('roadAnalysis', 'hideRoadAnalysisLayer', { noLoad: true });

    ['detectRoadsFromOSM', 'detectRoadsFromGUP', 'detectRoadsFromWFS', 'detectExistingRoads',
        'drawOSMRoads', 'drawGUPRoads', 'drawWFSRoadParcels', 'toggleOSMRoadLines',
        'toggleGUPRoadLines', 'toggleWFSPolygons', 'clearDetectedRoads']
        .forEach(name => forward('roadDetection', name));

    [
        'openSingleBuildingForParcels', 'openFreeformGeoJSONBuildings', 'createSingleBuildingFromUpload'
    ].forEach(name => forward('singleBuilding', name, {
        guardMapMode: name === 'openSingleBuildingForParcels' || name === 'openFreeformGeoJSONBuildings'
    }));
    forward('rowHouse', 'openRowHouseForParcels', { guardMapMode: true });
    forward('rowHouse', 'setPendingRowHouseProposalContext');
    forward('rowHouse', 'closeRowHouseModal', { noLoad: true, loadedPath: 'js/row-house.js' });
    forward('parcelBased', 'openParcelBasedForParcels', { guardMapMode: true });
    forward('parcelBased', 'closeParcelBasedModal', { noLoad: true, loadedPath: 'js/parcel-based.js' });

    // BuildingUpload is consumed as an object by the proposal geometry flow.
    global.BuildingUpload = {
        open(...args) {
            const mapModeAtCall = global.__mapModeState;
            return observeFailure(ensure('buildingUpload').then(() => {
                if (mapModeAtCall !== undefined && mapModeAtCall !== global.__mapModeState) return false;
                return global.BuildingUpload.open(...args);
            }));
        },
        close(...args) {
            const uploadScript = groups.buildingUpload[groups.buildingUpload.length - 1];
            if (!loaded.has(uploadScript)) return undefined;
            return global.BuildingUpload.close(...args);
        }
    };
})(window, document);
