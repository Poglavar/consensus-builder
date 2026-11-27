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
const PlanningSourceProposal = require('../../frontend/js/planning/source-proposal.js');
const labels = require('../../frontend/js/planning/item-labels.js');
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
        setupPlanningRoutes({ post() {}, get: (path, fn) => { handlers[path] = fn; } }, {}, { parcelQuery });
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
    it('renders a source calculation trace without turning assumptions or source links into a compliance verdict', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = name => body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
        const document = makeDocument();
        const element = (tag, className, text) => {
            const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
        };
        const labels = { calculationTraceTitle: 'Calculation breakdown', calculationTraceNote: 'Inputs and calculations', traceInputs: 'Inputs', traceResult: 'Result', traceLimit: 'Recorded limit', traceExpression: 'Expression',
            'traceStatus.failed': 'Failed', 'traceStatus.not-evaluated': 'Not evaluated', 'traceBound.maximum': 'Maximum' };
        const t = key => labels[key] || `planningViews.${key}`;
        const context = vm.createContext({ document, element, t, URL, citationLabel: citation => citation.kind, traceLabel: row => row.id,
            traceInputLabel: key => key, area: value => `${value} m²`, number: value => String(value),
            root: { CbFormat: { formatLength: value => `${value} m`, formatNumber: value => String(value) } } });
        vm.runInContext(source.slice(declaration('traceValue').start, declaration('traceValue').end), context);
        vm.runInContext(source.slice(declaration('sourceLink').start, declaration('sourceLink').end), context);
        vm.runInContext(source.slice(declaration('renderCalculationTrace').start, declaration('renderCalculationTrace').end), context);
        const trace = vm.runInContext('renderCalculationTrace', context)({ sourceEvidence: { calculationTrace: [
            { id: 'above-ground-far', quantity: 'floorAreaRatioAboveGround', status: 'failed', result: { value: 2.5, unit: 'ratio' }, limit: { value: 2.5, unit: 'ratio', bound: 'maximum' }, expression: '5000 / 2000', citations: [{ kind: 'provision', url: 'https://example.test/article' }, { kind: 'bad', url: 'javascript:alert(1)' }] },
            { id: 'natural-terrain', quantity: 'naturalTerrain', status: 'not-evaluated', limit: { value: 0.2, unit: 'ratio', bound: 'maximum' } }
        ] } });
        expect(trace.textContent).toContain('Failed'); expect(trace.textContent).toContain('2.5'); expect(trace.textContent).not.toContain('250%');
        expect(trace.textContent).toContain('20%'); expect(trace.textContent).toContain('Not evaluated');
        expect(trace.textContent).not.toContain('undefined');
        const links = trace.querySelectorAll('a'); expect(links).toHaveLength(1); expect(links[0].href).toBe('https://example.test/article');
    });
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

        const inspector = { hidden: false, dataset: {}, classList: { contains: vi.fn(() => false) }, replaceChildren: vi.fn() };
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
        const panel = { hidden: false, dataset: {}, replaceChildren: vi.fn(), classList: { contains: () => false } };
        const renderContext = vm.createContext({ selected: () => proposal, inspector: panel, isPhoto: () => false });
        vm.runInContext(inspectorSource, renderContext);
        renderContext.renderInspector();
        expect(panel.hidden).toBe(true);
        expect(panel.replaceChildren).toHaveBeenCalledOnce();
        expect(inspectorSource).toContain("const rules = sourceResult ? page('rules', root.i18n.t('proposalDrafts.approval.policyType')) : null;");
        expect(inspectorSource).toContain('if (sourceResult && item.volumes.length) (rules || info).append(assessment);');
    });
    it('separates a permitted result into Info, Options and Rules pages without moving evidence out of Info', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = name => body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
        const document = makeDocument();
        const inspector = document.createElement('aside'); inspector.className = 'planning-inspector'; document.body.append(inspector);
        const item = {
            role: 'permitted', title: 'Permitted fixture', parcelEnvelope: false, areas: [], volumes: [{}],
            assessment: { meaning: 'source-result', refresh: null, status: null, reason: null, current: true },
            metrics: { floorAreaM2: 100, heightM: 12, conditional: null, footprintM2: 40 },
            constraints: [{ quantity: 'height', value: 12, unit: 'm', evidence: 'derived', derivation: '4 × 3 m' }], configurations: [{ id: 'family', metrics: { heightM: 12, footprintM2: 40 } }],
            source: { label: 'Fixture source', computedAt: null, fetchedAt: null, solverVersion: null, parcel: null, url: null }, sourceEvidence: null
        };
        const element = (tag, className, text) => {
            const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
        };
        const t = key => ({ sourceProposal: 'Permitted massing', sourceEvidenceBadge: 'Source evidence', approximate: 'Approximate',
            conditionsTitle: 'Conditions', conditionsNote: 'Rules need checking', sourceDetails: 'Source and evidence',
            'evidence.derived': 'Calculated by UGT', floorArea: 'Floor area', height: 'Height', footprintArea: 'Footprint', close: 'Close', info: 'Info' }[key] || key);
        const root = { i18n: { t: key => ({ 'clickStackNavigation.info': 'Info', 'planningViews.tabs.options': 'Options', 'proposalDrafts.approval.policyType': 'Rules' }[key] || key) },
            CbFormat: { formatLength: value => `${value} m`, formatNumber: value => String(value), formatArea: value => `${value} m²`, formatDate: value => String(value) } };
        const context = vm.createContext({ selected: () => item, inspector, root: { ...root, PlanningSourceProposal }, element, t, parcelOf: () => null,
            inspectorBadgeKey: () => 'sourceEvidenceBadge', isParcelTooSmall: () => false, area: value => `${value} m²`, number: value => String(value), resultLabel: value => String(value),
            permittedFeatures: () => ({ configuration: null }), renderConfigurations: () => element('section', 'planning-configurations'), scenarioLabel: value => value, sourceConditionNotes: () => [], renderCalculationTrace: () => null,
            sourceRecord: async () => [], selectRecord() {}, select() {}, referenceStatus: null, document, itemTitle: value => value.title,
            labels, fullT: key => key, sourceText: text => element('q', 'planning-source-text', text), legendRows: () => [], sceneItems: () => [item], appearance: () => 'ghost' });
        for (const name of ['sourcePlanUrl', 'renderInspector']) vm.runInContext(source.slice(declaration(name).start, declaration(name).end), context);
        context.renderInspector();
        expect(inspector.querySelector('[data-stack-page-key="info"] .planning-evidence')).not.toBeNull();
        expect(inspector.querySelector('[data-stack-page-key="options"] .planning-configurations')).not.toBeNull();
        expect(inspector.querySelector('[data-stack-page-key="rules"] .planning-limits').textContent).toContain('12 m · Calculated by UGT · 4 × 3 m');
        expect(inspector.querySelector('[data-stack-page-key="info"] .planning-limits')).toBeNull();
    });
    it('names an Alatau envelope in the reader\'s language, quotes the plan\'s words in its language and keys its colours', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = name => body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
        const document = makeDocument();
        const inspector = document.createElement('aside'); inspector.className = 'planning-inspector'; document.body.append(inspector);
        const use = { key: 'residential-mid', group: 'housing-mid', label: 'Среднеэтажная застройка', stage: 'planned' };
        const item = { id: 'envelope:alatau-genplan-727:KZ-1', role: 'permitted', parcelEnvelope: true, use, areas: [], volumes: [{ topM: 15 }],
            title: 'Среднеэтажная застройка · до 5 эт. (6*) · проектируемая · 03055234792',
            assessment: { meaning: 'outer-bound', status: 'unresolved', reason: null, refresh: null, current: true },
            metrics: { heightM: 15, footprintM2: 300, conditional: { heightM: 18, condition: '6* этажей по легенде генплана', conditionCode: 'legend-asterisk' } },
            constraints: [], configurations: [],
            source: { label: 'Генплан Алатау', language: 'ru', parcel: 'KZ-1', computedAt: null, fetchedAt: null, solverVersion: null, url: null }, sourceEvidence: null };
        const zone = { role: 'permitted', use: { ...use, group: 'green' }, assessment: { meaning: 'zoning-area', status: 'prohibited' } };
        const element = (tag, className, text) => {
            const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
        };
        const dictionary = { 'planningViews.use.residential-mid': 'Mid-rise housing (4–6 floors)', 'planningViews.zoneStage.planned': 'planned',
            'planningViews.condition.legend-asterisk': 'asterisked 6th floor', 'planningViews.useGroup.housing-mid': 'Mid-rise housing',
            'planningViews.useGroup.green': 'Green land', 'planningViews.legend.envelope': 'Envelope',
            'planningViews.legend.dashed': 'Dashed edge' };
        const fullT = (key, params = {}) => (dictionary[key] || key).replace(/{{(\w+)}}/g, (_, name) => params[name]);
        const t = key => ({ sourceWording: 'Source wording:', envelopeTitle: 'Permitted envelope', conditionalHeight: 'Height under a condition' }[key] || key);
        const root = { i18n: { t: fullT }, CbFormat: { formatLength: value => `${value} m`, formatNumber: value => String(value), formatArea: value => `${value} m²`, formatDate: String } };
        const context = vm.createContext({ selected: () => item, inspector, root: { ...root, PlanningSourceProposal }, element, t, fullT, labels, parcelOf: () => 'KZ-1',
            inspectorBadgeKey: () => 'bound', isParcelTooSmall: () => false, area: value => `${value} m²`, number: value => String(value), resultLabel: value => String(value),
            permittedFeatures: () => ({ configuration: null }), renderConfigurations: () => element('section'), scenarioLabel: value => value, sourceConditionNotes: () => [], renderCalculationTrace: () => null,
            sourceRecord: async () => [], selectRecord() {}, select() {}, referenceStatus: null, document, sceneItems: () => [item, zone], appearance: () => 'ghost' });
        for (const name of ['renderInspector', 'sourceText', 'sourcePlanUrl', 'legendRows']) vm.runInContext(source.slice(declaration(name).start, declaration(name).end), context);
        vm.runInContext(source.match(/const itemTitle = .*;/)[0], context);
        context.renderInspector();
        expect(inspector.querySelector('h2').textContent).toBe('Mid-rise housing (4–6 floors) · planned');
        const quote = inspector.querySelector('.planning-source-wording q.planning-source-text');
        expect(quote.textContent).toBe(item.title);
        expect(quote.lang).toBe('ru');
        const conditional = [...inspector.querySelectorAll('.planning-metrics div')].find(row => row.textContent.includes('Height under a condition'));
        expect(conditional.textContent).toContain('18 m · asterisked 6th floor');
        expect(conditional.textContent).not.toContain('этажей');
        expect([...inspector.querySelectorAll('.planning-colour-key li')].map(row => [row.firstChild.className, row.textContent]))
            .toEqual([['planning-swatch planning-swatch--zone-housing-mid', 'Mid-rise housing']]);
        const legend = inspector.querySelector('details .planning-zone-legend');
        expect([...legend.querySelectorAll('li')].map(row => row.textContent)).toEqual(['Mid-rise housing', 'Green land', 'Dashed edge']);
        inspector.querySelector('.planning-map-colours').open = true;
        context.renderInspector();
        expect(inspector.querySelector('.planning-map-colours').open).toBe(true);
        item.id = 'envelope:alatau-genplan-727:KZ-2';
        context.renderInspector();
        expect(inspector.querySelector('.planning-map-colours').open).toBe(false);
    });
    it('does not clear an authored selection when source massing becomes unavailable at a wider zoom', async () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const declaration = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'refresh');
        const select = vi.fn();
        const context = vm.createContext({ ready: true, catalogReady: true, policy: () => ({ permitted: 'solid' }),
            root: { LoadView: { current: () => ({ mode: '2d', bbox: [15.96, 45.80, 15.98, 45.81], centre: [45.805, 15.97], zoom: 14 }) } }, viewCache: { abortExcept: vi.fn() }, request: 0, invalidate: vi.fn(), drawn: new Map(), items: [], status: '', payload: null,
            sourceId: '', sourceOptions: [], resetOverview() {}, zoningViewportCache: { abortExcept: vi.fn() },
            store: { select, get: () => ({ zoningAreas: 'off' }) }, selected: () => ({ role: 'proposed', id: 'proposed:design' }),
            drawMap() {}, render() {}, notifyGeometry() {}, markFailed: vi.fn(), ZONING_ZOOM: 15, MASSING_ZOOM: 16, massingWaits: false });
        vm.runInContext(source.slice(declaration.start, declaration.end), context);
        await context.refresh();
        expect(context.status).toBe('zoom'); expect(select).not.toHaveBeenCalled();
        // Nothing is drawn below the gate, so no cell is left marked as failed.
        expect(context.markFailed).toHaveBeenCalledWith();
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
            displayedPassages3D: () => [], openBuildingPassages: () => {}, addBuildingTunnelLiners3D: () => {},
            nearbyBuildingGeometryCache: { beginPass: () => ({}) }, nearbyProposalBuildings: [{ object_id: 12, source: 'gdi-3d' }],
            threeBuildingKey: building => `${building.source}:${building.object_id}`, buildingFootprintPolygon: () => null,
            xrayScope: null, suggestedAccess: 'auto', origin3857: null,
            sceneWork: { forEach: async (items, fn) => items.forEach(fn) },
            buildingDisplayPolicy: { resolveBuildingRenderParts: () => ({ detailed: true, remainder: true, demolished: true }) },
            appendBuildingFloorPlans: () => false, building3DHeightMeters: () => 8, buildMeshFromBuilding3D: mesh,
            polygonFeatureToMeshes: () => [mesh()], tagBuildingStoreys() {}, scaleToChosenHeight() {}, ensureNearbyProposalBuildings() {}, console
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
        // The stated storey count is shown on the building card; a missing height stays unknown.
        expect(item.volumes).toEqual([]); expect(item.metrics).toEqual({ floorAreaM2: null, heightM: null, footprintM2: 30, storeys: 3 });
        expect(representations.built({ ...feature, properties: { floors: null } }, { key: 'b', city: 'sample' }).metrics.storeys).toBeNull();
        expect(representations.built(representations.observedMeshFeature({ object_id: 14, floors: 5, z_min: 0, z_max: 15 }), { key: '14', city: 'sample' })
            .metrics.storeys).toBe(5);
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

// An observed building is measured from the height survey covering it, which replaces the height its
// source gave (the best measure available); the answer reaches the card even when the inspector shows another record of the same building by then.
describe('observed building height from a height survey', () => {
    const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
    const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
    const slice = node => source.slice(node.start, node.end);
    const pieces = body.filter(node => (node.type === 'FunctionDeclaration' && ['applyHeightSurvey', 'dropHeightSurvey', 'measureHeight', 'heightSurveyLine'].includes(node.id.name))
        || (node.type === 'VariableDeclaration' && ['heightSurveys', 'HEIGHT_SURVEY_NONE'].includes(node.declarations[0].id.name))).map(slice).join('\n');
    const t = (key, params = {}) => `${key}(${Object.values(params).join('|')})`;
    const record = (heightM = null) => ({ id: 'built:london:osm:w1', source: { recordId: 'osm:w1' }, metrics: { heightM } });
    const setup = ({ result, shown, heights = 'survey' }) => {
        const renderInspector = vi.fn();
        let answer; const pending = new Promise(resolve => { answer = resolve; });
        const client = { surveyFor: () => ({ id: 'gb-ea', name: 'EA LiDAR' }), usesSurvey: () => heights === 'survey', measureOne: vi.fn(() => pending) };
        const context = vm.createContext({ root: { HeightSurveyClient: client, CbFormat: { formatDate: d => d.toISOString().slice(0, 10), formatLength: v => `${v} m` } },
            selected: () => shown.current, renderInspector, t, console, Map, Number, Date });
        vm.runInContext(`${pieces}\nthis.api = { measureHeight, dropHeightSurvey, heightSurveyLine };`, context);
        return { ...context.api, client, renderInspector, answer: () => { answer(result); return pending.then(() => new Promise(resolve => setImmediate(resolve))); } };
    };
    it('shows measuring, then the measured height on the record now shown, with survey, flight date and eave', async () => {
        const first = record(), shown = { current: first };
        const card = setup({ shown, result: { heightM: 9.16, eaveM: 8.46, confidence: 'high', surveyedFrom: '2017-12-07' } });
        card.measureHeight(first, { geometry: {} });
        expect(card.heightSurveyLine(first)).toBe('heightSurveyMeasuring(EA LiDAR)');
        // The stack rebuilt the card meanwhile: a new record object for the same building is shown.
        const again = record(); shown.current = again;
        await card.answer();
        expect(again.metrics.heightM).toBe(9.16);
        expect(card.heightSurveyLine(again)).toBe('heightSurveyMeasured(EA LiDAR) · heightSurveyFlown(2017-12-07) · heightSurveyEave(8.46 m)');
        expect(card.renderInspector).toHaveBeenCalledTimes(2);
    });
    it('says why a building has no measured height, and leaves its height unknown', async () => {
        const first = record(), shown = { current: first };
        const card = setup({ shown, result: { rejection: 'no-building-seen' } });
        card.measureHeight(first, { geometry: {} });
        await card.answer();
        expect(first.metrics.heightM).toBeNull();
        expect(card.heightSurveyLine(first)).toBe('heightSurveyNoBuilding(EA LiDAR)');
    });
    // OpenStreetMap says 2 storeys (6 m); the survey measures 9.16 m. Without a survey height the 6 m stands.
    it('replaces a height from stated storeys with the measured one, and keeps it where the survey gives none', async () => {
        const storeys = record(6), shown = { current: storeys };
        const card = setup({ shown, result: { heightM: 9.16, confidence: 'high' } });
        card.measureHeight(storeys, { geometry: {} });
        await card.answer();
        expect(storeys.metrics.heightM).toBe(9.16);
        const unseen = record(6); shown.current = unseen;
        const none = setup({ shown, result: { rejection: 'no-building-seen' } });
        none.measureHeight(unseen, { geometry: {} });
        await none.answer();
        expect(unseen.metrics.heightM).toBe(6);
    });
    // Built → Heights set to the building source: nothing is measured, and a measured card goes back.
    it('measures nothing when heights come from the building source, and gives a measured card its source height back', async () => {
        const storeys = record(6), shown = { current: storeys };
        const off = setup({ shown, result: { heightM: 9.16 }, heights: 'source' });
        off.measureHeight(storeys, { geometry: {} });
        expect(off.client.measureOne).not.toHaveBeenCalled();
        expect(storeys.heightSurvey).toBeUndefined();
        const on = setup({ shown, result: { heightM: 9.16, confidence: 'high' } });
        on.measureHeight(storeys, { geometry: {} });
        await on.answer();
        expect(storeys.metrics.heightM).toBe(9.16);
        on.dropHeightSurvey(storeys);
        expect(storeys.metrics.heightM).toBe(6);
        expect(storeys.heightSurvey).toBeUndefined();
    });
});

describe('building facts on the card', () => {
    const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
    const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
    const slice = node => source.slice(node.start, node.end);
    const pieces = body.filter(node => (node.type === 'FunctionDeclaration' && ['readFacts', 'showFacts', 'readFactsOf', 'renderFacts', 'renderFactForm', 'renderEligibility', 'element'].includes(node.id.name))
        || (node.type === 'VariableDeclaration' && ['factReads', 'factDrafts'].includes(node.declarations[0].id.name))).map(slice).join('\n');
    const client = require('../../frontend/js/buildings/building-facts.js');
    const t = (key, params = {}) => `${key}(${Object.values(params).join('|')})`;
    const KEYS = { storeys: 'building:levels', built: 'start_date', roof_shape: 'roof:shape', parapet: 'building:parapet' };
    const building = parapet => ({ id: 'osm:way/1', found: true, edit: { url: 'https://www.openstreetmap.org/edit?editor=id&way=1', source: 'OpenStreetMap', keys: KEYS },
        facts: { storeys: { value: 3, source: 'osm', key: 'building:levels', raw: '3' }, built: null, roof_shape: null,
            parapet: parapet ? { value: true, source: 'osm', key: 'building:parapet', raw: 'yes' } : null } });
    const record = () => ({ id: 'built:london:w1', source: { recordId: 'w1' } });
    const setup = (reads, shown, extra = {}) => {
        const renderInspector = vi.fn(), read = vi.fn(async () => reads.shift());
        const document = makeDocument();
        const context = vm.createContext({ root: { BuildingFacts: { ...client, read }, BusyControl: { track: (_button, work) => Promise.resolve(typeof work === 'function' ? work() : work) }, ...extra },
            document, selected: () => shown.current, renderInspector, t, console, Map, Date });
        vm.runInContext(`${pieces}\nthis.api = { readFacts, readFactsOf, renderFacts };`, context);
        // Check again with the wait between reads stubbed (the real one sleeps 30 s).
        const again = (record, wait) => {
            const realWait = client.readUntilChanged;
            context.root.BuildingFacts.readUntilChanged = (ids, shownMap, readIds, options) => realWait(ids, shownMap, readIds, { ...options, wait });
            return context.api.readFactsOf(record, record.buildingFacts.id, { fresh: true });
        };
        return { ...context.api, read, renderInspector, again };
    };
    const text = node => node.textContent;
    it('reads the facts, lists them with the missing ones to add at the source, and reads again on Check again', async () => {
        const first = record(), shown = { current: first };
        // Tagging the parapet is an OpenStreetMap edit, so it raises the building's version.
        const card = setup([{ ...building(false), source_version: { version: 1 } }, { ...building(true), source_version: { version: 2 } }], shown);
        const reading = card.readFacts(first, { id: 'w1', properties: {} });
        expect(first.buildingFacts).toMatchObject({ status: 'reading', id: 'osm:way/1' });
        await reading;
        expect(card.read).toHaveBeenCalledWith('osm:way/1', {});
        const section = card.renderFacts(first);
        expect(text(section)).toContain('buildingFact.field.storeys()3');
        expect(text(section)).toContain('buildingFact.field.parapet()buildingFactUnknown()');
        expect(text(section)).toContain('buildingFactsMissing(OpenStreetMap|start_date, roof:shape, building:parapet)');
        expect(section.querySelector('a').getAttribute?.('href') ?? section.querySelector('a').href).toBe('https://www.openstreetmap.org/edit?editor=id&way=1');
        // The author tagged the parapet; Check again reads the source once more and the card shows it.
        section.querySelector('button').listeners.get('click').forEach(fn => fn());
        await new Promise(resolve => setImmediate(resolve));
        expect(card.read).toHaveBeenCalledTimes(2);
        expect(card.read).toHaveBeenLastCalledWith('osm:way/1', { fresh: true });
        expect(text(card.renderFacts(first))).toContain('buildingFact.field.parapet()buildingFact.parapetYes()');
    });
    it('waits on Check again until the source shows the edit, saying so, and says when nothing changed', async () => {
        const first = record(), shown = { current: first };
        const at = (parapet, version) => ({ ...building(parapet), source_version: { version } });
        const card = setup([at(false, 4), at(false, 4), at(true, 5)], shown);
        await card.readFacts(first, { id: 'w1', properties: {} });
        let release;
        card.BuildingFactsWait = new Promise(resolve => { release = resolve; });
        const checking = card.again(first, () => card.BuildingFactsWait);
        await new Promise(resolve => setImmediate(resolve));
        // The first fresh read still shows version 4: the card waits and says why.
        expect(first.buildingFacts.waiting).toBeTruthy();
        const waitingCard = card.renderFacts(first);
        expect(text(waitingCard)).toContain('buildingFactsWaiting(OpenStreetMap)');
        expect(waitingCard.querySelector('button').disabled).toBe(true);
        release();
        await checking;
        expect(card.read).toHaveBeenCalledTimes(3);
        expect(first.buildingFacts.waiting).toBeUndefined();
        expect(text(card.renderFacts(first))).toContain('buildingFact.field.parapet()buildingFact.parapetYes()');
        // Checked again with nothing new: after its last read the card says nothing changed yet.
        const same = setup([at(true, 5), ...Array(7).fill(at(true, 5))], shown);
        await same.readFacts(first, { id: 'w1', properties: {} });
        await same.again(first, async () => {});
        expect(same.read).toHaveBeenCalledTimes(8);
        expect(text(same.renderFacts(first))).toContain('buildingFactsUnchanged(OpenStreetMap)');
    });
    // Adding the missing facts on the card: a choice per missing fact, saved to OpenStreetMap as the
    // person's edit (osm/osm-fact-edits.js), then the saved facts and the changeset.
    it('offers the missing facts, saves the chosen ones to OpenStreetMap and shows them with the changeset', async () => {
        const first = record(), shown = { current: first };
        const factEdits = require('../../frontend/js/osm/osm-fact-edits.js');
        const save = vi.fn(async entries => ({ changeset: 555, buildings: new Map([['osm:way/1', factEdits.withSaved(entries[0].building, entries[0].values, 3, 'now')]]) }));
        const card = setup([{ ...building(false), source_version: { version: 2 } }], shown, {
            OsmFactEdits: { ...factEdits, save },
            OsmAccount: { SITE: 'https://www.openstreetmap.org', redirectUri: () => 'http://127.0.0.1:5611/osm-callback.html', user: () => null, signOut: vi.fn() } });
        await card.readFacts(first, { id: 'w1', properties: {} });
        const form = card.renderFacts(first).querySelector('.planning-fact-form');
        // Storeys are known (3); parapet and roof shape are not.
        expect(form.querySelectorAll('label').map(text)).toEqual(['buildingFact.field.parapet()', 'buildingFact.field.roof_shape()']);
        expect(text(form)).toContain('factEdit.signInNote()');
        const parapet = form.querySelectorAll('select').find(select => select.id === 'planning-fact-parapet');
        parapet.value = 'yes';
        parapet.listeners.get('change').forEach(fn => fn());
        form.querySelector('button').listeners.get('click').forEach(fn => fn());
        await new Promise(resolve => setImmediate(resolve));
        expect(save.mock.calls[0][0][0].values).toEqual({ parapet: 'yes' });
        expect(save.mock.calls[0][1].comment).toBe('Add building:parapet to 1 building');
        const after = card.renderFacts(first);
        expect(text(after)).toContain('buildingFact.field.parapet()buildingFact.parapetYes()');
        expect(text(after)).toContain('factEdit.saved(OpenStreetMap) factEdit.changeset(555)');
        expect(after.querySelectorAll('a').map(a => a.href)).toContain('https://www.openstreetmap.org/changeset/555');
    });
    // London plans under English rules, so the card adds Living Tradition's tests for the house:
    // a parapet now stated, its row and footprint from the source's geometry, its roof shape unknown.
    it('shows the city\'s eligibility tests for the house, from its facts', async () => {
        const house = { ...record(), source: { recordId: 'w1', city: 'london' } }, shown = { current: house };
        const geometry = (value, raw) => ({ value, source: 'osm', key: 'geometry', raw });
        const card = setup([{ ...building(true), facts: { ...building(true).facts, built: { value: { from: 1828, to: 1830 }, source: 'osm', key: 'start_date', raw: '1828..1830' },
            footprint_m2: geometry(45.6, '45.6 m² outline'), row_size: geometry(20, '20 buildings joined by party walls'),
            heritage: { value: { listed: true, grade: 'II*', register: 'National Heritage List for England', reference: '1195683', name: 'NUMBERS 26 TO 50', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683', basis: 'house-number' },
                source: 'gb-eng-nhle', key: 'listed-building', raw: 'NUMBERS 26 TO 50, Grade II* (matched by house number)' } } }], shown, {
            BuildingEligibility: require('../../frontend/js/planning/eligibility.js'),
            CityConfigManager: { getCityConfig: city => (city === 'london' ? { planning: { ruleSetIds: ['gb-eng-planning'] } } : null) } });
        await card.readFacts(house, { id: 'w1', properties: {} });
        const block = card.renderFacts(house).querySelector('.planning-eligibility');
        // A Grade II* listing fails 17.9, and the test names the grade it was judged on.
        expect(block.getAttribute('data-eligibility')).toBe('ineligible');
        const row = cite => block.querySelectorAll('li').find(item => text(item).startsWith(`${cite} `));
        const status = cite => row(cite).getAttribute('data-status');
        expect(['17.1', '17.2', '17.4', '17.5', '17.6', '17.7', '17.9', '17.10'].map(status)).toEqual(['pass', 'pass', 'unknown', 'pass', 'pass', 'pass', 'fail', 'unchecked']);
        expect(text(row('17.9'))).toContain('eligibility.withGrade(eligibility.status.fail()|II*)');
        // The facts list shows the listing with a link to its register entry.
        const section = card.renderFacts(house);
        expect(text(section)).toContain('buildingFact.field.heritage()buildingFact.heritageListed(II*) · buildingFact.heritageEntry(1195683)');
        expect(section.querySelectorAll('a').map(a => a.href)).toContain('https://historicengland.org.uk/listing/the-list/list-entry/1195683');
    });
    it('reads nothing for a building the contract does not answer, and says so when the read fails', async () => {
        const gdi = { id: 'built:zagreb:4711', source: { recordId: '4711' } }, shown = { current: gdi };
        const card = setup([], shown);
        expect(card.readFacts(gdi, { id: 4711, properties: { object_id: 4711 } })).toBeNull();
        expect(gdi.buildingFacts).toBeUndefined();
        const failing = setup([], shown);
        failing.read.mockImplementation(async () => { throw new Error('HTTP 502'); });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const osm = record(); shown.current = osm;
        await failing.readFacts(osm, { id: 'w1', properties: {} });
        expect(osm.buildingFacts.status).toBe('failed');
        expect(text(failing.renderFacts(osm))).toContain('buildingFactsFailed()');
        error.mockRestore();
    });
});
