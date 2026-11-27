// Build the shared provider adapters into static worker assets; Node-only disk I/O never ships.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { relative, resolve, dirname, join } from 'node:path';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function buildBrowserParcels({ outdir = resolve(root, 'frontend/assets/parcel-adapters') } = {}) {
    const outputDir = resolve(root, outdir);
    const result = await build({ absWorkingDir: root, entryPoints: [resolve(root, 'backend/parcels/browser-worker.js')],
        outdir: outputDir, write: false, entryNames: 'worker', chunkNames: 'chunks/[name]-[hash]', bundle: true, platform: 'browser',
        // Keep dependency identities relative to this checkout when node_modules is shared by
        // symlink between worktrees; otherwise identical chunks acquire different file names.
        format: 'esm', splitting: true, minify: true, target: ['es2022'], legalComments: 'external', preserveSymlinks: true,
        // The shared frontend modules the binding uses (site-binding.js and its helpers) require turf
        // as the backend does; frontend/ has no node_modules of its own.
        nodePaths: [resolve(root, 'backend/node_modules')],
        define: { 'process.env.NODE_ENV': '"production"' },
        banner: { js: '// Generated shared parcel worker asset; rebuild with npm run build:parcels:browser.' },
        metafile: true, plugins: [{ name: 'browser-snapshot-storage', setup(builder) {
            builder.onResolve({ filter: /disk-geojson-snapshot-source\.js$/ }, () => ({ path: resolve(root, 'backend/parcels/browser-disk-snapshot.js') }));
            builder.onResolve({ filter: /osgb36-grid-loader\.js$/ }, () => ({ path: resolve(root, 'backend/parcels/browser-osgb36-grid-loader.js') }));
        } }] });
    // Stage on the destination filesystem. Only one writer may switch the entry point and
    // retire its old chunks at a time, even if two checkouts build into the same directory.
    await mkdir(outputDir, { recursive: true });
    const stagingDir = join(outputDir, '.parcel-worker-build');
    try {
        await mkdir(stagingDir);
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Parcel build staging directory already in use: ${stagingDir}`, { cause: error });
        throw error;
    }
    try {
        const names = new Set(result.outputFiles.map(file => relative(outputDir, file.path)));
        for (const file of result.outputFiles) {
            const staged = join(stagingDir, relative(outputDir, file.path));
            await mkdir(dirname(staged), { recursive: true });
            await writeFile(staged, file.contents);
        }
        const chunksDir = join(outputDir, 'chunks');
        await mkdir(chunksDir, { recursive: true });
        for (const name of names) {
            if (name !== 'worker.js') await rename(join(stagingDir, name), join(outputDir, name));
        }
        await rename(join(stagingDir, 'worker.js'), join(outputDir, 'worker.js'));

        // chunks/[name]-[hash] is owned by this builder for every adapter and its license.
        for (const entry of await readdir(chunksDir, { withFileTypes: true })) {
            if (entry.isFile() && /-[A-Z0-9]{8}\.js(?:\.LEGAL\.txt)?$/.test(entry.name) && !names.has(join('chunks', entry.name))) {
                await rm(join(chunksDir, entry.name));
            }
        }
        if (!names.has('worker.js.LEGAL.txt')) await rm(join(outputDir, 'worker.js.LEGAL.txt'), { force: true });
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }
    return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = await buildBrowserParcels();
    console.log(`Built ${Object.keys(output.metafile.outputs).length} static parcel worker assets.`);
}
