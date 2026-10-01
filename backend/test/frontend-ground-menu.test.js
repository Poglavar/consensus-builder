// The ground menu (frontend/js/ui/ground-menu-model.js + its UiCommands entries): a map click with no
// parcel under it opens the menu on BARE ground (a loaded cadastre with no parcel at the point) or in
// a city without a cadastre, never where the cadastre has simply not loaded yet; its actions are
// Draw a site here and the transport tools. Also the repository fact it reads
// (CadastralParcelRepository.isPointLoaded) and the site commands of the palette, parcel menu and
// selection tray. PARCEL-OPTIONAL.md, phase 2.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../../frontend/js/ui/ground-menu-model.js');
const ParcelMenuModel = require('../../frontend/js/ui/parcel-menu-model.js');
const UiCommands = require('../../frontend/js/ui/commands.js');
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');

describe('which ground a click hit', () => {
    it('is bare only where the cadastre is loaded and has no parcel', () => {
        expect(Model.classifyGroundClick({ cityHasCadastre: true, pointLoaded: true })).toBe('bare');
        expect(Model.classifyGroundClick({ cityHasCadastre: true, pointLoaded: false })).toBe('not-loaded');
        // Missing facts are unknown, never bare.
        expect(Model.classifyGroundClick({ cityHasCadastre: true })).toBe('not-loaded');
        expect(Model.classifyGroundClick({})).toBe('not-loaded');
        expect(Model.classifyGroundClick(null)).toBe('not-loaded');
    });

    it('is open ground everywhere in a city without a cadastre, and a parcel wins over everything', () => {
        expect(Model.classifyGroundClick({ cityHasCadastre: false, pointLoaded: false })).toBe('no-cadastre');
        expect(Model.classifyGroundClick({ hasParcelAtPoint: true, cityHasCadastre: false })).toBe('parcel');
    });

    it('opens the menu on bare ground and without a cadastre only', () => {
        expect(['bare', 'no-cadastre', 'not-loaded', 'parcel'].filter(Model.opensMenu)).toEqual(['bare', 'no-cadastre']);
    });
});

describe('ground menu actions', () => {
    const facts = extra => ({ kind: 'bare', roadToolsEnabled: true, stationsEnabled: true, ...extra });

    it('offers Draw a site first, then the transport tools, in menu order', () => {
        expect(Model.availableActions(facts()))
            .toEqual(['drawSite', 'road', 'track', 'busStation', 'tramStation', 'undergroundStation', 'elevatedStation']);
    });

    it('drops roads where road tools are off, stations where they are, and everything on unloaded ground', () => {
        expect(Model.availableActions(facts({ roadToolsEnabled: false }))).not.toContain('road');
        expect(Model.availableActions(facts({ stationsEnabled: undefined })))
            .toEqual(['drawSite', 'road', 'track']);
        expect(Model.availableActions(facts({ kind: 'not-loaded' }))).toEqual([]);
        expect(Model.availableActions(facts({ kind: 'no-cadastre' }))[0]).toBe('drawSite');
    });

    it('describes bare ground and ground without a cadastre differently', () => {
        expect(Model.describeGround('bare').titleKey).toBe('groundMenu.title.bare');
        expect(Model.describeGround('no-cadastre').factsKey).toBe('groundMenu.facts.noCadastre');
    });
});

describe('ground menu and site commands', () => {
    const ctx = (extra = {}) => ({ global: {}, isControlAvailable: () => true, ...extra });
    const ground = { kind: 'bare', roadToolsEnabled: true, stationsEnabled: false };

    it('lists the ground menu from the model, and nothing without ground facts', () => {
        expect(UiCommands.commandsFor('ground-menu', ctx({ ground })).map(c => c.id))
            .toEqual(['ground.drawSite', 'ground.road', 'ground.track']);
        expect(UiCommands.commandsFor('ground-menu', ctx())).toEqual([]);
        // Ground actions belong to the menu, not the palette (Draw site is the palette's).
        expect(UiCommands.commandsFor('palette', ctx({ ground })).map(c => c.id).filter(id => id.startsWith('ground.'))).toEqual([]);
    });

    it('runs a ground action through GroundMenu with the facts it was offered for', () => {
        const runAction = vi.fn();
        UiCommands.runCommand('ground.drawSite', { global: { GroundMenu: { runAction } }, ground });
        expect(runAction).toHaveBeenCalledWith('drawSite', ground);
        expect(() => UiCommands.runCommand('ground.road', { global: {}, ground })).toThrow(/GroundMenu/);
    });

    it('offers Draw site in the palette while the site tool is idle, and starts it', () => {
        const start = vi.fn();
        const idle = { SiteTool: { isActive: () => false, start } };
        expect(UiCommands.commandsFor('palette', ctx({ global: idle })).map(c => c.id)).toContain('site.draw');
        expect(UiCommands.commandsFor('palette', ctx({ global: { SiteTool: { isActive: () => true } } })).map(c => c.id)).not.toContain('site.draw');
        expect(UiCommands.commandsFor('palette', ctx()).map(c => c.id)).not.toContain('site.draw');
        UiCommands.runCommand('site.draw', { global: idle });
        expect(start).toHaveBeenCalledOnce();
    });

    it('offers Use as site on a parcel and on a selection while the site tool is idle', () => {
        const parcel = { parcelId: 'HR-1-1', siteToolAvailable: true };
        expect(ParcelMenuModel.isActionAvailable('useAsSite', parcel)).toBe(true);
        expect(ParcelMenuModel.isActionAvailable('useAsSite', { parcelId: 'HR-1-1' })).toBe(false);
        expect(UiCommands.commandsFor('parcel-menu', ctx({ parcel })).map(c => c.id)).toContain('parcel.useAsSite');

        const startFromSelection = vi.fn();
        const global = { SiteTool: { isActive: () => false, startFromSelection } };
        expect(UiCommands.commandsFor('selection-tray', ctx({ global, selection: { active: true, count: 2 } })).map(c => c.id))
            .toContain('selection.useAsSite');
        expect(UiCommands.commandsFor('selection-tray', ctx({ global, selection: { active: true, count: 0 } })).map(c => c.id))
            .not.toContain('selection.useAsSite');
        UiCommands.runCommand('selection.useAsSite', { global });
        expect(startFromSelection).toHaveBeenCalledOnce();
    });
});

describe('CadastralParcelRepository.isPointLoaded', () => {
    // One grid cell per whole degree (a stand-in for getRequiredGridCells).
    const cellOf = bounds => {
        const c = bounds.getCenter ? bounds.getCenter() : bounds.getSouthWest();
        return [`${Math.floor(c.lng)},${Math.floor(c.lat)}`];
    };
    const viewport = (lng, lat) => {
        const p = { lng, lat };
        return { getSouthWest: () => p, getNorthEast: () => p, getCenter: () => p };
    };

    function repository() {
        let release = null;
        const fetchBounds = vi.fn(() => new Promise(resolve => {
            release = () => resolve({ status: 'ready', complete: true, ids: [], features: [], absentIds: [] });
        }));
        const service = createCadastralParcelRepository({
            root: {},
            onFeatures: async () => {},
            convertFeatures: collection => collection,
            boundsKeysOf: cellOf,
            transport: { fetchBounds, fetchByIds: vi.fn(), fetchUnderGeometry: vi.fn(), fetchRoadIds: vi.fn(), supportsRoadIds: () => false },
            footprintOf: () => null,
            cadastreParcelIdsOf: () => [],
            coverageOf: () => ({ ids: [], coverage: 0 })
        });
        return { service, release: () => release() };
    }

    it('is false before the cell answered, while it is in flight, and outside it; true after', async () => {
        const { service, release } = repository();
        expect(service.isPointLoaded(15.5, 45.5)).toBe(false);
        const pending = service.ensureBounds(viewport(15.5, 45.5));
        await Promise.resolve();
        expect(service.isPointLoaded(15.5, 45.5)).toBe(false);
        release();
        await pending;
        expect(service.isPointLoaded(15.5, 45.5)).toBe(true);
        expect(service.isPointLoaded(15.2, 45.9)).toBe(true);
        expect(service.isPointLoaded(16.5, 45.5)).toBe(false);
        expect(service.isPointLoaded(NaN, 45.5)).toBe(false);
    });
});
