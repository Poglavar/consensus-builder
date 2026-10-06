// Characterization tests for the Xray wiring functions in three-mode.js.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

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
        const stubs = {
            enabled, built, planned, isolated,
            clearGroupChildren: vi.fn(), disposeFloorPlans: vi.fn(), restoreParcelEmphasis: vi.fn(),
            buildingDisplayPolicy: { resolveBuiltDisplayPolicy: mode => ({ visible: mode !== 'off', material: mode, showSurviving: true, showDemolished: false }) },
            buildingMaterials: { xray: 'xray-material', solid: 'solid-material', ghost: 'ghost-material' },
            buildNearbyProposalBuildings3D: vi.fn(), buildProposedBuildings3D: vi.fn(),
            buildIneligibleParcels3D: vi.fn(), ensureNearbyProposalBuildings: vi.fn(),
            ensureNearbyTrees: vi.fn(), rebuildTreesOnly: vi.fn(), ensureNearbyWater: vi.fn(), rebuildWaterOnly: vi.fn(),
            applyParcelEmphasis: vi.fn(), isolateProposal: vi.fn(), updateXrayControls: vi.fn()
        };
        return extracted('rebuild3DBuildingsOnly', `
            let isActive=true, buildingGroup={}, buildingsRenderGeneration=0;
            let xrayEnabled=this.enabled, builtDisplay=this.built, plannedDisplay=this.planned;
            let realisticLayerActive=false, existingTransitAlignmentGroup={}, showIneligibleParcels=false;
            let isolatedParcelId=this.isolated, isolatedProposalId=null;
        `, stubs);
    }
    it.each([true, false])('X-ray=%s preserves chosen exterior materials for buildings without models', enabled => {
        const [rebuild, c] = rebuildHarness(enabled);
        rebuild();
        expect(c.disposeFloorPlans).toHaveBeenCalledOnce();
        expect(c.buildNearbyProposalBuildings3D.mock.calls[0][1]).toBe('ghost-material');
        expect(c.buildProposedBuildings3D.mock.calls[0][1]).toBe('solid-material');
        expect(c.updateXrayControls).toHaveBeenCalledOnce();
    });
    it('respects display-off families and reapplies isolation after a rebuild', () => {
        const [rebuild, c] = rebuildHarness(true, 'off', 'off', 'parcel-42');
        rebuild();
        expect(c.disposeFloorPlans).toHaveBeenCalledOnce();
        expect(c.buildNearbyProposalBuildings3D).not.toHaveBeenCalled();
        expect(c.buildProposedBuildings3D).not.toHaveBeenCalled();
        expect(c.applyParcelEmphasis).toHaveBeenCalledOnce();
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
            { groups, floorPlanRenderer: { setCutaway }, updateXrayControls: update });
        cut(2);
        expect(setCutaway.mock.calls).toEqual([[groups[0],2],[groups[1],2]]);
        cut(null);
        expect(setCutaway.mock.calls.slice(2)).toEqual([[groups[0],null],[groups[1],null]]);
        cut(NaN); expect(setCutaway).toHaveBeenCalledTimes(4); expect(update).toHaveBeenCalledTimes(2);
    });
    it('a rendered architectural model replaces its opaque proxy and leaves other buildings intact', () => {
        const model={properties:{name:'model'},geometry:{}}, ordinary={properties:{name:'ordinary'},geometry:{}};
        const draw=vi.fn(), group={};
        const [build] = extracted('buildProposedBuildings3D', 'let plannedRepresentation="both",buildOutDisplaySalt=0;let buildingMaterials={};', {
            window:{ proposedBuildings:[model,ordinary], UrbanRuleVariation:{plannedDrawPlan:feature=>({buildOut:feature})} },
            turf:{}, appendBuildingFloorPlans:feature=>feature===model,
            createBuildingSlices:draw, estimateBuildingHeightMeters:()=>9
        });
        build(group,'solid');
        expect(draw).toHaveBeenCalledExactlyOnceWith(ordinary,9,'solid',group,ordinary);
    });
    it('disposeFloorPlans disposes every owned child, removes them, and resets bookkeeping', () => {
        const children = [{}, {}], remove = vi.fn(), dispose = vi.fn(), keys = new Set(['a']);
        const [disposePlans] = extracted('disposeFloorPlans', 'let floorPlanGroup={children:this.children,remove:this.remove}; let renderedFloorPlanKeys=this.keys; let floorPlanErrors=3;', { children, remove, keys, floorPlanRenderer: { disposeGroup: dispose } });
        disposePlans(); expect(dispose).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(2); expect(keys.size).toBe(0);
    });
    it('applyIsolationVisibility filters floor-plan wrappers by parcel identity', () => {
        const [apply, context] = extracted('applyIsolationVisibility', `let flatGroup=null; let buildingGroup=null; let floorPlanGroup=this.fpGroup; let plannedFlatGroup=null; let parkGroup=null; let squareGroup=null; let lakeGroup=null; let stationGroup=null; let existingTransitAlignmentGroup=null;`, { fpGroup: { children: [{ userData: { parcelId: 'keep' } }, { userData: { parcelId: 'hide' } }] }, turf: { point: () => ({}), booleanPointInPolygon: () => false }, updateXrayControls: vi.fn() });
        apply(new Set(['keep']), []);
        expect(context.fpGroup.children.map(child => child.visible)).toEqual([true, false]);
    });
});
