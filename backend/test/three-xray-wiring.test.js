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
let buildingMaterialInitializer;
function collectFunctions(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    if (node.type === 'VariableDeclarator' && node.id.name === 'buildingMaterials') buildingMaterialInitializer = source.slice(node.init.start, node.init.end);
    Object.keys(node).forEach(key => { if (key !== 'loc' && key !== 'start' && key !== 'end') { const value = node[key]; if (Array.isArray(value)) value.forEach(collectFunctions); else collectFunctions(value); } });
}
collectFunctions(ast);

function extracted(name, variables = '', stubs = {}, helpers = []) {
    const calls = [];
    const context = { console, ...stubs, calls };
    const code = `${variables}\n${Array.from(Object.entries(stubs)).map(([key]) => `const ${key}=this.${key};`).join('\n')}\n${[name, ...helpers].map(helper => declarations.get(helper)).join('\n')}\nthis.fn=${name};`;
    vm.runInNewContext(code, context);
    return [context.fn, context];
}

describe('building hue', () => {
    it("gives a building's stepped parts one hue through their buildingId, and any other building its outline's", () => {
        const THREE = { Color: class { constructor(value) { this.value = value; } } };
        const [hue] = extracted('buildingHue', '', { THREE }, ['stringToColor']);
        const [colorOf] = extracted('stringToColor');
        const part = (coordinates, properties) => ({ geometry: { type: 'Polygon', coordinates: [coordinates] }, properties });
        const lower = part([[15, 45], [15.001, 45], [15.001, 45.001], [15, 45]], { proposalId: 'p1', buildingId: 'tower' });
        const upper = part([[15.0004, 45.0004], [15.0006, 45.0004], [15.0006, 45.0006], [15.0004, 45.0004]], { proposalId: 'p1', buildingId: 'tower' });
        expect(hue(lower).value).toBe(hue(upper).value);
        expect(hue(lower).value).not.toBe(hue({ ...upper, properties: { proposalId: 'p1', buildingId: 'hall' } }).value);
        const plain = part(upper.geometry.coordinates[0], { proposalId: 'p1' });
        expect(hue(plain).value).toBe(colorOf(JSON.stringify(plain.geometry.coordinates[0][0])));
        expect(hue(plain).value).not.toBe(hue(lower).value);
    });
});

describe('three-mode Xray wiring', () => {
    it('keeps translucent envelopes behind coincident building surfaces in color and depth passes', () => {
        class Material {
            constructor(parameters) { this.userData = {}; Object.assign(this, parameters); }
            clone() { return new Material({ ...this, userData: { ...this.userData } }); }
        }
        const smoothTransparency = require('../../frontend/js/three-smooth-transparency.js');
        const context = { THREE: { MeshPhongMaterial: Material, LessDepth: 2, EqualDepth: 4 }, smoothTransparency,
            nightWindows: require('../../frontend/js/three-night-windows.js'), nightWindowState: {} };
        vm.runInNewContext(`
            const BUILDING_GHOST_STYLE = 'smooth', BUILDING_OPACITY_KEY = 'cbBuildingOpacity';
            ${['buildingOpacityOf', 'configureBuildingMaterial', 'makeBuildingMaterial', 'cloneBuildingMaterial'].map(name => declarations.get(name)).join('\n')}
            this.materials = ${buildingMaterialInitializer};
            this.clone = cloneBuildingMaterial;
        `, context);
        const { massing, flagged, solid } = context.materials;
        for (const actual of [flagged, solid]) {
            expect(massing.polygonOffsetFactor).toBeGreaterThan(actual.polygonOffsetFactor);
            expect(massing.polygonOffsetUnits).toBeGreaterThan(actual.polygonOffsetUnits);
        }
        // Parcel slicing clones the material before the invisible depth pass is attached.
        for (const original of [massing, flagged]) {
            const color = context.clone(original);
            const depth = smoothTransparency.createDepthMaterial(color, { lessDepth: 2 });
            expect(color.polygonOffset).toBe(true);
            expect(depth.colorWrite).toBe(false);
            expect(depth.polygonOffsetFactor).toBe(original.polygonOffsetFactor);
            expect(depth.polygonOffsetUnits).toBe(original.polygonOffsetUnits);
            expect(color.opacity).toBe(original.opacity);
        }
    });

    function rebuildHarness(enabled, built = 'ghost', planned = 'solid', isolated = null) {
        const existingBuildingsGroup = { children: [], userData: {} };
        const proposedBuildingsGroup = { children: [{ id: 'proposal-survives' }], userData: {} };
        const ineligibleBuildingsGroup = { children: [{ id: 'ineligible-survives' }] };
        const clear = vi.fn();
        const stubs = {
            window: {},
            enabled, built, planned, isolated, existingGroup: existingBuildingsGroup, proposedGroup: proposedBuildingsGroup, ineligibleGroup: ineligibleBuildingsGroup,
            clearGroupChildren: clear, retireGroupAfterFrame: group => clear(group), disposeFloorPlans: vi.fn(),
            buildingDisplayPolicy: { resolveBuiltDisplayPolicy: mode => ({ visible: mode !== 'off', material: mode, showSurviving: true, showDemolished: false }) },
            buildingMaterials: { xray: 'xray-material', solid: 'solid-material', ghost: 'ghost-material' },
            buildNearbyProposalBuildings3D: vi.fn(async () => {}), buildProposedBuildings3D: vi.fn(async () => {}), appendSuggestedExistingFloorPlans: vi.fn(),
            applyUseHighlight3D: vi.fn(), reconcileExistingFloorPlans: vi.fn(),
            buildIneligibleParcels3D: vi.fn(), ensureNearbyProposalBuildings: vi.fn(),
            ensureNearbyTrees: vi.fn(), rebuildTreesOnly: vi.fn(), ensureNearbyWater: vi.fn(), rebuildWaterOnly: vi.fn(),
            applyParcelIsolation: vi.fn(), isolateProposal: vi.fn(), updateXrayControls: vi.fn(), refreshClickStackFigures: vi.fn(),
            invalidateThreeView: vi.fn(), ensureNearbyGreen: vi.fn(), ensureNearbyFurniture: vi.fn(), noteSceneWork: vi.fn(),
            // Replacements are built off-scene and swapped into the scene group (7ed6200e9).
            THREE: { Group: class { constructor() { this.children = []; this.userData = {}; } } },
            sceneWork
        };
        const [rebuild, context] = extracted('rebuild3DBuildingsOnly', `
            let isActive=true, buildingGroup={ add() {}, remove() {} }, sunLayer=null;
            let sharedPlanRetainedIds=null;
            const buildingRefreshQueue = this.sceneWork.createRefreshQueue(family => build3DBuildingFamilies(family));
            let buildingBuildPending=false, buildingDisplaySnapshot=null, buildingsWorkGeneration=0, pendingModelLoads=0;
            let nearbyBuildingsRevision=0;
            let buildingsRenderGeneration=0, sceneAbort=null;
            let existingBuildingsGroup=this.existingGroup, proposedBuildingsGroup=this.proposedGroup;
            let ineligibleBuildingsGroup=this.ineligibleGroup;
            let xrayEnabled=this.enabled, builtDisplay=this.built, plannedDisplay=this.planned;
            let realisticLayerActive=false, existingTransitAlignmentGroup={ visible: true }, showIneligibleParcels=false;
            let isolatedParcelId=this.isolated, isolatedProposalId=null;
            let existingFloorPlanShells=new Map();
        `, stubs, ['build3DBuildingFamilies', 'sharedPlanReconcile']);
        return [rebuild, context];
    }

    it.each([true, false])('X-ray=%s preserves chosen exterior materials for buildings without models', async enabled => {
        const [rebuild, c] = rebuildHarness(enabled);
        await rebuild();
        expect(c.disposeFloorPlans).toHaveBeenCalledOnce();
        expect(c.buildNearbyProposalBuildings3D.mock.calls[0][1]).toBe('ghost-material');
        expect(c.buildProposedBuildings3D.mock.calls[0][1]).toBe('solid-material');
        expect(c.updateXrayControls).toHaveBeenCalledOnce();
        // Highlight by use recolours the rebuilt meshes once they are in the scene.
        expect(c.applyUseHighlight3D).toHaveBeenCalledOnce();
    });
    it('respects display-off families and reapplies isolation after a rebuild', async () => {
        const [rebuild, c] = rebuildHarness(true, 'off', 'off', 'parcel-42');
        await rebuild();
        expect(c.disposeFloorPlans).toHaveBeenCalledOnce();
        expect(c.buildNearbyProposalBuildings3D).not.toHaveBeenCalled();
        expect(c.buildProposedBuildings3D).not.toHaveBeenCalled();
        expect(c.applyParcelIsolation).toHaveBeenCalledOnce();
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
    it('rebuilds only the asked family with X-ray on, keeps the designs\' floor plans, and reconciles interiors after the commit', async () => {
        const [rebuild, c] = rebuildHarness(true);
        await rebuild({ family: 'existing' });
        expect(c.buildNearbyProposalBuildings3D).toHaveBeenCalledOnce();
        expect(c.buildProposedBuildings3D).not.toHaveBeenCalled();
        expect(c.proposedGroup.children).toEqual([{ id: 'proposal-survives' }]);
        expect(c.disposeFloorPlans).toHaveBeenCalledExactlyOnceWith({ planned: false });
        expect(c.reconcileExistingFloorPlans).toHaveBeenCalledOnce();
    });

    it('setXrayEnabled rebuilds nothing when only existing interiors depend on it, and only the designs otherwise', () => {
        const toggle = (suggested, proposedBuildings) => {
            const [set, context] = extracted('setXrayEnabled', `let xrayEnabled=false; let suggestedPlansEnabled=${suggested};`, {
                window: { proposedBuildings }, rebuild3DBuildingsOnly: options => context.calls.push(`rebuild ${options.family}`),
                updateFloorModelLoads: force => context.calls.push(`floor models ${force}`), reconcileExistingFloorPlans: () => context.calls.push('reconcile'),
                applyModelSections: () => context.calls.push('sections'),
                updateXrayControls: () => context.calls.push('update'), invalidateThreeView: () => context.calls.push('invalidate') }, ['xrayRebuildsDesigns']);
            set(true);
            return context.calls;
        };
        // Uploaded models are cut by their materials (applyModelSections), never rebuilt.
        expect(toggle(false, [{ properties: {} }])).toEqual(['floor models true', 'reconcile', 'sections', 'update', 'invalidate']);
        expect(toggle(false, [{ properties: { floorPlans: {} } }])).toEqual(['rebuild planned', 'floor models true', 'reconcile', 'sections', 'update', 'invalidate']);
        expect(toggle(true, [])).toEqual(['rebuild planned', 'floor models true', 'reconcile', 'sections', 'update', 'invalidate']);
    });
    it("an arriving floor model adds only its building's group, rebuilds nothing, and its drop restores only that shell", async () => {
        const proximity = require('../../frontend/js/floor-plan-proximity.js');
        const meshA = { id: 'a', visible: true }, meshB = { id: 'b', visible: true };
        const existing = { visible: true, children: [meshA, meshB] };
        const added = [], removed = [], disposed = [];
        const modelB = { floorPlans: { storeys: [] }, footprint: null };
        const variables = `let xrayEnabled = true, isActive = true, buildingBuildPending = false, floorCutawayLevel = null, floorPlanErrors = 0;
            let existingBuildingsGroup = this.existing;
            let floorPlanGroup = { add: group => this.added.push(group), remove: group => this.removed.push(group) };
            const renderedFloorPlanKeys = new Set();
            const floorModelLoads = { models: new Map([['s:a', null]]), pending: new Map(), camera: null, revision: -1 };
            let existingFloorPlanShells = new Map([['s:a', { meshes: [this.existing.children[0]], building: { properties: {} }, material: 'ghost' }],
                ['s:b', { meshes: [this.existing.children[1]], building: { properties: {} }, material: 'ghost' }]]);
            const existingFloorPlanGroups = new Map(); let existingFloorPlanQueue = Promise.resolve();
            this.loads = floorModelLoads; this.groups = existingFloorPlanGroups;
            this.reconcile = () => reconcileExistingFloorPlans();`;
        const [request, c] = extracted('requestFloorModel', variables, {
            existing, added, removed, floorPlanProximity: proximity, URLSearchParams, AbortController,
            window: { getBackendBase: () => 'http://api.test' },
            fetch: vi.fn(async () => ({ ok: true, json: async () => ({ model: modelB }) })),
            rebuild3DBuildingsOnly: vi.fn(), updateFloorModelLoads: vi.fn(), updateXrayControls: vi.fn(), invalidateThreeView: vi.fn(),
            building3DHeightMeters: () => 29.5, THREE: {}, floorPlanGeometry: {}, latLngToXY: () => [0, 0], sceneWork, nextDrawnFrame: async () => {},
            floorPlanRenderer: { disposeGroup: group => disposed.push(group), setCutaway: vi.fn(),
                createBuildingGroupCooperative: vi.fn(async () => ({ isObject3D: true, userData: {} })) }
        }, ['reconcileExistingFloorPlans', 'removeExistingFloorPlanGroup', 'queueExistingFloorPlanGroup', 'addExistingFloorPlanGroup']);
        request('s:b', { object_id: 'b', floorPlansAvailable: { city: 'c', source: 's' } });
        await vi.waitFor(() => expect(added).toHaveLength(1));
        expect(c.fetch.mock.calls[0][0]).toBe('http://api.test/buildings/floor-model?city=c&source=s&buildingId=b');
        expect(c.rebuild3DBuildingsOnly).not.toHaveBeenCalled();
        expect(c.floorPlanRenderer.createBuildingGroupCooperative).toHaveBeenCalledOnce();
        expect(c.floorPlanRenderer.createBuildingGroupCooperative.mock.calls[0][1].properties.floorPlans).toBe(modelB.floorPlans);
        expect(c.groups.get('s:b')).toBe(added[0]);
        expect(added[0].userData).toMatchObject({ floorPlanFamily: 'existing-model', floorModelKey: 's:b', proxySource: 'ghost' });
        expect(existing.children[0]).toBe(meshA); expect(existing.children[1]).toBe(meshB);
        expect([meshA.visible, meshB.visible]).toEqual([true, false]);
        // The drop: only B's group goes, and B's own shell comes back.
        c.loads.models.delete('s:b');
        c.reconcile();
        expect(disposed).toEqual([added[0]]);
        expect(c.groups.size).toBe(0);
        expect([meshA.visible, meshB.visible]).toEqual([true, true]);
        expect(c.rebuild3DBuildingsOnly).not.toHaveBeenCalled();
    });
    it('requests floor models of marked buildings near the camera only while X-ray is on, and abandons them when it goes off', () => {
        const proximity = require('../../frontend/js/floor-plan-proximity.js');
        const face = lng => ({ coordinates: [[[lng, 0, 0], [lng + 1e-4, 1e-4, 10]]] });
        const buildings = [{ source: 's', object_id: 1, floorPlansAvailable: { city: 'c', source: 's' }, faces: [face(0)] },
            { source: 's', object_id: 2, floorPlansAvailable: { city: 'c', source: 's' }, faces: [face(1)] },
            { source: 's', object_id: 3, faces: [face(0)] }];
        const requested = [], abort = vi.fn();
        const variables = `let xrayEnabled = true; let isActive = true; let nearbyBuildingsRevision = 1; let origin3857 = {};
            const floorModelLoads = { models: new Map(), pending: new Map(), camera: null, revision: -1 };
            const floorModelCentres = new WeakMap(); const FLOOR_MODEL_RECHECK_M = 20;
            this.setXray = value => { xrayEnabled = value; }; this.loads = floorModelLoads;`;
        const [update, context] = extracted('updateFloorModelLoads', variables, { floorPlanProximity: proximity, nearbyProposalBuildings: buildings,
            camera: { position: { x: 0, y: 0, z: 30 } }, lifeMercatorK: () => 1, latLngToXY: (lat, lng) => [lng * 111320, lat * 111320],
            threeBuildingKey: b => `${b.source}:${b.object_id}`, rebuild3DBuildingsOnly: vi.fn(),
            requestFloorModel: key => { requested.push(key); context.loads.pending.set(key, { abort }); } }, ['floorModelCentre']);
        update(true);
        // Building 2 is ~111 km away, building 3 has no marker.
        expect(requested).toEqual(['s:1']);
        context.setXray(false);
        update(true);
        expect(abort).toHaveBeenCalledTimes(1);
        expect(context.loads.pending.size).toBe(0);
        update(true);
        expect(requested).toEqual(['s:1']);
        expect(context.rebuild3DBuildingsOnly).not.toHaveBeenCalled();
    });
    it('builds arriving interiors one at a time, the next after the previous one has been drawn', async () => {
        const proximity = require('../../frontend/js/floor-plan-proximity.js');
        const order = [], frames = [];
        const shell = { meshes: [{ visible: true }], building: { properties: {} }, material: 'ghost' };
        const variables = `let xrayEnabled = true, isActive = true, buildingBuildPending = false, floorCutawayLevel = null, floorPlanErrors = 0;
            let existingBuildingsGroup = { visible: true };
            let floorPlanGroup = { add() {}, remove() {} };
            const floorModelLoads = { models: new Map([['a', { floorPlans: {} }], ['b', { floorPlans: {} }]]), pending: new Map() };
            let existingFloorPlanShells = new Map([['a', this.shell], ['b', { ...this.shell, meshes: [{ visible: true }] }]]);
            const existingFloorPlanGroups = new Map(); let existingFloorPlanQueue = Promise.resolve();`;
        const [reconcile] = extracted('reconcileExistingFloorPlans', variables, { shell, floorPlanProximity: proximity, THREE: {}, floorPlanGeometry: {},
            latLngToXY: () => [0, 0], sceneWork, building3DHeightMeters: () => 10, updateXrayControls: vi.fn(), invalidateThreeView: vi.fn(),
            nextDrawnFrame: () => new Promise(resolve => frames.push(resolve)),
            floorPlanRenderer: { disposeGroup: vi.fn(), setCutaway: vi.fn(), createBuildingGroupCooperative: async (_three, feature) => {
                order.push(feature); return { isObject3D: true, userData: {} }; } }
        }, ['removeExistingFloorPlanGroup', 'queueExistingFloorPlanGroup', 'addExistingFloorPlanGroup']);
        reconcile();
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        expect(order).toHaveLength(1);
        frames[0]();
        await vi.waitFor(() => expect(order).toHaveLength(2));
    });
    it('appendBuildingFloorPlans does no work while disabled and deduplicates registered geometry', () => {
        const add = vi.fn(), create = vi.fn(() => ({ userData: { cbFloorPlan: true } }));
        const feature = { properties: { floorPlans: { registration: { corners: [[1, 2]] }, storeys: [{ id: 'f1' }] } } };
        const [append] = extracted('appendBuildingFloorPlans', 'let xrayEnabled=false; let floorPlanGroup={add:this.add}; let renderedFloorPlanKeys=new Set(); let floorPlanErrors=0;', { add, THREE: {}, floorPlanRenderer: { createBuildingGroup: create, setCutaway: vi.fn() }, floorPlanGeometry: {}, latLngToXY: () => [0, 0] });
        append(feature); expect(create).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
        const [enabledAppend] = extracted('appendBuildingFloorPlans', 'let xrayEnabled=true; let floorCutawayLevel=1; let floorPlanGroup={add:this.add}; let renderedFloorPlanKeys=new Set(); let floorPlanErrors=0;', { add, THREE: {}, floorPlanRenderer: { createBuildingGroup: create, setCutaway: vi.fn() }, floorPlanGeometry: {}, latLngToXY: () => [0, 0] });
        expect(enabledAppend(feature)).toMatchObject({ userData: { cbFloorPlan: true, floorPlanFamily: 'planned' } });
        expect(enabledAppend(feature)).toBe(true); expect(create).toHaveBeenCalledTimes(1); expect(add).toHaveBeenCalledTimes(1);
    });
    it('appendBuildingFloorPlans reports renderer failures without throwing', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const [append] = extracted('appendBuildingFloorPlans', 'let xrayEnabled=true; let floorCutawayLevel=1; let floorPlanGroup={add(){}}; let renderedFloorPlanKeys=new Set(); let floorPlanErrors=0;', { THREE: {}, floorPlanRenderer: { createBuildingGroup: () => { throw new Error('bad plan'); } }, floorPlanGeometry: {}, latLngToXY: () => [0, 0] });
        expect(() => append({ properties: { name: 'bad', floorPlans: { registration: {}, storeys: [] } } })).not.toThrow();
        expect(error).toHaveBeenCalled(); error.mockRestore();
    });
    it('cutaway changes visibility without rebuilding mesh geometry', () => {
        const groups = [{ id: 'a' }, { id: 'b' }], setCutaway = vi.fn(), update = vi.fn(), sections = vi.fn();
        const [cut] = extracted('setFloorCutaway', 'let floorCutawayLevel=null; let floorPlanGroup={children:this.groups};',
            { groups, floorPlanRenderer: { setCutaway }, applyModelSections: sections, updateXrayControls: update, invalidateThreeView: vi.fn() });
        cut(2);
        expect(setCutaway.mock.calls).toEqual([[groups[0],2],[groups[1],2]]);
        cut(null);
        expect(setCutaway.mock.calls.slice(2)).toEqual([[groups[0],null],[groups[1],null]]);
        cut(NaN); expect(setCutaway).toHaveBeenCalledTimes(4); expect(update).toHaveBeenCalledTimes(2); expect(sections).toHaveBeenCalledTimes(2);
    });
    it('a rendered architectural model replaces its opaque proxy and leaves other buildings intact', async () => {
        const model={properties:{name:'model'},geometry:{}}, ordinary={properties:{name:'ordinary'},geometry:{}};
        const draw=vi.fn(), group={};
        const [build] = extracted('buildProposedBuildings3D', 'let plannedRepresentation="both",buildOutDisplaySalt=0;let buildingMaterials={};', {
            window:{ proposedBuildings:[model,ordinary], UrbanRuleVariation:{plannedDrawPlan:feature=>({buildOut:feature})} },
            turf:{}, appendBuildingFloorPlans:feature=>feature===model, appendSuggestedFloorPlans:()=>false,
            createBuildingSlices:draw, estimateBuildingHeightMeters:()=>9, sceneWork,
            displayedFeatures:features=>features, buildoutSiteOf:()=>null
        });
        await build(group,'solid');
        expect(draw).toHaveBeenCalledExactlyOnceWith(ordinary,9,'solid',group,ordinary,null);
    });
    it('disposeFloorPlans disposes the families a build replaces and keeps existing buildings\' interiors to the scene', () => {
        const group = (family, key) => ({ userData: { floorPlanFamily: family, floorPlanKey: key } });
        const planned = group('planned', 'p'), suggested = group('existing-suggested', 's'), model = group('existing-model', 'm');
        const children = [planned, suggested, model], dispose = vi.fn(), keys = new Set(['p', 's', 'm']);
        const remove = item => children.splice(children.indexOf(item), 1);
        const [disposePlans] = extracted('disposeFloorPlans', 'let floorPlanGroup={children:this.children,remove:this.remove}; let renderedFloorPlanKeys=this.keys; let floorPlanErrors=3; const existingFloorPlanGroups=new Map([["m",1]]); const suggestedPlanTotals={buildings:2,slices:3,flagged:1,apartments:4,cores:2,pendingStreets:true}; const suggestedPlanByParcel=new Map([["a",1]]); const suggestedPlanByProposal=new Map([["p",1]]);', { children, remove, keys, floorPlanRenderer: { disposeGroup: dispose } });
        disposePlans({ planned: false });
        expect(children).toEqual([planned, model]); expect([...keys]).toEqual(['p', 'm']);
        disposePlans();
        expect(children).toEqual([model]);
        disposePlans({ planned: true, models: true });
        expect(children).toEqual([]); expect(keys.size).toBe(0); expect(dispose).toHaveBeenCalledTimes(3);
    });
    it('applyIsolationVisibility filters floor-plan wrappers by parcel identity', () => {
        const [apply, context] = extracted('applyIsolationVisibility', `let flatGroup=null; let buildingGroup=null; let existingBuildingsGroup={children:[]}; let proposedBuildingsGroup={children:[]}; let ineligibleBuildingsGroup={children:[]}; let floorPlanGroup=this.fpGroup; let plannedFlatGroup=null; let parkGroup=null; let squareGroup=null; let lakeGroup=null; let stationGroup=null; let existingTransitAlignmentGroup=null; let treesGroup=null; let lifeGroup=null; let planningSourcesGroup=null; let isolationHidden=[];`, { fpGroup: { children: [{ userData: { parcelId: 'keep' }, visible: true }, { userData: { parcelId: 'hide' }, visible: true }] }, turf: { point: () => ({}), booleanPointInPolygon: () => false }, updateXrayControls: vi.fn(), invalidateThreeView: vi.fn(), window: { __threeSceneIsolation: require('../../frontend/js/three-scene-isolation.js') } });
        apply(new Set(['keep']), []);
        expect(context.fpGroup.children.map(child => child.visible)).toEqual([true, false]);
    });

    // Suggested default layouts: generated per parcel slice, flagged red when the core does not fit.
    function suggestedHarness(overrides = {}) {
        const okPlans = { suggested: true, registration: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, storeys: [{ id: 'f0' }] };
        const slices = overrides.slices || [
            { parcelId: 'A', footprint: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } },
                result: { floorPlans: okPlans, warnings: [], summary: { cores: 1, apartmentsPerFloor: 2, heightM: 12 } } },
            { parcelId: 'B', footprint: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } },
                result: { floorPlans: null, warnings: [{ code: 'core-does-not-fit' }], summary: { cores: 0, apartmentsPerFloor: 0 } } }
        ];
        const stubs = {
            suggestedFloorPlans: {}, suggestedPlanContext: { planBuilding: vi.fn(() => ({ slices, floors: 4 })), neighbourPool: vi.fn(() => []) },
            window: { UrbanRuleVariation: { plannedDrawPlan: feature => ({ buildOut: feature, massing: null }) }, LiveParcelFabric: { queryBounds: () => ['parcel'] },
                proposedBuildings: [], buildingFeaturePool: [], STOREY_HEIGHT_M: 3.3, BuildingUse: require('../../frontend/js/building-use.js') },
            turf: { bbox: () => [0, 0, 1, 1] }, estimateBuildingHeightMeters: () => 12, suggestedRoadsFor: vi.fn(() => ['road']), suggestedRegion: () => 'HR',
            recordSuggestedSlice: vi.fn(), buildingFacades: { buildingKey: () => 'k', buildingDesign: () => ({ bayWidth: 3.2 }) },
            appendBuildingFloorPlans: vi.fn(() => true), polygonFeatureToMeshes: vi.fn(() => [{ userData: {} }]), createBuildingSlices: vi.fn(), appendFlaggedFlats: vi.fn(),
            ...(overrides.stubs || {})
        };
        const [append, c] = extracted('appendSuggestedFloorPlans', `
            let xrayEnabled=${overrides.xray !== false}, suggestedPlansEnabled=${overrides.suggested !== false}, floorPlanGroup={}, floorPlanErrors=0;
            let plannedRepresentation='both', buildOutDisplaySalt=0, suggestedAccess='${overrides.access || 'auto'}';
            const suggestedPlanCache=new Map();
            const suggestedPlanTotals={buildings:0,slices:0,flagged:0,apartments:0,cores:0,northFlats:0,pendingStreets:false};
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
        expect(context).toMatchObject({ owner: feature, parcels: ['parcel'], heightM: 12, storeyFallbackM: 3.3, roads: ['road'], region: 'HR', rules: { facadeBayWidthM: 3.2 }, accessOverride: 'auto' });
        expect(c.recordSuggestedSlice).toHaveBeenCalledTimes(2);
        const [modelled, material, proxyHeight] = c.appendBuildingFloorPlans.mock.calls[0];
        expect(modelled.properties).toMatchObject({ name: 'block piece', parcelId: 'A', floorPlans: slices[0].result.floorPlans });
        expect(modelled.geometry).toBe(slices[0].footprint.geometry);
        expect(material).toBe('planned-material');
        expect(proxyHeight).toBe(12);
        expect(feature.properties.floorPlans).toBeUndefined();
        expect(c.polygonFeatureToMeshes).toHaveBeenCalledExactlyOnceWith(slices[1].footprint, 'flagged-material', 0, 12);
        expect(group.add).toHaveBeenCalledOnce();
        expect(group.add.mock.calls[0][0].userData).toEqual({ parcelId: 'B', cbSuggestedLayoutWarnings: slices[1].result.warnings });
        expect(c.totals).toMatchObject({ buildings: 1, slices: 2, flagged: 1, apartments: 2, cores: 1 });
        // The drawn slice's north-only flats are painted on its group; the view's Access reaches the planner.
        expect(c.appendFlaggedFlats).toHaveBeenCalledExactlyOnceWith(true, slices[0].result);
        const corridor = suggestedHarness({ access: 'corridor' });
        corridor.append(feature, 'm', { add: vi.fn() }, {});
        expect(corridor.c.suggestedPlanContext.planBuilding.mock.calls[0][1].accessOverride).toBe('corridor');
    });
    it('appendSuggestedFloorPlans keeps the translucent envelope when the plan draws an example inside it', () => {
        const massing = { geometry: {}, properties: {} };
        const { append, c } = suggestedHarness({ stubs: { window: {
            UrbanRuleVariation: { plannedDrawPlan: feature => ({ buildOut: feature, massing, massingStyle: 'envelope' }) },
            LiveParcelFabric: null, proposedBuildings: [], buildingFeaturePool: [], STOREY_HEIGHT_M: 3.3, BuildingUse: require('../../frontend/js/building-use.js')
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
        const ok = { floorPlans: { storeys: [{ units: [{ kind: 'apartment' }, { kind: 'apartment' }] }, { units: [{ kind: 'apartment' }, { kind: 'apartment' }] }] }, warnings: [], summary: { cores: 1, apartmentsPerFloor: 2, rooms: 9 } };
        const bad = { floorPlans: null, warnings: [{ severity: 'error', message: 'Too small to fit a minimum stair core of 4.6 × 5.87 m behind the front facade.' }], summary: { cores: 0, apartmentsPerFloor: 0 } };
        record(owner, { parcelId: 'A', wing: null, result: ok }, 2);
        record(owner, { parcelId: 'B', wing: null, result: bad }, 2);
        expect(c.byProposal.get('p1')).toEqual({ buildings: 1, flagged: 1, apartmentsPerFloor: 2, apartments: 4, cores: 1 });
        const panelVariables = `let suggestedPlansEnabled=true; const suggestedPlanByParcel=this.byParcel; const suggestedPlanByProposal=this.byProposal;`;
        const [parcelText] = extracted('suggestedParcelPanelText', panelVariables, { ...stubs, byParcel: c.byParcel, byProposal: c.byProposal });
        expect(parcelText('A')).toBe('1 core(s) · 2 apartments per storey · 9 rooms');
        expect(parcelText('B')).toMatch(/^No default layout fits: Too small/);
        expect(parcelText('Z')).toBe('');
        const [proposalText] = extracted('suggestedProposalPanelText', panelVariables, { ...stubs, byParcel: c.byParcel, byProposal: c.byProposal });
        expect(proposalText({ proposalId: 'p1' })).toBe('Suggested layouts: 1 buildings · 2 apartments per storey · 4 in total 1 in red: too small for a minimum stair core.');
        const [offText] = extracted('suggestedProposalPanelText', `let suggestedPlansEnabled=false; const suggestedPlanByParcel=new Map(); const suggestedPlanByProposal=this.byProposal;`, { ...stubs, byProposal: c.byProposal });
        expect(offText({ proposalId: 'p1' })).toBe('');
    });
    it('setSuggestedPlansEnabled rebuilds and refreshes the controls', () => {
        const [set, context] = extracted('setSuggestedPlansEnabled', 'let suggestedPlansEnabled=false;',
            { rebuild3DBuildingsOnly: () => context.calls.push('rebuild'), updateXrayControls: () => context.calls.push('update') });
        set(true);
        expect(context.calls).toEqual(['rebuild', 'update']);
    });
    it('setSuggestedAccess rebuilds once per change of the view\'s Access and reads anything else as automatic', () => {
        const [set, context] = extracted('setSuggestedAccess', `let suggestedAccess='auto'; this.read=()=>suggestedAccess;`,
            { rebuild3DBuildingsOnly: () => context.calls.push('rebuild'), updateXrayControls: () => context.calls.push('update') });
        set('corridor');
        expect(context.read()).toBe('corridor');
        set('corridor');
        expect(context.calls).toEqual(['rebuild', 'update']);
        set('spiral');
        expect(context.read()).toBe('auto');
        expect(context.calls).toEqual(['rebuild', 'update', 'rebuild', 'update']);
    });
    it('appendFlaggedFlats paints each north-only flat red on the storeys it occupies, inside that storey', () => {
        const meshes = [];
        const polygonFeatureToMeshes = vi.fn((feature, material, z, depth) => { const mesh = { userData: {}, feature, material, z, depth }; meshes.push(mesh); return [mesh]; });
        const floor = (id, level) => ({ userData: { cbFloorPlanFloor: true, id, level }, children: [], add(mesh) { this.children.push(mesh); } });
        const floors = [floor('s-1', -1), floor('s0', 0), floor('s1', 1), floor('s2', 2)];
        const group = { isObject3D: true, children: [{ userData: {} }, ...floors] };
        const ring = [[16, 45], [16.0001, 45], [16.0001, 45.0001], [16, 45]];
        const result = {
            summary: { flats: [{ id: 'flat-1', flag: 'north-single-aspect', rings: [ring] }, { id: 'flat-2', flag: null, rings: [ring] }] },
            floorPlans: { storeys: [
                { id: 's-1', units: [{ id: 'garage--1', kind: 'garage' }] },
                { id: 's0', units: [{ id: 'flat-1-0', kind: 'shop' }, { id: 'flat-2-0', kind: 'shop' }] },
                { id: 's1', units: [{ id: 'flat-1-1', kind: 'apartment', flag: 'north-single-aspect' }, { id: 'flat-2-1', kind: 'apartment' }] },
                { id: 's2', units: [{ id: 'flat-1-2', kind: 'apartment', flag: 'north-single-aspect' }, { id: 'flat-2-2', kind: 'apartment' }] }] }
        };
        const [paint] = extracted('appendFlaggedFlats', `const buildingMaterials={flagged:{clone:()=>'red-copy'}};`, { polygonFeatureToMeshes });
        expect(paint(group, result)).toBe(2);
        expect(floors.map(f => f.children.length)).toEqual([0, 0, 1, 1]);
        expect(meshes.every(mesh => mesh.material === 'red-copy' && mesh.depth > 0 && mesh.userData.cbSuggestedFlag === 'north-single-aspect')).toBe(true);
        expect(meshes[0].feature.geometry).toEqual({ type: 'MultiPolygon', coordinates: [[ring]] });
        expect(paint(group, { summary: { flats: [] }, floorPlans: result.floorPlans })).toBe(0);
        expect(paint(true, result)).toBe(0); // an already drawn model is not repainted
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
    it('the solid-existing notice shows only while typical layouts of existing buildings sit inside solid volumes', () => {
        const notice = { hidden: true }, access = { hidden: true }, accessSelect = { value: 'auto' };
        const [update, c] = extracted('updateXrayControls', `
            let xrayButton=null, suggestedPlansButton=null, suggestedExistingRow=null, suggestedExistingCheckbox=null;
            let suggestedAccessControl=this.access, suggestedAccessSelect=this.accessSelect, suggestedAccess='point';
            let floorCutawayControl=null, floorCutawaySelect=null, xrayNote=null, xraySolidNotice=this.notice;
            let xrayEnabled=true, suggestedPlansEnabled=true, suggestedExistingEnabled=true, builtDisplay='solid';
            this.set=(key, value)=>{ eval(key + '=value'); };`, { notice, access, accessSelect });
        update();
        expect(notice.hidden).toBe(false);
        // The Access select shows with the suggested layouts and says the view's choice.
        expect(access.hidden).toBe(false);
        expect(accessSelect.value).toBe('point');
        for (const [key, value] of [['builtDisplay', 'ghost'], ['suggestedExistingEnabled', false], ['suggestedPlansEnabled', false], ['xrayEnabled', false]]) {
            c.set(key, value);
            update();
            expect(notice.hidden).toBe(true);
            expect(access.hidden).toBe(key === 'suggestedPlansEnabled' || key === 'xrayEnabled');
            c.set(key, key === 'builtDisplay' ? 'solid' : true);
            update();
            expect(notice.hidden).toBe(false);
        }
    });
    it('typical layouts of existing buildings ask once for the whole radius and plan the nearest first', () => {
        const ensure = vi.fn(() => Promise.resolve());
        // b10, the second nearest, is an office its source states: it gets no housing layout.
        const pool = [40, 5, 400, 20].map(d => ({ geometry: {}, properties: { id: `b${d}`, d, floors: 3 } }))
            .concat([{ geometry: {}, properties: { id: 'b10', d: 10, floors: 3, use: 'office' } }]);
        const turf = { point: coordinates => ({ coordinates }), circle: () => 'circle', bbox: () => [-74.11, 4.61, -74.10, 4.62],
            centroid: feature => feature, distance: (_, feature) => feature.properties.d };
        const planBuilding = vi.fn(feature => ({ slices: [{ footprint: feature, result: { floorPlans: {}, summary: { heightM: 9.9 } } }] }));
        const [append, c] = extracted('appendSuggestedExistingFloorPlans', `
            let xrayEnabled=true, suggestedPlansEnabled=true, suggestedExistingEnabled=true, floorPlanGroup={};
            let nearbyProposalBuildingsKey='near', buildingLoadRadiusM=300, suggestedExistingPoolKey=null, floorPlanErrors=0, suggestedAccess='corridor';
            const SUGGESTED_EXISTING_CAP=2, suggestedFloorPlans={}, suggestedPlanCache=new Map();
            const suggestedPlanTotals={existing:0,existingCapped:false}; this.totals=suggestedPlanTotals;`,
        { turf, suggestedPlanContext: { planBuilding, neighbourPool: () => [] },
            window: { buildingFeaturePool: pool, proposedBuildings: [], STOREY_HEIGHT_M: 3.3, ensureBuildingFootprintsForBounds: ensure,
                BuildingUse: require('../../frontend/js/building-use.js') },
            getGeoCameraView: () => ({ targetLng: -74.105, targetLat: 4.615 }), suggestedRegion: () => 'CO', suggestedRoadsFor: () => null,
            estimateBuildingHeightMeters: () => null, reportThreeClip: vi.fn(), appendBuildingFloorPlans: vi.fn(() => true) });
        append('material');
        append('material');
        expect(ensure).toHaveBeenCalledExactlyOnceWith([[4.61, -74.11], [4.62, -74.10]]);
        expect(planBuilding.mock.calls.map(([feature]) => feature.properties.id)).toEqual(['b5', 'b20', 'b5', 'b20']);
        expect(planBuilding.mock.calls.every(([, context]) => context.accessOverride === 'corridor')).toBe(true);
        expect(c.totals).toMatchObject({ existing: 4, existingCapped: true });
    });
});
