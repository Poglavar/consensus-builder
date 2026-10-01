// The Settings sheet's "Data & maintenance" section (UI-REWORK.md, Phase 6): local-cache upkeep
// (parcel coverage/refresh/clear, block/road/proposal clears, wipe all) lives there and nowhere
// else in the shell, each dataset's upkeep inside its own data-section wrapper so a city that hides
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
    const end = indexHtml.indexOf('</section>', start);
    return indexHtml.slice(start, end);
}

const MAINTENANCE = [
    { marker: 'id="showParcelCoverageButton"', section: 'parcels', command: 'parcels.coverage' },
    { marker: 'id="refreshParcelDataButton"', section: 'parcels', command: 'parcels.refresh' },
    { marker: 'clearLocalParcelData', section: 'parcels', command: 'parcels.clearLocal' },
    { marker: 'onclick="clearBlocks()"', section: 'blocks', command: 'blocks.clear' },
    { marker: 'onclick="clearDetectedRoads()"', section: 'roads', command: 'roads.clear' },
    { marker: 'onclick="clearLocalProposalData()"', section: 'proposals', command: 'proposals.clearLocal' },
    { marker: 'id="wipeLocalDataButton"', section: 'data', command: 'settings.wipeLocalData' }
];

describe('Data & maintenance section', () => {
    const settings = sheetHtml('settings-sheet');

    it('holds every local-cache action, and no other sheet does', () => {
        for (const { marker } of MAINTENANCE) {
            expect(settings, marker).toContain(marker);
            for (const other of ['layers-sheet', 'tools-sheet', 'proposals-sheet', 'game-sheet', 'activity-sheet']) {
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

    it('lists the actions on the Settings surface (and the palette), not on Layers/Tools/Proposals', () => {
        for (const { command } of MAINTENANCE) {
            const entry = UiCommands.findCommand(command);
            expect(entry, command).toBeTruthy();
            expect(entry.surfaces, command).toEqual(expect.arrayContaining(['settings', 'palette']));
            for (const surface of ['layers', 'tools', 'proposals']) expect(entry.surfaces, command).not.toContain(surface);
        }
    });

    it('offers the per-dataset clears in the palette only in debug mode, like the sheet', () => {
        // The sheet hides them outside debug mode (.btn-danger); the palette used to offer them anyway.
        const clears = ['parcels.clearLocal', 'blocks.clear', 'roads.clear', 'proposals.clearLocal'];
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

    it('keeps the section hidden for a city when every wrapper is hidden, including the Settings upkeep', () => {
        // isSectionHidden: true only when every .accordion-section[data-section] wrapper is hidden.
        const wrappers = [...indexHtml.matchAll(/class="[^"]*accordion-section[^"]*"[^>]*data-section="parcels"/g)];
        expect(wrappers.length).toBeGreaterThanOrEqual(2); // Layers' parcels section + the Settings upkeep
    });
});

describe('runWithButtonBusyState', () => {
    const source = fs.readFileSync(path.join(FRONTEND, 'js/ui-helpers.js'), 'utf8');
    const start = source.indexOf('function runWithButtonBusyState(');
    const end = source.indexOf('\n}\n', start) + 2;
    // eslint-disable-next-line no-new-func
    const factory = new Function('window', `${source.slice(start, end)}\nreturn runWithButtonBusyState;`);

    function fakeButton(html) {
        return {
            innerHTML: html,
            disabled: false,
            classList: { contains: () => false, add() { }, remove() { } },
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
            during = { text: button.textContent, disabled: button.disabled };
        });
        expect(during).toEqual({ text: 'Osvježavanje...', disabled: true });
        expect(button.innerHTML).toBe(markup);
        expect(button.disabled).toBe(false);
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
    });

    it('still takes a plain text label and an explicit restoreText', () => {
        const run = factory({});
        const button = fakeButton(markup);
        run(button, 'Busy', () => { expect(button.textContent).toBe('Busy'); }, { restoreText: 'Done' });
        expect(button.innerHTML).toBe('Done');
    });
});
