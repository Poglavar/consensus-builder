// One map-object palette must agree across CSS, Leaflet paths and Three.js colour encodings.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { MapHighlight } = createRequire(import.meta.url)('../../frontend/js/shared-utils.js');

describe('shared map highlight', () => {
    it('retains the model view yellow and dark halo in CSS and numeric colour forms', () => {
        const css = readFileSync(new URL('../../frontend/css/tokens.css', import.meta.url), 'utf8');
        expect(MapHighlight.colorHex).toBe(0xffdd00);
        expect(MapHighlight.haloHex).toBe(0x292000);
        expect(MapHighlight.emissiveHex).toBe(0x3d3000);
        expect(css).toContain(`--cb-map-highlight: ${MapHighlight.color};`);
        expect(css).toContain(`--cb-map-highlight-halo: ${MapHighlight.halo};`);
        expect(MapHighlight.rgb()).toEqual([1, 221 / 255, 0]);
        expect(MapHighlight.rgb(MapHighlight.halo)).toEqual([41 / 255, 32 / 255, 0]);
    });
    it('keeps solid and dashed shapes distinct while sharing the selection colour', () => {
        const solid = MapHighlight.style({ fillOpacity: .2, weight: 5 });
        const dashed = MapHighlight.style({ dashArray: '10 5' });
        expect(solid).toMatchObject({ color: '#ffdd00', fillColor: '#ffdd00', fillOpacity: .2, dashArray: null, weight: 5 });
        expect(dashed).toMatchObject({ color: solid.color, fillColor: solid.fillColor, fillOpacity: 0, dashArray: '10 5' });
        solid.color = 'red';
        expect(MapHighlight.style().color).toBe('#ffdd00');
    });
});
