// Exercise cached parcel evidence, source editions and the common inspection projections.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDocument } from './helpers/fake-dom.js';
import { parse } from '@babel/parser';
import { gupRecord, readZagrebParcel } from '../planning/providers/zagreb-gup.js';
import { nycPilotSource, readNycPilotParcel } from '../planning/providers/nyc-pilot.js';
import { planningParcel, sourcesFor } from '../planning/sources.js';
import { setupPlanningRoutes } from '../routes/planning.js';
const require = createRequire(import.meta.url);
const representations = require('../../frontend/js/planning/representations.js');
const Cid = require('../../frontend/js/cid.js');
const geometry = { type: 'Polygon', coordinates: [[[10,40],[10.001,40],[10.001,40.001],[10,40]]] };

describe('cache-only parcel inspection', () => {
    it('returns the saved reason and provenance even when the cached result was withdrawn and has no geometry', async () => {
        const record = { current: false, gup_id: 2025, parcel_id: 'HR-335614-1675', cestica_id: 123,
            reason: 'exception_unresolved', result_status: 'evidence_missing', computed_at: '2026-10-09T17:24:00Z',
            solver_version: 'v44', floors: [], gbp_m2: null, max_units: null, parcel_geometry: geometry };
        const pool = { query: vi.fn().mockResolvedValue({ rows: [{ record }] }) };
        const [item] = await readZagrebParcel(pool, { parcel: record.parcel_id });
        expect(item.assessment).toMatchObject({ current: false, reason: record.reason, status: 'evidence_missing' });
        expect(item.volumes).toEqual([]); expect(item.metrics).toEqual({ floorAreaM2: null, heightM: null });
        expect(item.source.computedAt).toBe(record.computed_at); expect(item.source.solverVersion).toBe('v44');
        const [sql, params] = pool.query.mock.calls[0];
        expect(params).toEqual([335614, '1675', 2025, record.parcel_id]);
        expect(sql).not.toMatch(/WHERE e.current|error_detail|\b(INSERT|UPDATE|CREATE|DELETE)\b/);
    });
    it('returns no invented diagnosis when no cache row exists', async () => {
        const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
        expect(await readZagrebParcel(pool, { parcel: 'HR-1-1' })).toEqual([]);
        expect(await readZagrebParcel(pool, { parcel: 'another-country' })).toEqual([]);
        expect(pool.query).toHaveBeenCalledTimes(1);
    });
    it('does not turn a withdrawn positive record into drawable geometry', async () => {
        const record = { current: false, gup_id: 2016, parcel_id: 'HR-1-1', reason: 'source_parcel_retired',
            floors: [{ geometry, base_elevation_m: 0, top_elevation_m: 3, height_m: 3 }], gbp_m2: 50 };
        const pool = { query: vi.fn().mockResolvedValue({ rows: [{ record }] }) };
        const [item] = await readZagrebParcel(pool, { parcel: 'HR-1-1', edition: '2016' });
        expect(item.volumes).toEqual([]); expect(item.metrics.floorAreaM2).toBe(50);
        expect(item.source.edition).toBe('2016');
    });
    it('requires explicit source descriptors and rejects unknown source IDs', () => {
        expect(() => sourcesFor({ city: 'sample' })).toThrow(/explicit planning sources/i);
        const sources = [
            { descriptor: { city: 'sample', id: 'edition-a', edition: 'a', revision: 'rev-a' } },
            { descriptor: { city: 'sample', id: 'edition-b', edition: 'b', revision: 'rev-b' } }
        ];
        expect(sourcesFor({ city: 'sample', source: 'edition-b' }, sources).map(p => p.descriptor.id)).toEqual(['edition-b']);
        expect(() => sourcesFor({ city: 'sample', source: 'unknown' }, sources)).toThrow(/unknown planning source/i);
    });
    it('routes the exact parcel to a provider without requiring a viewport or computing geometry', async () => {
        const parcel = vi.fn().mockResolvedValue([{ id: 'saved', volumes: [] }]);
        const answer = await planningParcel({}, { city: 'sample', parcel: 'a', source: 'one' }, [{ descriptor: { city: 'sample', id: 'one' }, parcel }]);
        expect(answer.items).toEqual([{ id: 'saved', volumes: [] }]); expect(parcel).toHaveBeenCalledTimes(1);
    });
    it('exposes the existing NYC pilot flags without claiming that a clear screen is an accepted envelope', async () => {
        const [item] = await readNycPilotParcel(null, { parcel: 'US-NY-3016230003' });
        expect(item.assessment.reason).toContain('nyco: mapped constraint'); expect(item.volumes).toEqual([]);
        expect(item.source.capabilities.volumes).toBe(false); expect(item.assessment.constraints).toBe('not-evaluated');
        const [clear] = await readNycPilotParcel(null, { parcel: 'US-NY-3016010012' });
        expect(clear.assessment.reason).toBeNull(); expect(clear.metrics.floorAreaM2).toBeNull();
    });
    it('does not change the calculation revision merely because retry metadata changed', () => {
        const record = { gup_id: 2025, parcel_id: 'HR-1-1', floors: [] };
        expect(gupRecord(record).source.version).toBe(gupRecord({ ...record, refresh_pending: { code: 'retry' } }).source.version);
    });
    it('bounds parcel input and exposes provider capabilities through the read-only routes', async () => {
        const handlers = {}, parcelQuery = vi.fn().mockResolvedValue({ items: [] });
        setupPlanningRoutes({ get: (path, fn) => { handlers[path] = fn; } }, {}, { parcelQuery });
        const res = { set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
        await handlers['/planning/parcel']({ query: { city: 'zagreb', parcel: ['a', 'b'] } }, res);
        expect(res.status).toHaveBeenCalledWith(400); expect(parcelQuery).not.toHaveBeenCalled();
        await handlers['/planning/parcel']({ query: { city: 'zagreb', parcel: 'HR-1-1', source: 'zagreb-gup-2016' } }, res);
        expect(parcelQuery).toHaveBeenCalledWith({}, { city: 'zagreb', parcel: 'HR-1-1', source: 'zagreb-gup-2016' });
        handlers['/planning/sources']({ query: {} }, res);
        const catalog = res.json.mock.calls.at(-1)[0].sources;
        expect(catalog.find(source => source.id === nycPilotSource.id).capabilities).toMatchObject({ volumes: false, parcelEvidence: true });
    });
});

describe('parcel panel evidence', () => {
    it('asks the cache for cadastral parcels only, never for a design-formed piece', async () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const show = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'showParcelEvidence');
        // persistent-storage.js needs a browser; its rule is that a formed piece's id carries a '#'.
        const PersistentStorage = { isDerivedParcelId: id => String(id).includes('#') };
        const parcelRecords = vi.fn(async () => []);
        const section = { isConnected: true, append: vi.fn() };
        const container = { querySelector: () => null, append: vi.fn() };
        const context = vm.createContext({ root: { PersistentStorage }, parcelRecords, element: () => section, parcelPanel: null, console });
        vm.runInContext(source.slice(show.start, show.end), context);
        await context.showParcelEvidence(container, 'HR-340715-3004#p-nswq61td8m-1');
        expect(parcelRecords).not.toHaveBeenCalled();
        expect(container.append).not.toHaveBeenCalled();
        await context.showParcelEvidence(container, 'HR-340715-3004');
        expect(parcelRecords).toHaveBeenCalledWith('HR-340715-3004');
    });
});

describe('shared building and proposal representations', () => {
    it('routes public built inspection to the click stack and keeps an unhosted built inspector hidden', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const inspect = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'inspectBuilding');
        const render = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'renderInspector');
        const feature = { geometry };
        const showBuilding = vi.fn(() => true);
        const root = { ClickStack: { showBuilding } };
        const context = vm.createContext({ root });
        vm.runInContext(source.slice(inspect.start, inspect.end), context);
        expect(vm.runInContext('inspectBuilding', context)(feature, 'source-id')).toBe(true);
        expect(showBuilding).toHaveBeenCalledWith(feature, 'source-id');

        const inspector = { hidden: false, classList: { contains: vi.fn(() => false) }, replaceChildren: vi.fn() };
        const renderContext = vm.createContext({ selected: () => representations.built(feature, { key: 'source-id', city: 'test-city' }), inspector });
        vm.runInContext(source.slice(render.start, render.end), renderContext);
        renderContext.renderInspector();
        expect(inspector.hidden).toBe(true);
        expect(inspector.replaceChildren).toHaveBeenCalledOnce();
    });

    it('labels screening and zoning-area evidence neutrally while retaining the GUP normative label and qualified proposal evidence', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'inspectorBadgeKey');
        const inspector = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'renderInspector');
        const context = vm.createContext({});
        vm.runInContext(source.slice(declaration.start, declaration.end), context);
        const badgeKey = vm.runInContext('inspectorBadgeKey', context);
        expect(badgeKey({ role: 'permitted', assessment: { meaning: 'public-screen' } })).toBe('sourceEvidenceBadge');
        expect(badgeKey({ role: 'permitted', assessment: { meaning: 'zoning-area' } })).toBe('sourceEvidenceBadge');
        const gup = gupRecord({ gup_id: 2025, parcel_id: 'HR-1-17', floors: [], result_status: 'evidence_missing' });
        expect(gup.volumes).toEqual([]);
        expect(badgeKey(gup)).toBe('obligatory');
        const proposal = representations.proposed({ proposalId: 'local', lifecycleStatus: 'Executed', lifecycleEvidence: {
            protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Executed'
        } }, { key: 'local' });
        expect(proposal.sourceEvidence.lifecycleEvidence).toMatchObject({ state: 'unknown', claimedStatus: 'Executed' });
        // Authored records keep their selection projection, but their visible reader belongs to
        // the click panel. A restored selection must clear the former standalone inspector.
        const inspectorSource = source.slice(inspector.start, inspector.end);
        const panel = { hidden: false, replaceChildren: vi.fn(), classList: { contains: () => false } };
        const renderContext = vm.createContext({ selected: () => proposal, inspector: panel, isPhoto: () => false });
        vm.runInContext(inspectorSource, renderContext);
        renderContext.renderInspector();
        expect(panel.hidden).toBe(true);
        expect(panel.replaceChildren).toHaveBeenCalledOnce();
        expect(inspectorSource).toContain("const rules = sourceResult ? page('rules', root.i18n.t('planningViews.tabs.rules')) : null;");
        expect(inspectorSource).toContain('if (sourceResult && item.volumes.length) (rules || info).append(assessment);');
    });
    it('separates a permitted result into Info, Options and Rules pages without moving evidence out of Info', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'renderInspector');
        const document = makeDocument();
        const inspector = document.createElement('aside'); inspector.className = 'planning-inspector'; document.body.append(inspector);
        const item = {
            role: 'permitted', title: 'Permitted fixture', parcelEnvelope: false, areas: [], volumes: [{}],
            assessment: { meaning: 'source-result', refresh: null, status: null, reason: null, current: true },
            metrics: { floorAreaM2: 100, heightM: 12, conditional: null, footprintM2: 40 },
            constraints: [{ quantity: 'height', value: 12, unit: 'm', evidence: null }], configurations: [{ id: 'family', metrics: { heightM: 12, footprintM2: 40 } }],
            source: { label: 'Fixture source', computedAt: null, fetchedAt: null, solverVersion: null, parcel: null, url: null }, sourceEvidence: null
        };
        const element = (tag, className, text) => {
            const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
        };
        const t = key => ({ sourceProposal: 'Permitted massing', sourceEvidenceBadge: 'Source evidence', approximate: 'Approximate',
            conditionsTitle: 'Conditions', conditionsNote: 'Rules need checking', sourceDetails: 'Source and evidence',
            floorArea: 'Floor area', height: 'Height', footprintArea: 'Footprint', close: 'Close', info: 'Info' }[key] || key);
        const root = { i18n: { t: key => ({ 'clickStackNavigation.info': 'Info', 'planningViews.tabs.options': 'Options', 'planningViews.tabs.rules': 'Rules' }[key] || key) },
            CbFormat: { formatLength: value => `${value} m`, formatNumber: value => String(value), formatArea: value => `${value} m²`, formatDate: value => String(value) } };
        const context = vm.createContext({ selected: () => item, inspector, root, element, t, parcelOf: () => null,
            inspectorBadgeKey: () => 'sourceEvidenceBadge', area: value => `${value} m²`, number: value => String(value), resultLabel: value => String(value),
            permittedFeatures: () => ({ configuration: null }), renderConfigurations: () => element('section', 'planning-configurations'), scenarioLabel: value => value,
            sourceRecord: async () => [], selectRecord() {}, select() {}, referenceStatus: null, document });
        vm.runInContext(source.slice(declaration.start, declaration.end), context);
        context.renderInspector();
        expect(inspector.querySelector('[data-stack-page-key="info"] .planning-evidence')).not.toBeNull();
        expect(inspector.querySelector('[data-stack-page-key="options"] .planning-configurations')).not.toBeNull();
        expect(inspector.querySelector('[data-stack-page-key="rules"] .planning-limits')).not.toBeNull();
        expect(inspector.querySelector('[data-stack-page-key="info"] .planning-limits')).toBeNull();
    });
    it('does not clear an authored selection when source massing becomes unavailable at a wider zoom', async () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'refresh');
        const select = vi.fn();
        const context = vm.createContext({ ready: true, catalogReady: true, policy: () => ({ permitted: 'solid' }),
            root: { LoadView: { current: () => ({ mode: '2d', bbox: [15.96, 45.80, 15.98, 45.81], centre: [45.805, 15.97], zoom: 15 }) } }, viewCache: { abortExcept: vi.fn() }, request: 0, invalidate: vi.fn(), items: [], status: '', payload: null,
            store: { select }, selected: () => ({ role: 'proposed', id: 'proposed:design' }),
            drawMap() {}, render() {}, notifyGeometry() {} });
        vm.runInContext(source.slice(declaration.start, declaration.end), context);
        await context.refresh();
        expect(context.status).toBe('zoom'); expect(select).not.toHaveBeenCalled();
    });
    it('preserves proposal selection when closing the parcel panel for the shared inspector', () => {
        const source = readFileSync(new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url), 'utf8');
        const start = source.indexOf('    function hideParcelInfoPanel(');
        const end = source.indexOf('\n    function ', start + 1);
        const global = { document: { getElementById: () => null }, clearProposalHighlights: vi.fn() };
        global.window = global;
        const context = vm.createContext({ global, renderParcelHistory() {} });
        vm.runInContext(source.slice(start, end), context);
        context.hideParcelInfoPanel({ preserveProposalSelection: true });
        expect(global.clearProposalHighlights).not.toHaveBeenCalled();
        context.hideParcelInfoPanel();
        expect(global.clearProposalHighlights).toHaveBeenCalledOnce();
    });
    it('connects real city-model meshes and carved parts to the original building inspection record', async () => {
        const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'buildNearbyProposalBuildings3D');
        const feature = { type: 'Feature', geometry, properties: { object_id: 12, source: 'gdi-3d', height_m: 8 } };
        const mesh = () => ({ userData: {} });
        const group = { add: vi.fn() };
        let carved = false;
        const context = vm.createContext({
            window: { DemolitionIndex: { carveRecords: () => ({ records: new Map(), carveOf: () => (carved ? { remainder: geometry, demolished: geometry } : null) }) },
                buildingFeaturePool: [feature], buildingPoolFeatureKey: f => `${f.properties.source}:${f.properties.object_id}`, PlanningRepresentations: representations },
            proposalStorage: { getAllProposals: () => [] }, displayedProposals: () => [], demolishedMaterialFor: () => ({}),
            nearbyBuildingGeometryCache: { beginPass: () => ({}) }, nearbyProposalBuildings: [{ object_id: 12, source: 'gdi-3d' }],
            threeBuildingKey: building => `${building.source}:${building.object_id}`, buildingFootprintPolygon: () => null,
            xrayEnabled: false, suggestedPlansEnabled: false, suggestedExistingEnabled: false, origin3857: null,
            sceneWork: { forEach: async (items, fn) => items.forEach(fn) },
            buildingDisplayPolicy: { resolveBuildingRenderParts: () => ({ detailed: true, remainder: true, demolished: true }) },
            appendBuildingFloorPlans: () => false, building3DHeightMeters: () => 8, buildMeshFromBuilding3D: mesh,
            polygonFeatureToMeshes: () => [mesh()], tagBuildingStoreys() {}, ensureNearbyProposalBuildings() {}, console
        });
        vm.runInContext(source.slice(declaration.start, declaration.end), context);
        await context.buildNearbyProposalBuildings3D(group, {});
        carved = true;
        await context.buildNearbyProposalBuildings3D(group, {});
        expect(group.add).toHaveBeenCalledTimes(3);
        for (const [object] of group.add.mock.calls) expect(object.userData.planningBuiltFeature).toBe(feature);
    });
    it('uses the same source building for mesh inspection and keeps absent mesh measurements unknown', () => {
        const feature = { type: 'Feature', geometry, properties: { object_id: 12, height_m: 8 } };
        expect(representations.observedMeshFeature({ object_id: 12 }, feature)).toBe(feature);
        const mesh = representations.observedMeshFeature({ object_id: 13, z_min: null, z_max: 10 });
        const record = representations.built(mesh, { key: '13', city: 'sample' });
        expect(record.id).toBe('built:sample:13'); expect(record.site).toBeNull();
        expect(record.volumes).toEqual([]); expect(record.metrics.heightM).toBeNull();
    });
    it('preserves unknown observed quantities and the original source feature', () => {
        const feature = { type: 'Feature', geometry, properties: { height_m: null, floors: 3 } }, before = JSON.stringify(feature);
        const item = representations.built(feature, { key: 'a', city: 'sample', footprintM2: 30 });
        expect(item.id).toBe('built:sample:a'); expect(item.role).toBe('existing');
        expect(item.volumes).toEqual([]); expect(item.metrics).toEqual({ floorAreaM2: null, heightM: null, footprintM2: 30 });
        expect(JSON.stringify(feature)).toBe(before);
    });
    it('titles a building by its name or the given label, never by its record key', () => {
        const key = 'building.eyJhZGFwdGVyIjoiYXJjZ2lzIn0:CUSTOM-B-58c2-78778';
        const unnamed = { type: 'Feature', geometry, properties: { FID: 78778 } };
        expect(representations.built(unnamed, { key, city: 'sample' }).title).toBeNull();
        expect(representations.built(unnamed, { key, city: 'sample', title: '120 m²' }).title).toBe('120 m²');
        expect(representations.built({ ...unnamed, properties: { name: 'Town hall' } }, { key, city: 'sample' }).title).toBe('Town hall');
        expect(representations.built(unnamed, { key, city: 'sample' }).source.recordId).toBe(key);
    });
    it('names a building’s source by its display name, never by its encoded source id', () => {
        const feature = { type: 'Feature', geometry, properties: { source: 'building.eyJhZGFwdGVyIjoiYXJjZ2lzIn0' } };
        const record = representations.built(feature, { key: 'a', city: 'sample', sourceName: 'IDECA/UAECD Construcción' });
        expect(record.source.label).toBe('IDECA/UAECD Construcción');
        expect(record.source.id).toBe('building.eyJhZGFwdGVyIjoiYXJjZ2lzIn0');
        expect(representations.built(feature, { key: 'a', city: 'sample' }).source.label).toBeNull();
    });
    it('keeps proposed identity, authored geometry and lifecycle separate from local application', () => {
        const proposal = { proposalId: 'p1', name: 'Example', lifecycleStatus: 'Active',
            geometry: { buildings: [{ type: 'Feature', geometry, properties: { height: 8 } }] } };
        const before = JSON.stringify(proposal);
        const item = representations.proposed(proposal, { key: 'p1', city: 'sample', applied: true });
        expect(item.id).toBe('proposed:p1'); expect(item.proposalId).toBe('p1'); expect(item.volumes[0].topM).toBe(8);
        expect(item.assessment).toMatchObject({ status: 'Active', applied: true, constraints: 'not-evaluated' });
        expect(item.metrics.floorAreaM2).toBeNull(); expect(JSON.stringify(proposal)).toBe(before);
    });
    it('names publication by the design CID, separately from the local selection key, and preserves lifecycle evidence', () => {
        const proposal = { proposalId: 'local-key', id: 17, lifecycleStatus: 'Executed',
            lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Executed' } };
        const unpublished = representations.proposed(proposal, { key: proposal.proposalId });
        expect(unpublished.id).toBe('proposed:local-key');
        expect(unpublished.sourceEvidence.publication).toBeNull();
        expect(unpublished.sourceEvidence.lifecycleEvidence).toEqual(proposal.lifecycleEvidence);
        const cid = Cid.cidOfObject({ schema: 'design/v1', title: 'Example' });
        const published = representations.proposed({ ...proposal, published: { cid, publishedAt: null, apiBase: 'https://api.example' } }, { key: proposal.proposalId });
        expect(published.id).toBe('proposed:local-key');
        expect(published.sourceEvidence.publication).toEqual({ cid });
        expect(representations.proposed({ ...proposal, published: { cid: 'not-a-cid' } }, { key: proposal.proposalId }).sourceEvidence.publication).toBeNull();
        expect(representations.proposed({ proposalId: 'unknown' }, { key: 'unknown' }).assessment.status).toBe('Unknown');
    });
});
