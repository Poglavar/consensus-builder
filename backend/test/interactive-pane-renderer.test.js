// Clicking the map worked all through a reload and stopped the instant it finished.
//
// The corridor HIT layer — invisible polygons that exist only to be clicked — had been moved to a
// canvas renderer to get 2,151 paths out of the SVG. An invisible layer seems like the ideal
// candidate for that. It is the worst one, because the only thing it has is SHAPE:
//
//   * an SVG path receives pointer events where the path IS; a click anywhere else falls through
//     to whatever is underneath;
//   * a <canvas> is ONE element covering the whole viewport. Its pane is pointer-events:auto at
//     z-index 656, the parcels sit at 400, and Leaflet's canvas renderer hit-tests only the layers
//     in that renderer. Every click that missed a corridor was swallowed instead of reaching the
//     parcel below.
//
// And the timing that made it so confusing: a Leaflet renderer creates its <canvas> when its FIRST
// layer is added, which for corridor strips is the last phase of the rebuild. Until then there was
// no element to swallow anything.
//
// The invariant: a pane that accepts pointer events must not be drawn by a canvas renderer.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const render = read('../../frontend/js/corridor-render.js');

/** Panes this file creates, with the pointer-events value it forces on each. */
function panesWithPointerEvents(source) {
    const found = new Map();
    // ensureXPane() bodies: a getPane/createPane on a constant, then a pointerEvents assignment.
    const blocks = source.split(/function ensure/).slice(1);
    blocks.forEach(block => {
        const paneConst = block.match(/getPane\((\w+)\)/);
        const pointer = block.match(/pointerEvents = '(\w+)'/);
        if (paneConst && pointer) found.set(paneConst[1], pointer[1]);
    });
    return found;
}

describe('an interactive pane is never drawn on canvas', () => {
    const panes = panesWithPointerEvents(render);

    it('reads the panes out of the source at all', () => {
        expect(panes.size, 'no ensure*Pane blocks matched — the parser below is testing nothing')
            .toBeGreaterThanOrEqual(3);
        expect(panes.get('CORRIDOR_HIT_PANE')).toBe('auto');
        expect(panes.get('CORRIDOR_STRIPS_PANE')).toBe('none');
    });

    it('no pane that accepts clicks asks for a canvas renderer', () => {
        const offenders = [];
        panes.forEach((pointerEvents, paneConst) => {
            if (pointerEvents !== 'auto') return;
            if (render.includes(`corridorCanvasFor(${paneConst})`)) offenders.push(paneConst);
        });
        expect(offenders, 'a canvas in a pointer-events:auto pane swallows every click that misses it')
            .toEqual([]);
    });

    it('the hit targets specifically are SVG', () => {
        // Named separately from the rule above so a failure says WHICH layer regressed, and so the
        // reason survives even if the pane parser is ever rewritten.
        expect(render).not.toContain('corridorCanvasFor(CORRIDOR_HIT_PANE)');
        expect(render).toContain("className: 'corridor-applied-hit-target'");
    });

    it('the non-interactive corridor panes still use canvas — this is not a blanket ban', () => {
        // Those panes are pointer-events:none, so their canvas cannot take a click from anything.
        // Reverting them would put ~9,700 paths back into the SVG for no reason.
        expect(render).toContain('corridorCanvasFor(pane)');
        expect(panes.get('CORRIDOR_RAIL_PANE')).toBe('none');
    });
});
