#!/usr/bin/env node
// Assemble a portable traffic simulator package from the app checkout and a canonical topology HEAD.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ASSETS = [
    ['frontend/js/reduced-motion.js', 'frontend/traffic/assets/reduced-motion.js'],
    ['frontend/js/corridor-profile.js', 'frontend/traffic/assets/corridor-profile.js']
];
const TOPOLOGY_FILES = [
    'frontend/js/lane-topology-graph.js',
    'frontend/js/lane-topology-view.js',
    'frontend/js/lane-topology-junction-rules.js',
    'frontend/js/lane-topology-decisions.js',
    'frontend/js/lane-topology-restrictions.js',
    'frontend/js/lane-width-provenance.js',
    'frontend/js/corridor-profile.js',
    'frontend/js/osm-profile.js',
    'frontend/js/corridor-lane-topology.js',
    'backend/scripts/lib/stored-solutions.js'
];
const STORED_SOLUTIONS_PATH = 'backend/scripts/lib/stored-solutions.js';
const STORED_SOLUTIONS_EXPORTS = ['isUnsafeComparedWithParent', 'nodesWithMissingIncomingAssignments'];
const BACKEND_FILES = [
    ['backend/traffic/network-source.mjs', 'backend/traffic/network-source.mjs'],
    ['backend/routes/traffic-simulator.js', 'backend/routes/traffic-simulator.js'],
    ['backend/scripts/lib/traffic-snapshot.mjs', 'backend/scripts/lib/traffic-snapshot.mjs'],
    ['backend/scripts/serve-traffic-simulator.mjs', 'backend/scripts/serve-traffic-simulator.mjs']
];
const TRAFFIC_FILE_EXTENSIONS = new Set(['.html', '.css', '.js', '.svg', '.png', '.txt', '.xml', '.md']);
const LEAFLET_SOURCE = 'frontend/vendor/leaflet-1.9.4';

function usage() {
    return 'Usage: node backend/scripts/build-traffic-release.mjs --topology-root <canonical-checkout> --output <new-package-directory>';
}

function parseArgs(argv) {
    const values = new Map();
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!['--topology-root', '--output'].includes(key) || values.has(key)) {
            throw new Error(`Unknown or repeated option: ${key}\n${usage()}`);
        }
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}\n${usage()}`);
        values.set(key, value);
    }
    for (const key of ['--topology-root', '--output']) {
        if (!values.has(key)) throw new Error(`Missing required option ${key}\n${usage()}`);
    }
    return { topologyRoot: values.get('--topology-root'), output: values.get('--output') };
}

function runGit(cwd, args, label) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        const detail = result.error?.message || result.stderr.trim() || 'git command failed';
        throw new Error(`${label}: ${detail}`);
    }
    return result.stdout.trim();
}

function readGitFile(root, commit, path) {
    const result = spawnSync('git', ['-C', root, 'show', `${commit}:${path}`], { encoding: null });
    if (result.error || result.status !== 0) {
        const detail = result.error?.message || result.stderr?.toString('utf8').trim() || 'file is absent from that commit';
        throw new Error(`Canonical topology file ${path} is unavailable at HEAD ${commit}: ${detail}`);
    }
    return result.stdout;
}

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

function exportStoredSolutionHelpers(data) {
    const source = data.toString('utf8');
    for (const name of STORED_SOLUTIONS_EXPORTS) {
        const definition = new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
        const declarationExport = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:(?:async\\s+)?function|class|const|let|var)\\s+${name}\\b`);
        const exportList = [...source.matchAll(/\bexport\s*\{([^}]*)\}/gs)]
            .some(([, list]) => list.split(',').some(item => item.trim().split(/\s+as\s+/).some(token => token.trim() === name)));
        if (!definition.test(source)) throw new Error(`Canonical stored-solutions.js no longer defines ${name} at top level.`);
        if (declarationExport.test(source) || exportList) throw new Error(`Canonical stored-solutions.js already exports ${name}; remove the package adapter.`);
    }
    return Buffer.from(`${source.trimEnd()}\n\nexport { ${STORED_SOLUTIONS_EXPORTS.join(', ')} };\n`);
}

function isAtOrInside(path, root) {
    const rel = relative(root, path);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function overlaps(pathA, pathB) {
    return isAtOrInside(pathA, pathB) || isAtOrInside(pathB, pathA);
}

async function resolveOutputPath(rawOutput, appRoot, topologyRoot) {
    const requested = resolve(rawOutput);
    const parent = await realpath(dirname(requested)).catch(() => {
        throw new Error('The output parent directory must already exist.');
    });
    const output = resolve(parent, requested.slice(dirname(requested).length + 1));
    const forbidden = [
        appRoot,
        topologyRoot,
        '/root',
        '/home',
        '/Users',
        process.env.HOME ? resolve(process.env.HOME) : null
    ].filter(Boolean);
    if (output === '/' || forbidden.some(root => overlaps(output, root))) {
        throw new Error('Choose a new output directory outside the app checkout, topology checkout, and home directories.');
    }
    return output;
}

async function listTrafficFiles() {
    const dir = join(APP_ROOT, 'frontend/traffic');
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.isFile() && TRAFFIC_FILE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map(entry => entry.name)
        .sort();
    if (!files.includes('index.html') || !files.includes('traffic.css')) {
        throw new Error('The traffic frontend is missing index.html or traffic.css.');
    }
    return files.map(name => [`frontend/traffic/${name}`, `frontend/traffic/${name}`]);
}

async function walkAssetFiles(sourceDir, targetPrefix) {
    const result = [];
    async function walk(current, target) {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const source = join(current, entry.name);
            const output = `${target}/${entry.name}`;
            if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in release assets: ${relative(APP_ROOT, source)}`);
            if (entry.isDirectory()) await walk(source, output);
            else if (entry.isFile()) result.push([relative(APP_ROOT, source), output]);
            else throw new Error(`Unsupported file type in release assets: ${relative(APP_ROOT, source)}`);
        }
    }
    await walk(sourceDir, targetPrefix);
    if (!result.length) throw new Error(`No release assets found in ${relative(APP_ROOT, sourceDir)}.`);
    return result;
}

async function assertRegularFile(path) {
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Required release source is missing or not a regular file: ${relative(APP_ROOT, path)}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const appRoot = await realpath(APP_ROOT);
    const topologyRoot = await realpath(resolve(args.topologyRoot)).catch(() => {
        throw new Error('The --topology-root must name an existing canonical checkout.');
    });
    const output = await resolveOutputPath(args.output, appRoot, topologyRoot);

    const appCommitSha = runGit(appRoot, ['rev-parse', 'HEAD'], 'Cannot resolve the current app commit');
    const topologyCommitSha = runGit(topologyRoot, ['rev-parse', 'HEAD'], 'Cannot resolve the canonical topology commit');
    const packageJson = JSON.parse(await readFile(join(appRoot, 'backend/package.json'), 'utf8'));
    const dependencies = Object.fromEntries(['dotenv', 'express', 'pg'].map(name => {
        const version = packageJson.dependencies?.[name];
        if (typeof version !== 'string' || !version) throw new Error(`backend/package.json has no runtime dependency version for ${name}.`);
        return [name, version];
    }));

    const trafficFiles = await listTrafficFiles();
    const leafletFiles = await walkAssetFiles(join(appRoot, LEAFLET_SOURCE), 'frontend/traffic/assets/leaflet');
    const copyFiles = [...trafficFiles, ...APP_ASSETS, ...leafletFiles, ...BACKEND_FILES];
    const sourcePaths = new Set();
    for (const [sourceRel] of copyFiles) {
        if (sourcePaths.has(sourceRel)) throw new Error(`Duplicate release source: ${sourceRel}`);
        sourcePaths.add(sourceRel);
        await assertRegularFile(join(appRoot, sourceRel));
    }

    const topologyFiles = TOPOLOGY_FILES.map(path => ({ path, data: readGitFile(topologyRoot, topologyCommitSha, path) }));
    const packagedTopologyFiles = topologyFiles.map(file => ({
        ...file,
        packagedData: file.path === STORED_SOLUTIONS_PATH ? exportStoredSolutionHelpers(file.data) : file.data
    }));
    try {
        await mkdir(output);
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('The output directory already exists; choose a new directory to avoid overwriting files.');
        throw error;
    }

    const packaged = new Map();
    async function writePackageFile(path, data) {
        if (packaged.has(path)) throw new Error(`Duplicate release destination: ${path}`);
        const destination = join(output, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, data);
        packaged.set(path, sha256(data));
    }
    async function copyPackageFile(sourceRel, targetRel) {
        const data = await readFile(join(appRoot, sourceRel));
        await writePackageFile(targetRel, data);
    }

    for (const [sourceRel, targetRel] of copyFiles) await copyPackageFile(sourceRel, targetRel);
    for (const { path, packagedData } of packagedTopologyFiles) {
        await writePackageFile(`topology/${path}`, packagedData);
    }

    await writePackageFile('topology/package.json', JSON.stringify({
        name: 'traffic-topology-runtime', private: true, type: 'commonjs'
    }, null, 2) + '\n');
    await writePackageFile('topology/backend/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
    await writePackageFile('backend/package.json', JSON.stringify({
        name: 'traffic-simulator-runtime', private: true, type: 'module', dependencies
    }, null, 2) + '\n');

    const storedSolutions = await import(pathToFileURL(join(output, `topology/${STORED_SOLUTIONS_PATH}`)).href);
    for (const name of STORED_SOLUTIONS_EXPORTS) {
        if (typeof storedSolutions[name] !== 'function') {
            throw new Error(`Packaged stored-solutions.js does not expose callable ${name}.`);
        }
    }
    const unsafeCheck = storedSolutions.isUnsafeComparedWithParent({}, {});
    const missingNodes = storedSolutions.nodesWithMissingIncomingAssignments({});
    if (typeof unsafeCheck !== 'boolean' || !(missingNodes instanceof Set)) {
        throw new Error('Packaged stored-solutions.js helpers returned unexpected values for empty graphs.');
    }

    const manifest = {
        schemaVersion: 1,
        appCommitSha,
        canonicalTopology: {
            commitSha: topologyCommitSha,
            files: topologyFiles.map(({ path, data }) => ({ path, sha256: sha256(data) }))
        },
        releaseFiles: [...packaged].sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => ({ path, sha256: hash }))
    };
    await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Built traffic release package (${packaged.size} files plus release-manifest.json).`);
}

main().catch(error => {
    console.error(`Traffic release package failed: ${error.message}`);
    process.exitCode = 1;
});
