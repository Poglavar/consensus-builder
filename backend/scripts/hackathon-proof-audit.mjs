#!/usr/bin/env node
// One-command, read-only verification of the public evidence used by the judge demo.

import { auditHackathonProof } from '../agents/hackathon-proof-audit.js';

function usage(code = 0) {
    console.log([
        'Audit the public Hyperstition hackathon proof.',
        '',
        'Usage: node scripts/hackathon-proof-audit.mjs [options]',
        '  --url <backend>        Default: https://api.urbangametheory.xyz',
        '  --max-age-hours <n>    Freshness window for the daily proposer (default: 48)',
        '  --json                 Print the complete machine-readable result',
        '  --open-ground          Also run the advisory open-ground audit: v3 proposal accounts against',
        '                         their published records (needs PG* env and SOLANA_RPC_URL; read-only)',
        '  --help'
    ].join('\n'));
    process.exit(code);
}

function argsOf(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help') usage(0);
        if (token === '--json') { args.json = true; continue; }
        if (token === '--open-ground') { args.openGround = true; continue; }
        if (!['--url', '--max-age-hours'].includes(token) || !argv[index + 1]) usage(2);
        args[token.slice(2)] = argv[index + 1];
        index += 1;
    }
    const maxRunAgeHours = args['max-age-hours'] === undefined ? 48 : Number(args['max-age-hours']);
    if (!Number.isFinite(maxRunAgeHours) || maxRunAgeHours <= 0) usage(2);
    return { baseUrl: args.url, maxRunAgeHours, json: Boolean(args.json), openGround: Boolean(args.openGround) };
}

// The open-ground audit reads the proposal table and the chain, so it is loaded only on request.
async function openGroundRunner() {
    const dotenv = await import('dotenv');
    dotenv.config({ quiet: true });
    const { default: pg } = await import('pg');
    const { Connection } = await import('@solana/web3.js');
    const { runOpenGroundAudit } = await import('../oracle/open-ground-audit.js');
    const pool = new pg.Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    return {
        run: () => runOpenGroundAudit({ pool, connection }),
        close: () => pool.end()
    };
}

const args = argsOf(process.argv.slice(2));
const openGround = args.openGround ? await openGroundRunner() : null;
try {
    const result = await auditHackathonProof({ ...args, openGroundAudit: openGround?.run ?? null });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(`Hyperstition public proof: ${result.status.toUpperCase()}`);
        for (const item of result.checks) {
            const mark = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✗';
            console.log(`${mark} ${item.label}`);
        }
        console.log(`${result.summary.pass} passed · ${result.summary.warn} warning · ${result.summary.fail} failed`);
    }
    if (result.status !== 'verified') process.exitCode = 1;
} catch (error) {
    console.error(`hackathon proof audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    await openGround?.close();
}
