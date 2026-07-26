// Which building surveys the cross-section editor puts on the map, and which of them it will listen
// to. GDI is the standard every measurement reads (see corridorEditorBuildingSurveys), so entering
// the editor no longer ASKS which buildings to show — there is one right answer and it just switches
// it on. DGU and OSM stay on the map as outlines you can call up from the panel, and can never
// become the standard.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
    corridorEditorEntryBuildingLayers,
    corridorEditorToggledReferenceLayers,
    corridorEditorOsmSourceLink
} = require('../../frontend/js/corridor-editor.js');

const editorSource = readFileSync(new URL('../../frontend/js/corridor-editor.js', import.meta.url), 'utf8');
const drawingSource = readFileSync(new URL('../../frontend/js/road-drawing.js', import.meta.url), 'utf8');
const locales = ['en', 'hr', 'sr', 'es'].map(lang => ({
    lang,
    strings: JSON.parse(readFileSync(new URL(`../../frontend/i18n/${lang}.json`, import.meta.url), 'utf8'))
}));

describe('the surveys the editor turns on when it opens', () => {
    it('switches GDI on, because that is what every measurement reads', () => {
        expect(corridorEditorEntryBuildingLayers({ gdi: false, dgu: false, osm: false }).gdi).toBe(true);
        expect(corridorEditorEntryBuildingLayers(null).gdi).toBe(true);
    });

    it('leaves the other two exactly as the user had them', () => {
        expect(corridorEditorEntryBuildingLayers({ gdi: false, dgu: true, osm: false }))
            .toEqual({ gdi: true, dgu: true, osm: false });
        expect(corridorEditorEntryBuildingLayers({ gdi: true, dgu: false, osm: true }))
            .toEqual({ gdi: true, dgu: false, osm: true });
    });

    // The dialog asked "which buildings to show?" — a question whose every answer now means the same
    // thing, since the measurement cannot follow it. Opening a road must not stop to ask it.
    it('does not open the building-layers picker on the way in', () => {
        const enter = editorSource.slice(
            editorSource.indexOf('async function corridorEditorShowBuildingFootprints'),
            editorSource.indexOf('function corridorEditorRestoreBuildingFootprints')
        );
        expect(enter.length).toBeGreaterThan(0);
        expect(enter.includes('dialog.open()')).toBe(false);
        expect(enter.includes('BuildingLayersDialog')).toBe(true);   // still reads the state to restore
    });
});

describe('the panel\'s reference-survey buttons', () => {
    it('turns a reference survey on and off without disturbing the other', () => {
        const off = { gdi: true, dgu: false, osm: false };
        expect(corridorEditorToggledReferenceLayers(off, 'dgu')).toEqual({ gdi: true, dgu: true, osm: false });
        expect(corridorEditorToggledReferenceLayers({ gdi: true, dgu: true, osm: false }, 'dgu'))
            .toEqual({ gdi: true, dgu: false, osm: false });
        expect(corridorEditorToggledReferenceLayers({ gdi: true, dgu: true, osm: false }, 'osm'))
            .toEqual({ gdi: true, dgu: true, osm: true });
    });

    it('never lets GDI be switched off — it is the standard, not a view', () => {
        expect(corridorEditorToggledReferenceLayers({ gdi: false, dgu: false, osm: false }, 'gdi').gdi).toBe(true);
        expect(corridorEditorToggledReferenceLayers({ gdi: true, dgu: false, osm: false }, 'gdi'))
            .toEqual({ gdi: true, dgu: false, osm: false });
    });

    it('offers exactly the two reference surveys as buttons in the header row', () => {
        expect(editorSource.includes("['dgu', 'osm'].map")).toBe(true);
        expect(editorSource.includes('data-survey="${key}"')).toBe(true);
        expect(editorSource.includes('[data-survey]')).toBe(true);
    });

    // They are for inspecting THIS road. What the map shows the rest of the time is B's business,
    // so a reference outline must not survive the panel closing.
    it('lasts only as long as the panel — the close puts the map back as it was', () => {
        const handler = editorSource.slice(
            editorSource.indexOf("querySelectorAll('[data-survey]')"),
            editorSource.indexOf('function corridorEditorOnBuildingLayersChanged')
        );
        expect(handler.length).toBeGreaterThan(0);
        // Comments stripped: the handler EXPLAINS that it does not record the toggle, and the
        // explanation naming the field would otherwise pass for the field being written.
        expect(handler.replace(/\/\/.*$/gm, '').includes('restoreBuildingLayers')).toBe(false);
    });

    it('is translated everywhere the app is', () => {
        locales.forEach(({ lang, strings }) => {
            const corridor = strings.modal.corridor;
            expect(typeof corridor.referenceSurveys, lang).toBe('string');
            expect(typeof corridor.referenceSurvey.dgu, lang).toBe('string');
            expect(typeof corridor.referenceSurvey.osm, lang).toBe('string');
        });
    });
});

// A reconstructed cross-section is only ever as good as the OSM way it was read off, so when it is
// wrong the fix belongs in OSM. "Incorrect?" is the pointer back to the source.
describe('the way back to OpenStreetMap', () => {
    it('points at the way the section was read from', () => {
        const link = corridorEditorOsmSourceLink({ osmIds: ['45759336', '12'], osmName: 'Gundulićeva ulica' });
        expect(link.url).toBe('https://www.openstreetmap.org/way/45759336');
        expect(link.ids).toEqual(['45759336', '12']);
        expect(link.name).toBe('Gundulićeva ulica');
    });

    it('shows nothing for a road that did not come from OSM', () => {
        expect(corridorEditorOsmSourceLink(null)).toBe(null);
        expect(corridorEditorOsmSourceLink({})).toBe(null);
        expect(corridorEditorOsmSourceLink({ osmIds: [] })).toBe(null);
    });

    // The id goes straight into an href, so anything that is not a way id is not a way id.
    it('refuses an id that is not one, rather than building a URL out of it', () => {
        expect(corridorEditorOsmSourceLink({ osmIds: ['../../evil'] })).toBe(null);
        expect(corridorEditorOsmSourceLink({ osmIds: ['1 OR 1'] })).toBe(null);
        expect(corridorEditorOsmSourceLink({ osmIds: ['x99', '77'] }).url).toBe('https://www.openstreetmap.org/way/77');
    });

    it('is offered in the header row, and translated everywhere', () => {
        expect(editorSource.includes('corridorEditorOsmSourceHtml()')).toBe(true);
        locales.forEach(({ lang, strings }) => {
            expect(typeof strings.modal.corridor.osmSource, lang).toBe('string');
            expect(typeof strings.modal.corridor.osmSourceTitle, lang).toBe('string');
        });
    });
});

describe('the B key', () => {
    it('still opens the picker on the map', () => {
        expect(drawingSource.includes('toggleBuildingReferenceLayers()')).toBe(true);
        expect(drawingSource.includes("event.key === 'b' || event.key === 'B'")).toBe(true);
    });

    // Inside the editor the picker could only contradict the panel: it would offer a survey as a
    // choice where the panel states one as the standard.
    it('does nothing while the cross-section editor is docked', () => {
        const hotkey = drawingSource.slice(
            drawingSource.indexOf('function handleRoadDrawHotkey'),
            drawingSource.indexOf('function attachRoadDrawHotkey')
        );
        const bBranch = hotkey.slice(hotkey.indexOf("event.key === 'b'"));
        const guard = bBranch.indexOf('isCorridorEditorOpen()');
        const opens = bBranch.indexOf('toggleBuildingReferenceLayers()');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(opens);   // the guard must come FIRST, or it guards nothing
    });
});
