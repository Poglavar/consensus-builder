import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parcelSourceCatalog } from '../parcels/sources.js';
import { createProviderRelayFetch, fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { officialArchiveFetch } from '../parcels/gml-snapshot-source.js';
import { createParcelProviderRelayRouter } from '../routes/parcel-provider-relay.js';

const dgu = parcelSourceCatalog.sources.find(source => source.id === 'hr-dgu-oss-dkp-cestice');
const originalPublicToken = process.env.OSS_PUBLIC_ACCESS_TOKEN;
const originalToken = process.env.OSS_TOKEN;
async function invokeRelayHandler(router, sourceId, body) {
    const layer = router.stack.find(entry => entry.route);
    const handler = layer.route.stack.at(-1).handle;
    const req = Object.assign(new EventEmitter(), { params: { sourceId }, body });
    const res = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200, headersSent: false, writableEnded: false,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; this.headersSent = true; this.writableEnded = true; return this; },
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        write(value) { this.chunks ||= []; this.chunks.push(Buffer.from(value)); this.headersSent = true; return true; },
        end() { this.writableEnded = true; this.headersSent = true; },
        destroy() { this.destroyed = true; } });
    await handler(req, res);
    return res;
}
afterEach(() => {
    if (originalPublicToken === undefined) delete process.env.OSS_PUBLIC_ACCESS_TOKEN;
    else process.env.OSS_PUBLIC_ACCESS_TOKEN = originalPublicToken;
    if (originalToken === undefined) delete process.env.OSS_TOKEN;
    else process.env.OSS_TOKEN = originalToken;
});

describe('parcel provider relay validation', () => {
    it('permits the reviewed AkwaGIS anonymous token route only for its registered layer', () => {
        const descriptor = parcelSourceCatalog.sources.find(source => source.id === 'ng-akwaibom-akwagis-surveymap-parcel-drafter');
        const url = 'https://akwagis.akwaibomstate.gov.ng/api/v1/gis/public-token';
        expect(validateParcelProviderRelayRequest(descriptor.id, { url }, { sources: [descriptor] }).target.href).toBe(url);
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: url.replace('public-token', 'admin') }, { sources: [descriptor] })).toThrow();
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url }, { sources: [{ ...descriptor, endpoint: descriptor.endpoint + '/other' }] })).toThrow();
        const other = parcelSourceCatalog.sources.find(source => source.adapter === 'arcgis' && source.id !== descriptor.id);
        expect(() => validateParcelProviderRelayRequest(other.id, { url }, { sources: [other] })).toThrow();
    });

    it('injects the configured DGU token server-side and rejects client credentials', () => {
        process.env.OSS_PUBLIC_ACCESS_TOKEN = 'server-secret';
        const validated = validateParcelProviderRelayRequest(dgu.id, { url: `${dgu.endpoint}?service=WFS&token=browser-relay` }, { sources: [dgu] });
        expect(validated.target.searchParams.get('token')).toBe('server-secret');
        expect(() => validateParcelProviderRelayRequest(dgu.id, { url: `${dgu.endpoint}?token=client-secret` }, { sources: [dgu] })).toThrow();
        expect(() => validateParcelProviderRelayRequest(dgu.id, { url: 'https://127.0.0.1/private' }, { sources: [dgu] })).toThrow();
    });

    it('allows only configured Kerala paths, methods, and small form or JSON bodies', () => {
        const descriptor = { id: 'in-kl-test', adapter: 'kerala-entebhoomi', endpoint: 'https://entebhoomi.kerala.gov.in/web/ilms/map', locationCode: '123456' };
        expect(validateParcelProviderRelayRequest(descriptor.id, { url: 'https://entebhoomi.kerala.gov.in/web/taluk/gid?districtId=x' }, { sources: [descriptor] }).target.pathname).toBe('/web/taluk/gid');
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: 'https://entebhoomi.kerala.gov.in/admin' }, { sources: [descriptor] })).toThrow();
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: 'https://entebhoomi.kerala.gov.in/web/ilms/map/view', method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }, { sources: [descriptor] })).toThrow();
    });

    it('allows only native BEV tile and lookup paths and OGC item paths', () => {
        const bev = parcelSourceCatalog.sources.find(source => source.id === 'at-bev-kataster-vector-tiles');
        expect(validateParcelProviderRelayRequest(bev.id, { url: 'https://kataster.bev.gv.at/tiles/kataster/16/100/200.pbf' }, { sources: [bev] })).toBeTruthy();
        expect(() => validateParcelProviderRelayRequest(bev.id, { url: 'https://kataster.bev.gv.at/tiles/kataster/16/65536/22000.pbf' }, { sources: [bev] })).toThrow();
        expect(() => validateParcelProviderRelayRequest(bev.id, { url: 'https://kataster.bev.gv.at/admin' }, { sources: [bev] })).toThrow();
        const ogc = parcelSourceCatalog.sources.find(source => source.adapter === 'ogc-api');
        expect(validateParcelProviderRelayRequest(ogc.id, { url: `${ogc.endpoint}/parcel-42?f=json` }, { sources: [ogc] }).target.pathname).toBe(`${new URL(ogc.endpoint).pathname}/parcel-42`);
        expect(() => validateParcelProviderRelayRequest(ogc.id, { url: `${new URL(ogc.endpoint).origin}/admin/parcel-42` }, { sources: [ogc] })).toThrow();
        const tkgm = parcelSourceCatalog.sources.find(source => source.adapter === 'tkgm-point');
        expect(validateParcelProviderRelayRequest(tkgm.id, { url: `${tkgm.endpoint}/41.123/29.456` }, { sources: [tkgm] })).toBeTruthy();
        expect(validateParcelProviderRelayRequest(tkgm.id, { url: `${tkgm.endpoint}/1e-7/1e-7` }, { sources: [tkgm] })).toBeTruthy();
        expect(validateParcelProviderRelayRequest(tkgm.id, { url: `${tkgm.endpoint}/123/456/789` }, { sources: [tkgm] })).toBeTruthy();
        expect(() => validateParcelProviderRelayRequest(tkgm.id, { url: `${tkgm.endpoint}/admin` }, { sources: [tkgm] })).toThrow();
        expect(() => validateParcelProviderRelayRequest(tkgm.id, { url: `${tkgm.endpoint}/91/181` }, { sources: [tkgm] })).toThrow();
        const msda = parcelSourceCatalog.sources.find(source => source.adapter === 'msda-point');
        expect(validateParcelProviderRelayRequest(msda.id, { url: `${msda.endpoint}/search-by-xy`, method: 'POST',
            headers: { 'content-type': 'application/json' }, body: '{}' }, { sources: [msda] })).toBeTruthy();
        expect(() => validateParcelProviderRelayRequest(msda.id, { url: `${msda.endpoint}/admin` }, { sources: [msda] })).toThrow();
    });

    it('honors a snapshot source byte cap above the relay default', () => {
        const snapshot = { id: 'test-snapshot', adapter: 'geojson-snapshot', endpoint: 'https://example.test/parcels.zip', maxSnapshotBytes: 80 * 1024 * 1024 };
        const validated = validateParcelProviderRelayRequest(snapshot.id, { url: snapshot.endpoint }, { sources: [snapshot] });
        expect(validated.maxResponseBytes).toBe(80 * 1024 * 1024);
    });

    it('accepts only the DLRS fixed referrer and injects its fixed user agent', async () => {
        const descriptor = parcelSourceCatalog.sources.find(source => source.adapter === 'dlrs-sheet');
        const validated = validateParcelProviderRelayRequest(descriptor.id, { url: descriptor.endpoint, method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://settlement.gov.bd/' }, body: 'rsnum=1' }, { sources: [descriptor] });
        const providerFetch = vi.fn(async () => new Response('{}'));
        await fetchParcelProviderRelay(validated, { providerFetch });
        expect(providerFetch.mock.calls[0][1].userAgent).toContain('Chrome/150.0.0.0');
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: descriptor.endpoint, headers: { referer: 'https://evil.example/' } }, { sources: [descriptor] })).toThrow();
    });

    it('accepts the actual HMLR browser descriptor, archive pin headers, follow mode, and scoped metadata URLs', async () => {
        const descriptor = { ...parcelSourceCatalog.sources.find(source => source.adapter === 'hmlr-browser'),
            manifestUrl: 'https://metadata.example/hmlr/manifest.json' };
        const archiveUrl = `${descriptor.endpoint}/Oxford_City_Council.zip`;
        const browserFetchImpl = vi.fn(async (_url, options) => new Response('zip', { status: 200,
            headers: { 'content-length': '3', etag: '"pin"', 'content-type': 'application/zip' } }));
        const browserFetch = createBrowserProviderFetch(descriptor, { relayBase: 'https://backend.example', fetchImpl: browserFetchImpl });
        const response = await browserFetch(archiveUrl, { redirect: 'follow', headers: { Accept: 'application/zip', 'If-Match': '"pin"' } });
        expect(response.url).toBe(archiveUrl);
        const envelope = JSON.parse(browserFetchImpl.mock.calls[0][1].body);
        const validated = validateParcelProviderRelayRequest(descriptor.id, envelope, { sources: [descriptor] });
        expect(validated).toMatchObject({ hmlr: true, redirect: 'follow', maxResponseBytes: 128 * 1024 * 1024, headers: expect.any(Headers) });
        const archiveFetch = vi.fn(async () => new Response('zip'));
        await fetchParcelProviderRelay(validated, { archiveFetch });
        expect(archiveFetch).toHaveBeenCalledWith(archiveUrl, expect.objectContaining({ redirect: 'follow',
            headers: expect.any(Headers) }));
        expect(archiveFetch.mock.calls[0][1].headers.get('if-match')).toBe('"pin"');

        const metadataFetch = vi.fn(async url => {
            if (url === descriptor.manifestUrl) throw new TypeError('force same-origin relay path');
            return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2' } });
        });
        const metadataBrowserFetch = createBrowserProviderFetch(descriptor, { relayBase: 'https://backend.example', fetchImpl: metadataFetch });
        const jsonResponse = await metadataBrowserFetch(descriptor.manifestUrl, { redirect: 'follow', headers: { Accept: 'application/json' } });
        expect(jsonResponse.url).toBe(descriptor.manifestUrl);
        const manifestEnvelope = JSON.parse(metadataFetch.mock.calls[1][1].body);
        const manifest = validateParcelProviderRelayRequest(descriptor.id, manifestEnvelope, { sources: [descriptor] });
        expect(manifest).toMatchObject({ hmlr: false, maxResponseBytes: 16 * 1024 * 1024 });
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: `${descriptor.manifestUrl}?other=1` }, { sources: [descriptor] })).toThrow();
        expect(validateParcelProviderRelayRequest(descriptor.id, { url: `https://metadata.example/hmlr/${'a'.repeat(64)}/ids/1234.${'b'.repeat(64)}.json` }, { sources: [descriptor] })).toBeTruthy();
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: 'https://metadata.example/hmlr/unrelated.json' }, { sources: [descriptor] })).toThrow();
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: `${archiveUrl}?download=1` }, { sources: [descriptor] })).toThrow();
        expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: `${descriptor.endpoint}?download=1` }, { sources: [descriptor] })).toThrow();
    });

    it('allows only canonical scope paths in the descriptor-pinned HMLR release', () => {
        const release = 'a'.repeat(64), hash = 'b'.repeat(64);
        const descriptor = { ...parcelSourceCatalog.sources.find(source => source.adapter === 'hmlr-browser'),
            snapshotId: release, manifestUrl: `https://metadata.example/hmlr/${release}/manifest.json` };
        const scopeRoot = `https://metadata.example/hmlr/${release}/scopes/`;
        const valid = `${scopeRoot}203.${hash}.json`;
        expect(validateParcelProviderRelayRequest(descriptor.id, { url: valid }, { sources: [descriptor] }))
            .toMatchObject({ hmlr: false, maxResponseBytes: 16 * 1024 * 1024 });
        for (const url of [valid.replace(release, 'c'.repeat(64)), valid.replace('metadata.example', 'other.example'),
            valid.replace('/hmlr/', '/other/'), `${valid}?token=x`, `${valid}#fragment`,
            `${scopeRoot}0203.${hash}.json`, `${scopeRoot}-1.${hash}.json`, `${scopeRoot}1000.${hash}.json`,
            `${scopeRoot}203.${'B'.repeat(64)}.json`, `${scopeRoot}203.${hash.slice(1)}.json`,
            `${scopeRoot}203.not-a-hash.json`, `${scopeRoot}203.${hash}.zip`, `${scopeRoot}nested/203.${hash}.json`]) {
            expect(() => validateParcelProviderRelayRequest(descriptor.id, { url }, { sources: [descriptor] }), url).toThrow();
        }
        for (const unpinned of [{ ...descriptor, snapshotId: undefined }, { ...descriptor, snapshotId: 'c'.repeat(64) },
            { ...descriptor, manifestUrl: 'https://metadata.example/hmlr/manifest.json' }]) {
            expect(() => validateParcelProviderRelayRequest(descriptor.id, { url: valid }, { sources: [unpinned] })).toThrow();
        }
        const limited = { ...descriptor, maxResponseBytes: 1024 };
        expect(validateParcelProviderRelayRequest(descriptor.id, { url: valid }, { sources: [limited] }).maxResponseBytes).toBe(1024);
    });

    it('forwards only pinned HMLR headers to the verified S3 archive hop', async () => {
        const originalFetch = globalThis.fetch, calls = [];
        const bytes = 'zipbytes';
        vi.stubGlobal('fetch', async (url, options) => {
            calls.push([String(url), options]);
            if (String(url) === 'https://use-land-property-data.service.gov.uk/datasets/inspire/download') return new Response('catalog');
            if (String(url).endsWith('/Oxford_City_Council.zip')) return new Response(null, { status: 302,
                headers: { location: 'https://datapub-prd-s3-bucket.s3.amazonaws.com/archive.zip' } });
            return new Response(bytes, { headers: { etag: '"pin"', 'content-length': String(bytes.length) } });
        });
        try {
            const response = await officialArchiveFetch('https://use-land-property-data.service.gov.uk/datasets/inspire/download/Oxford_City_Council.zip', {
                headers: new Headers({ Accept: 'application/zip', 'If-Match': '"pin"' }), redirect: 'follow' });
            expect(await response.text()).toBe(bytes);
            const [, archiveRequest] = calls.at(-1);
            expect(archiveRequest.headers.Accept).toBe('application/zip');
            expect(archiveRequest.headers['If-Match']).toBe('"pin"');
            expect(calls[1][1].headers['If-Match']).toBeUndefined();
            await expect(officialArchiveFetch('https://use-land-property-data.service.gov.uk/datasets/inspire/download/Oxford_City_Council.zip', {
                headers: { Cookie: 'secret' } })).rejects.toThrow(/Unsupported HMLR archive request header/);
        } finally { vi.stubGlobal('fetch', originalFetch); }
    });

    it('cancelling a response body after headers destroys the pinned upstream stream', async () => {
        const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-length': '5' };
        const requestImpl = vi.fn((_options, onResponse) => Object.assign(new EventEmitter(), {
            destroy: vi.fn(() => incoming.destroy()), end: () => setImmediate(() => { onResponse(incoming); incoming.write('chunk'); })
        }));
        const fetch = createProviderRelayFetch({ lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl });
        const response = await fetch(new URL('https://parcels.example/archive.zip'));
        const reader = response.body.getReader();
        await expect(reader.read()).resolves.toMatchObject({ done: false });
        await reader.cancel();
        expect(incoming.destroyed).toBe(true);
    });
});

describe('parcel provider relay route', () => {
    it('streams bounded provider responses and sends no-store headers', async () => {
        process.env.OSS_PUBLIC_ACCESS_TOKEN = 'server-secret';
        const relayFetch = vi.fn(async () => new Response('parcel-data', { status: 200, headers: { 'content-type': 'text/plain',
            'set-cookie': 'private=1', 'x-parcel-upstream-cookies': '["session=private"]' } }));
        const router = createParcelProviderRelayRouter({ sources: [dgu], relayFetch });
        const response = await invokeRelayHandler(router, dgu.id, { url: `${dgu.endpoint}?service=WFS&token=browser-relay` });
        expect(response.statusCode).toBe(200);
        expect(Buffer.concat(response.chunks).toString()).toBe('parcel-data');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(response.headers['x-parcel-upstream-cookies']).toBe('["session=private"]');
        expect(response.headers['access-control-expose-headers']).toContain('X-Parcel-Upstream-Cookies');
        expect(JSON.parse(new Headers(response.headers).get('x-parcel-upstream-cookies'))).toEqual(['session=private']);
        expect(relayFetch).toHaveBeenCalledOnce();
    });

    it('preserves and verifies HMLR archive length metadata', async () => {
        const descriptor = { id: 'gb-hmlr-browser-v1', adapter: 'gml-snapshot', endpoint: 'https://use-land-property-data.service.gov.uk/datasets/inspire/download' };
        const router = createParcelProviderRelayRouter({ sources: [descriptor], relayFetch: async () => new Response('zipbytes', { status: 200,
            headers: { 'content-type': 'application/zip', 'content-length': '8', etag: '"stable"' } }) });
        const response = await invokeRelayHandler(router, descriptor.id, { url: descriptor.endpoint });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-length']).toBe('8');
        expect(response.headers['access-control-expose-headers']).toContain('Content-Length');
        expect(Buffer.concat(response.chunks).toString()).toBe('zipbytes');
    });

    it('preserves unencoded pinned shapefile ZIP lengths above the default relay cap', async () => {
        const descriptor = { id: 'test-shapefile', adapter: 'shapefile-snapshot', endpoint: 'https://files.example/parcels.zip',
            snapshotFormat: 'shapefile-zip', maxSnapshotBytes: 80 * 1024 * 1024 };
        const router = createParcelProviderRelayRouter({ sources: [descriptor], relayFetch: async () => new Response('zipbytes', { status: 200,
            headers: { 'content-type': 'application/zip', 'content-length': '8', etag: '"stable"' } }) });
        const response = await invokeRelayHandler(router, descriptor.id, { url: descriptor.endpoint });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-length']).toBe('8');
        expect(Buffer.concat(response.chunks).toString()).toBe('zipbytes');
    });

    it('rejects an over-limit declared snapshot length and cancels the upstream body', async () => {
        const descriptor = { id: 'test-shapefile-small-cap', adapter: 'shapefile-snapshot', endpoint: 'https://files.example/parcels.zip',
            snapshotFormat: 'shapefile-zip', maxSnapshotBytes: 8 };
        let cancelled = false;
        const router = createParcelProviderRelayRouter({ sources: [descriptor], relayFetch: async () => new Response(new ReadableStream({
            cancel() { cancelled = true; }
        }), { status: 200, headers: { 'content-length': '9' } }) });
        const response = await invokeRelayHandler(router, descriptor.id, { url: descriptor.endpoint });
        expect(response.statusCode).toBe(502);
        expect(cancelled).toBe(true);
    });

    it('forwards a Location only for explicit manual redirects that pass the source allowlist', async () => {
        const descriptor = { id: 'in-kl-test', adapter: 'kerala-entebhoomi', endpoint: 'https://entebhoomi.kerala.gov.in/web/ilms/map', locationCode: '123456' };
        const redirectResponse = () => new Response(null, { status: 302, headers: { location: 'https://entebhoomi.kerala.gov.in/web/ilms/map/view' } });
        const router = createParcelProviderRelayRouter({ sources: [descriptor], relayFetch: request => fetchParcelProviderRelay(request, {
            providerFetch: async () => redirectResponse()
        }) });
        const manual = await invokeRelayHandler(router, descriptor.id, { url: descriptor.endpoint, redirect: 'manual' });
        expect(manual.statusCode).toBe(200);
        expect(manual.headers.location).toBeUndefined();
        expect(manual.headers['x-parcel-upstream-status']).toBe('302');
        expect(manual.headers['x-parcel-upstream-location']).toBe('https://entebhoomi.kerala.gov.in/web/ilms/map/view');
        const noFollow = await invokeRelayHandler(createParcelProviderRelayRouter({ sources: [descriptor], relayFetch: request => fetchParcelProviderRelay(request, {
            providerFetch: async () => redirectResponse()
        }) }), descriptor.id, { url: descriptor.endpoint });
        expect(noFollow.statusCode).toBe(302);
        expect(noFollow.headers.location).toBeUndefined();
        const errorRouter = createParcelProviderRelayRouter({ sources: [descriptor], relayFetch: request => fetchParcelProviderRelay(request, {
            providerFetch: async () => redirectResponse()
        }) });
        const errorMode = await invokeRelayHandler(errorRouter, descriptor.id, { url: descriptor.endpoint, redirect: 'error' });
        expect(errorMode.statusCode).toBe(502);
        const unsafeRouter = createParcelProviderRelayRouter({ sources: [descriptor], relayFetch: request => fetchParcelProviderRelay(request, {
            providerFetch: async () => new Response(null, { status: 302, headers: { location: 'https://entebhoomi.kerala.gov.in/admin' } })
        }) });
        const unsafe = await invokeRelayHandler(unsafeRouter, descriptor.id, { url: descriptor.endpoint, redirect: 'manual' });
        expect(unsafe.statusCode).toBe(403);
        expect(unsafe.headers.location).toBeUndefined();
    });

    it('follows regular provider redirects only after validating each destination against the source', async () => {
        const descriptor = { id: 'in-kl-test', adapter: 'kerala-entebhoomi', endpoint: 'https://entebhoomi.kerala.gov.in/web/ilms/map', locationCode: '123456' };
        const seen = [];
        const validated = validateParcelProviderRelayRequest(descriptor.id, { url: descriptor.endpoint, redirect: 'follow' }, { sources: [descriptor] });
        const response = await fetchParcelProviderRelay(validated, { providerFetch: async target => {
            seen.push(target.href);
            return seen.length === 1 ? new Response(null, { status: 302, headers: { location: '/web/taluk/gid?districtId=12' } })
                : new Response('ok', { status: 200 });
        } });
        expect(seen).toEqual([descriptor.endpoint, 'https://entebhoomi.kerala.gov.in/web/taluk/gid?districtId=12']);
        expect(await response.text()).toBe('ok');
        const unsafe = validateParcelProviderRelayRequest(descriptor.id, { url: descriptor.endpoint, redirect: 'follow' }, { sources: [descriptor] });
        await expect(fetchParcelProviderRelay(unsafe, { providerFetch: async () => new Response(null, { status: 302,
            headers: { location: 'https://127.0.0.1/admin' } }) })).rejects.toMatchObject({ status: 403 });
    });

    it('limits active fetches and rejects excess work with a retry hint', async () => {
        process.env.OSS_PUBLIC_ACCESS_TOKEN = 'server-secret';
        let finishFirst;
        const relayFetch = vi.fn(() => new Promise(resolve => { finishFirst = resolve; }));
        const router = createParcelProviderRelayRouter({ sources: [dgu], relayFetch, maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 100 });
        const first = invokeRelayHandler(router, dgu.id, { url: `${dgu.endpoint}?service=WFS&token=browser-relay` });
        await Promise.resolve(); await Promise.resolve();
        const second = await invokeRelayHandler(router, dgu.id, { url: `${dgu.endpoint}?service=WFS&token=browser-relay` });
        expect(second.statusCode).toBe(503);
        expect(second.headers['retry-after']).toBe('5');
        finishFirst(new Response('ok', { status: 200 }));
        expect((await first).statusCode).toBe(200);
    });

    it('rejects invalid sources before calling the transport', async () => {
        const relayFetch = vi.fn();
        const router = createParcelProviderRelayRouter({ sources: [dgu], relayFetch });
        const response = await invokeRelayHandler(router, 'not-a-source', { url: 'https://example.org/' });
        expect(response.statusCode).toBe(404);
        expect(relayFetch).not.toHaveBeenCalled();
    });
});
