// Checks the published metadata builder and browser query adapter agree on release identity.
import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { buildManifest } from '../scripts/build-hmlr-browser-manifest.mjs';
import { createHmlrBrowserParcelSource, createMemoryHmlrFeatureStore } from '../parcels/hmlr-browser-source.js';

it('serves an exact parcel ID from real builder output, including a duplicate across council archives', async () => {
    const out = await mkdtemp(join(tmpdir(), 'hmlr-browser-contract-'));
    const baseUrl = 'https://metadata.example/hmlr';
    const authorityNames = ['Cardiff_Council', 'Oxford_City_Council'];
    const catalogue = { sourceDate: '2026-10-04', authorities: authorityNames.map(name => ({ name,
        endpoint: `https://use-land-property-data.service.gov.uk/datasets/inspire/download/${name}.zip` })) };
    const xml = '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:lr="www.landregistry.gov.uk" xmlns:g="http://www.opengis.net/gml/3.2" timeStamp="2026-10-04T03:01:14Z" numberMatched="1" numberReturned="1"><wfs:member><lr:PREDEFINED><lr:INSPIREID>123456</lr:INSPIREID><lr:GEOMETRY><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::27700"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>530800 180200 530810 180200 530810 180210 530800 180210 530800 180200</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></lr:GEOMETRY></lr:PREDEFINED></wfs:member></wfs:FeatureCollection>';
    const bytes = zipSync({ 'native.gml': strToU8(xml) });
    const archive = () => new Response(bytes, { headers: { etag: '"rev1"', 'content-length': String(bytes.length) } });
    try {
        const manifest = await buildManifest({ out, baseUrl, catalogueFn: async () => catalogue, fetcher: async () => archive(), log: () => {} });
        const fetchImpl = async url => {
            if (String(url).startsWith(baseUrl)) {
                const relative = new URL(url).pathname.slice('/hmlr/'.length);
                const data = await readFile(join(out, relative));
                return new Response(data, { headers: { 'content-length': String(data.length) } });
            }
            return archive();
        };
        const source = createHmlrBrowserParcelSource({ id: 'gb-hmlr-browser-v1', adapter: 'hmlr-browser',
            idPrefix: 'GB-HMLR-BROWSER-v1-', manifestUrl: `${baseUrl}/${manifest.releaseId}/manifest.json` },
        { fetchImpl, allowSample: true, featureStore: createMemoryHmlrFeatureStore(), cacheStorage: null });
        const result = await source.queryIds(['GB-HMLR-BROWSER-v1-123456', 'GB-HMLR-BROWSER-v1-999']);
        expect(result.complete).toBe(true);
        expect(result.snapshotId).toBe(manifest.releaseId);
        expect(result.features.map(feature => feature.id)).toEqual(['GB-HMLR-BROWSER-v1-123456']);
        expect(result.absentIds).toEqual(['GB-HMLR-BROWSER-v1-999']);
    } finally { await rm(out, { recursive: true, force: true }); }
}, 30000);
