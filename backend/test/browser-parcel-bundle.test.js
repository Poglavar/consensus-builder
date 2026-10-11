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
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import catalog from '../parcels/source-catalog.json' with { type: 'json' };

const deployed = fileURLToPath(new URL('../../frontend/assets/parcel-adapters/', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
describe('static browser parcel adapters', () => {
    it('supports every registered source family and ships an exact browser build', async () => {
        expect([...new Set(catalog.sources.map(source => source.adapter))].filter(adapter => !browserParcelFactories[adapter])).toEqual([]);
        const outdir = await mkdtemp(join(tmpdir(), 'parcel-browser-build-'));
        try {
            const build = await buildBrowserParcels({ outdir });
            expect(Object.keys(build.metafile.inputs).some(input => input.endsWith('hmlr-browser-source.js'))).toBe(true);
            expect(Object.keys(build.metafile.inputs).some(input => input.endsWith('disk-geojson-snapshot-source.js'))).toBe(false);
            for (const [path, output] of Object.entries(build.metafile.outputs)) {
                expect(output.imports.some(item => item.external)).toBe(false);
                const name = path.includes('/chunks/') ? `chunks/${basename(path)}` : basename(path);
                expect(resolve(projectRoot, path)).toBe(resolve(outdir, name));
                const generated = await readFile(join(outdir, name));
                expect(createHash('sha256').update(await readFile(join(deployed, name))).digest('hex')).toBe(createHash('sha256').update(generated).digest('hex'));
                if (name.endsWith('.js')) expect(generated.toString()).not.toMatch(/(?:from|import\()\s*["']node:/);
            }
        } finally { await rm(outdir, { recursive: true, force: true }); }
    }, 30000);
    it('runs the compiled WebAssembly geometry engine without Node globals', async () => {
        const output = await build({ entryPoints: [fileURLToPath(new URL('../parcels/hmlr-browser-ground.js', import.meta.url))],
            platform: 'browser', bundle: true, format: 'iife', globalName: 'BrowserGround', write: false,
            define: { 'import.meta.url': '"https://app.example/assets/hmlr.js"' }, logLevel: 'silent' });
        const context = vm.createContext({ console, crypto: webcrypto, window: {}, self: { location: { href: 'https://app.example/worker.js' } },
            TextEncoder, TextDecoder, URL, atob, btoa, setTimeout, clearTimeout });
        vm.runInContext(output.outputFiles[0].text, context);
        expect(vm.runInContext('typeof process + ":" + typeof Buffer + ":" + typeof require', context)).toBe('undefined:undefined:undefined');
        const engine = await context.BrowserGround.createHmlrBrowserGroundEngine();
        const result = await engine.resolve([{ type: 'Feature', properties: { INSPIREID: '1' }, geometry: {
            type: 'Polygon', coordinates: [[[530800,180200],[530810,180200],[530810,180210],[530800,180210],[530800,180200]]] } }]);
        expect(result.features).toHaveLength(1);
        expect(result.features[0].id).toBe('GB-HMLR-BROWSER-v1-1');
    }, 30000);
    it('parses a real ZIP-backed GML snapshot without Node setImmediate', async () => {
        const entryPoint = fileURLToPath(new URL('../parcels/gml-snapshot-source.js', import.meta.url));
        const output = await build({ entryPoints:[entryPoint], platform:'browser', bundle:true, format:'iife',
            globalName:'BrowserGmlSnapshot', write:false, logLevel:'silent' });
        let timerYields = 0;
        const browserSetTimeout = (callback, delay, ...args) => {
            if (delay === 0) timerYields++;
            return setTimeout(callback, delay, ...args);
        };
        const context = vm.createContext({ console, crypto:webcrypto, TextEncoder, TextDecoder, URL, AbortSignal,
            setTimeout:browserSetTimeout, clearTimeout, structuredClone });
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
    }, 30000);
});
