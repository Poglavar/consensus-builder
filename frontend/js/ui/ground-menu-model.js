// ui/ground-menu-model.js — the pure half of the ground menu (the popover a map click opens where
// there is no parcel): what kind of ground the click hit, and which actions apply there. No DOM, no
// Leaflet; UMD so backend/test/frontend-ground-menu.test.js loads it headlessly. The DOM half is
// ui/ground-menu.js; placement reuses ParcelMenuModel.placeMenuAtPoint.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GroundMenuModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Menu order. Each id is also the suffix of its UiCommands command (`ground.<id>`).
    const ACTIONS = Object.freeze(['drawSite', 'road', 'track', 'busStation', 'tramStation', 'undergroundStation', 'elevatedStation']);
    const STATION_ACTIONS = Object.freeze({
        busStation: 'bus', tramStation: 'tram', undergroundStation: 'underground', elevatedStation: 'elevated'
    });

    // What a click with no parcel under it hit. Never treats "not loaded yet" as bare ground
    // (unsurveyed-ground.md): only a loaded cadastral cell with no parcel at the point is bare.
    //   parcel      — a parcel or applied proposal is there (the parcel menu / drill answers);
    //   no-cadastre — the city has no cadastre at all (explore): every click is open ground;
    //   not-loaded  — the cadastre here is not loaded (zoomed out, still fetching, failed): unknown;
    //   bare        — the cadastre here is loaded and has no parcel at the point (an unsurveyed
    //                 hole, or a gap between parcels).
    // facts: { hasParcelAtPoint, cityHasCadastre, pointLoaded }. Missing facts count as unknown.
    function classifyGroundClick(facts) {
        const f = facts || {};
        if (f.hasParcelAtPoint === true) return 'parcel';
        if (f.cityHasCadastre === false) return 'no-cadastre';
        if (f.pointLoaded === true) return 'bare';
        return 'not-loaded';
    }

    // Whether the ground menu opens for this kind of ground.
    function opensMenu(kind) {
        return kind === 'bare' || kind === 'no-cadastre';
    }

    // facts: { kind, roadToolsEnabled, stationsEnabled }. Missing facts count as "not available".
    function isActionAvailable(action, facts) {
        const f = facts || {};
        if (!opensMenu(f.kind)) return false;
        if (action === 'drawSite') return true;
        if (action === 'road' || action === 'track') return f.roadToolsEnabled === true;
        if (Object.prototype.hasOwnProperty.call(STATION_ACTIONS, action)) return f.stationsEnabled === true;
        return false;
    }

    function availableActions(facts) {
        return ACTIONS.filter(action => isActionAvailable(action, facts));
    }

    // The i18n key and English fallback of the menu's title and facts line for a ground kind.
    function describeGround(kind) {
        if (kind === 'no-cadastre') {
            return {
                titleKey: 'groundMenu.title.noCadastre', title: 'Open ground',
                factsKey: 'groundMenu.facts.noCadastre', facts: 'No parcel data here. A proposal can only execute through an authority\'s verdict.'
            };
        }
        return {
            titleKey: 'groundMenu.title.bare', title: 'No parcel here',
            factsKey: 'groundMenu.facts.bare', facts: 'Unsurveyed ground or a gap between parcels: nobody\'s land that we know of.'
        };
    }

    return { ACTIONS, STATION_ACTIONS, classifyGroundClick, opensMenu, isActionAvailable, availableActions, describeGround };
});
