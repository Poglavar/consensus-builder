// The parcels section is gated twice: by its own "Show parcels" checkbox (updateSectionControlsState)
// and by zoom (updateParcelsCheckboxByZoom). Zoom writes `checked` programmatically, so no change
// event fires and the first gate has to be re-run by hand — in the right order. No DOM environment
// is installed here, so this is asserted at the source, which is also where the ordering trap lives.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../frontend/js/sidebar-management.js', import.meta.url), 'utf8');

function sectionOf(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
    return { text: source.slice(start, end), start };
}

describe('parcels section gating follows the zoom', () => {
    const zoomFn = () => sectionOf('function updateParcelsCheckboxByZoom(within)', 'window.updateParcelsCheckboxByZoom =').text;

    it('re-runs the section gate — nothing else does, so the grey would never lift', () => {
        expect(zoomFn()).toContain('updateSectionControlsState(parcelsSection)');
    });

    it('runs the gate BEFORE the zoom loop, which must have the last word on the checkboxes', () => {
        // The gate restores each control to the state it remembered (data-prev-disabled). Run it
        // after the loop and it restores the disabled-by-zoom state it just recorded, switching the
        // checkboxes back off the moment the user zooms in.
        const body = zoomFn();
        const gate = body.indexOf('updateSectionControlsState(parcelsSection)');
        const zoomLoop = body.indexOf('cb.disabled = !within;');
        expect(gate).toBeGreaterThan(0);
        expect(zoomLoop).toBeGreaterThan(gate);
    });

    it('greys the section through the same class the gate owns', () => {
        const gate = sectionOf('function updateSectionControlsState(section)', 'function toggleSectionExpansion').text;
        expect(gate).toContain("classList.add('section-disabled')");
        expect(gate).toContain("classList.remove('section-disabled')");
    });
});
