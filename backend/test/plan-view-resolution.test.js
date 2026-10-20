import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/plan-view.js', import.meta.url), 'utf8');
const API = 'https://api.example.test';

function classList() {
    const values = new Set();
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
        toggle(value, force) {
            const add = force === undefined ? !values.has(value) : !!force;
            if (add) values.add(value); else values.delete(value);
            return add;
        }
    };
}

function boot({ proposals = [], parcelFeatures = [], city = 'zagreb', withoutParcels = false, batchRecords = null } = {}) {
    let activeApi = API;
    const title = {};
    const close = { setAttribute() {} };
    const body = {};
    let panelClick = null;
    const panel = {
        classList: classList(),
        setAttribute() {},
        addEventListener(type, callback) { if (type === 'click') panelClick = callback; },
        querySelector(selector) {
            if (selector === '#plan-view-title') return title;
            if (selector === '[data-plan-action="close"]') return close;
            if (selector === '[data-plan-region="body"]') return body;
            return null;
        },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
    };
    const svg = { querySelector: () => null, insertBefore() {} };
    const document = {
        body: { classList: classList(), appendChild() {} },
        addEventListener() {},
        getElementById: () => null,
        createElement: () => panel,
        createElementNS: () => ({ setAttribute() {}, appendChild() {} })
    };
    const bounds = { isValid: () => false };
    const map = {
        getPane: () => null,
        createPane: () => ({ classList: classList() }),
        removeLayer() {},
        fitBounds() {}
    };
    const getProposalByServerRowId = vi.fn((rowId, apiBase) => {
        const copies = proposals.filter(record => String(record.serverProposalId) === String(rowId)
            && record.publicationApiBase === apiBase);
        if (copies.length > 1) throw new Error(`Multiple local proposals refer to server row ${rowId}.`);
        return copies[0] || null;
    });
    const ensureIds = vi.fn(async () => {});
    const getMany = vi.fn((ids, options) => parcelFeatures.filter(feature => ids.includes(feature.properties.parcelId)
        && options.city === city));
    const geoJSON = vi.fn(() => ({ on() { return this; }, addTo() { return this; }, getBounds: () => bounds }));
    const window = {
        document,
        location: { href: 'https://app.example.test/proposals/plan', origin: 'https://app.example.test' },
        history: { state: null, replaceState() {} },
        innerWidth: 1200,
        innerHeight: 800,
        resolveBackendBaseUrl: () => activeApi,
        ProposalOrigin: { apiBase: value => typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : null },
        resolveCurrentCityCode: () => city,
        normalizeCityCodeForApi: value => String(value || '').trim().toLowerCase(),
        ProposalPlans: { planLabel: plan => plan.title || plan.slug },
        proposalStorage: {
            getAllProposals: vi.fn(() => proposals),
            getProposalByServerRowId,
            _normalizeProposal: record => record
        },
        fetchSharedProposalBatch: vi.fn(async ids => ({ records: batchRecords || new Map(ids.map(id => [id, {
            proposalId: `published-${id}`, serverProposalId: id, publicationApiBase: API, city,
            cadastreParcelIds: ['parcel-1'], parcelSet: { parcelSource: { sourceId: 'provider-a', snapshotId: 'release-a' } }
        }])) })),
        collectProposalFeatureSets: record => ({ primaryFeatures: record.primaryFeatures || [] }),
        isProposalCurrentlyApplied: record => !!record.applied,
        ParcelGroundFallback: { isWithoutParcels: () => withoutParcels },
        CadastralParcelRepository: { ensureIds, getMany },
        BusyControl: { track: vi.fn(async (_button, callback) => callback()) },
        handleSharedPlanRoute: vi.fn(async () => {}),
        fetchSharedProposalResponse: vi.fn(async () => ({ ok: true, status: 200, data: plan })),
        L: {
            svg: () => ({ _container: svg }),
            featureGroup: () => ({ addTo() { return this; }, getBounds: () => bounds }),
            geoJSON
        },
        map,
        console: { log() {}, warn() {}, error: vi.fn() }
    };
    const context = vm.createContext({ window, URL, CSS: { escape: value => value }, console: window.console, Date });
    vm.runInContext(source, context);
    return { window, body, ensureIds, getMany, getProposalByServerRowId, geoJSON,
        clickApply() {
            const button = { getAttribute: () => 'apply' };
            return panelClick?.({ target: { closest: selector => selector === '[data-plan-action]' ? button : null } });
        },
        setApiBase(value) { activeApi = value; }
    };
}

function isApplyDisabled(body) {
    return /<button[^>]*data-plan-action="apply"[^>]* disabled>/.test(body.innerHTML);
}

const plan = {
    slug: 'plan', title: 'Plan', planHash: 'a'.repeat(64), proposalRowIds: ['42'],
    members: [{ proposalRowId: '42', title: 'Member', changed: false }]
};

describe('named plan preview data resolution', () => {
    it('rejects duplicate API-qualified local copies even when one is applied', async () => {
        const app = boot({ proposals: [
            { proposalId: 'draft-copy', serverProposalId: '42', publicationApiBase: API, applied: true },
            { proposalId: 'plan-copy', serverProposalId: '42', publicationApiBase: API, applied: false }
        ] });

        await app.window.PlanView.open('plan', { plan });

        expect(app.getProposalByServerRowId).toHaveBeenCalledWith('42', API);
        expect(app.window.proposalStorage.getAllProposals).not.toHaveBeenCalled();
        expect(app.window.fetchSharedProposalBatch).not.toHaveBeenCalled();
        expect(app.window.console.error).toHaveBeenCalledWith(expect.stringContaining('could not be opened'),
            expect.objectContaining({ message: 'Multiple local proposals refer to server row 42.' }));
    });

    it('loads parcel-only preview geometry only from the member’s typed source in its own city', async () => {
        const record = {
            proposalId: 'published-42', serverProposalId: '42', publicationApiBase: API, city: 'zagreb',
            cadastreParcelIds: ['parcel-1'], parcelSet: { parcelSource: { sourceId: 'provider-a', snapshotId: 'release-a' } }
        };
        const wrongRelease = { type: 'Feature', properties: {
            parcelId: 'parcel-1', parcelSource: { sourceId: 'provider-a', snapshotId: 'release-b' }
        }, geometry: { type: 'Polygon', coordinates: [] } };
        const app = boot({ parcelFeatures: [wrongRelease] });
        app.window.fetchSharedProposalBatch = vi.fn(async () => ({ records: new Map([['42', record]]) }));

        await app.window.PlanView.open('plan', { plan });

        expect(app.ensureIds).toHaveBeenCalledWith(['parcel-1'], { city: 'zagreb' });
        expect(app.getMany).toHaveBeenCalledWith(['parcel-1'], { city: 'zagreb' });
        expect(app.geoJSON).not.toHaveBeenCalled();
    });

    it('draws parcel-only preview geometry when the retained source and release match', async () => {
        const record = {
            proposalId: 'published-42', serverProposalId: '42', publicationApiBase: API, city: 'zagreb',
            cadastreParcelIds: ['parcel-1'], parcelSet: { parcelSource: { sourceId: 'provider-a', snapshotId: 'release-a' } }
        };
        const matchingRelease = { type: 'Feature', properties: {
            parcelId: 'parcel-1', parcelSource: { sourceId: 'provider-a', snapshotId: 'release-a' }
        }, geometry: { type: 'Polygon', coordinates: [] } };
        const app = boot({ parcelFeatures: [matchingRelease] });
        app.window.fetchSharedProposalBatch = vi.fn(async () => ({ records: new Map([['42', record]]) }));

        await app.window.PlanView.open('plan', { plan });

        expect(app.geoJSON).toHaveBeenCalledOnce();
    });

    it('does not fetch parcel IDs for a member from another city', async () => {
        const record = {
            proposalId: 'published-42', serverProposalId: '42', publicationApiBase: API, city: 'rotterdam',
            cadastreParcelIds: ['parcel-1'], parcelSet: { parcelSource: { sourceId: 'provider-a', snapshotId: 'release-a' } }
        };
        const app = boot({ city: 'zagreb' });
        app.window.fetchSharedProposalBatch = vi.fn(async () => ({ records: new Map([['42', record]]) }));

        await app.window.PlanView.open('plan', { plan });

        expect(app.ensureIds).not.toHaveBeenCalled();
        expect(app.geoJSON).not.toHaveBeenCalled();
    });

    it('keeps authored geometry preview available while continuing without parcels', async () => {
        const authoredFeature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } };
        const record = {
            proposalId: 'published-42', serverProposalId: '42', publicationApiBase: API,
            primaryFeatures: [authoredFeature], cadastreParcelIds: ['parcel-1']
        };
        const app = boot({ withoutParcels: true });
        app.window.fetchSharedProposalBatch = vi.fn(async () => ({ records: new Map([['42', record]]) }));

        await app.window.PlanView.open('plan', { plan });

        expect(app.ensureIds).not.toHaveBeenCalled();
        expect(app.geoJSON).toHaveBeenCalledOnce();
    });

    it.each([
        ['changed', { ...plan, members: [{ ...plan.members[0], changed: true }] }],
        ['missing', { ...plan, members: [{ ...plan.members[0], missing: true, changed: true }] }],
        ['unverified', { ...plan, members: [{ proposalRowId: '42' }] }]
    ])('disables and refuses Apply when a plan member is %s', async (_status, stalePlan) => {
        const app = boot();

        await app.window.PlanView.open('plan', { plan: stalePlan });
        expect(isApplyDisabled(app.body)).toBe(true);

        // Exercise the delegated handler even though a real browser will not click a disabled button.
        app.clickApply();
        await Promise.resolve();
        expect(app.window.BusyControl.track).not.toHaveBeenCalled();
        expect(app.window.handleSharedPlanRoute).not.toHaveBeenCalled();
    });

    it('enables Apply and sends the exact plan snapshot when every member is verified', async () => {
        const app = boot();

        await app.window.PlanView.open('plan', { plan });
        expect(isApplyDisabled(app.body)).toBe(false);

        await app.clickApply();
        expect(app.window.BusyControl.track).toHaveBeenCalledOnce();
        expect(app.window.handleSharedPlanRoute).toHaveBeenCalledWith(['42'], 0, expect.objectContaining({
            explicitApply: true,
            namedPlan: expect.objectContaining({ slug: 'plan', proposalRowIds: ['42'], publicationApiBase: API })
        }));
    });

    it('refuses Apply when the active publication API changes after preview', async () => {
        const app = boot();

        await app.window.PlanView.open('plan', { plan });
        app.setApiBase('https://other.example.test/api');
        await app.clickApply();

        expect(app.window.BusyControl.track).not.toHaveBeenCalled();
        expect(app.window.handleSharedPlanRoute).not.toHaveBeenCalled();
    });

    it('keeps the supplied plan API origin for member lookup and blocks applying after an API switch', async () => {
        const app = boot();
        app.setApiBase('https://other.example.test/api');

        await app.window.PlanView.open('plan', { plan: { ...plan, publicationApiBase: API } });

        expect(app.getProposalByServerRowId).toHaveBeenCalledWith('42', API);
        expect(isApplyDisabled(app.body)).toBe(true);
        await app.clickApply();
        expect(app.window.handleSharedPlanRoute).not.toHaveBeenCalled();
    });

    it('rejects inconsistent API origins on an already loaded plan', async () => {
        const app = boot();

        await app.window.PlanView.open('plan', {
            plan: { ...plan, publicationApiBase: API },
            publicationApiBase: 'https://other.example.test/api'
        });

        expect(app.window.fetchSharedProposalBatch).not.toHaveBeenCalled();
        expect(app.window.console.error).toHaveBeenCalledWith(expect.stringContaining('could not be opened'),
            expect.objectContaining({ message: 'Plan preview publication API identity is invalid or inconsistent.' }));
    });

    it('disables and refuses Apply when the loaded member set is incomplete', async () => {
        const app = boot({ batchRecords: new Map() });
        const twoMemberPlan = {
            slug: 'plan', title: 'Plan', proposalRowIds: ['42', '43'],
            members: [
                { proposalRowId: '42', changed: false, missing: false },
                { proposalRowId: '43', changed: false, missing: false }
            ]
        };

        await app.window.PlanView.open('plan', { plan: twoMemberPlan });
        expect(isApplyDisabled(app.body)).toBe(true);

        app.clickApply();
        await Promise.resolve();
        expect(app.window.BusyControl.track).not.toHaveBeenCalled();
        expect(app.window.handleSharedPlanRoute).not.toHaveBeenCalled();
    });
});
