// ui/parcel-menu.js — the parcel's facts and actions (the 'parcel-menu' UiCommands surface). The
// actions show in the click stack's parcel section (click-stack.md), which replaced the popover a
// parcel click used to open; they open the parcel panel on the tab they need
// (window.ParcelMenu.runAction). Which ones apply is decided by the pure ui/parcel-menu-model.js.
(function (win) {
    'use strict';

    const doc = win.document;
    const model = win.ParcelMenuModel;

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (typeof value === 'string' && value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    };

    // ---- facts ----

    function ownersFor(parcelId, props) {
        if (Array.isArray(props.ownershipList) && props.ownershipList.length) return props.ownershipList;
        if (Array.isArray(props.owners) && props.owners.length) return props.owners;
        const cache = win.ParcelsOwnershipUi && win.ParcelsOwnershipUi.parcelOwnerDataCache;
        const cached = cache && typeof cache.get === 'function' ? cache.get(String(parcelId)) : null;
        return Array.isArray(cached) && cached.length ? cached : null;
    }

    function geometryArea(feature) {
        if (!feature || !feature.geometry || !win.turf || typeof win.turf.area !== 'function') return null;
        try { return win.turf.area(feature); } catch (_) { return null; }
    }

    function blocksEnabled() {
        const config = win.CityConfigManager;
        const enabled = config && typeof config.isFeatureEnabled === 'function' ? config.isFeatureEnabled('parcelBlocks') : true;
        return enabled && typeof win.animateFloodfillFromSelected === 'function';
    }

    // Everything the model and the menu need about one parcel, read synchronously from what is
    // already loaded.
    function factsFor(parcelId, feature) {
        const id = String(parcelId);
        const props = (feature && feature.properties) || {};
        const multi = win.multiParcelSelection;
        let cadastreIds = [];
        let groundIds = [];
        try {
            const fabric = win.LiveParcelFabric;
            if (fabric && typeof fabric.explicitCadastreIds === 'function') cadastreIds = fabric.explicitCadastreIds(feature);
            if (fabric && typeof fabric.explicitGroundIds === 'function') groundIds = fabric.explicitGroundIds(feature);
        } catch (_) { cadastreIds = []; }
        const { historyIds, isGround } = model.parcelHistoryIds({ parcelId: id, cadastreIds, groundIds });
        const ownership = model.ownershipFacts({
            ownershipType: props.ownershipType,
            ownershipSummary: props.ownership_summary,
            owners: ownersFor(id, props),
            classify: typeof win.getOwnershipType === 'function' ? win.getOwnershipType : null
        });
        return {
            parcelId: id,
            displayId: model.displayParcelId(props, id),
            identityKind: model.parcelIdentityKind(props, id),
            isRoad: typeof win.isRoadParcel === 'function' ? !!win.isRoadParcel(id) : false,
            multiSelectActive: !!(multi && multi.isActive),
            historyIds,
            isGround,
            blocksEnabled: blocksEnabled(),
            siteToolAvailable: !!(win.SiteTool && typeof win.SiteTool.isActive === 'function' && !win.SiteTool.isActive()),
            // Proposals touching this parcel, for "Compare proposals here" (null when not loaded).
            compareCount: !isGround && win.ParcelCompare ? win.ParcelCompare.countFor(id) : null,
            area: model.parcelArea(props, geometryArea(feature)),
            ownershipType: ownership.ownershipType,
            ownerCount: ownership.ownerCount
        };
    }

    // The parcel commands act on: the selected single parcel (the click stack's parcel section
    // selects it; the command palette offers the same commands). Null without one.
    function contextFacts() {
        const multi = win.multiParcelSelection;
        if (multi && multi.isActive) return null;
        const current = win.currentParcel;
        if (!current || current.id === undefined || current.id === null) return null;
        const feature = win.LiveParcelFabric && win.LiveParcelFabric.get ? win.LiveParcelFabric.get(String(current.id)) : null;
        return feature ? factsFor(current.id, feature) : null;
    }

    function factsLine(facts) {
        const parts = [];
        if (facts.area !== null) {
            parts.push(CbFormat.formatArea(facts.area));
        }
        if (facts.isGround) parts.push(t('parcelMenu.groundNote', 'no cadastral parcel'));
        if (facts.isRoad) parts.push(t('panel.parcel.multi.roadTag', 'Road'));
        if (facts.ownershipType) {
            parts.push(t(`panel.parcel.ownershipType.${facts.ownershipType}`, facts.ownershipType));
        }
        if (facts.ownerCount !== null) {
            parts.push(t('parcelMenu.ownerCount', '{{count}} owner(s)', { count: facts.ownerCount }));
        }
        return parts.join(' · ');
    }

    function featureFor(facts) {
        const feature = win.LiveParcelFabric && win.LiveParcelFabric.get ? win.LiveParcelFabric.get(facts.parcelId) : null;
        if (!feature) throw new Error(`ParcelMenu: parcel ${facts.parcelId} is no longer on the map`);
        return feature;
    }

    function showPanelTab(facts, tabId) {
        const panelApi = (win.Parcels && win.Parcels.uiParcelPanel) || win.ParcelsUIParcelPanel || {};
        const showPanel = panelApi.showParcelInfoPanel || win.showParcelInfoPanel;
        showPanel(featureFor(facts));
        win.switchParcelTab(null, tabId);
    }

    // The parcel panel always carries its History section (collapsed) at the end of the Info tab;
    // this opens it, which fetches the history, and brings it into view.
    function showHistory(facts) {
        showPanelTab(facts, 'info-tab');
        const first = doc.querySelector('#parcel-history-section details[data-parcel-history]');
        if (!first) throw new Error(`ParcelMenu: the parcel panel shows no history for ${facts.parcelId}`);
        first.open = true;
        try { first.scrollIntoView({ block: 'start', behavior: 'auto' }); } catch (_) { }
    }

    const ACTION_RUNNERS = {
        propose: facts => showPanelTab(facts, 'propose-tab'),
        details: facts => showPanelTab(facts, 'info-tab'),
        proposals: facts => showPanelTab(facts, 'proposals-tab'),
        tools: facts => showPanelTab(facts, 'tools-tab'),
        history: showHistory,
        compare: facts => win.ParcelCompare.open(facts.parcelId),
        // Same seed as Shift+click: the selected parcel starts the multi-selection.
        selectMore: () => win.multiParcelSelection.toggle({ preserveSelectedParcel: true }),
        detectBlock: () => win.animateFloodfillFromSelected(),
        // This parcel as the starting outline of an editable site (js/site-drawing.js).
        useAsSite: facts => win.SiteTool.startFromParcels([facts.parcelId])
    };

    function runAction(action, facts) {
        const runner = ACTION_RUNNERS[action];
        if (!runner) throw new Error(`ParcelMenu: unknown action ${action}`);
        if (!facts || !facts.parcelId) throw new Error(`ParcelMenu: ${action} needs a parcel`);
        return runner(facts);
    }

    win.ParcelMenu = { contextFacts, runAction, factsFor, factsLine };
})(window);
