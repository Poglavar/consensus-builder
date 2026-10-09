// The UI command registry (frontend/js/ui/commands.js) and the floating shell that replaced the left
// sidebar (frontend/js/ui/map-shell.js, UI-REWORK.md). The registry names every capability the map
// UI offers; these tests fail when a capability has nowhere to appear, when a control the old sidebar
// held (and existing code still finds by id) goes missing from index.html, when an inline handler in
// the sheets has no command, when a label is untranslated, and when the sidebar comes back.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const UiCommands = require('../../frontend/js/ui/commands.js');
const MapShell = require('../../frontend/js/ui/map-shell.js');

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const indexHtml = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const LANGS = ['en', 'hr', 'es', 'sr'];
const dictionaries = Object.fromEntries(LANGS.map(lang => [
    lang, JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', `${lang}.json`), 'utf8'))
]));
const lookup = (dict, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
const tEn = key => lookup(dictionaries.en, key) ?? key;

const commands = UiCommands.listCommands();

// The markup of the floating shell (buttons and sheets).
const shellStart = indexHtml.indexOf('<!-- ===== Floating map shell');
const shellEnd = indexHtml.indexOf('<!-- ===== End floating map shell ===== -->');
const shellHtml = indexHtml.slice(shellStart, shellEnd);

function attr(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
    return match ? match[1] : (new RegExp(`\\s${name}(\\s|>|$)`).test(tag) ? '' : null);
}

const openingTags = (html, tagName) => [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'g'))].map(m => m[0]);

// Interactive controls in the sheets that are deliberately NOT commands, and why.
const NOT_COMMANDS = {
    // View controls now follow the search/user row in DOM order, inside the floating shell's
    // markup range; their handlers belong to the map view rather than the sheet registry.
    'mode-walk-toggle': 'map view control',
    'cadastre-view-toggle': 'map view control',
    'mode-2d-toggle': 'map view control',
    'mode-3d-toggle': 'map view control',
    'mode-realistic-toggle': 'map view control',
    'mode-ai-toggle': 'map view control',
    areaMonitorUploadButton: 'permanently disabled (upload not built)',
    'urban-blocks-browse': 'permanently disabled (browse is not built)',
    showClaimsCounts: 'permanently disabled (claims counts not built)',
    'aerial-city-visible': 'aerial renderer control created by the world view',
    'area-monitor-drawing-undo': 'transient area drawing toolbar action',
    'area-monitor-drawing-cancel': 'transient area drawing toolbar action',
    'dev-badge': 'indicator, not an action',
    'debug-badge': 'indicator, not an action',
    'version-badge': 'indicator, not an action',
    ...Object.fromEntries([0, 1, 2, 3, 4, 5].flatMap(i => [
        [`legend-min-${i}`, 'road legend threshold input'], [`legend-max-${i}`, 'road legend threshold input']
    ]))
};
// Inline handlers in the sheets that are not commands, and why.
const NOT_COMMAND_HANDLERS = {
    hideBlocksList: 'closes the block list inside the sheet',
    detectRoadsUsingAI: 'button permanently disabled; the function does not exist',
    algorithmicRoads: 'button permanently disabled; the function does not exist'
};

describe('command registry shape', () => {
    it('has commands, each with at least one known surface', () => {
        expect(commands.length).toBeGreaterThan(50);
        for (const entry of commands) {
            expect(entry.surfaces.length, `${entry.id} has no surface`).toBeGreaterThan(0);
            for (const surface of entry.surfaces) {
                expect(UiCommands.SURFACES, `${entry.id}: unknown surface ${surface}`).toContain(surface);
            }
        }
    });

    it('gives every command a unique id and the fields the surfaces render', () => {
        const ids = commands.map(entry => entry.id);
        expect(new Set(ids).size, 'duplicate command ids').toBe(ids.length);
        for (const entry of commands) {
            expect(typeof entry.group, entry.id).toBe('string');
            expect(typeof entry.labelKey, entry.id).toBe('string');
            expect(entry.fallbackLabel, entry.id).toBeTruthy();
            expect(typeof entry.run, entry.id).toBe('function');
            expect(typeof entry.when, entry.id).toBe('function');
            expect(entry.icon, entry.id).toMatch(/^fas fa-[a-z0-9-]+$/);
        }
    });

    it('uses only icons the vendored Font Awesome 6.4 has', () => {
        const css = fs.readFileSync(path.join(FRONTEND, 'vendor/fontawesome-6.4.0/css/all.min.css'), 'utf8');
        for (const entry of commands) {
            const name = entry.icon.split(' ')[1];
            expect(css.includes(`.${name}:before`) || css.includes(`.${name},`), `${entry.id}: ${name}`).toBe(true);
        }
    });

    it('has every label translated in all four locales', () => {
        for (const entry of commands) {
            for (const lang of LANGS) {
                const value = lookup(dictionaries[lang], entry.labelKey);
                expect(typeof value, `${lang}: ${entry.labelKey} (${entry.id})`).toBe('string');
                expect(value.length, `${lang}: ${entry.labelKey}`).toBeGreaterThan(0);
            }
        }
    });
});

describe('rehoused sidebar controls', () => {
    it('lists each control once', () => {
        const ids = UiCommands.REHOUSED_CONTROL_IDS;
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps every control id in index.html, exactly once', () => {
        for (const id of UiCommands.REHOUSED_CONTROL_IDS) {
            const count = indexHtml.split(`id="${id}"`).length - 1;
            expect(count, `#${id} in index.html`).toBe(1);
        }
    });

    it('backs every command that drives a control with a control that exists', () => {
        for (const entry of commands.filter(c => c.control)) {
            expect(indexHtml, `${entry.id} -> #${entry.control}`).toContain(`id="${entry.control}"`);
        }
    });

    it('keeps the selectors existing code uses to find sidebar controls', () => {
        expect(openingTags(shellHtml, 'input').filter(tag => /class="ownership-type-checkbox"/.test(tag))).toHaveLength(4);
        expect(shellHtml).toContain('data-site-intro-open');
        for (const handler of ['countBlocks()', 'animateFloodfillFromSelected()', 'clearBlocks()']) {
            expect(shellHtml, `updateBlockButtonStates finds button[onclick="${handler}"]`).toContain(`onclick="${handler}"`);
        }
        expect(UiCommands.SURFACES).not.toContain('tools');
        expect(UiCommands.SURFACES).toContain('measurement');
    });

    it('turns every interactive control in the sheets into a command, or says why not', () => {
        const byControl = new Set(commands.map(c => c.control).filter(Boolean));
        const calls = new Set(commands.map(c => c.run.calls).filter(Boolean));
        const uncovered = [];
        for (const tagName of ['button', 'input', 'select']) {
            for (const tag of openingTags(shellHtml, tagName)) {
                const id = attr(tag, 'id');
                if (id && (byControl.has(id) || NOT_COMMANDS[id])) continue;
                if (tagName === 'button' && attr(tag, 'data-sheet-target') !== null) continue; // shell buttons
                if (tagName === 'button' && attr(tag, 'data-sheet-close') !== null) continue;
                if (tagName === 'button' && attr(tag, 'data-site-intro-open') !== null) {
                    if (commands.some(c => c.id === 'settings.siteIntro')) continue;
                }
                const handler = attr(tag, 'onclick') || '';
                const names = handler.match(/[A-Za-z_$][\w$]*/g) || [];
                if (names.some(name => calls.has(name) || NOT_COMMAND_HANDLERS[name])) continue;
                uncovered.push(tag.slice(0, 120));
            }
        }
        expect(uncovered, 'controls with no command').toEqual([]);
    });
});

describe('availability and search', () => {
    const fakeCtx = (unavailable = []) => ({
        global: {},
        isControlAvailable: id => !unavailable.includes(id)
    });

    it('commandsFor keeps a surface to its commands and respects when()', () => {
        const measurement = UiCommands.commandsFor('measurement', fakeCtx()).map(c => c.id);
        expect(measurement).toContain('tools.measure');
        expect(measurement).not.toContain('layers.parcels');

        const withoutMeasure = UiCommands.commandsFor('measurement', fakeCtx(['measureButton'])).map(c => c.id);
        expect(withoutMeasure).not.toContain('tools.measure');
        expect(withoutMeasure).toContain('tools.pinpoint');
    });

    it('puts the explorer and the simulation on the Activity sheet surface, and in the palette', () => {
        const activity = UiCommands.commandsFor('activity', fakeCtx()).map(c => c.id);
        expect(activity).toEqual(expect.arrayContaining(['activity.explorer',
            'game.enable', 'game.playPause', 'game.interval', 'game.new']));
        expect(UiCommands.SURFACES).not.toContain('game');
        const palette = UiCommands.commandsFor('palette', fakeCtx()).map(c => c.id);
        expect(palette).toEqual(expect.arrayContaining(['activity.explorer', 'game.playPause']));
        // A city that hides the game section loses the simulation, not the explorer.
        const noGame = { ...fakeCtx(), isSectionHidden: section => section === 'game' };
        const withoutGame = UiCommands.commandsFor('activity', noGame).map(c => c.id);
        expect(withoutGame).toEqual(expect.arrayContaining(['activity.explorer']));
        expect(withoutGame.filter(id => id.startsWith('game.'))).toEqual([]);
    });

    it('keeps watched-area access available in every map mode and reveals its inline list', () => {
        const list = UiCommands.findCommand('areaMonitor.list');
        expect(list.surfaces).toContain('activity');
        expect(list.modes).toEqual(['2d', '3d', 'photo']);
        expect(UiCommands.REHOUSED_CONTROL_IDS).not.toContain('areaMonitorListButton');
        for (const mode of ['2d', '3d', 'photo']) {
            const ctx = { mode, global: {}, isControlAvailable: id => id === 'activity-watched-areas-list', revealControl: vi.fn() };
            expect(UiCommands.isAvailable('areaMonitor.list', ctx)).toBe(true);
            UiCommands.runCommand('areaMonitor.list', ctx);
            expect(ctx.revealControl).toHaveBeenCalledWith('activity-watched-areas-list');
        }
    });

    it('places the city road-plan toggle on Layers', () => {
        expect(UiCommands.findCommand('areaMonitor.cityPlan').surfaces).toContain('layers');
        expect(UiCommands.findCommand('areaMonitor.cityPlan').surfaces).not.toContain('activity');
    });

    it('places map data sources and parcel refresh on 2D Layers, with diagnostics in Settings', () => {
        const layers = UiCommands.commandsFor('layers', fakeCtx()).map(c => c.id);
        const settings = UiCommands.commandsFor('settings', fakeCtx()).map(c => c.id);
        expect(layers).toEqual(expect.arrayContaining([
            'settings.parcelSourceSettings', 'settings.buildingSourceSettings', 'settings.baseMap', 'parcels.refresh'
        ]));
        expect(settings).toEqual(expect.arrayContaining(['parcels.coverage', 'settings.dataSource']));
        expect(settings).not.toContain('parcels.refresh');
        const model = { mode: 'model', global: {} };
        for (const id of ['parcels.coverage', 'parcels.refresh', 'settings.dataSource', 'settings.baseMap']) {
            expect(UiCommands.supportsMode(id, model), id).toBe(false);
        }
    });

    it('treats a throwing when() as unavailable instead of breaking the surface', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const ctx = { global: {}, isControlAvailable: () => { throw new Error('boom'); } };
        expect(UiCommands.commandsFor('layers', ctx).map(c => c.id)).not.toContain('layers.parcels');
        expect(UiCommands.commandsFor('settings', ctx).map(c => c.id)).toContain('settings.siteIntro'); // no when() of its own
        warn.mockRestore();
    });

    it('ranks an exact label first, then prefixes, then word starts, then substrings', () => {
        expect(UiCommands.searchCommands('measure', fakeCtx(), tEn)[0].id).toBe('tools.measure');
        const mea = UiCommands.searchCommands('mea', fakeCtx(), tEn).map(c => c.id);
        expect(mea[0]).toBe('tools.measure');
        expect(mea).toContain('tools.clearMeasurements');
        expect(mea.indexOf('tools.clearMeasurements')).toBeGreaterThan(mea.indexOf('tools.measure'));
        expect(UiCommands.searchCommands('parcel ids', fakeCtx(), tEn)[0].id).toBe('layers.parcelIds');
    });

    it('lists a group\'s commands before a mid-word label hit ("lay" → Layers before "Play")', () => {
        const ranked = UiCommands.rankCommands('lay', fakeCtx(), tEn);
        const firstLayers = ranked.findIndex(item => item.entry.group === 'layers');
        const play = ranked.findIndex(item => /play/i.test(item.label));
        expect(firstLayers).toBeGreaterThanOrEqual(0);
        expect(play).toBeGreaterThan(firstLayers);
        // A raw key from a translator without the group string never matches its key words.
        expect(UiCommands.rankCommands('palette', fakeCtx(), key => key).every(item => !/^layers\./.test(item.entry.id))).toBe(true);
    });

    it('searches the translated label, accent-insensitively, and falls back to English', () => {
        const tHr = key => lookup(dictionaries.hr, key) ?? key;
        expect(UiCommands.searchCommands('podloga', fakeCtx(), tHr).map(c => c.id)).toContain('settings.baseMap');
        expect(UiCommands.searchCommands('drzavne', fakeCtx(), tHr).map(c => c.id)).toContain('layers.ownership.government');
        const noTranslations = key => key;
        expect(UiCommands.searchCommands('base map', fakeCtx(), noTranslations)[0].id).toBe('settings.baseMap');
    });

    it('matches by id when the label does not, and leaves out what is unavailable', () => {
        expect(UiCommands.searchCommands('areaMonitor.list', fakeCtx(), tEn).map(c => c.id)).toEqual(['areaMonitor.list']);
        expect(UiCommands.searchCommands('measure', fakeCtx(['measureButton']), tEn).map(c => c.id)).not.toContain('tools.measure');
        expect(UiCommands.searchCommands('zzzz-no-such-thing', fakeCtx(), tEn)).toEqual([]);
    });

    it('shares the 2D capability rule across command listing, ranking, and execution', () => {
        const model = { mode: 'model', global: { isThreeModeActive: () => true } };
        for (const id of ['stations.bus', 'site.draw', 'tools.measure', 'parcel.propose', 'selection.propose']) {
            expect(UiCommands.supportsMode(id, model), id).toBe(false);
            expect(UiCommands.isAvailable(id, model), id).toBe(false);
            expect(UiCommands.rankCommands(id, model, tEn).map(item => item.entry.id)).not.toContain(id);
            expect(UiCommands.runCommand(id, model), id).toBe(false);
        }
        const browse3d = { ...model, global: { showAllProposalsModal: vi.fn(), openBetsSheet: vi.fn(), showGameLogDialog: vi.fn() } };
        for (const id of ['proposals.list', 'bets.open', 'activity.explorer']) {
            expect(UiCommands.isAvailable(id, browse3d), id).toBe(true);
        }
    });

    it('requires parcel or open-ground context for global station placement', () => {
        const global = { startTransitStationPlacement: vi.fn() };
        expect(UiCommands.isAvailable('stations.bus', { mode: '2d', global })).toBe(false);
        const onParcel = { mode: '2d', global, parcel: { parcelId: 'p-1', isRoad: false } };
        expect(UiCommands.isAvailable('stations.bus', onParcel)).toBe(true);
        UiCommands.runCommand('stations.bus', onParcel);
        expect(global.startTransitStationPlacement).toHaveBeenCalledWith('bus');
    });

    it('keeps selection proposal dispatch behind a nonempty selection gate', () => {
        const global = { SelectionTray: { propose: vi.fn() } };
        const ctx = { mode: '2d', global, selection: { active: false, count: 0 } };
        expect(UiCommands.isAvailable('selection.propose', ctx)).toBe(false);
        expect(UiCommands.runCommand('selection.propose', ctx)).toBe(false);
        expect(global.SelectionTray.propose).not.toHaveBeenCalled();
    });

    it('honors explicit data-map-modes on control containers while a sheet is closed', () => {
        const sheet = {
            style: { display: 'none' },
            parentElement: null,
            classList: { contains: name => name === 'map-sheet' },
            getAttribute: () => null
        };
        const section = {
            style: {}, parentElement: sheet,
            classList: { contains: () => false },
            getAttribute: name => name === 'data-map-modes' ? '2d' : null
        };
        const control = {
            disabled: false,
            style: {},
            parentElement: section,
            classList: { contains: () => false },
            getAttribute: () => null,
            hasAttribute: () => false
        };
        const body = { classList: { contains: () => false } };
        sheet.parentElement = body;
        const doc = { body, getElementById: id => id === 'measureButton' ? control : null };
        const win = { document: doc, __mapModeState: { desired: 'model' } };
        const ctx = UiCommands.createBrowserContext(win);
        expect(ctx.mode).toBe('model');
        expect(ctx.isControlAvailable('measureButton')).toBe(false);
        expect(ctx.controlUnavailableReason('measureButton')).toBe('disabledIn3D');
        section.getAttribute = name => name === 'data-map-modes' ? '2d model photo' : null;
        expect(ctx.isControlAvailable('measureButton')).toBe(true);
    });
});

describe('running commands', () => {
    it('calls the existing global, with its arguments', () => {
        const showAllProposalsModal = vi.fn();
        const showGameLogDialog = vi.fn();
        const ctx = { global: { showAllProposalsModal, showGameLogDialog } };
        UiCommands.runCommand('proposals.list', ctx);
        UiCommands.runCommand('activity.explorer', ctx);
        expect(showAllProposalsModal).toHaveBeenCalledOnce();
        expect(showGameLogDialog).toHaveBeenCalledOnce();
    });

    it('drives the rehoused control: clicks toggles and buttons, reveals inputs', () => {
        const clickControl = vi.fn();
        const revealControl = vi.fn();
        const ctx = { global: {}, clickControl, revealControl };
        UiCommands.runCommand('layers.parcels', ctx);
        UiCommands.runCommand('tools.measure', ctx);
        UiCommands.runCommand('settings.baseMap', ctx);
        expect(clickControl.mock.calls).toEqual([['parcelsCheckbox'], ['measureButton']]);
        expect(revealControl).toHaveBeenCalledWith('tile-source-select');
    });

    it('opens parcel source settings from the shortcut palette command', () => {
        const clickControl = vi.fn();
        const entry = UiCommands.findCommand('settings.parcelSourceSettings');
        expect(entry.surfaces).toContain('palette');
        expect(entry.control).toBe('parcel-source-settings-button');
        UiCommands.runCommand(entry.id, { global: {}, clickControl });
        expect(clickControl).toHaveBeenCalledWith('parcel-source-settings-button');
    });

    it('fails loudly when the global it needs is missing', () => {
        expect(() => UiCommands.runCommand('blocks.reform', { global: {} })).toThrow(/countBlocks/);
        expect(() => UiCommands.runCommand('no.such.command', { global: {} })).toThrow(/unknown command/);
    });
});

describe('the floating shell', () => {
    it('wires every shell button to a sheet that exists', () => {
        const sheets = new Set(openingTags(shellHtml, 'section')
            .filter(tag => /class="map-sheet\b/.test(tag)).map(tag => attr(tag, 'id')));
        expect([...sheets].sort()).toEqual(['activity-sheet', 'bets-sheet', 'layers-sheet', 'measurement-sheet', 'proposals-sheet', 'settings-sheet']);
        const triggers = openingTags(shellHtml, 'button').filter(tag => attr(tag, 'data-sheet-target') !== null);
        expect(triggers.length).toBe(6);
        for (const tag of triggers) {
            const target = attr(tag, 'data-sheet-target');
            expect(sheets.has(target), target).toBe(true);
            expect(attr(tag, 'aria-controls')).toBe(target);
            expect(attr(tag, 'aria-expanded')).toBe('false');
        }
    });

    it('leaves the hooks later phases mount into', () => {
        expect(indexHtml).toContain('id="map-search-slot"');
        expect(indexHtml).toContain('id="selection-tray-slot"');
    });

    it('opens a popover below a top button and above a bottom one, aligned to its side', () => {
        const viewport = { width: 1200, height: 800 };
        const topRight = MapShell.placePopover({ top: 10, bottom: 50, left: 1100, right: 1140, width: 40, height: 40 }, viewport);
        expect(topRight).toMatchObject({ top: 58, bottom: null, right: 60, left: null, maxHeight: 732 });
        const bottomLeft = MapShell.placePopover({ top: 736, bottom: 776, left: 10, right: 210, width: 200, height: 40 }, viewport);
        expect(bottomLeft).toMatchObject({ top: null, bottom: 72, left: 10, right: null, maxHeight: 718 });
    });

    it('never gives a popover less than a usable height', () => {
        const cramped = MapShell.placePopover({ top: 20, bottom: 60, left: 10, right: 50, width: 40, height: 40 }, { width: 400, height: 100 });
        expect(cramped.maxHeight).toBe(120);
    });

    // A press on the map folds the sheet away; a press inside a dialog opened on top of the sheet
    // (the stake dialog, the wallet picker) must not, or a bet lands the person back on the bare map.
    it('closes the sheet on an outside press, but not while a dialog is open on top of it', () => {
        const node = (inside = []) => ({ contains: other => inside.includes(other), closest: () => null });
        const target = node();
        const sheet = node([target]);
        const trigger = node([target]);
        const sheetButton = { contains: () => false, closest: selector => (selector === '[data-sheet-target]' ? {} : null) };
        const map = node();
        expect(MapShell.pointerDownClosesSheet({ sheet: node(), trigger: null, target: map, blockingDialogOpen: false })).toBe(true);
        expect(MapShell.pointerDownClosesSheet({ sheet, trigger: null, target, blockingDialogOpen: false })).toBe(false);
        expect(MapShell.pointerDownClosesSheet({ sheet: node(), trigger, target, blockingDialogOpen: false })).toBe(false);
        expect(MapShell.pointerDownClosesSheet({ sheet: node(), trigger: null, target: sheetButton, blockingDialogOpen: false })).toBe(false);
        expect(MapShell.pointerDownClosesSheet({ sheet: node(), trigger: null, target: map, blockingDialogOpen: true })).toBe(false);
        expect(MapShell.pointerDownClosesSheet({ sheet: null, trigger: null, target: map, blockingDialogOpen: false })).toBe(false);
    });
});

describe('the sidebar is gone', () => {
    function walk(dir, out = []) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['vendor', 'node_modules', 'i18n'].includes(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, out);
            else if (/\.(js|html|css)$/.test(entry.name)) out.push(full);
        }
        return out;
    }

    it('has no #sidebar, toggleSidebar() or setSidebarDisabled() anywhere in the frontend', () => {
        const offenders = [];
        for (const file of walk(FRONTEND)) {
            const text = fs.readFileSync(file, 'utf8');
            for (const needle of ['id="sidebar"', 'toggleSidebar(', 'setSidebarDisabled(', "getElementById('sidebar')", '#sidebar']) {
                // #sidebar-… ids (e.g. #sidebar-scrollable-content) are gone too; other *-sidebar ids
                // (#blockify-sidebar) are unrelated dialogs.
                if (text.includes(needle)) offenders.push(`${path.relative(FRONTEND, file)}: ${needle}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
