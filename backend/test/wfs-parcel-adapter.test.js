// Exercises WFS axis order, count-backed paging, ID lookup and failure behavior without network I/O.
import { describe, it, expect, vi } from 'vitest';
import { createWfsParcelSource } from '../parcels/wfs-source.js';

const descriptor = {
    id: 'fr-ign-parcellaire-express', endpoint: 'https://data.geopf.fr/wfs/ows',
    featureType: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle', idField: 'idu', idType: 'string',
    idPattern: '^[0-9A-Z]{14}$', idPrefix: 'FR-PCI-', outFields: ['idu', 'numero'], pageSize: 2, maxFeatures: 10
};
const BOUNDS = [2.355, 48.8486, 2.356, 48.8494];
const GEOMETRY = { type: 'Polygon', coordinates: [[[2.355, 48.8486], [2.356, 48.8486], [2.356, 48.8494], [2.355, 48.8494], [2.355, 48.8486]]] };
function feature(oid, native = '75105000AD0011', geometry = GEOMETRY) {
    return { type: 'Feature', id: `parcelle.${oid}`, properties: { idu: native, numero: typeof native === 'string' ? native.slice(-4) : null, ignored: 'drop' }, geometry };
}
function page(features, matched = features.length, extra = {}) {
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features, numberMatched: matched, numberReturned: features.length, ...extra }) };
}
function integerFeature(oid, geometry = GEOMETRY) {
    return { type: 'Feature', id: `lot.${oid}`, properties: { lotid: oid, ignored: 'drop' }, geometry };
}
function wfs11Page(features, totalFeatures = features.length) {
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features, totalFeatures }) };
}
function ahmedabadCapFeature(index) {
    const search = `Jamalpur 1 ${index}`;
    return {
        type: 'Feature', id: `final_plot_boundary.${index}`,
        properties: { search, fp_no: String(index), status: 'Final', city: 'Ahmedabad', authority: 'AMC' },
        geometry: { type: 'Polygon', coordinates: [[[72.5901, 23.0151], [72.5902, 23.0151], [72.5902, 23.0152], [72.5901, 23.0152], [72.5901, 23.0151]]] }
    };
}
function source(pages, override = {}) {
    const fetchImpl = vi.fn(); pages.forEach(payload => fetchImpl.mockResolvedValueOnce(payload));
    return { adapter: createWfsParcelSource({ ...descriptor, ...override }, { fetchImpl }), fetchImpl };
}
const AHMEDABAD_CAPPED_PROFILE = {
    id: 'ahmedabad-wfs11-capped-profile-test', endpoint: 'https://tpvd.openprp.in/geoserver/ows',
    version: '1.1.0', featureType: 'ctp:final_plot_boundary', idField: 'search', idType: 'string',
    idPattern: undefined, idPrefix: 'IN-GJ-TPVD-', parcelNumberField: 'fp_no',
    outFields: ['search', 'fp_no', 'status', 'city', 'authority'],
    attributeFilters: { status: 'Final', city: 'Ahmedabad', authority: 'AMC' },
    geometryField: 'the_geom', pageSize: 1000, maxFeatures: 1000, maxBboxKm2: 2
};
const AHMEDABAD_BOUNDS = [72.59, 23.015, 72.595, 23.02];

describe('WFS parcel adapter', () => {
    it('uses explicit longitude/latitude CRS and pages until the known match count is reached', async () => {
        const { adapter, fetchImpl } = source([
            page([feature(1), feature(2, '75105000AD0012')], 3, { links: [{ rel: 'next', href: 'http://localhost/unsafe' }] }),
            page([feature(3, '75105000AD0013')], 3)
        ]);
        const result = await adapter.queryBounds(BOUNDS);
        expect(result).toMatchObject({ complete: true, returnsWGS84: true, sourceId: descriptor.id });
        expect(result.features.map(f => f.id)).toEqual(['FR-PCI-75105000AD0011', 'FR-PCI-75105000AD0012', 'FR-PCI-75105000AD0013']);
        const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
        expect(urls.map(url => url.searchParams.get('startIndex'))).toEqual(['0', '2']);
        urls.forEach(url => {
            expect(url.origin).toBe('https://data.geopf.fr');
            expect(url.pathname).toBe('/wfs/ows');
            expect(url.searchParams.get('bbox')).toBe('2.355,48.8486,2.356,48.8494,CRS:84');
            expect(url.searchParams.get('srsName')).toBe('CRS:84');
            expect(url.searchParams.get('sortBy')).toBe('idu');
        });
        expect(result.features[0].properties.sourceProperties).toEqual({ idu: '75105000AD0011', numero: '0011' });
    });
    it('returns explicit absences after an exact-ID read', async () => {
        const { adapter, fetchImpl } = source([page([feature(1)])]);
        const result = await adapter.queryIds(['FR-PCI-75105000AD0011', 'FR-PCI-75105000AD9999']);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('cql_filter')).toBe("idu IN ('75105000AD0011','75105000AD9999')");
        expect(result.absentIds).toEqual(['FR-PCI-75105000AD9999']);
        expect(result.complete).toBe(true);
    });
    it('combines fixed city attributes and a CRS:84 BBOX in one CQL filter', async () => {
        const filtered = {
            geometryField: 'shape',
            attributeFilters: { status: 'Final', city: 'Ahmedabad', authority: 'AMC' },
            outFields: [...descriptor.outFields, 'status', 'city', 'authority']
        };
        const matching = {
            ...feature(1),
            properties: { ...feature(1).properties, status: 'Final', city: 'Ahmedabad', authority: 'AMC' }
        };
        const { adapter, fetchImpl } = source([page([matching])], filtered);
        const result = await adapter.queryBounds(BOUNDS);
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(result.features).toHaveLength(1);
        expect(url.searchParams.get('cql_filter')).toBe("(status = 'Final' AND city = 'Ahmedabad' AND authority = 'AMC') AND (BBOX(shape,2.355,48.8486,2.356,48.8494,'CRS:84'))");
        expect(url.searchParams.has('bbox')).toBe(false);
    });
    it('combines fixed city attributes with exact native-ID lookup scope', async () => {
        const filtered = {
            attributeFilters: { status: 'Final', city: 'Ahmedabad', authority: 'AMC' },
            geometryField: 'shape',
            outFields: [...descriptor.outFields, 'status', 'city', 'authority']
        };
        const matching = {
            ...feature(1),
            properties: { ...feature(1).properties, status: 'Final', city: 'Ahmedabad', authority: 'AMC' }
        };
        const { adapter, fetchImpl } = source([page([matching])], filtered);
        const result = await adapter.queryIds(['FR-PCI-75105000AD0011']);
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(result.features.map(parcel => parcel.id)).toEqual(['FR-PCI-75105000AD0011']);
        expect(url.searchParams.get('cql_filter')).toBe("(status = 'Final' AND city = 'Ahmedabad' AND authority = 'AMC') AND (idu IN ('75105000AD0011'))");
        expect(url.searchParams.has('bbox')).toBe(false);
    });
    it('rejects a feature when the provider ignores a fixed city filter', async () => {
        const filtered = {
            attributeFilters: { status: 'Final', city: 'Ahmedabad', authority: 'AMC' },
            geometryField: 'shape',
            outFields: [...descriptor.outFields, 'status', 'city', 'authority']
        };
        const outside = {
            ...feature(1),
            properties: { ...feature(1).properties, status: 'Final', city: 'Gandhinagar', authority: 'AMC' }
        };
        const { adapter } = source([page([outside])], filtered);
        await expect(adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });
    it.each([undefined, '', 'shape);DROP_TABLE', 'geom.field'])('requires a safe geometry field with fixed filters (%s)', geometryField => {
        const fetchImpl = vi.fn();
        expect(() => createWfsParcelSource({
            ...descriptor, geometryField,
            attributeFilters: { status: 'Final' }, outFields: [...descriptor.outFields, 'status']
        }, { fetchImpl })).toThrow(/invalid wfs parcel source descriptor/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('supports GeoServer WFS 1.1 paging and strict numeric native IDs', async () => {
        const hk = {
            id: 'hk-landsd-lot-index-api', endpoint: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/iC1000/lot',
            version: '1.1.0', featureType: 'iC1000:lot', idField: 'lotid', idType: 'integer',
            idPrefix: 'HK-LOT-', outFields: ['lotid'], pageSize: 3, maxFeatures: 10
        };
        const { adapter, fetchImpl } = source([
            wfs11Page([integerFeature(1800293576), integerFeature(1800293577), integerFeature(1800293578)], 4),
            wfs11Page([integerFeature(1800293579)], 4)
        ], hk);
        const result = await adapter.queryBounds([114.181, 22.314, 114.185, 22.317]);
        expect(result.features.map(parcel => parcel.id)).toEqual([
            'HK-LOT-1800293576', 'HK-LOT-1800293577', 'HK-LOT-1800293578', 'HK-LOT-1800293579'
        ]);
        expect(result.features[0].properties.sourceParcelId).toBe('1800293576');
        const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
        expect(urls.map(url => url.searchParams.get('startIndex'))).toEqual(['0', '3']);
        urls.forEach(url => {
            expect(url.searchParams.get('version')).toBe('1.1.0');
            expect(url.searchParams.get('typeName')).toBe('iC1000:lot');
            expect(url.searchParams.has('typeNames')).toBe(false);
            expect(url.searchParams.get('maxFeatures')).toBe('3');
            expect(url.searchParams.has('count')).toBe(false);
            expect(url.searchParams.get('sortBy')).toBe('lotid');
            expect(url.searchParams.get('srsName')).toBe('CRS:84');
            expect(url.searchParams.get('bbox')).toBe('114.181,22.314,114.185,22.317,CRS:84');
        });
    });
    it('uses an unquoted exact numeric WFS 1.1 lookup and rejects noncanonical or injected integer IDs', async () => {
        const hk = {
            id: 'hk-exact-lot-id-test', endpoint: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/iC1000/lot',
            version: '1.1.0', featureType: 'iC1000:lot', idField: 'lotid', idType: 'integer',
            idPrefix: 'HK-LOT-', outFields: ['lotid'], pageSize: 3, maxFeatures: 10
        };
        const { adapter, fetchImpl } = source([wfs11Page([integerFeature(1800293576)], 1)], hk);
        const result = await adapter.queryIds(['HK-LOT-1800293576']);
        expect(result.features.map(parcel => parcel.id)).toEqual(['HK-LOT-1800293576']);
        const exactUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(exactUrl.searchParams.get('cql_filter')).toBe('lotid IN (1800293576)');
        expect(exactUrl.searchParams.get('version')).toBe('1.1.0');
        for (const invalid of ["HK-LOT-1800293576' OR 1=1", 'HK-LOT-01800293576', 'HK-LOT-9007199254740992']) {
            await expect(adapter.queryIds([invalid])).rejects.toMatchObject({ status: 400 });
        }
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it('fails closed when WFS 1.1 match counts reveal an incomplete page', async () => {
        const hk = {
            id: 'hk-incomplete-page-test', endpoint: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/iC1000/lot',
            version: '1.1.0', featureType: 'iC1000:lot', idField: 'lotid', idType: 'integer',
            idPrefix: 'HK-LOT-', outFields: ['lotid'], pageSize: 2, maxFeatures: 10
        };
        const { adapter } = source([wfs11Page([integerFeature(1800293576)], 2), wfs11Page([], 2)], hk);
        await expect(adapter.queryBounds([114.181, 22.314, 114.185, 22.317])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });
    it('accepts a counted 1000-feature WFS 1.1 capped profile in one request', async () => {
        const { adapter, fetchImpl } = source([
            wfs11Page(Array.from({ length: 1000 }, (_, index) => ahmedabadCapFeature(index + 1)), 1000)
        ], AHMEDABAD_CAPPED_PROFILE);
        const result = await adapter.queryBounds(AHMEDABAD_BOUNDS);
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(result.complete).toBe(true);
        expect(result.features).toHaveLength(1000);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(url.searchParams.get('maxFeatures')).toBe('1000');
        expect(url.searchParams.get('startIndex')).toBe('0');
        expect(url.searchParams.get('cql_filter')).toContain("(status = 'Final' AND city = 'Ahmedabad' AND authority = 'AMC') AND (BBOX(the_geom,72.59,23.015,72.595,23.02,'CRS:84'))");
        expect(url.searchParams.has('bbox')).toBe(false);
    });
    it('rejects a capped WFS 1.1 page when the reported count exceeds the feature limit', async () => {
        const { adapter, fetchImpl } = source([
            wfs11Page(Array.from({ length: 1000 }, (_, index) => ahmedabadCapFeature(index + 1)), 1001)
        ], AHMEDABAD_CAPPED_PROFILE);
        await expect(adapter.queryBounds(AHMEDABAD_BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(url.searchParams.get('maxFeatures')).toBe('1000');
        expect(url.searchParams.get('startIndex')).toBe('0');
    });
    it.each([undefined, 'unknown', -1])('refuses missing or invalid WFS 1.1 match counts (%s)', async matched => {
        const hk = { id: 'wfs11-counter-test', endpoint: 'https://provider.example/wfs', version: '1.1.0',
            featureType: 'landsd:lot', idField: 'lotid', idType: 'integer', idPrefix: 'HK-LOT-',
            outFields: ['lotid'], pageSize: 3, maxFeatures: 10 };
        const fetchImpl = async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection',
            features: [integerFeature(1800293576)], totalFeatures: matched }) });
        await expect(createWfsParcelSource(hk, { fetchImpl }).queryBounds([114.181, 22.314, 114.185, 22.317])).rejects.toMatchObject({ status: 502 });
    });
    it('rejects contradictory optional counters in a WFS 1.1 response', async () => {
        const hk = { id: 'wfs11-conflicting-counter-test', endpoint: 'https://provider.example/wfs', version: '1.1.0',
            featureType: 'landsd:lot', idField: 'lotid', idType: 'integer', idPrefix: 'HK-LOT-',
            outFields: ['lotid'], pageSize: 3, maxFeatures: 10 };
        const payload = wfs11Page([integerFeature(1800293576)], 1);
        const fetchImpl = async () => ({ ok: true, json: async () => ({ ...(await payload.json()), numberReturned: 2 }) });
        await expect(createWfsParcelSource(hk, { fetchImpl }).queryBounds([114.181, 22.314, 114.185, 22.317])).rejects.toMatchObject({ status: 502 });
    });
    it('rejects WFS pages larger than the configured page limit', async () => {
        const { adapter } = source([page([feature(1), feature(2), feature(3)], 3)]);
        await expect(adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        const hk = {
            id: 'hk-oversized-page-test', endpoint: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/iC1000/lot',
            version: '1.1.0', featureType: 'iC1000:lot', idField: 'lotid', idType: 'integer',
            idPrefix: 'HK-LOT-', outFields: ['lotid'], pageSize: 2, maxFeatures: 10
        };
        const wfs11 = source([wfs11Page([integerFeature(1), integerFeature(2), integerFeature(3)], 3)], hk);
        await expect(wfs11.adapter.queryBounds([114.181, 22.314, 114.185, 22.317])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });
    it('rejects unsafe or nonnumeric WFS 1.1 native integer IDs', async () => {
        const hk = {
            id: 'hk-invalid-native-id-test', endpoint: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/iC1000/lot',
            version: '1.1.0', featureType: 'iC1000:lot', idField: 'lotid', idType: 'integer',
            idPrefix: 'HK-LOT-', outFields: ['lotid'], pageSize: 3, maxFeatures: 10
        };
        for (const nativeId of [9007199254740992, '1800293576']) {
            const { adapter } = source([wfs11Page([integerFeature(nativeId)], 1)], hk);
            await expect(adapter.queryBounds([114.181, 22.314, 114.185, 22.317])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        }
    });
    it('rejects a skinny WFS bbox when one side exceeds the provider limit', async () => {
        const { adapter, fetchImpl } = source([], { maxBboxWidthM: 750, maxBboxHeightM: 600 });
        expect(() => adapter.queryBounds([2.35, 48.8, 2.37, 48.8001])).toThrow(/area is too large|dimensions exceed/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('shares source-specific request spacing across adapters and recovers after a failed request', async () => {
        vi.useFakeTimers();
        try {
            const hk = {
                id: 'hk-shared-rate-limit-test', endpoint: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/iC1000/lot',
                version: '1.1.0', featureType: 'iC1000:lot', idField: 'lotid', idType: 'integer',
                idPrefix: 'HK-LOT-', outFields: ['lotid'], pageSize: 3, maxFeatures: 10, minRequestIntervalMs: 100
            };
            const starts = [];
            const firstFetch = vi.fn(async () => {
                starts.push(Date.now());
                return { ok: false, status: 503 };
            });
            const secondFetch = vi.fn(async () => {
                starts.push(Date.now());
                return wfs11Page([integerFeature(1800293576)], 1);
            });
            const first = createWfsParcelSource(hk, { fetchImpl: firstFetch });
            const second = createWfsParcelSource({ ...hk, id: 'hk-same-endpoint-other-collection' }, { fetchImpl: secondFetch });
            const failed = first.queryBounds([114.181, 22.314, 114.185, 22.317]);
            const failedAssertion = expect(failed).rejects.toMatchObject({ status: 502 });
            const succeeded = second.queryBounds([114.181, 22.314, 114.185, 22.317]);
            await vi.advanceTimersByTimeAsync(0);
            expect(firstFetch).toHaveBeenCalledTimes(1);
            expect(secondFetch).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(99);
            expect(secondFetch).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await Promise.all([failedAssertion, succeeded]);
            expect(secondFetch).toHaveBeenCalledTimes(1);
            expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(100);
        } finally {
            vi.useRealTimers();
        }
    });
    it('maps WFS 1.1 HTTP failures to unavailable without losing the status', async () => {
        const hk = {
            id: 'hk-http-failure-test', endpoint: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/iC1000/lot',
            version: '1.1.0', featureType: 'iC1000:lot', idField: 'lotid', idType: 'integer',
            idPrefix: 'HK-LOT-', outFields: ['lotid'], pageSize: 3, maxFeatures: 10
        };
        const { adapter } = source([{ ok: false, status: 503 }], hk);
        await expect(adapter.queryBounds([114.181, 22.314, 114.185, 22.317])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });
    it('does not turn a provider that ignored its ID filter into apparent absence', async () => {
        const { adapter } = source([page([feature(1, '75105000AD0012')])]);
        await expect(adapter.queryIds(['FR-PCI-75105000AD0011'])).rejects.toMatchObject({ status: 502 });
    });
    it('rejects foreign or malformed IDs and oversized areas before I/O', async () => {
        const { adapter, fetchImpl } = source([]);
        for (const ids of [['US-DC-12'], ['FR-PCI-x'], ["FR-PCI-75105000AD0011' OR 1=1"], []]) await expect(adapter.queryIds(ids)).rejects.toMatchObject({ status: 400 });
        expect(() => adapter.queryBounds([2, 48, 4, 50])).toThrow(/area is too large/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([
        ['unknown count', [page([feature(1)], 'unknown')]],
        ['missing count', [page([feature(1)], undefined, { numberMatched: undefined })]],
        ['wrong returned count', [page([feature(1)], 1, { numberReturned: 2 })]],
        ['changing count', [page([feature(1)], 2), page([feature(2, '75105000AD0012')], 3)]],
        ['empty partial page', [page([], 1)]],
        ['repeated page', [page([feature(1)], 2), page([feature(1)], 2)]],
        ['missing native ID', [page([feature(1, null)])]],
        ['invalid geometry', [page([feature(1, '75105000AD0011', { type: 'MultiPolygon', coordinates: [null] })])]],
        ['limit exceeded', [page([feature(1)], 11)]]
    ])('fails closed on %s', async (_name, pages) => {
        const { adapter } = source(pages);
        await expect(adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });
    it('rejects spatially different polygons claiming one durable ID', async () => {
        const different = { type: 'Polygon', coordinates: [[[2.3551, 48.8486], [2.356, 48.8486], [2.356, 48.8494], [2.3551, 48.8494], [2.3551, 48.8486]]] };
        const { adapter } = source([page([feature(1), feature(2, '75105000AD0011', different)])]);
        await expect(adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
    });
    it('filters an envelope response by the actual proposal footprint', async () => {
        const outside = { type: 'Polygon', coordinates: [[[2.3557, 48.8491], [2.3558, 48.8491], [2.3558, 48.8492], [2.3557, 48.8492], [2.3557, 48.8491]]] };
        const inside = { type: 'Polygon', coordinates: [[[2.3551, 48.8487], [2.3552, 48.8487], [2.3552, 48.8488], [2.3551, 48.8488], [2.3551, 48.8487]]] };
        const triangle = { type: 'Polygon', coordinates: [[[2.355, 48.8486], [2.356, 48.8486], [2.355, 48.8494], [2.355, 48.8486]]] };
        const { adapter } = source([page([feature(1, '75105000AD0011', inside), feature(2, '75105000AD0012', outside)])]);
        const result = await adapter.queryGeometry(triangle);
        expect(result.complete).toBe(true);
        expect(result.features.map(f => f.id)).toEqual(['FR-PCI-75105000AD0011']);
    });
    it('rejects malformed caller geometry as input rather than provider failure', async () => {
        const { adapter, fetchImpl } = source([]);
        await expect(adapter.queryGeometry({ type: 'MultiPolygon', coordinates: [null] })).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('maps HTTP and parser failures without publishing a complete empty cell', async () => {
        const http = source([{ ok: false, status: 503 }]);
        await expect(http.adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
        const xml = source([{ ok: true, json: async () => { throw new SyntaxError('WFS ExceptionReport'); } }]);
        await expect(xml.adapter.queryBounds(BOUNDS)).rejects.toMatchObject({ status: 502 });
    });
});
