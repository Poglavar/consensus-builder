// The Settings sheet's "Data & maintenance" section (UI-REWORK.md, Phase 6): local-cache upkeep
// (parcel coverage/clear, block/road/proposal clears, wipe all) lives there and nowhere else in the
// shell; source selectors and parcel refresh live with Layers. Each dataset's upkeep stays in its
// own data-section wrapper so a city that hides
// the section hides it too; and runWithButtonBusyState gives a sheet button back its icon and
// translatable label span after a busy run instead of flattening it to text.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const UiCommands = require('../../frontend/js/ui/commands.js');

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const indexHtml = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

// The markup of one sheet, from its <section id="…"> to the next sheet or the end of the shell.
function sheetHtml(id) {
    const start = indexHtml.indexOf(`<section id="${id}"`);
    expect(start, id).toBeGreaterThan(-1);
    const tags = /<\/?section\b[^>]*>/g; tags.lastIndex = start;
    let depth = 0, match;
    while ((match = tags.exec(indexHtml))) {
        depth += match[0].startsWith('</') ? -1 : 1;
        if (!depth) return indexHtml.slice(start, tags.lastIndex);
    }
    throw new Error('Unclosed sheet');
}

const MAINTENANCE = [
    { marker: 'id="showParcelCoverageButton"', section: 'parcels', command: 'parcels.coverage' },
    { marker: 'clearLocalParcelData', section: 'parcels', command: 'parcels.clearLocal' },
    { marker: 'onclick="clearBlocks()"', section: 'blocks', command: 'blocks.clear' },
    { marker: 'onclick="clearDetectedRoads()"', section: 'roads', command: 'roads.clear' },
    { marker: 'id="wipeLocalDataButton"', section: 'data', command: 'settings.wipeLocalData' }
];

const LAYERS_DATA_ACTIONS = [
    { marker: 'id="parcel-source-settings-button"', command: 'settings.parcelSourceSettings' },
    { marker: 'id="building-source-settings-button"', command: 'settings.buildingSourceSettings' },
    { marker: 'id="refreshParcelDataButton"', command: 'parcels.refresh' },
    { marker: 'id="tile-source-select"', command: 'settings.baseMap' }
];

describe('Data & maintenance section', () => {
    const settings = sheetHtml('settings-sheet');

    it('holds every local-cache action, and no other sheet does', () => {
        for (const { marker } of MAINTENANCE) {
            expect(settings, marker).toContain(marker);
            for (const other of ['layers-sheet', 'measurement-sheet', 'proposals-sheet', 'bets-sheet', 'activity-sheet']) {
                expect(sheetHtml(other), `${marker} in ${other}`).not.toContain(marker);
            }
        }
    });

    it('wraps each dataset’s upkeep in that dataset’s section, so the city config hides it with the section', () => {
        // (Wipe all sits in the Data section itself, after the per-dataset wrappers close.)
        for (const { marker, section } of MAINTENANCE.filter(item => item.section !== 'data')) {
            const at = settings.indexOf(marker);
            const opener = settings.lastIndexOf(`data-section="`, at);
            expect(settings.slice(opener, settings.indexOf('"', opener + 14) + 1), marker).toBe(`data-section="${section}"`);
        }
    });

    it('lists maintenance actions on the Settings surface (and the palette), not on Layers/Proposals', () => {
        for (const { command } of MAINTENANCE) {
            const entry = UiCommands.findCommand(command);
            expect(entry, command).toBeTruthy();
            expect(entry.surfaces, command).toEqual(expect.arrayContaining(['settings', 'palette']));
            for (const surface of ['layers', 'tools', 'proposals']) expect(entry.surfaces, command).not.toContain(surface);
        }
    });

    it('keeps parcel refresh and map sources with Layers and removes the global data-source switch', () => {
        const layers = sheetHtml('layers-sheet');
        for (const { marker, command } of LAYERS_DATA_ACTIONS) {
            expect(layers, marker).toContain(marker);
            const entry = UiCommands.findCommand(command);
            expect(entry, command).toBeTruthy();
            expect(entry.surfaces, command).toContain('layers');
            expect(entry.surfaces, command).not.toContain('settings');
        }
        const settings = sheetHtml('settings-sheet');
        expect(settings).not.toContain('id="data-source-select"');
        expect(UiCommands.findCommand('settings.dataSource')).toBeFalsy();
        expect(UiCommands.findCommand('parcels.coverage').surfaces).toContain('settings');
        expect(UiCommands.findCommand('parcels.coverage').modes).toEqual(['2d']);
    });

    it('offers the per-dataset clears in the palette only in debug mode, like the sheet', () => {
        // The sheet hides them outside debug mode (.btn-danger); the palette used to offer them anyway.
        const clears = ['parcels.clearLocal', 'blocks.clear', 'roads.clear'];
        const ctx = debug => ({ global: {}, isControlAvailable: () => true, isDebugMode: () => debug });
        const ids = debug => UiCommands.commandsFor('palette', ctx(debug)).map(c => c.id);
        for (const id of clears) {
            expect(ids(true), id).toContain(id);
            expect(ids(false), id).not.toContain(id);
            const ranked = UiCommands.rankCommands('clear', ctx(false), null).find(item => item.entry.id === id);
            expect(ranked, id).toMatchObject({ available: false, reason: 'debugOnly' });
        }
        // Wipe ALL is always visible in the sheet, so it stays available outside debug mode.
        expect(ids(false)).toContain('settings.wipeLocalData');
        // Every debug-only command is backed by a .btn-danger in the Settings sheet.
        for (const id of clears) {
            const marker = MAINTENANCE.find(item => item.command === id).marker;
            const at = settings.indexOf(marker);
            const tag = settings.slice(settings.lastIndexOf('<button', at), settings.indexOf('>', at));
            expect(tag, id).toContain('btn-danger');
        }
    });

    it('keeps Advanced as the only accordion and leaves upkeep wrappers flat', () => {
        const settings = sheetHtml('settings-sheet');
        const groups = [...settings.matchAll(/<details\b([^>]*)>/g)].flatMap(([, attributes]) => {
            const classes = attributes.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) || [];
            const section = attributes.match(/\bdata-section="([^"]+)"/)?.[1];
            return classes.includes('accordion-section') && section ? [section] : [];
        });
        expect(groups).toEqual(['advanced']);
        const upkeepWrappers = [...settings.matchAll(/<[^>]+data-section="(?:parcels|blocks|roads|proposals)"[^>]*>/g)]
            .map(match => match[0]);
        expect(upkeepWrappers.length).toBeGreaterThanOrEqual(3);
        for (const wrapper of upkeepWrappers) expect(wrapper).not.toContain('accordion-section');
    });
});

describe('runWithButtonBusyState', () => {
    const source = fs.readFileSync(path.join(FRONTEND, 'js/ui-helpers.js'), 'utf8');
    const start = source.indexOf('function runWithButtonBusyState(');
    const end = source.indexOf('\n}\n', start) + 2;
    // eslint-disable-next-line no-new-func
    const factory = new Function('window', `${source.slice(start, end)}\nreturn runWithButtonBusyState;`);

    function fakeButton(html) {
        const classes = new Set();
        const attrs = new Map();
        return {
            innerHTML: html,
            disabled: false,
            classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
            getAttribute: name => attrs.get(name) ?? null,
            setAttribute: (name, value) => attrs.set(name, value),
            removeAttribute: name => attrs.delete(name),
            focus() { },
            get textContent() { return this.innerHTML.replace(/<[^>]+>/g, ''); },
            set textContent(value) { this.innerHTML = String(value); }
        };
    }

    const markup = '<i class="fas fa-rotate" aria-hidden="true"></i><span data-i18n-key="sidebar.parcels.refreshButton">Refresh Parcel Data</span>';

    it('shows the translated busy label, then restores the icon and label span', async () => {
        const run = factory({ i18n: { t: key => (key === 'common.busy.refreshing' ? 'Osvježavanje...' : key) } });
        const button = fakeButton(markup);
        let during = null;
        await run(button, { key: 'common.busy.refreshing', fallback: 'Refreshing...' }, async () => {
            during = { text: button.textContent, disabled: button.disabled,
                spinner: button.classList.contains('cb-busy'), ariaBusy: button.getAttribute('aria-busy') };
        });
        expect(during).toEqual({ text: 'Osvježavanje...', disabled: true, spinner: true, ariaBusy: 'true' });
        expect(button.innerHTML).toBe(markup);
        expect(button.disabled).toBe(false);
        expect(button.classList.contains('cb-busy')).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe(null);
    });

    it('falls back to English when the key is missing, and restores after a failure too', async () => {
        const run = factory({ i18n: { t: key => key } });
        const button = fakeButton(markup);
        let during = null;
        await expect(run(button, { key: 'common.busy.nope', fallback: 'Working...' }, async () => {
            during = button.textContent;
            throw new Error('boom');
        })).rejects.toThrow('boom');
        expect(during).toBe('Working...');
        expect(button.innerHTML).toBe(markup);
        expect(button.disabled).toBe(false);
        expect(button.classList.contains('cb-busy')).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe(null);
    });

    it('still takes a plain text label and an explicit restoreText', () => {
        const run = factory({});
        const button = fakeButton(markup);
        run(button, 'Busy', () => { expect(button.textContent).toBe('Busy'); }, { restoreText: 'Done' });
        expect(button.innerHTML).toBe('Done');
    });

    it('restores existing disabled and busy state after a synchronous failure', () => {
        const run = factory({});
        const button = fakeButton(markup);
        button.disabled = true;
        button.classList.add('cb-busy');
        button.setAttribute('aria-busy', 'true');
        expect(() => run(button, 'Working...', () => { throw new Error('failed'); })).toThrow('failed');
        expect(button.innerHTML).toBe(markup);
        expect(button.disabled).toBe(true);
        expect(button.classList.contains('cb-busy')).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');
    });
});
