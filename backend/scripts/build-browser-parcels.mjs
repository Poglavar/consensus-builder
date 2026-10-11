// Build the shared provider adapters into static worker assets; Node-only disk I/O never ships.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildBrowserParcels({ outdir = resolve(root, 'frontend/assets/parcel-adapters') } = {}) {
    const outputDir = resolve(root, outdir);
    const result = await build({ absWorkingDir: root, entryPoints: [resolve(root, 'backend/parcels/browser-worker.js')],
        outdir: outputDir, entryNames: 'worker', chunkNames: 'chunks/[name]-[hash]', bundle: true, platform: 'browser',
        format: 'esm', splitting: true, minify: true, target: ['es2022'], legalComments: 'external',
        define: { 'process.env.NODE_ENV': '"production"' },
        banner: { js: '// Generated shared parcel worker asset; rebuild with npm run build:parcels:browser.' },
        metafile: true, plugins: [{ name: 'browser-snapshot-storage', setup(builder) {
            builder.onResolve({ filter: /disk-geojson-snapshot-source\.js$/ }, () => ({ path: resolve(root, 'backend/parcels/browser-disk-snapshot.js') }));
        } }] });
    const outputs = new Set(Object.keys(result.metafile.outputs).map(path => resolve(root, path)));
    // Only this builder's generated names are retired; unrelated output-directory files stay.
    for (const directory of [outputDir, resolve(outputDir, 'chunks')]) {
        let files;
        try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const name of files) {
            if (!/^(?:worker|chunk-[A-Z0-9]+|hmlr-browser-source-[A-Z0-9]+)\.js(?:\.LEGAL\.txt)?$/.test(name)) continue;
            const path = resolve(directory, name);
            if (!outputs.has(path)) await unlink(path);
        }
    }
    return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = await buildBrowserParcels();
    console.log(`Built ${Object.keys(output.metafile.outputs).length} static parcel worker assets.`);
}
