// Load rarely used editor and analysis tools on their first command. The app uses classic scripts
// because many modules expose globals; keep each file separate and in its original order.
(function (global, doc) {
    'use strict';

    const groups = {
        roadAnalysis: ['js/road-analysis.js'],
        roadDetection: ['js/road-detection.js'],
        singleBuilding: ['js/single-building-geometry.js', 'js/single-building.js'],
        rowHouse: ['js/single-building-geometry.js', 'js/row-house.js'],
        parcelBased: ['js/single-building-geometry.js', 'js/parcel-based.js'],
        buildingUpload: ['js/single-building-geometry.js', 'js/single-building.js', 'js/building-upload.js']
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

    function loadScript(path) {
        if (loaded.has(path)) return Promise.resolve();
        if (inFlight.has(path)) return inFlight.get(path);
        let resolveLoad;
        let rejectLoad;
        const promise = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
        inFlight.set(path, promise);
        const src = typeof global.appendBuildToken === 'function'
            ? global.appendBuildToken(path)
            : path;
        const script = doc.createElement('script');
        script.src = src;
        script.async = false;
        script.onload = () => {
            loaded.add(path);
            inFlight.delete(path);
            resolveLoad();
        };
        script.onerror = () => {
            inFlight.delete(path);
            rejectLoad(new Error(`Could not load optional tool: ${path}`));
        };
        doc.head.appendChild(script);
        return promise;
    }

    function ensure(group) {
        const paths = groups[group];
        if (!paths) return Promise.reject(new Error(`Unknown optional tool group: ${group}`));
        if (pending.has(group)) return pending.get(group);
        const promise = loadScript(paths[0])
            .then(() => paths.slice(1).reduce((chain, path) => chain.then(() => loadScript(path)), Promise.resolve()))
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
        'openSingleBuildingForParcels', 'singleBuildingOnSelectedBlock',
        'createSingleBuildingProposal', 'createSingleBuildingFromUpload'
    ].forEach(name => forward('singleBuilding', name, {
        guardMapMode: name === 'openSingleBuildingForParcels'
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
