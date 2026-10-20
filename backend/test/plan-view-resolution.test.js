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

function boot({ proposals = [], parcelFeatures = [], city = 'zagreb', withoutParcels = false } = {}) {
    const title = {};
    const close = { setAttribute() {} };
    const body = {};
    const panel = {
        classList: classList(),
        setAttribute() {},
        addEventListener() {},
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
        resolveBackendBaseUrl: () => API,
        resolveCurrentCityCode: () => city,
        normalizeCityCodeForApi: value => String(value || '').trim().toLowerCase(),
        ProposalPlans: { planLabel: plan => plan.title || plan.slug },
        proposalStorage: {
            getAllProposals: vi.fn(() => proposals),
            getProposalByServerRowId,
            _normalizeProposal: record => record
        },
        fetchSharedProposalBatch: vi.fn(async ids => ({ records: new Map(ids.map(id => [id, {
            proposalId: `published-${id}`, serverProposalId: id, publicationApiBase: API, city,
            cadastreParcelIds: ['parcel-1'], parcelSet: { parcelSource: { sourceId: 'provider-a', snapshotId: 'release-a' } }
        }])) })),
        collectProposalFeatureSets: record => ({ primaryFeatures: record.primaryFeatures || [] }),
        isProposalCurrentlyApplied: record => !!record.applied,
        ParcelGroundFallback: { isWithoutParcels: () => withoutParcels },
        CadastralParcelRepository: { ensureIds, getMany },
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
    return { window, body, ensureIds, getMany, getProposalByServerRowId, geoJSON };
}

const plan = {
    slug: 'plan', title: 'Plan', proposalRowIds: ['42'],
    members: [{ proposalRowId: '42', title: 'Member', changed: false, missing: false }]
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
});
