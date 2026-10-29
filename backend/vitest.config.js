import { configDefaults, defineConfig } from 'vitest/config';
import { cpus } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ledger = createRequire(import.meta.url)('../scripts/lib/test-run-ledger.cjs');

// Worker cap. Vitest defaults to one worker per core, and each of ours boots a full express app,
// so on a developer machine that is also running a browser the suite oversubscribes the CPU and
// starts losing races: 1-2 tests failed per run, a DIFFERENT 1-2 each time (ens-gateway+ens-route
// one run, parcels+proposals the next), every one of them passing when run on its own. Nothing was
// order-dependent — the same suite run with --no-file-parallelism passed 1944/1944.
//
// Measured on this 8-core laptop (2026-08-08), same commit, three runs each:
//   default (8 workers)  70-188 s, flaky
//   maxWorkers 4         31-42 s,  3/3 green
//   no parallelism       260 s,    green
// Halving the workers made it both stable AND 2-4x faster, because the thrashing was costing more
// than the concurrency won. Half the cores is the rule: leave the other half for the OS, the
// browser, and whatever else the machine is doing.
//
// Raise or lower with VITEST_MAX_WORKERS. If a flake ever survives this, fall back to a run with
// --no-file-parallelism, which is the deterministic (and slow) configuration.
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS)
    || Math.max(2, Math.floor((cpus()?.length || 4) / 2));

// Named runs (TEST_RUN=<name>) record each finished file and skip the recorded ones on a rerun, so a
// killed run continues instead of starting over. See docs/development.md.
const testRun = ledger.runName();
const finishedFiles = testRun
    ? [...ledger.finishedIds(ledger.readLedger(ledger.ledgerFile(path.dirname(fileURLToPath(import.meta.url)), testRun, 'vitest')))]
    : [];

export default defineConfig({
    test: {
        include: ['test/**/*.test.js'],
        // Native node:test suites have their own runner in npm test; importing them here
        // executes their callbacks outside Vitest and leaves an empty Vitest suite.
        exclude: [...configDefaults.exclude, 'test/**/*.node.test.js', ...finishedFiles],
        ...(testRun && {
            reporters: ['default', './test/helpers/run-ledger-vitest-reporter.js'],
            // A continued run whose files all finished has nothing left to run; that is not an error.
            passWithNoTests: true,
        }),
        maxWorkers,
        // supertest requests reach the server they started, not whatever else holds 127.0.0.1 on that port.
        setupFiles: ['test/helpers/supertest-bound-address.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            reportsDirectory: './coverage',
            include: ['index.js', 'routes/**/*.js', 'utils/**/*.js'],
            exclude: ['test/**', 'uploads/**']
        }
    },
});
