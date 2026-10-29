// The 3D parcel view and design view hide what they leave out and show exactly that again on leaving,
// with no rebuild: three-scene-isolation.js and its wiring in three-mode.js.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const isolation = require('../../frontend/js/three-scene-isolation.js');
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const declarations = new Map();
(function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect); else collect(value);
    }
})(parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] }));

const object = (userData = {}, visible = true) => ({ userData, visible });
const group = (...children) => ({ visible: true, children });

// A scene with parcels A and B and a road; buildings, decorations and permitted massing on both.
function scene() {
    const parcels = { A: { id: 'A', contains: point => point === 'in-A' }, B: { id: 'B', contains: point => point === 'in-B' } };
    const g = {
        flatGroup: group(object({ isParcel: true, parcelId: 'A' }), object({ isParcel: true, parcelId: 'B' }), object({ road: true })),
        existingBuildingsGroup: group(object({ isNearbyBuilding3D: true, footprintLatLng: 'in-A' }),
            object({ isNearbyBuilding3D: true, footprintLatLng: 'in-B' }),
            object({ isNearbyBuilding3D: true, footprintLatLng: 'in-A', demolished: true }, false)),
        proposedBuildingsGroup: group(object({ parcelId: 'A' }), object({ parcelId: 'B' })),
        ineligibleBuildingsGroup: group(), floorPlanGroup: group(),
        plannedFlatGroup: group(object({ pond: true })), parkGroup: group(object({ tree: true })),
        squareGroup: null, lakeGroup: null, stationGroup: null, existingTransitAlignmentGroup: group(object({ rail: true })),
        treesGroup: group(object({ osmTree: true })), lifeGroup: group(object({ person: true })),
        planningSourcesGroup: group(object({ planningRepresentationId: 'permitted-A' }), object({ planningRepresentationId: 'permitted-B' }))
    };
    const stubs = {
        window: { __threeSceneIsolation: isolation },
        turf: { point: latLng => latLng, booleanPointInPolygon: (point, feature) => feature.contains(point) },
        getParcelFeatureById: id => parcels[id] || null,
        parcelMassingItem: id => ({ id: `permitted-${id}` }),
        updateXrayControls: vi.fn(), invalidateThreeView: vi.fn(), updateIsolationButton: vi.fn(),
        notifyIsolationChanged: vi.fn(), rebuild3DBuildingsOnly: vi.fn(), viewParcel: vi.fn(), g
    };
    const names = ['applyIsolationVisibility', 'isolateParcel', 'applyParcelIsolation', 'endParcelView', 'clearIsolation'];
    const code = `${Object.keys(stubs).map(key => `const ${key}=this.${key};`).join('\n')}
        let { ${Object.keys(g).join(', ')} } = g;
        let isolatedParcelId = null, isolatedProposalId = null, viewedParcelId = null, realisticLayerActive = this.photo, isolationHidden = [];
        ${names.map(name => declarations.get(name)).join('\n')}
        this.api = { ${names.join(', ')}, state: () => ({ isolatedParcelId, viewedParcelId, hidden: isolationHidden.length }), photo: on => { realisticLayerActive = on; }, designOf: id => { isolatedProposalId = id; } };`;
    const context = { ...stubs, photo: false };
    vm.runInNewContext(code, context);
    return { ...context.api, g, stubs, parcels };
}
const shown = grp => grp.children.map(child => child.visible);

describe('three-scene-isolation.js', () => {
    it('hides only what is shown and rejected, and shows exactly that again', () => {
        const kept = object({ keep: true }), off = object({}, false), gone = object({});
        const hidden = isolation.hideChildren([group(kept, off, gone), null], child => child.userData.keep);
        expect(hidden).toEqual([gone]);
        expect([kept.visible, off.visible, gone.visible]).toEqual([true, false, false]);
        expect(isolation.showAgain(hidden)).toEqual([]);
        expect([kept.visible, off.visible, gone.visible]).toEqual([true, false, true]);
    });
    it('keeps tagged objects of the set and untagged buildings standing on it', () => {
        const contains = point => point === 'in';
        const ids = new Set(['A']);
        expect(isolation.standsOn({ parcelId: 'A' }, ids, contains)).toBe(true);
        expect(isolation.standsOn({ parcelId: 'B', isNearbyBuilding3D: true, footprintLatLng: 'in' }, ids, contains)).toBe(false);
        expect(isolation.standsOn({ isNearbyBuilding3D: true, footprintLatLng: 'in' }, ids, contains)).toBe(true);
        expect(isolation.standsOn({ road: true }, ids, contains)).toBe(false);
    });
});

describe('the parcel view (three-mode.js)', () => {
    it('keeps every parcel and road flat and shows only what stands on the chosen one', () => {
        const view = scene();
        view.isolateParcel('A');
        expect(view.state()).toMatchObject({ isolatedParcelId: 'A', viewedParcelId: 'A' });
        expect(shown(view.g.flatGroup)).toEqual([true, true, true]);
        expect(shown(view.g.existingBuildingsGroup)).toEqual([true, false, false]);
        expect(shown(view.g.proposedBuildingsGroup)).toEqual([true, false]);
        expect(shown(view.g.planningSourcesGroup)).toEqual([true, false]);
        expect(shown(view.g.plannedFlatGroup)).toEqual([true]);
        for (const name of ['parkGroup', 'existingTransitAlignmentGroup', 'treesGroup', 'lifeGroup']) expect(shown(view.g[name])).toEqual([false]);
    });
    it('shows again exactly what it hid, leaving what a layer hid meanwhile', () => {
        const view = scene();
        view.isolateParcel('A');
        view.g.treesGroup.visible = false; // the Trees layer was switched off during the view
        view.endParcelView();
        expect(view.state()).toMatchObject({ isolatedParcelId: null, viewedParcelId: 'A', hidden: 0 });
        expect(shown(view.g.existingBuildingsGroup)).toEqual([true, true, false]);
        expect(shown(view.g.planningSourcesGroup)).toEqual([true, true]);
        expect(shown(view.g.treesGroup)).toEqual([true]);
        expect(view.g.treesGroup.visible).toBe(false);
        expect(view.stubs.rebuild3DBuildingsOnly).not.toHaveBeenCalled();
    });
    it('moving to another parcel shows the first one\'s buildings again', () => {
        const view = scene();
        view.isolateParcel('A');
        view.isolateParcel('B');
        expect(shown(view.g.existingBuildingsGroup)).toEqual([false, true, false]);
        expect(shown(view.g.proposedBuildingsGroup)).toEqual([false, true]);
        expect(shown(view.g.planningSourcesGroup)).toEqual([false, true]);
    });
    it('the photo view keeps the city and only takes the parcel into view', () => {
        const view = scene();
        view.photo(true);
        view.isolateParcel('A');
        expect(view.state()).toMatchObject({ isolatedParcelId: null, viewedParcelId: 'A', hidden: 0 });
        expect(shown(view.g.existingBuildingsGroup)).toEqual([true, true, false]);
    });
});

describe('the design view (three-mode.js)', () => {
    it('shows only its parcels and comes back without a rebuild', () => {
        const view = scene();
        view.designOf('design-1');
        view.applyIsolationVisibility(new Set(['A']), [view.parcels.A]);
        expect(shown(view.g.flatGroup)).toEqual([true, false, false]);
        expect(shown(view.g.plannedFlatGroup)).toEqual([false]);
        expect(shown(view.g.treesGroup)).toEqual([true]);
        expect(shown(view.g.planningSourcesGroup)).toEqual([true, true]);
        view.clearIsolation();
        expect(shown(view.g.flatGroup)).toEqual([true, true, true]);
        expect(shown(view.g.existingBuildingsGroup)).toEqual([true, true, false]);
        expect(shown(view.g.plannedFlatGroup)).toEqual([true]);
        expect(view.stubs.rebuild3DBuildingsOnly).not.toHaveBeenCalled();
    });
});
