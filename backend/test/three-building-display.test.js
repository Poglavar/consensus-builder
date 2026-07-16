// Verifies the abstract-3D Built state model, especially the complementary Surviving/Removed views.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
    displayStatesForKind,
    resolveBuiltDisplayPolicy,
    resolveBuildingRenderParts
} = require('../../frontend/js/three-building-display.js');
const frontendIndex = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

describe('3D building display policy', () => {
    it('offers Removed only for existing Built fabric', () => {
        expect(displayStatesForKind('built')).toEqual(['solid', 'ghost', 'surviving', 'removed', 'off']);
        expect(displayStatesForKind('planned')).toEqual(['solid', 'ghost', 'off']);
    });

    it('loads the policy before the 3D view that consumes it', () => {
        expect(frontendIndex.indexOf("'js/three-building-display.js'")).toBeGreaterThan(-1);
        expect(frontendIndex.indexOf("'js/three-building-display.js'"))
            .toBeLessThan(frontendIndex.indexOf("'js/three-mode.js'"));
    });

    it('shows only demolished buildings and cut portions in Removed mode', () => {
        expect(resolveBuiltDisplayPolicy('removed')).toEqual({
            visible: true,
            material: 'solid',
            showSurviving: false,
            showDemolished: true,
            showExistingRail: false
        });
    });

    it('keeps Surviving as the exact complement of Removed', () => {
        expect(resolveBuiltDisplayPolicy('surviving')).toEqual({
            visible: true,
            material: 'solid',
            showSurviving: true,
            showDemolished: false,
            showExistingRail: true
        });
    });

    it('keeps Solid and Transparent inclusive, while Off renders no Built fabric', () => {
        expect(resolveBuiltDisplayPolicy('solid')).toMatchObject({
            visible: true, material: 'solid', showSurviving: true, showDemolished: true
        });
        expect(resolveBuiltDisplayPolicy('ghost')).toMatchObject({
            visible: true, material: 'ghost', showSurviving: true, showDemolished: true
        });
        expect(resolveBuiltDisplayPolicy('off')).toMatchObject({
            visible: false, showSurviving: false, showDemolished: false, showExistingRail: false
        });
    });

    it('selects the exact carve halves for Surviving and Removed views', () => {
        const cut = { remainder: { type: 'Polygon' }, demolished: { type: 'Polygon' } };
        const full = { remainder: null, demolished: { type: 'Polygon' } };
        const surviving = resolveBuiltDisplayPolicy('surviving');
        const removed = resolveBuiltDisplayPolicy('removed');

        expect(resolveBuildingRenderParts(null, surviving)).toEqual({
            detailed: true, remainder: false, demolished: false
        });
        expect(resolveBuildingRenderParts(cut, surviving)).toEqual({
            detailed: false, remainder: true, demolished: false
        });
        expect(resolveBuildingRenderParts(full, surviving)).toEqual({
            detailed: false, remainder: false, demolished: false
        });

        expect(resolveBuildingRenderParts(null, removed)).toEqual({
            detailed: false, remainder: false, demolished: false
        });
        expect(resolveBuildingRenderParts(cut, removed)).toEqual({
            detailed: false, remainder: false, demolished: true
        });
        expect(resolveBuildingRenderParts(full, removed)).toEqual({
            detailed: true, remainder: false, demolished: false
        });
    });
});
