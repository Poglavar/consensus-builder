#!/usr/bin/env node
// Close out the coverage tiles that are nearly finished, cheapest first.
//
// The bulk solver's `--order finish` already prefers nearly-done tiles, but only within ONE
// enumeration area — and the tiles worth closing are scattered across the whole city, so a bbox
// covering them would be most of Zagreb. This reads the coverage report, picks the tiles that are
// within a few junctions of complete, and runs the solver over each one's core in turn.
//
// Why bother: a tile is what the coverage map draws, so closing one is the unit of visible
// progress, and the arithmetic is lopsided. Ordering by size spent ~200 s and ~15,000 output
// tokens per junction on big interchanges; closing tiles measured 90 s and ~5,900, because the
// junction left over in a 98%-done tile is usually a small one. One took a 109-junction tile from
// 99% to done in 23 seconds.
//
//   node backend/scripts/finish-tiles.js --dry-run
//   node backend/scripts/finish-tiles.js --provider codex --model gpt-5.6-sol --max-open 3
//
// Resume is by artifact, twice over: the solver skips junctions it has already solved, and a tile
// whose junctions are all solved simply reports nothing to do. Re-running after a kill is safe and
// costs only the enumeration it repeats. Long runs belong under `run-job`.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
    coverage: path.join(HERE, '../../frontend/topology/coverage.json'),
    solver: path.join(HERE, 'solve-junctions.js'),
    provider: 'codex',
    model: 'gpt-5.6-sol',
    city: 'zagreb',
    // A tile with fewer junctions than this is a field with a driveway in it; "100% done" there
    // means nothing, and it is not worth a model run to say so.
    minJunctions: 8,
    // Above this a tile is not a quick win, it is ordinary work — run the bulk solver instead.
    maxOpen: 3,
    log: null
};

const USAGE = `
Close the coverage tiles that are within a few junctions of finished.

  --coverage FILE     Coverage report to read (default frontend/topology/coverage.json).
  --tiles FILE        Process exactly these tile cores, one "W,S,E,N" per line, in this order.
                      Overrides the nearly-done filter; the coverage report is still read, to
                      recover how many junctions each tile has open.
  --max-open N        Only tiles with at most N open junctions (default ${DEFAULTS.maxOpen}).
  --min-junctions N   Ignore tiles smaller than this (default ${DEFAULTS.minJunctions}).
  --limit N           Stop after N tiles.
  --provider claude|codex   Recognition CLI (default ${DEFAULTS.provider}).
  --model NAME        Model passed to the CLI (default ${DEFAULTS.model}).
  --city NAME         City key (default ${DEFAULTS.city}).
  --log FILE          Passed through to the solver, one JSON line per junction.
  --dry-run           List the tiles and what they would cost; run nothing.

The coverage report is a snapshot. Regenerate it with topology-coverage.js after a big run, or
this will keep offering tiles that are already closed — they cost an enumeration each to discover.
`;

function parseArgs(argv) {
    const args = { ...DEFAULTS };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index + 1];
        const take = () => { index += 1; return value; };
        switch (argv[index]) {
            case '--coverage': args.coverage = take(); break;
            case '--tiles': args.tiles = take(); break;
            case '--solver': args.solver = take(); break;
            case '--max-open': args.maxOpen = Number(take()); break;
            case '--min-junctions': args.minJunctions = Number(take()); break;
            case '--limit': args.limit = Number(take()); break;
            case '--provider': args.provider = take(); break;
            case '--model': args.model = take(); break;
            case '--city': args.city = take(); break;
            case '--log': args.log = take(); break;
            case '--dry-run': args.dryRun = true; break;
            case '--help': case '-h': args.help = true; break;
            default: throw new Error(`Unknown argument "${argv[index]}".`);
        }
    }
    return args;
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = message => console.log(`[${stamp()}] ${message}`);

function clockFor(seconds) {
    const total = Math.max(0, Math.round(seconds));
    return `${String(Math.floor(total / 3600)).padStart(2, '0')}:`
        + `${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:`
        + `${String(total % 60).padStart(2, '0')}`;
}

// Nearly-done tiles, cheapest first: fewest open junctions, and among those the biggest tile,
// because closing a 109-junction tile is worth more on the map than closing a 9-junction one.
export function tilesToFinish(coverage, args) {
    return (coverage.tiles || [])
        .filter(tile => tile.junctions >= args.minJunctions
            && tile.open > 0
            && tile.open <= args.maxOpen)
        .sort((a, b) => a.open - b.open || b.junctions - a.junctions)
        .slice(0, args.limit || undefined);
}

// An explicit list of tile cores, in the caller's own order. "Nearly done" is one way to choose
// tiles worth running; "outside the ring road" and "this district" are others, and none of them
// belong in here — the selection is a question about the map, this script is the thing that grinds
// through whatever was selected. The coverage report still supplies each tile's open count, which
// is what sets the per-tile limit.
export function tilesFromList(coverage, listing, args) {
    const known = new Map((coverage.tiles || []).map(tile => [tile.core.join(','), tile]));
    const missing = [];
    const tiles = listing.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const core = line.split(',').map(Number);
        if (core.length !== 4 || core.some(value => !Number.isFinite(value))) {
            throw new Error(`"${line}" is not a W,S,E,N tile core.`);
        }
        const match = known.get(core.map(value => Number(value.toFixed(6))).join(','))
            || known.get(line);
        if (!match) missing.push(line);
        // A tile the report has never seen still runs; it just cannot say how much is open, so it
        // gets the default budget rather than a tailored one.
        return match || { core, open: args.maxOpen, junctions: 0, done: 0, unknown: true };
    }).slice(0, args.limit || undefined);
    return { tiles, missing };
}

// One solver run over one tile core. Resolves with what it managed, never rejects: a tile that
// fails must not take the other sixty-eight with it.
function solveTile(args, tile) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [
            args.solver,
            '--bbox', tile.core.join(','),
            '--city', args.city,
            '--provider', args.provider,
            '--model', args.model,
            '--order', 'finish',
            // Slack over the reported count: the coverage snapshot may be a little behind the
            // graph, and a tile is only closed if everything open in it is run.
            '--limit', String(tile.open + 2),
            ...(args.log ? ['--log', args.log] : [])
        ], { cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'] });

        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('close', code => {
            const solved = Number((output.match(/done: (\d+) solved/) || [])[1] || 0);
            const failed = Number((output.match(/done: \d+ solved, (\d+) failed/) || [])[1] || 0);
            const nothing = /; 0 need recognition/.test(output);
            resolve({ code, solved, failed, nothing, output });
        });
        child.on('error', error => resolve({ code: 1, solved: 0, failed: 1, nothing: false,
            output: String(error.message) }));
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !process.argv.slice(2).length) {
        console.log(USAGE);
        return 0;
    }
    const coverage = JSON.parse(readFileSync(args.coverage, 'utf8'));
    let tiles;
    if (args.tiles) {
        const listed = tilesFromList(coverage, readFileSync(args.tiles, 'utf8'), args);
        tiles = listed.tiles;
        if (listed.missing.length) {
            log(`WARNING: ${listed.missing.length} listed tiles are not in the coverage report; `
                + `running them on the default budget of ${args.maxOpen}`);
        }
        log(`${tiles.length} tiles from ${path.resolve(args.tiles)}, `
            + `${tiles.reduce((total, tile) => total + tile.open, 0)} junctions open in them`);
    } else {
        tiles = tilesToFinish(coverage, args);
        const junctions = tiles.reduce((total, tile) => total + tile.open, 0);
        log(`${tiles.length} tiles within ${args.maxOpen} junction${args.maxOpen === 1 ? '' : 's'} of `
            + `finished, ${junctions} junctions to close them`);
    }
    log(`coverage snapshot: ${path.resolve(args.coverage)}`);

    if (args.dryRun) {
        tiles.forEach(tile => log(`  ${tile.open} open · ${String(tile.junctions).padStart(3)} junctions`
            + ` · ${(100 * tile.done).toFixed(0)}% done · ${tile.core.join(',')}`));
        return 0;
    }

    const startedAt = Date.now();
    let closed = 0;
    let solvedTotal = 0;
    let failedTiles = 0;
    let alreadyDone = 0;
    for (const [index, tile] of tiles.entries()) {
        const result = await solveTile(args, tile);
        solvedTotal += result.solved;
        if (result.failed || result.code !== 0) failedTiles += 1;
        else if (result.nothing) alreadyDone += 1;
        else if (result.solved) closed += 1;

        const done = index + 1;
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = done ? (elapsed / done) * (tiles.length - done) : 0;
        log(`tile ${done}/${tiles.length} · ${Math.round(100 * done / tiles.length)}%`
            + ` · ${result.nothing ? 'already closed' : `${result.solved} solved`}`
            + `${result.failed ? `, ${result.failed} FAILED` : ''}`
            + ` · ${closed} tiles closed, ${solvedTotal} junctions`
            + ` · ETA ${clockFor(eta)}`);
        if (result.failed || result.code !== 0) {
            log(`  tile ${tile.core.join(',')} did not finish cleanly:`);
            result.output.split('\n').filter(line => /FAILED|fatal|Error/.test(line))
                .slice(0, 3).forEach(line => log(`    ${line.trim()}`));
        }
    }

    log(`done: ${closed} tiles closed, ${solvedTotal} junctions solved, `
        + `${alreadyDone} already closed, ${failedTiles} tiles with failures, `
        + `${Math.round((Date.now() - startedAt) / 60000)} min`);
    if (alreadyDone) {
        log(`the coverage snapshot was behind on ${alreadyDone} tiles — regenerate it with `
            + 'topology-coverage.js to stop paying an enumeration to rediscover that');
    }
    // Per-tile failures poison the verdict rather than hiding inside a "done" line.
    return failedTiles ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`[${stamp()}] fatal: ${error.message}`);
        process.exitCode = 1;
    });
}
