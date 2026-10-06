// Headless contracts for the first five US capital parcel sources: native identity, display labels,
// complete object-ID manifests, city filters, projections and live-source binding without parcel DB reads.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearParcelSourceRuntimeCache, createParcelSource, parcelSourceCatalog } from '../parcels/sources.js';
import { computeBinding } from '../proposals/binding.js';

const samples = [
    { city: 'montgomery', sourceId: 'us-al-montgomery-city-parcels', native: '1004181031004000', label: '10 04 18 1 031 004.000            ', center: [-86.3, 32.3668] },
    { city: 'juneau', sourceId: 'us-ak-cbj-parcels', native: '1C060C250020', label: '1C060C250020', center: [-134.4202, 58.3016] },
    { city: 'phoenix', sourceId: 'us-az-maricopa-assessor-parcels', native: '11221002', label: '11221002', center: [-112.074, 33.4484] },
    { city: 'little_rock', sourceId: 'us-ar-ago-parcels-pulaski', native: '34L-032.00-016.00', label: '34L-032.00-016.00', center: [-92.2896, 34.7465] },
    { city: 'sacramento', sourceId: 'us-ca-sacramento-active-parcels', native: '00600360310000', label: '006-0036-031-0000', center: [-121.4944, 38.5816] }
];
const rect = ([x, y], d = 0.0001) => ({ type: 'Polygon', coordinates: [[[x-d,y-d],[x+d,y-d],[x+d,y+d],[x-d,y+d],[x-d,y-d]]] });
const jsonResponse = value => ({ ok: true, status: 200, json: async () => value });
const descriptor = sample => parcelSourceCatalog.sources.find(row => row.id === sample.sourceId);
function geoFeature(sample, oid, geom = rect(sample.center)) {
    const d = descriptor(sample);
    return { type: 'Feature', id: oid, properties: { [d.objectIdField]: oid, [d.idField]: sample.native,
        ...(d.parcelNumberField ? { [d.parcelNumberField]: sample.label } : {}), ...(d.attributeFilters ? { county: 'Pulaski' } : {}) }, geometry: geom };
}
function manifestFetch(sample, rows) {
    const d = descriptor(sample);
    return vi.fn(async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.searchParams.get('returnCountOnly') === 'true') return jsonResponse({ count: rows.length });
        if (url.searchParams.get('returnIdsOnly') === 'true') return jsonResponse({ objectIdFieldName: d.objectIdField, objectIds: rows.map(f => f.properties[d.objectIdField]) });
        const ids = url.searchParams.get('objectIds')?.split(',').map(Number);
        const features = ids ? rows.filter(f => ids.includes(f.properties[d.objectIdField])) : rows;
        return jsonResponse({ type: 'FeatureCollection', features, exceededTransferLimit: false });
    });
}
afterEach(() => { vi.unstubAllGlobals(); clearParcelSourceRuntimeCache(); });

describe('configured capital source identities and geometry reads', () => {
    it.each(samples)('$city keeps native identity separate from the display label', async sample => {
        const d = descriptor(sample); const nativeFeature = geoFeature(sample, 31);
        const source = createParcelSource(d, { fetchImpl: manifestFetch(sample, [nativeFeature]) });
        const result = await source.queryBounds([sample.center[0]-.001, sample.center[1]-.001, sample.center[0]+.001, sample.center[1]+.001]);
        expect(result.features[0]).toMatchObject({ id: d.idPrefix + sample.native,
            properties: { sourceParcelId: sample.native, parcelNumber: sample.label } });
        expect(result.features[0].properties.parcelId).toBe(d.idPrefix + sample.native);
    });

    it('keeps Montgomery PID identity and padded ParcelNo display text verbatim', async () => {
        const s=samples[0], d=descriptor(s), fetchImpl=manifestFetch(s,[geoFeature(s,44)]);
        const result=await createParcelSource(d,{fetchImpl}).queryBounds([-86.301,32.366,-86.299,32.368]);
        expect(result.features[0].id).toBe('US-AL-MONTGOMERY-1004181031004000');
        expect(result.features[0].properties.parcelNumber).toBe('10 04 18 1 031 004.000            ');
        expect(result.features[0].properties.sourceProperties.PID).toBe('1004181031004000');
    });

    it('applies the Pulaski county filter before returning Little Rock parcels', async () => {
        const s=samples[3], d=descriptor(s), fetchImpl=manifestFetch(s,[geoFeature(s,5)]);
        await createParcelSource(d,{fetchImpl}).queryBounds([-92.29,34.746,-92.289,34.747]);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('where')).toBe("county = 'Pulaski'");
    });

    it('uses Sacramento full 14-digit native identity while exposing the parcel-number label', async () => {
        const s=samples[4], d=descriptor(s), fetchImpl=manifestFetch(s,[geoFeature(s,9)]);
        const result=await createParcelSource(d,{fetchImpl}).queryBounds([-121.495,38.581,-121.493,38.583]);
        expect(result.features[0].id).toBe('US-CA-SACRAMENTO-00600360310000');
        expect(result.features[0].properties.parcelNumber).toBe('006-0036-031-0000');
        expect(result.features[0].properties.sourceProperties.PARCEL_NUMBER).toBe('00600360310000');
    });

    it('uses count/OID manifests for Montgomery bounds and exact native-ID reads', async () => {
        const s=samples[0], d=descriptor(s), row=geoFeature(s,81), fetchImpl=manifestFetch(s,[row]);
        const source=createParcelSource(d,{fetchImpl});
        await source.queryBounds([-86.301,32.366,-86.299,32.368]);
        await source.queryIds([d.idPrefix+s.native]);
        const params=fetchImpl.mock.calls.map(([input])=>new URL(input).searchParams);
        expect(params.filter(p=>p.get('returnCountOnly')==='true')).toHaveLength(1);
        expect(params.filter(p=>p.get('returnIdsOnly')==='true')).toHaveLength(1);
        expect(params.some(p=>p.get('where')?.includes("PID IN ('1004181031004000')"))).toBe(true);
    });

    it('expands Juneau parts through complete bounds and native-ID OID manifests', async () => {
        const s=samples[1], d=descriptor(s), geom1=rect(s.center), geom2=rect(s.center,0.00025);
        // Disconnected components under one tax_id are expected; adapter returns a dissolved parcel.
        const rows=[geoFeature(s,101,geom1),geoFeature(s,102,geom2)];
        const fetchImpl=manifestFetch(s,rows), source=createParcelSource(d,{fetchImpl});
        const bounds=await source.queryBounds([-134.421,58.301,-134.419,58.303]);
        expect(bounds.features).toHaveLength(1);
        expect(bounds.features[0].id).toBe(d.idPrefix+s.native);
        expect(bounds.features[0].properties.sourcePartCount).toBe(2);
        const exact=await source.queryIds([d.idPrefix+s.native]);
        expect(exact.features).toHaveLength(1);
        expect(exact.features[0].properties.sourcePartCount).toBe(2);
        const urls=fetchImpl.mock.calls.map(([input])=>new URL(input));
        expect(urls.filter(u=>u.searchParams.get('returnCountOnly')==='true').length).toBeGreaterThanOrEqual(2);
        expect(urls.filter(u=>u.searchParams.get('returnIdsOnly')==='true').length).toBeGreaterThanOrEqual(2);
        expect(urls.some(u=>u.searchParams.get('where')?.includes("tax_id IN ('1C060C250020')"))).toBe(true);
    });

    it('computes binding from the configured live adapter without reading parcel tables', async () => {
        const s=samples[2], d=descriptor(s), row=geoFeature(s,71), fetchImpl=manifestFetch(s,[row]);
        vi.stubGlobal('fetch',fetchImpl); clearParcelSourceRuntimeCache();
        const db={query:vi.fn(async()=>{throw new Error('configured source binding must not read parcel tables');})};
        const {binding}=await computeBinding(db,{city:s.city,site:rect(s.center),toleranceM:0});
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({coverage:'complete',source:`server:${d.id}`});
        expect(binding.parcels.map(x=>x.parcelId)).toEqual([d.idPrefix+s.native]);
    });
});
