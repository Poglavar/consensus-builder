// Characterization tests for the Xray wiring functions in three-mode.js.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const sceneWork = require('../../frontend/js/three-scene-work.js');
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
const declarations = new Map();
function collectFunctions(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    Object.keys(node).forEach(key => { if (key !== 'loc' && key !== 'start' && key !== 'end') { const value = node[key]; if (Array.isArray(value)) value.forEach(collectFunctions); else collectFunctions(value); } });
}
collectFunctions(ast);

function extracted(name, variables = '', stubs = {}) {
    const calls = [];
    const context = { console, ...stubs, calls };
    const code = `${variables}\n${Array.from(Object.entries(stubs)).map(([key]) => `const ${key}=this.${key};`).join('\n')}\n${declarations.get(name)}\nthis.fn=${name};`;
    vm.runInNewContext(code, context);
    return [context.fn, context];
}

describe('three-mode Xray wiring', () => {
    function rebuildHarness(enabled, built = 'ghost', planned = 'solid', isolated = null) {
        const existingBuildingsGroup = { children: [] };
        const proposedBuildingsGroup = { children: [{ id: 'proposal-survives' }] };
        const ineligibleBuildingsGroup = { children: [{ id: 'ineligible-survives' }] };
        const stubs = {
            enabled, built, planned, isolated, existingGroup: existingBuildingsGroup, proposedGroup: proposedBuildingsGroup, ineligibleGroup: ineligibleBuildingsGroup,
            clearGroupChildren: vi.fn(), disposeFloorPlans: vi.fn(), restoreParcelEmphasis: vi.fn(),
            buildingDisplayPolicy: { resolveBuiltDisplayPolicy: mode => ({ visible: mode !== 'off', material: mode, showSurviving: true, showDemolished: false }) },
            buildingMaterials: { xray: 'xray-material', solid: 'solid-material', ghost: 'ghost-material' },
            buildNearbyProposalBuildings3D: vi.fn(async () => {}), buildProposedBuildings3D: vi.fn(async () => {}), appendSuggestedExistingFloorPlans: vi.fn(),
            buildIneligibleParcels3D: vi.fn(), ensureNearbyProposalBuildings: vi.fn(),
            ensureNearbyTrees: vi.fn(), rebuildTreesOnly: vi.fn(), ensureNearbyWater: vi.fn(), rebuildWaterOnly: vi.fn(),
            applyParcelEmphasis: vi.fn(), isolateProposal: vi.fn(), updateXrayControls: vi.fn(),
            invalidateThreeView: vi.fn()
        };
        const [rebuild, context] = extracted('rebuild3DBuildingsOnly', `
            let isActive=true, buildingGroup={};
            let buildingBuildPending=false, buildingDisplaySnapshot=null, buildingsWorkGeneration=0, pendingModelLoads=0;
            let buildingsRenderGeneration=0, sceneAbort=null;
            let existingBuildingsGroup=this.existingGroup, proposedBuildingsGroup=this.proposedGroup;
            let ineligibleBuildingsGroup=this.ineligibleGroup;
            let xrayEnabled=this.enabled, builtDisplay=this.built, plannedDisplay=this.planned;
            let realisticLayerActive=false, existingTransitAlignmentGroup={ visible: true }, showIneligibleParcels=false;
            let isolatedParcelId=this.isolated, isolatedProposalId=null;
        `, stubs);
        return [rebuild, context];
    }

    it.each([true, false])('X-ray=%s preserves chosen exterior materials for buildings without models', async enabled => {
        const [rebuild, c] = rebuildHarness(enabled);
        await rebuild();
        expect(c.disposeFloorPlans).toHaveBeenCalledOnce();
        expect(c.buildNearbyProposalBuildings3D.mock.calls[0][1]).toBe('ghost-material');
        expect(c.buildProposedBuildings3D.mock.calls[0][1]).toBe('solid-material');
        expect(c.updateXrayControls).toHaveBeenCalledOnce();
    });
    it('respects display-off families and reapplies isolation after a rebuild', async () => {
        const [rebuild, c] = rebuildHarness(true, 'off', 'off', 'parcel-42');
        await rebuild();
        expect(c.disposeFloorPlans).toHaveBeenCalledOnce();
        expect(c.buildNearbyProposalBuildings3D).not.toHaveBeenCalled();
        expect(c.buildProposedBuildings3D).not.toHaveBeenCalled();
        expect(c.applyParcelEmphasis).toHaveBeenCalledOnce();
    });
    it('an existing-context refresh preserves proposed families and does not rebuild scene scenery', async () => {
        const [rebuild, c] = rebuildHarness(false);
        await rebuild({ family: 'existing' });

        expect(c.clearGroupChildren.mock.calls).toEqual([[c.existingGroup]]);
        expect(c.proposedGroup.children).toEqual([{ id: 'proposal-survives' }]);
        expect(c.ineligibleGroup.children).toEqual([{ id: 'ineligible-survives' }]);
        expect(c.buildNearbyProposalBuildings3D).toHaveBeenCalledOnce();
        expect(c.buildProposedBuildings3D).not.toHaveBeenCalled();
        expect(c.rebuildTreesOnly).not.toHaveBeenCalled();
        expect(c.rebuildWaterOnly).not.toHaveBeenCalled();
    });

    it('setXrayEnabled changes state and rebuilds', () => {
        const [set, context] = extracted('setXrayEnabled', 'let xrayEnabled=false;', { rebuild3DBuildingsOnly: () => context.calls.push('rebuild'), updateXrayControls: () => context.calls.push('update') });
        set(true);
        expect(context.calls).toEqual(['rebuild', 'update']);
    });
    it('appendBuildingFloorPlans does no work while disabled and deduplicates registered geometry', () => {
        const add = vi.fn(), create = vi.fn(() => ({ userData: { cbFloorPlan: true } }));
        const feature = { properties: { floorPlans: { registration: { corners: [[1, 2]] }, floors: [{ id: 'f1' }] } } };
        const [append] = extracted('appendBuildingFloorPlans', 'let xrayEnabled=false; let floorPlanGroup={add:this.add}; let renderedFloorPlanKeys=new Set(); let floorPlanErrors=0;', { add, THREE: {}, floorPlanRenderer: { createBuildingGroup: create, setCutaway: vi.fn() }, floorPlanGeometry: {}, latLngToXY: () => [0, 0] });
        append(feature); expect(create).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
        const [enabledAppend] = extracted('appendBuildingFloorPlans', 'let xrayEnabled=true; let floorCutawayLevel=1; let floorPlanGroup={add:this.add}; let renderedFloorPlanKeys=new Set(); let floorPlanErrors=0;', { add, THREE: {}, floorPlanRenderer: { createBuildingGroup: create, setCutaway: vi.fn() }, floorPlanGeometry: {}, latLngToXY: () => [0, 0] });
        expect(enabledAppend(feature)).toBe(true); expect(enabledAppend(feature)).toBe(true); expect(create).toHaveBeenCalledTimes(1); expect(add).toHaveBeenCalledTimes(1);
    });
    it('appendBuildingFloorPlans reports renderer failures without throwing', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const [append] = extracted('appendBuildingFloorPlans', 'let xrayEnabled=true; let floorCutawayLevel=1; let floorPlanGroup={add(){}}; let renderedFloorPlanKeys=new Set(); let floorPlanErrors=0;', { THREE: {}, floorPlanRenderer: { createBuildingGroup: () => { throw new Error('bad plan'); } }, floorPlanGeometry: {}, latLngToXY: () => [0, 0] });
        expect(() => append({ properties: { name: 'bad', floorPlans: { registration: {}, floors: [] } } })).not.toThrow();
        expect(error).toHaveBeenCalled(); error.mockRestore();
    });
    it('cutaway changes visibility without rebuilding mesh geometry', () => {
        const groups = [{ id: 'a' }, { id: 'b' }], setCutaway = vi.fn(), update = vi.fn();
        const [cut] = extracted('setFloorCutaway', 'let floorCutawayLevel=null; let floorPlanGroup={children:this.groups};',
            { groups, floorPlanRenderer: { setCutaway }, updateXrayControls: update, invalidateThreeView: vi.fn() });
        cut(2);
        expect(setCutaway.mock.calls).toEqual([[groups[0],2],[groups[1],2]]);
        cut(null);
        expect(setCutaway.mock.calls.slice(2)).toEqual([[groups[0],null],[groups[1],null]]);
        cut(NaN); expect(setCutaway).toHaveBeenCalledTimes(4); expect(update).toHaveBeenCalledTimes(2);
    });
    it('a rendered architectural model replaces its opaque proxy and leaves other buildings intact', async () => {
        const model={properties:{name:'model'},geometry:{}}, ordinary={properties:{name:'ordinary'},geometry:{}};
        const draw=vi.fn(), group={};
        const [build] = extracted('buildProposedBuildings3D', 'let plannedRepresentation="both",buildOutDisplaySalt=0;let buildingMaterials={};', {
            window:{ proposedBuildings:[model,ordinary], UrbanRuleVariation:{plannedDrawPlan:feature=>({buildOut:feature})} },
            turf:{}, appendBuildingFloorPlans:feature=>feature===model, appendSuggestedFloorPlans:()=>false,
            createBuildingSlices:draw, estimateBuildingHeightMeters:()=>9, sceneWork
        });
        await build(group,'solid');
        expect(draw).toHaveBeenCalledExactlyOnceWith(ordinary,9,'solid',group,ordinary);
    });
    it('disposeFloorPlans disposes every owned child, removes them, and resets bookkeeping', () => {
        const children = [{}, {}], remove = vi.fn(), dispose = vi.fn(), keys = new Set(['a']);
        const [disposePlans] = extracted('disposeFloorPlans', 'let floorPlanGroup={children:this.children,remove:this.remove}; let renderedFloorPlanKeys=this.keys; let floorPlanErrors=3; const suggestedPlanTotals={buildings:2,slices:3,flagged:1,apartments:4,cores:2,pendingStreets:true}; const suggestedPlanByParcel=new Map([["a",1]]); const suggestedPlanByProposal=new Map([["p",1]]);', { children, remove, keys, floorPlanRenderer: { disposeGroup: dispose } });
        disposePlans(); expect(dispose).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(2); expect(keys.size).toBe(0);
    });
    it('applyIsolationVisibility filters floor-plan wrappers by parcel identity', () => {
        const [apply, context] = extracted('applyIsolationVisibility', `let flatGroup=null; let buildingGroup=null; let existingBuildingsGroup={children:[]}; let proposedBuildingsGroup={children:[]}; let ineligibleBuildingsGroup={children:[]}; let floorPlanGroup=this.fpGroup; let plannedFlatGroup=null; let parkGroup=null; let squareGroup=null; let lakeGroup=null; let stationGroup=null; let existingTransitAlignmentGroup=null;`, { fpGroup: { children: [{ userData: { parcelId: 'keep' } }, { userData: { parcelId: 'hide' } }] }, turf: { point: () => ({}), booleanPointInPolygon: () => false }, updateXrayControls: vi.fn() });
        apply(new Set(['keep']), []);
        expect(context.fpGroup.children.map(child => child.visible)).toEqual([true, false]);
    });

    // Suggested default layouts: generated per parcel slice, flagged red when the core does not fit.
    function suggestedHarness(overrides = {}) {
        const okPlans = { suggested: true, registration: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, floors: [{ id: 'f0' }] };
        const slices = overrides.slices || [
            { parcelId: 'A', footprint: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } },
                result: { floorPlans: okPlans, warnings: [], summary: { cores: 1, apartmentsPerFloor: 2, heightM: 12 } } },
            { parcelId: 'B', footprint: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } },
                result: { floorPlans: null, warnings: [{ code: 'core-does-not-fit' }], summary: { cores: 0, apartmentsPerFloor: 0 } } }
        ];
        const stubs = {
            suggestedFloorPlans: {}, suggestedPlanContext: { planBuilding: vi.fn(() => ({ slices, floors: 4 })), neighbourPool: vi.fn(() => []) },
            window: { UrbanRuleVariation: { plannedDrawPlan: feature => ({ buildOut: feature, massing: null }) }, LiveParcelFabric: { queryBounds: () => ['parcel'] },
                proposedBuildings: [], buildingFeaturePool: [], STOREY_HEIGHT_M: 3.3 },
            turf: { bbox: () => [0, 0, 1, 1] }, estimateBuildingHeightMeters: () => 12, suggestedRoadsFor: vi.fn(() => ['road']), suggestedRegion: () => 'HR',
            recordSuggestedSlice: vi.fn(), buildingFacades: { buildingKey: () => 'k', buildingDesign: () => ({ bayWidth: 3.2 }) },
            appendBuildingFloorPlans: vi.fn(() => true), polygonFeatureToMeshes: vi.fn(() => [{ userData: {} }]), createBuildingSlices: vi.fn(),
            ...(overrides.stubs || {})
        };
        const [append, c] = extracted('appendSuggestedFloorPlans', `
            let xrayEnabled=${overrides.xray !== false}, suggestedPlansEnabled=${overrides.suggested !== false}, floorPlanGroup={}, floorPlanErrors=0;
            let plannedRepresentation='both', buildOutDisplaySalt=0;
            const suggestedPlanCache=new Map();
            const suggestedPlanTotals={buildings:0,slices:0,flagged:0,apartments:0,cores:0,pendingStreets:false};
            const buildingMaterials={flagged:'flagged-material',massing:'massing-material'};
            this.totals=suggestedPlanTotals;
        `, stubs);
        return { append, c, slices };
    }
    it('appendSuggestedFloorPlans stays out of the way while X-ray or the toggle is off, and never second-guesses evidence', () => {
        const feature = { geometry: {}, properties: { name: 'house' } };
        const off = suggestedHarness({ suggested: false });
        expect(off.append(feature, 'm', { add: vi.fn() }, {})).toBe(false);
        expect(off.c.suggestedPlanContext.planBuilding).not.toHaveBeenCalled();
        expect(suggestedHarness({ xray: false }).append(feature, 'm', { add: vi.fn() }, {})).toBe(false);
        const on = suggestedHarness();
        expect(on.append({ geometry: {}, properties: { floorPlans: {} } }, 'm', { add: vi.fn() }, {})).toBe(false);
        expect(on.append({ geometry: {}, properties: { modelUrl: 'x.glb' } }, 'm', { add: vi.fn() }, {})).toBe(false);
        expect(on.c.suggestedPlanContext.planBuilding).not.toHaveBeenCalled();
    });
    it('appendSuggestedFloorPlans draws a generated interior per fitting slice and a red volume per flagged one, leaving the proposal untouched', () => {
        const { append, c, slices } = suggestedHarness();
        const feature = { geometry: {}, properties: { name: 'block piece', proposalId: 'p1', buildingIndex: 2 } };
        const group = { add: vi.fn() };
        expect(append(feature, 'planned-material', group, {})).toBe(true);
        expect(c.suggestedPlanContext.planBuilding).toHaveBeenCalledOnce();
        const [subject, context] = c.suggestedPlanContext.planBuilding.mock.calls[0];
        expect(subject).toBe(feature);
        expect(context).toMatchObject({ owner: feature, parcels: ['parcel'], heightM: 12, storeyFallbackM: 3.3, roads: ['road'], region: 'HR', rules: { facadeBayWidthM: 3.2 } });
        expect(c.recordSuggestedSlice).toHaveBeenCalledTimes(2);
        const [modelled, material, proxyHeight] = c.appendBuildingFloorPlans.mock.calls[0];
        expect(modelled.properties).toMatchObject({ name: 'block piece', parcelId: 'A', floorPlans: slices[0].result.floorPlans });
        expect(modelled.geometry).toBe(slices[0].footprint.geometry);
        expect(material).toBe('planned-material');
        expect(proxyHeight).toBeCloseTo(11.998);
        expect(feature.properties.floorPlans).toBeUndefined();
        expect(c.polygonFeatureToMeshes).toHaveBeenCalledExactlyOnceWith(slices[1].footprint, 'flagged-material', 0, 12);
        expect(group.add).toHaveBeenCalledOnce();
        expect(group.add.mock.calls[0][0].userData).toEqual({ parcelId: 'B', cbSuggestedLayoutWarnings: slices[1].result.warnings });
        expect(c.totals).toMatchObject({ buildings: 1, slices: 2, flagged: 1, apartments: 2, cores: 1 });
    });
    it('appendSuggestedFloorPlans keeps the translucent envelope when the plan draws an example inside it', () => {
        const massing = { geometry: {}, properties: {} };
        const { append, c } = suggestedHarness({ stubs: { window: {
            UrbanRuleVariation: { plannedDrawPlan: feature => ({ buildOut: feature, massing, massingStyle: 'envelope' }) },
            LiveParcelFabric: null, proposedBuildings: [], buildingFeaturePool: [], STOREY_HEIGHT_M: 3.3
        } } });
        expect(append({ geometry: {}, properties: {} }, 'm', { add: vi.fn() }, {})).toBe(true);
        expect(c.createBuildingSlices).toHaveBeenCalledExactlyOnceWith(massing, 12, 'massing-material', expect.anything(), null);
    });
    it('records slices per parcel and per proposal, and the panels read them back', () => {
        const variables = `
            let suggestedPlansEnabled=true;
            const suggestedPlanByParcel=new Map(); const suggestedPlanByProposal=new Map();
            this.byParcel=suggestedPlanByParcel; this.byProposal=suggestedPlanByProposal;`;
        const stubs = { threeI18n: (key, fallback) => fallback };
        const [record, c] = extracted('recordSuggestedSlice', variables, stubs);
        const owner = { properties: { proposalId: 'p1' } };
        const ok = { floorPlans: { floors: [{ apartments: [{}, {}] }, { apartments: [{}, {}] }] }, warnings: [], summary: { cores: 1, apartmentsPerFloor: 2, rooms: 9 } };
        const bad = { floorPlans: null, warnings: [{ severity: 'error', message: 'Too small to fit a minimum stair core of 4.6 × 5.87 m behind the front facade.' }], summary: { cores: 0, apartmentsPerFloor: 0 } };
        record(owner, { parcelId: 'A', wing: null, result: ok }, 2);
        record(owner, { parcelId: 'B', wing: null, result: bad }, 2);
        expect(c.byProposal.get('p1')).toEqual({ buildings: 1, flagged: 1, apartmentsPerFloor: 2, apartments: 4, cores: 1 });
        const panelVariables = `let suggestedPlansEnabled=true; const suggestedPlanByParcel=this.byParcel; const suggestedPlanByProposal=this.byProposal;`;
        const [parcelText] = extracted('suggestedParcelPanelText', panelVariables, { ...stubs, byParcel: c.byParcel, byProposal: c.byProposal });
        expect(parcelText('A')).toBe('1 core(s) · 2 apartments per floor · 9 rooms');
        expect(parcelText('B')).toMatch(/^No default layout fits: Too small/);
        expect(parcelText('Z')).toBe('');
        const [proposalText] = extracted('suggestedProposalPanelText', panelVariables, { ...stubs, byParcel: c.byParcel, byProposal: c.byProposal });
        expect(proposalText({ proposalId: 'p1' })).toBe('Suggested layouts: 1 buildings · 2 apartments per floor · 4 in total 1 in red: too small for a minimum stair core.');
        const [offText] = extracted('suggestedProposalPanelText', `let suggestedPlansEnabled=false; const suggestedPlanByParcel=new Map(); const suggestedPlanByProposal=this.byProposal;`, { ...stubs, byProposal: c.byProposal });
        expect(offText({ proposalId: 'p1' })).toBe('');
    });
    it('setSuggestedPlansEnabled rebuilds and refreshes the controls', () => {
        const [set, context] = extracted('setSuggestedPlansEnabled', 'let suggestedPlansEnabled=false;',
            { rebuild3DBuildingsOnly: () => context.calls.push('rebuild'), updateXrayControls: () => context.calls.push('update') });
        set(true);
        expect(context.calls).toEqual(['rebuild', 'update']);
    });
    it('suggestedStreetsFor answers from the cell cache, fetches a missing cell once and reports the wait', () => {
        const fetch = vi.fn(() => new Promise(() => {}));
        const [streetsFor, c] = extracted('suggestedStreetsFor', `
            const suggestedStreetCells=new Map([['cached', { features: ['street'], pending: false }]]);
            const suggestedPlanTotals={pendingStreets:false}; const suggestedPlanCache=new Map();
            let isActive=true, xrayEnabled=true, suggestedPlansEnabled=true; this.totals=suggestedPlanTotals;`,
        { suggestedPlanContext: { streetCellKey: feature => feature.cell, streetCellBbox: () => [1, 2, 3, 4] }, turf: {}, fetch, window: { getBackendBase: () => 'http://api' } });
        expect(streetsFor({ cell: 'cached' })).toEqual(['street']);
        expect(c.totals.pendingStreets).toBe(false);
        expect(streetsFor({ cell: 'fresh' })).toBeNull();
        expect(streetsFor({ cell: 'fresh' })).toBeNull();
        expect(fetch).toHaveBeenCalledExactlyOnceWith('http://api/streets/near?bbox=1%2C2%2C3%2C4');
        expect(c.totals.pendingStreets).toBe(true);
    });
});
