// Guards deployable browser assets against Node dependencies and stale generated code.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import vm from 'node:vm';
import { zipSync, strToU8 } from 'fflate';
import { buildBrowserParcels } from '../scripts/build-browser-parcels.mjs';
import { OSTN15_GRID_SHA256 } from '../parcels/osgb36-projection.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import catalog from '../parcels/source-catalog.json' with { type: 'json' };

const deployed = fileURLToPath(new URL('../../frontend/assets/parcel-adapters/', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const ostn15GridPath = fileURLToPath(new URL('../parcels/grids/ostn15/OSTN15_NTv2_OSGBtoETRS.gsb', import.meta.url));
const browserGridLoader = { name: 'browser-osgb36-grid-loader', setup(builder) {
    builder.onResolve({ filter: /osgb36-grid-loader\.js$/ }, () => ({
        path: fileURLToPath(new URL('../parcels/browser-osgb36-grid-loader.js', import.meta.url))
    }));
} };

async function browserGridResponse(url) {
    const expectedUrl = `/assets/parcel-adapters/grids/${OSTN15_GRID_SHA256}.gsb`;
    if (!String(url).includes(expectedUrl)) return null;
    const bytes = await readFile(ostn15GridPath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer };
}

function browserGridFetch(context, onGridLoaded = () => {}) {
    return async url => {
        const response = await browserGridResponse(url);
        if (!response) return { ok: false, status: 404 };
        onGridLoaded();
        const source = await response.arrayBuffer();
        const vmBuffer = vm.runInContext(`new ArrayBuffer(${source.byteLength})`, context);
        new Uint8Array(vmBuffer).set(new Uint8Array(source));
        return { ok: true, status: 200, arrayBuffer: async () => vmBuffer };
    };
}
describe('static browser parcel adapters', () => {
    it('supports every registered source family and ships an exact browser build', async () => {
        expect([...new Set(catalog.sources.map(source => source.adapter))].filter(adapter => !browserParcelFactories[adapter])).toEqual([]);
        const outdir = await mkdtemp(join(tmpdir(), 'parcel-browser-build-'));
        try {
            const build = await buildBrowserParcels({ outdir });
            const gridBytes = await readFile(ostn15GridPath);
            expect(createHash('sha256').update(gridBytes).digest('hex')).toBe(OSTN15_GRID_SHA256);
            expect(await readFile(join(outdir, 'grids', `${OSTN15_GRID_SHA256}.gsb`))).toEqual(gridBytes);
            expect(Object.keys(build.metafile.outputs).some(path => path.endsWith('.gsb'))).toBe(false);
            expect(Object.keys(build.metafile.inputs).some(input => input.endsWith('hmlr-browser-source.js'))).toBe(true);
            expect(Object.keys(build.metafile.inputs).some(input => input.endsWith('disk-geojson-snapshot-source.js'))).toBe(false);
            for (const [path, output] of Object.entries(build.metafile.outputs)) {
                expect(output.imports.some(item => item.external)).toBe(false);
                const name = path.includes('/chunks/') ? `chunks/${basename(path)}` : basename(path);
                expect(resolve(projectRoot, path)).toBe(resolve(outdir, name));
                const generated = await readFile(join(outdir, name));
                expect(createHash('sha256').update(await readFile(join(deployed, name))).digest('hex')).toBe(createHash('sha256').update(generated).digest('hex'));
                if (name.endsWith('.js')) {
                    expect(generated.toString()).not.toMatch(/(?:from|import\()\s*["']node:/);
                    expect(generated.includes(gridBytes)).toBe(false);
                }
            }
        } finally { await rm(outdir, { recursive: true, force: true }); }
    }, 180000);
    it('runs the compiled WebAssembly geometry engine without Node globals', async () => {
        const output = await build({ entryPoints: [fileURLToPath(new URL('../parcels/hmlr-browser-ground.js', import.meta.url))],
            platform: 'browser', bundle: true, format: 'iife', globalName: 'BrowserGround', write: false,
            define: { 'import.meta.url': '"https://app.example/assets/hmlr.js"' }, plugins: [browserGridLoader], logLevel: 'silent' });
        let gridLoaded = false;
        let context;
        context = vm.createContext({ console, crypto: webcrypto, AbortSignal, window: {}, self: { location: { href: 'https://app.example/worker.js' } },
            TextEncoder, TextDecoder, URL, atob, btoa, setTimeout, clearTimeout });
        context.fetch = browserGridFetch(context, () => { gridLoaded = true; });
        vm.runInContext(output.outputFiles[0].text, context);
        expect(vm.runInContext('typeof process + ":" + typeof Buffer + ":" + typeof require', context)).toBe('undefined:undefined:undefined');
        const engine = await context.BrowserGround.createHmlrBrowserGroundEngine();
        const result = await engine.resolve([{ type: 'Feature', properties: { INSPIREID: '1' }, geometry: {
            type: 'Polygon', coordinates: [[[530800,180200],[530810,180200],[530810,180210],[530800,180210],[530800,180200]]] } }]);
        expect(result.features).toHaveLength(1);
        expect(result.features[0].id).toBe('GB-HMLR-BROWSER-v1-1');
        expect(gridLoaded).toBe(true);
    }, 30000);
    it('parses a real ZIP-backed GML snapshot without Node setImmediate', async () => {
        const entryPoint = fileURLToPath(new URL('../parcels/gml-snapshot-source.js', import.meta.url));
        const output = await build({ entryPoints:[entryPoint], platform:'browser', bundle:true, format:'iife',
            globalName:'BrowserGmlSnapshot', write:false, plugins:[browserGridLoader], logLevel:'silent' });
        let timerYields = 0;
        const browserSetTimeout = (callback, delay, ...args) => {
            if (delay === 0) timerYields++;
            return setTimeout(callback, delay, ...args);
        };
        let gridLoaded = false;
        const context = vm.createContext({ console, crypto:webcrypto, TextEncoder, TextDecoder, URL, AbortSignal,
            setTimeout:browserSetTimeout, clearTimeout, structuredClone });
        context.fetch = browserGridFetch(context, () => { gridLoaded = true; });
        expect(vm.runInContext('typeof setImmediate + ":" + typeof process + ":" + typeof Buffer', context)).toBe('undefined:undefined:undefined');
        vm.runInContext(output.outputFiles[0].text, context);

        const feature = id => `<w:member><l:PREDEFINED><l:INSPIREID>${id}</l:INSPIREID><l:GEOMETRY><g:Polygon srsName="EPSG:27700" srsDimension="2"><g:exterior><g:LinearRing><g:posList>530800 180200 530810 180200 530810 180210 530800 180210 530800 180200</g:posList></g:LinearRing></g:exterior></g:Polygon></l:GEOMETRY></l:PREDEFINED></w:member>`;
        const count = 320;
        const xml = `<w:FeatureCollection xmlns:w="http://www.opengis.net/wfs/2.0" xmlns:l="www.landregistry.gov.uk" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="${count}" numberReturned="${count}">${Array.from({ length:count }, (_, index) => feature(index + 1)).join('')}</w:FeatureCollection>`;
        const bytes = zipSync({ 'parcels.gml':strToU8(xml) });
        const descriptor = { id:'gb-browser-gml-test', adapter:'gml-snapshot', endpoint:'https://example.org/city.zip',
            idField:'INSPIREID', idPrefix:'GB-HMLR-TEST-', outFields:['INSPIREID'], parcelNumberField:'INSPIREID',
            maxSnapshotBytes:2_000_000, maxDecompressedBytes:2_000_000, maxSnapshotFeatures:500,
            maxFeatures:500, maxBboxKm2:25 };
        const source = context.BrowserGmlSnapshot.createGmlSnapshotParcelSource(descriptor,
            { fetchImpl:async () => new Response(bytes) });
        const result = await source.queryIds(['GB-HMLR-TEST-1']);
        expect(result.complete).toBe(true);
        expect(result.features).toHaveLength(1);
        expect(result.features[0].id).toBe('GB-HMLR-TEST-1');
        expect(timerYields).toBeGreaterThan(0);
        expect(gridLoaded).toBe(true);
    }, 30000);
});
