// Where the proposed buildings are drawn, and what counts as a duplicate parcel.
//
// mapLoad kept reporting "duplicate ground copies" in overlayPane — 678, then 146, then 156 — and
// twice the accused turned out to be the same innocent layer: the proposed buildings, drawn as
// default-renderer SVG polygons that legitimately CARRY the parcel id of the plot they stand on.
// The duplicate detector judged ground by property shape (kind present/absent), which convicted
// decoration both times; and the buildings themselves were the last bulk of the map-level SVG,
// re-composited on every frame of a drag.
//
// Two fixes, pinned here: the buildings render to their own canvas pane (interactive:false
// decoration is the ideal canvas tenant — the exact opposite of the hit targets, which need SVG's
// per-path pointer events), and the detector counts only layers the parcel system itself registers.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const buildings = read('../../frontend/js/building-blocks.js');
const mapLoad = read('../../frontend/js/map-load-debug.js');

describe('proposed buildings render to canvas, not the map SVG', () => {
    const factory = buildings.slice(
        buildings.indexOf('function proposedBuildingCanvas()'),
        buildings.indexOf('function ensureProposedBuildingLayer()')
    );

    it('one shared canvas in a pane of its own', () => {
        expect(factory).toContain("map.createPane('proposedBuildingsPane')");
        expect(factory).toContain("L.canvas({ pane: 'proposedBuildingsPane', padding: 0.5 })");
    });

    it('the pane sits between the parcels and the corridor strips, exactly as SVG painted', () => {
        // Parcels live in overlayPane (400); corridor strips at 655. 645 keeps buildings above
        // ground and under the designed road surface — the order the SVG gave by accident of
        // element position, now stated.
        expect(factory).toContain("pane.style.zIndex = '645'");
    });

    it('the pane can never swallow a click — the invariant that put hit targets back on SVG', () => {
        expect(factory).toContain("pane.style.pointerEvents = 'none'");
    });

    it('BOTH draw sites use it: the buildings and the ineligible plots', () => {
        // The end marker is searched FROM the start marker — announceProposedBuildings is defined
        // before the draw function, and an end before the start is a silently empty slice.
        const start = buildings.indexOf('function drawProposedBuildingsForProposal(');
        const end = buildings.indexOf('\nfunction ', start + 10);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const draw = buildings.slice(start, end);
        const wired = draw.match(/renderer: proposedBuildingCanvas\(\)/g) || [];
        expect(wired, 'a site left on the default renderer quietly refills the SVG').toHaveLength(2);
        expect(draw.match(/pane: 'proposedBuildingsPane'/g) || []).toHaveLength(2);
    });
});

describe('the duplicate detector judges by registration, not by property shape', () => {
    const census = mapLoad.slice(
        mapLoad.indexOf('const id = props.parcelId ?? props.id ?? null;'),
        mapLoad.indexOf('const duplicated = Array.from(ids.entries())')
    );

    it('a layer counts only if the parcel system registered it', () => {
        expect(census).toContain('global.parcelLayer.hasLayer(layer)');
        expect(census).toContain('global.ParcelPresenter?.getLayer?.(key) === layer');
        expect(census).toContain('if (!inGroup && !indexed) return;');
    });

    it('the property-shape test is gone — it convicted decoration twice', () => {
        // First massing polygons (kind stamped), then the same buildings without a kind. Any test
        // on `props.kind` is the same proxy waiting for a third costume.
        expect(census).not.toContain('props.kind');
    });

    it('what survives as an orphan is a real anomaly: indexed ground the map is not showing', () => {
        expect(census).toContain('if (!inGroup && indexed) orphans.set(key, layer);');
    });
});
