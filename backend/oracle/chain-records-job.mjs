#!/usr/bin/env node
// CLI of the chain watcher (chain-records.js): lists the design and plan records minted on the EVM
// chains' RecordRegistry, fetches each record's content from public IPFS, verifies it against its
// CID and imports what the index does not hold (designs bound with their city's parcel source,
// chain/design-parcel-source.js; then plans whose member designs are indexed). Dry run unless
// --apply. --once runs one pass and exits; without it a pass runs every --interval seconds.
// Restartable and idempotent: every pass re-derives the work from the chains and the index, and an
// indexed CID is never written again. Applied passes write the run-stats artifact
// (CHAIN_RECORDS_RUN_STATS).

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { createPool } from '../db/connection.cjs';
import { readAdapter, normalizeChainId, CHAINS } from '../chain/evm.js';
import { designParcelSourceId } from '../chain/design-parcel-source.js';
import { indexDesign } from '../routes/designs.js';
import { indexPlan } from '../routes/plans.js';
import { writeRunStatsAtomic } from '../operations/run-stats.js';
import { createThumbnailQueue } from '../thumbnails/thumbnail-queue.js';
import { buildChainRecordsRunStats, syncChainRecords } from './chain-records.js';

const require = createRequire(import.meta.url);
const IpfsRead = require('../../frontend/js/chain/ipfs-read.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INTERVAL_SECONDS = 600;
const DEFAULT_CHAINS = '84532';
const log = message => console.log(`[${new Date().toISOString()}] [chain-records] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node oracle/chain-records-job.mjs (--once | --apply) [options]',
        '',
        '  --once              One pass, then exit (exit code 1 when the pass fails).',
        '  --apply             Write: import the retrievable records into consensus.design and consensus.plan.',
        '                      Without it the pass is a dry run that reads the chains and IPFS and writes nothing.',
        `  --interval <s>      Seconds between passes when not --once (default ${DEFAULT_INTERVAL_SECONDS}).`,
        `  --chains <ids>      Comma-separated chain ids (default EVM_WATCH_CHAIN_IDS, else ${DEFAULT_CHAINS}); known: ${Object.keys(CHAINS).join(', ')}.`,
        '  --help              This text.',
        '',
        'Examples:',
        '  node oracle/chain-records-job.mjs --once                          # dry run on Base Sepolia',
        '  node oracle/chain-records-job.mjs --once --apply --chains 84532,11155111',
        '',
        'Env (backend/.env): DATABASE_URL, EVM_WATCH_CHAIN_IDS, EVM_RPC_URL_<chainId> (a public RPC by default),',
        'CHAIN_RECORDS_RUN_STATS (run-stats file, default logs/chain-records-stats.json; written by --apply passes).'
    ].join('\n'));
    process.exit(code);
}

function options() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                once: { type: 'boolean' },
                apply: { type: 'boolean' },
                interval: { type: 'string' },
                chains: { type: 'string' },
                help: { type: 'boolean' }
            }
        }));
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (values.help) usage(0);
    if (!values.once && !values.apply) usage(2);
    if (values.once && values.interval !== undefined) throw new Error('--interval is for repeated passes; drop --once or --interval');
    const interval = values.interval === undefined ? DEFAULT_INTERVAL_SECONDS : Number(values.interval);
    if (!Number.isInteger(interval) || interval < 10) throw new Error(`--interval must be whole seconds, at least 10; got ${values.interval}`);
    return { once: Boolean(values.once), apply: Boolean(values.apply), interval, chains: values.chains };
}

function chainIds(raw) {
    const ids = String(raw).split(',').map(value => value.trim()).filter(Boolean).map(value => {
        const id = normalizeChainId(value);
        if (!id || !CHAINS[id]) throw new Error(`unknown chain id ${value} (known: ${Object.keys(CHAINS).join(', ')})`);
        return id;
    });
    if (!ids.length) throw new Error('no chain ids to watch');
    return [...new Set(ids)];
}

async function main() {
    const opts = options();
    dotenv.config({ path: path.join(HERE, '..', '.env'), quiet: true });
    const ids = chainIds(opts.chains || process.env.EVM_WATCH_CHAIN_IDS || DEFAULT_CHAINS);
    const chains = ids.map(id => readAdapter(id, { env: process.env, log: line => console.log(line) }));
    const statsPath = process.env.CHAIN_RECORDS_RUN_STATS || path.resolve(process.cwd(), 'logs/chain-records-stats.json');
    const pool = createPool();
    pool.on('error', error => log(`idle pg client error: ${error.message}`));
    log(`${opts.apply ? 'APPLY' : 'DRY RUN'} on ${chains.map(chain => `${chain.name} (${chain.chainId})`).join(', ')}${opts.once ? ', one pass' : `, a pass every ${opts.interval}s`}`);

    // An imported design gets its thumbnail like one posted to the API; a pass waits for them before it ends.
    const thumbnailQueue = createThumbnailQueue();
    const deps = {
        pool, chains, log,
        fetchContent: (cid, schema) => IpfsRead.fetchObject(cid, { schema, fetchImpl: globalThis.fetch }),
        // The design's city decides its parcel source, as the browser's publication does.
        indexDesign: ({ cid, content }) => indexDesign(pool, { thumbnailQueue }, { cid, content }, { parcelSourceId: designParcelSourceId(content) }),
        indexPlan: ({ cid, content }) => indexPlan(pool, { cid, content })
    };

    async function pass() {
        const startedAt = new Date().toISOString();
        let result = null;
        let error = null;
        try {
            result = await syncChainRecords({ ...deps, apply: opts.apply });
        } catch (caught) {
            error = caught;
            log(`pass FAILED: ${caught.stack || caught.message}`);
        }
        if (thumbnailQueue.size) log(`waiting for ${thumbnailQueue.size} thumbnail render(s)`);
        await thumbnailQueue.onIdle();
        const failed = Boolean(error) || Boolean(result?.errors?.length);
        if (result?.skipped?.length) log(`${result.skipped.length} record(s) skipped: ${result.skipped.slice(0, 5).map(item => `${item.kind} ${item.cid} ${item.reason}`).join('; ')}${result.skipped.length > 5 ? '; ...' : ''}`);
        if (opts.apply) {
            const stats = buildChainRecordsRunStats({ startedAt, endedAt: new Date().toISOString(), result, error, dryRun: false, chains: ids });
            try {
                writeRunStatsAtomic(statsPath, stats);
            } catch (writeError) {
                log(`run-stats write failed: ${writeError.stack || writeError.message}`);
                return 1;
            }
        }
        return failed ? 1 : 0;
    }

    if (opts.once) {
        try {
            process.exitCode = await pass();
        } finally {
            await pool.end();
        }
        return;
    }

    // Repeated passes: the next starts `interval` seconds after the previous one ended, so passes never
    // overlap; SIGINT/SIGTERM stop between passes or cut the wait short.
    let stopping = false;
    let timer = null;
    let wake = null;
    const stop = signal => {
        log(`${signal}: stopping after the current pass`);
        stopping = true;
        clearTimeout(timer);
        wake?.();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    while (!stopping) {
        const code = await pass();
        if (code) process.exitCode = code;
        if (stopping) break;
        await new Promise(resolve => {
            wake = resolve;
            timer = setTimeout(resolve, opts.interval * 1000);
        });
    }
    await pool.end();
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] [chain-records] failed: ${error.stack || error.message}`);
    process.exit(1);
});
