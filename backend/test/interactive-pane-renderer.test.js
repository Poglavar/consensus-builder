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
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const render = read('../../frontend/js/corridor-render.js');
const drawing = read('../../frontend/js/road-drawing.js');
const governmentRoads = read('../../frontend/js/government-roads.js');
const mapCore = read('../../frontend/js/map-core.js');
const structures = read('../../frontend/js/structures.js');
const frontendJsRoot = fileURLToPath(new URL('../../frontend/js/', import.meta.url));

function javascriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'vendor' ? [] : javascriptFiles(path);
        return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
    });
}

function explicitCanvasCalls() {
    const calls = [];
    javascriptFiles(frontendJsRoot).forEach(path => {
        const source = readFileSync(path, 'utf8');
        const pattern = /(?:[A-Za-z_$][\w$]*\.)*L\.canvas\s*\(\s*\{[\s\S]*?\}\s*\)/g;
        for (const match of source.matchAll(pattern)) {
            calls.push({
                file: relative(frontendJsRoot, path),
                call: match[0].replace(/\s+/g, ' ')
            });
        }
    });
    return calls;
}

function sourceSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
}

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

    it('and there is no hit target per STRIP — the footprint carries their exact handlers', () => {
        // ~2,000 SVG paths whose click was rememberSegment(null) + the same forward the footprint
        // target already does, over ground the footprint already covers. mapLoad measured them as
        // the bulk of the SVG once the parcels moved to canvas. Per-SEGMENT targets stay: they are
        // the only ones that remember which segment was clicked.
        const targets = render.slice(render.indexOf('function renderAppliedCorridorHitTargets'), render.indexOf('function isAppliedCorridorProposal'));
        expect(targets).not.toContain('strips.forEach');
        expect(targets).toContain('rememberSegment(entry.segmentId)');
        // Exactly one null-segment click WIRING remains (the footprint's). Matched as code —
        // handler shape included — because the explanatory comment also says rememberSegment(null)
        // and a prose match counted it.
        expect(targets.match(/\.on\('click', event => \{ rememberSegment\(null\)/g) || []).toHaveLength(1);
    });

    it('the non-interactive corridor panes still use canvas — this is not a blanket ban', () => {
        // Those panes are pointer-events:none, so their canvas cannot take a click from anything.
        // Reverting them would put ~9,700 paths back into the SVG for no reason.
        expect(render).toContain('corridorCanvasFor(pane)');
        expect(panes.get('CORRIDOR_RAIL_PANE')).toBe('none');
    });

    it('cannot silently turn a missing corridor pane into another default-pane canvas', () => {
        const allowed = sourceSection(render, 'const CORRIDOR_CANVAS_PANES', 'function ensureCorridorStripsPane');
        const factory = sourceSection(render, 'function corridorCanvasFor(pane)', 'function renderCorridorLaneMarkings');
        const railFactory = sourceSection(render, 'function corridorRailRenderer()', 'const CORRIDOR_SLEEPER_SPACING');

        ['CORRIDOR_STRIPS_PANE', 'CORRIDOR_JUNCTIONS_PANE', 'CORRIDOR_MARKINGS_PANE', 'CORRIDOR_RAIL_PANE']
            .forEach(pane => {
                expect(allowed).toContain(pane);
                expect(panes.get(pane)).toBe('none');
            });
        expect(allowed).not.toContain('CORRIDOR_HIT_PANE');
        expect(factory).toContain('CORRIDOR_CANVAS_PANES.has(pane)');
        expect(factory).not.toContain("pane || 'overlayPane'");
        expect(railFactory).not.toContain("L.canvas({ padding: 0.5 })");
    });

    it('draws the live road preview in those panes, never in the clickable default overlay pane', () => {
        const preview = sourceSection(
            drawing,
            'function redrawRoadStrips()',
            '// The cross-section of the corridor being drawn'
        );

        expect(preview).toContain('pane: CORRIDOR_STRIPS_PANE');
        expect(preview).toContain('renderCorridorJunctions(junctions, group, CORRIDOR_JUNCTIONS_PANE)');
        expect(preview).toContain('renderCorridorLaneMarkings(markings, group, CORRIDOR_MARKINGS_PANE)');
        expect(preview).not.toContain('renderCorridorJunctions(junctions, group, undefined)');
        expect(preview).not.toContain('renderCorridorLaneMarkings(markings, group, undefined)');
    });

    it('keeps drawing vertices above the corridor without turning their pane into a click shield', () => {
        const markerPane = sourceSection(
            drawing,
            'function ensureRoadDrawingMarkerPane()',
            '// Closest point to `p` on the pixel segment'
        );
        const marker = sourceSection(
            drawing,
            'function createRoadVertexMarker(latlng)',
            '// Markers are cosmetic'
        );

        expect(markerPane).toContain("pane.style.pointerEvents = 'none'");
        expect(marker).toContain('interactive: false');
        expect(marker).toContain('...(pane ? { pane } : {})');
    });
});

describe('every decorative main-map canvas names a click-through pane', () => {
    it('keeps the complete renderer list explicit so a new canvas requires a pane review', () => {
        const sites = explicitCanvasCalls().map(({ file, call }) => {
            const named = call.match(/\bpane\s*:\s*([A-Za-z_$][\w$]*|'[^']+')/);
            const pane = named ? named[1].replaceAll("'", '') : (/\{\s*pane\s*[,}]/.test(call) ? 'pane' : null);
            return `${file}:${pane || 'default'}`;
        }).sort();

        expect(sites).toEqual([
            'building-blocks.js:proposedBuildingsPane',
            'corridor-render.js:CORRIDOR_RAIL_PANE',
            'corridor-render.js:pane',
            'government-roads.js:GOVERNMENT_PLAN_PANE',
            'parcels/ingest.js:default',
            'structures.js:SQUARES_PANE'
        ]);
    });

    it('allows only the intentional parcel renderer to use the default pane', () => {
        const bare = explicitCanvasCalls().filter(({ call }) => !/\bpane\s*(?::|[,}])/.test(call));
        expect(bare).toEqual([{
            file: 'parcels/ingest.js',
            call: 'global.L.canvas({ padding: 0.5 })'
        }]);
    });

    it('keeps the government-plan renderer in a display-only pane', () => {
        const renderer = sourceSection(governmentRoads, 'function governmentPlanRenderer()', 'function initialiseGovernmentPlanProposalState');
        const layer = sourceSection(governmentRoads, 'function ensurePlanLayer(useHighlightStyle)', 'function setPlanLayerFeatures');

        expect(renderer).toContain("pane.style.pointerEvents = 'none'");
        expect(renderer).toContain('L.canvas({ pane: GOVERNMENT_PLAN_PANE, padding: 0.5 })');
        expect(layer).toContain('pane: renderer ? GOVERNMENT_PLAN_PANE : undefined');
        expect(layer).toContain('interactive: false');
    });

    it('keeps the square texture canvas click-through too', () => {
        const pane = sourceSection(structures, 'function ensureSquaresPane()', 'function ensureSquaresIconPane');
        expect(pane).toContain("pane.style.pointerEvents = 'none'");
        expect(structures).toContain('L.canvas({ padding: 0.5, pane: SQUARES_PANE })');
    });

    it('does not opt the main map into one shared catch-all canvas', () => {
        expect(mapCore).not.toMatch(/preferCanvas\s*:\s*true/);
    });
});
