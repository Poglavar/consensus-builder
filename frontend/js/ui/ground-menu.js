// ui/ground-menu.js — what a map click on ground with no parcel can start: an unsurveyed hole, a gap
// between parcels, or anywhere in a city without a cadastre. Its actions are the UiCommands of the
// 'ground-menu' surface ("Draw a site here" and the transport tools that need no selection), shown
// in the click stack's Ground section (click-stack.md), which replaced the popover. Which ground a
// click hit is decided by the pure ui/ground-menu-model.js; "not loaded yet" is not bare ground.
(function (win) {
    'use strict';

    const model = win.GroundMenuModel;

    // ---- facts ----

    function cityHasCadastre() {
        const config = win.CityConfigManager;
        if (config && typeof config.hasParcelData === 'function') return !!config.hasParcelData();
        return true;
    }

    function roadToolsEnabled() {
        const config = win.CityConfigManager;
        const enabled = config && typeof config.isFeatureEnabled === 'function' ? config.isFeatureEnabled('roadTools') : true;
        return enabled !== false && typeof win.startParcelTransportTool === 'function';
    }

    function factsAt(latlng) {
        const repository = win.CadastralParcelRepository;
        const kind = model.classifyGroundClick({
            hasParcelAtPoint: false,
            cityHasCadastre: cityHasCadastre(),
            pointLoaded: !!(repository && typeof repository.isPointLoaded === 'function'
                && repository.isPointLoaded(latlng.lng, latlng.lat))
        });
        return {
            kind,
            lat: latlng.lat,
            lng: latlng.lng,
            roadToolsEnabled: roadToolsEnabled(),
            stationsEnabled: typeof win.startTransitStationPlacement === 'function'
        };
    }

    // The ground the click stack's Ground section shows, for the commands that act on it.
    function contextFacts() {
        const stack = win.ClickStack?.current?.();
        const point = win.ClickStack?.point?.();
        return stack && stack.expanded === 'ground' && point ? factsAt(point) : null;
    }

    const RUNNERS = {
        drawSite: facts => win.SiteTool.start({ ground: facts.kind }),
        road: () => win.startParcelTransportTool('road'),
        track: () => win.startParcelTransportTool('track')
    };

    function runAction(action, facts) {
        if (!facts) throw new Error(`GroundMenu: ${action} needs ground facts`);
        const station = model.STATION_ACTIONS[action];
        if (station === 'bus') return win.startTransitStationPlacement(station);
        if (station === 'track') return win.chooseTrackStationType();
        const runner = RUNNERS[action];
        if (!runner) throw new Error(`GroundMenu: unknown action ${action}`);
        return runner(facts);
    }

    // Bare ground (an unsurveyed hole, or anywhere in a city without a cadastre): the click stack's
    // Ground section. Cadastre that has not loaded yet is not bare ground.
    const isBareGround = latlng => !!latlng && model.opensMenu(factsAt(latlng).kind);
    win.GroundMenu = { contextFacts, runAction, factsAt, isBareGround };
})(window);
