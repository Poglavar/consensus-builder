#!/usr/bin/env node
// CLI for the reference lens member (backend/lens/README.md): serves the lens API on a port.
// --dry-run uses a fake SAS issuer, an in-memory attestation store and an ephemeral key, with x402
// pricing off; --live signs real SAS attestations with --keypair through sas-lib.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import pg from 'pg';
import { Keypair } from '@solana/web3.js';
import { createLensMember, DEFAULT_CREDENTIAL_NAME, systemClock } from './member.js';
import { createDevnetRegistryIdentity } from './identity/devnet-registry.js';
import { createCertiliaIdentity } from './identity/certilia.js';
import { createFakeIssuer, loadSasIssuer } from './issuers.js';
import { createMemoryStore, createPgStore } from './store.js';
import { createLensPricing, describePricing } from './pricing.js';
import { createLensMemberApp } from './server.js';
import { lensLog } from './errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLUSTERS = {
    devnet: 'https://api.devnet.solana.com',
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
    localhost: 'http://127.0.0.1:8899'
};
const DEFAULT_PORT = 3095;

function usage(code = 0) {
    console.log([
        'Usage: node lens/run.mjs (--dry-run | --live --keypair <path>) [options]',
        '',
        '  --dry-run                 Fake SAS issuer, in-memory attestation store, ephemeral key, no x402.',
        '  --live                    Issue real SAS attestations (needs sas-lib installed in backend/).',
        '  --keypair <path>          Solana keypair JSON of the member (the SAS credential authority). --live only.',
        '  --port <n>                HTTP port (default 3095); binds 127.0.0.1 unless --host is given.',
        '  --host <addr>             Bind address (default 127.0.0.1).',
        `  --credential-name <name>  SAS credential name (default ${DEFAULT_CREDENTIAL_NAME}); register it first with`,
        '                            scripts/register-lens-schemas.mjs --schemas ownership,verdict.',
        '  --identity <adapter>      devnet-registry (default) | certilia (not configured yet).',
        '  --owners <file.json>      devnet-registry rows in memory: [{parcelUid, owner, ownerCount, establishedAt}].',
        '                            Without it the registry is consensus.lens_devnet_owner (PG* env).',
        '  --cluster <name>          devnet (default) | mainnet-beta | localhost.',
        '  --rpc <url>               RPC URL override for --live.',
        '  --expiry-days <n>         Attestation expiry (default 365).',
        '  --help                    This text.',
        '',
        'Env: PG* (Postgres), X402_NETWORK, X402_FACILITATOR_URL, X402_PAY_TO, LENS_OWNERSHIP_PRICE_USDC (0.01),',
        '     LENS_OPERATOR_TOKEN (enables POST /lens/verdict).'
    ].join('\n'));
    process.exit(code);
}

function readOwners(file) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`${file} must hold a JSON array of owner rows`);
    return rows;
}

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                'dry-run': { type: 'boolean' },
                live: { type: 'boolean' },
                keypair: { type: 'string' },
                port: { type: 'string', default: String(DEFAULT_PORT) },
                host: { type: 'string', default: '127.0.0.1' },
                'credential-name': { type: 'string', default: DEFAULT_CREDENTIAL_NAME },
                identity: { type: 'string', default: 'devnet-registry' },
                owners: { type: 'string' },
                cluster: { type: 'string', default: 'devnet' },
                rpc: { type: 'string' },
                'expiry-days': { type: 'string', default: '365' },
                help: { type: 'boolean' }
            }
        }));
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (values.help) usage(0);
    if (!!values['dry-run'] === !!values.live) throw new Error('pass exactly one of --dry-run or --live');
    if (values.live && !values.keypair) throw new Error('--live needs --keypair');
    if (values['dry-run'] && values.keypair) throw new Error('--dry-run never loads a key; drop --keypair');
    if (!CLUSTERS[values.cluster]) throw new Error(`unknown --cluster ${values.cluster}`);
    const port = Number(values.port);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`bad --port ${values.port}`);
    const expiryDays = Number(values['expiry-days']);
    if (!(expiryDays > 0)) throw new Error(`bad --expiry-days ${values['expiry-days']}`);

    dotenv.config({ path: path.join(HERE, '..', '.env'), quiet: true });
    const dryRun = !!values['dry-run'];
    const clock = systemClock;
    const needsPg = !dryRun || (!values.owners && values.identity === 'devnet-registry');
    const pool = needsPg ? new pg.Pool() : null;
    pool?.on('error', error => console.error(`[${new Date().toISOString()}] [lens-member] idle pg client error:`, error.message));

    const keypair = dryRun ? null : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(values.keypair, 'utf8'))));
    const authority = keypair ? keypair.publicKey.toBase58() : Keypair.generate().publicKey.toBase58();
    const issuer = dryRun
        ? createFakeIssuer({ authority, clock })
        : await loadSasIssuer({ keypair, rpcUrl: values.rpc || CLUSTERS[values.cluster] });

    let identity;
    if (values.identity === 'certilia') {
        identity = createCertiliaIdentity();
        identity.assertReady();
    } else if (values.identity === 'devnet-registry') {
        identity = values.owners
            ? createDevnetRegistryIdentity({ rows: readOwners(values.owners), clock, authority })
            : createDevnetRegistryIdentity({ pool, clock, authority });
    } else {
        throw new Error(`unknown --identity ${values.identity}`);
    }

    const member = createLensMember({
        keypair,
        authority: keypair ? null : authority,
        credentialName: values['credential-name'],
        issuer,
        store: dryRun ? createMemoryStore() : createPgStore(pool),
        identity,
        clock,
        expirySeconds: Math.round(expiryDays * 86400),
        dryRun
    });
    const pricing = createLensPricing({ dryRun, env: process.env });
    const operatorToken = process.env.LENS_OPERATOR_TOKEN?.trim() || null;
    const app = createLensMemberApp({ member, pricing, operatorToken });

    const status = await member.status();
    lensLog(`${dryRun ? 'DRY RUN' : 'LIVE'} lens member ${status.key}${status.ephemeralKey ? ' (ephemeral key)' : ''}`);
    lensLog(`credential ${status.credential} (${status.credentialName}); schemas ownership ${status.schemas.ownership}, verdict ${status.schemas.verdict}`);
    lensLog(`identity ${identity.kind}${values.owners ? ` from ${values.owners}` : ''}; issuer ${issuer.kind}; store ${dryRun ? 'memory' : 'postgres'}`);
    lensLog(`ownership pricing: ${JSON.stringify(describePricing(pricing))}`);
    lensLog(`verdicts: ${operatorToken ? 'enabled (operator token set)' : 'disabled (LENS_OPERATOR_TOKEN unset)'}`);
    const server = app.listen(port, values.host, () => lensLog(`listening on http://${values.host}:${port}/lens/status`));
    const stop = signal => {
        lensLog(`${signal}: shutting down`);
        server.close(() => pool ? pool.end().finally(() => process.exit(0)) : process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] [lens-member] failed: ${error.message}`);
    process.exit(1);
});
