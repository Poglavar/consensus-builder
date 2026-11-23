// Zoom changes availability without changing the visitor's Show parcels preference.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/map-controls.js', import.meta.url), 'utf8');

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

    it.each([true, false])('keeps the chosen visibility (%s) through a zoom round trip', checked => {
        const section = { querySelector: () => null };
        const checkbox = { checked, disabled: false, closest: () => section };
        const states = [];
        const context = vm.createContext({
            window: {},
            document: { getElementById: id => id === 'parcelsCheckbox' ? checkbox : null },
            updateSectionControlsState: () => states.push({ checked: checkbox.checked, disabled: checkbox.disabled })
        });
        vm.runInContext(`${zoomFn()}\nupdateParcelsCheckboxByZoom(false); updateParcelsCheckboxByZoom(true);`, context);
        expect(states).toEqual([{ checked, disabled: true }, { checked, disabled: false }]);
    });

    it('greys the section through the same class the gate owns', () => {
        const gate = sectionOf('function updateSectionControlsState(section)', 'function toggleDebugMode').text;
        expect(gate).toContain("classList.add('section-disabled')");
        expect(gate).toContain("classList.remove('section-disabled')");
    });
});
