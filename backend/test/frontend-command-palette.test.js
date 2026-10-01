// The command palette (frontend/js/ui/command-palette.js) over the command registry: every palette
// command is listed, grouped in registry order, filtered by the query; commands whose when() is
// false stay visible but unavailable, with the reason when the registry can tell.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const UiCommands = require('../../frontend/js/ui/commands.js');
const Palette = require('../../frontend/js/ui/command-palette.js');

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const en = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.json'), 'utf8'));
const tEn = key => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), en) ?? key;

const fakeCtx = (unavailable = {}) => ({
    global: {},
    isControlAvailable: id => !(id in unavailable),
    controlUnavailableReason: id => unavailable[id] || null
});
const groupOrder = Palette.registryGroupOrder(UiCommands.listCommands());
const view = (query, ctx = fakeCtx()) => Palette.groupPaletteItems(UiCommands.rankCommands(query, ctx, tEn), groupOrder, { query });

describe('command palette', () => {
    it('lists every palette command when the query is empty, grouped in registry order', () => {
        const groups = view('');
        const paletteCount = UiCommands.listCommands().filter(entry => entry.surfaces.includes('palette')).length;
        expect(groups.flatMap(g => g.items)).toHaveLength(paletteCount);
        expect(groups.map(g => g.group)).toEqual(groupOrder.filter(group => groups.some(g => g.group === group)));
        expect(groups[0].group).toBe('layers');
    });

    it('leaves out the command that opens the palette itself', () => {
        expect(view('').flatMap(g => g.items).map(i => i.entry.id)).not.toContain('settings.commandPalette');
        expect(UiCommands.findCommand('settings.commandPalette').surfaces).toEqual(['settings']);
    });

    it('filters by the query and puts the group with the best match first', () => {
        const groups = view('measure');
        expect(groups[0].group).toBe('tools');
        expect(groups[0].items[0].entry.id).toBe('tools.measure');
        expect(groups.flatMap(g => g.items).every(i => /measure/i.test(i.label) || /measure/i.test(i.entry.id))).toBe(true);
    });

    it('keeps an unavailable command visible, after the available ones, with the reason', () => {
        const ctx = fakeCtx({ measureButton: 'disabledIn3D' });
        const tools = view('measure', ctx).find(g => g.group === 'tools').items;
        const measure = tools.find(i => i.entry.id === 'tools.measure');
        expect(measure).toMatchObject({ available: false, reason: 'disabledIn3D' });
        expect(tools[tools.length - 1].entry.id).toBe('tools.measure');
        // The search box only offers what can run.
        expect(UiCommands.searchCommands('measure', ctx, tEn).map(e => e.id)).not.toContain('tools.measure');
    });

    it('has no reason for a command the registry cannot explain', () => {
        const ranked = UiCommands.rankCommands('', { global: {}, isControlAvailable: () => false }, tEn);
        const measure = ranked.find(i => i.entry.id === 'tools.measure');
        expect(measure).toMatchObject({ available: false, reason: null });
        const global = ranked.find(i => i.entry.id === 'proposals.list');
        expect(global.available).toBe(true);
    });

    it('does not let a group of only unavailable matches outrank an available one', () => {
        const ctx = fakeCtx({ measureButton: 'disabled', pinpointButton: 'disabled', clearMeasurementsButton: 'disabled' });
        const groups = Palette.groupPaletteItems([
            { entry: { group: 'tools' }, label: 'Measure', rank: 0, available: false },
            { entry: { group: 'roads' }, label: 'Measure road', rank: 1, available: true }
        ], groupOrder, { query: 'measure' });
        expect(groups.map(g => g.group)).toEqual(['roads', 'tools']);
        expect(ctx.controlUnavailableReason('measureButton')).toBe('disabled');
    });

    it('runs the search box and city commands through their new homes', () => {
        const calls = [];
        const ctx = {
            global: {
                MapSearch: { focus: () => calls.push('focus'), showCities: () => calls.push('cities') },
                CityConfigManager: { detectNearestCity: () => calls.push('detect') }
            }
        };
        UiCommands.runCommand('parcels.locate', ctx);
        UiCommands.runCommand('settings.city', ctx);
        UiCommands.runCommand('settings.detectCity', ctx);
        expect(calls).toEqual(['focus', 'cities', 'detect']);
        expect(() => UiCommands.runCommand('parcels.locate', { global: {} })).toThrow(/MapSearch\.focus/);
    });
});
