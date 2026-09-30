#!/usr/bin/env node
// Runs a lens-member persona from personas.json (role "lens-member", e.g. notary-01 or the
// lifecycle-01 expiry-verdict member) as the reference
// lens member process (backend/lens/run.mjs). Dry run unless --live: fake SAS issuer, in-memory store,
// ephemeral key, no x402. It registers nothing on chain; the credential and schemas are registered
// separately with scripts/register-lens-schemas.mjs before a live run makes sense.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LENS_RUN = path.join(__dirname, '..', 'lens', 'run.mjs');

function usage(code) {
    console.log([
        'Lens member persona runner: starts backend/lens/run.mjs for a role "lens-member" persona.',
        '',
        '  --persona NAME     lens-member persona in agents/personas.json (e.g. notary-01, lifecycle-01)',
        '  --dry-run          (default) fake issuer, in-memory store, ephemeral key, x402 off',
        '  --live             sign real SAS attestations with the persona keypair (schemas must be registered',
        '                     first: scripts/register-lens-schemas.mjs; needs sas-lib and X402_* env)',
        '  --owners FILE      dry run only: devnet-registry rows in memory instead of consensus.lens_devnet_owner',
        '  --port N           override the persona service port',
        '  --print            print the lens/run.mjs command and exit',
        '  --help             this text'
    ].join('\n'));
    process.exit(code);
}

function expandHome(value) {
    return value?.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

export function loadLensMemberPersona(name, file = path.join(__dirname, 'personas.json')) {
    const personas = JSON.parse(fs.readFileSync(file, 'utf8')).personas || [];
    const persona = personas.find(item => item.name === name);
    if (!persona) throw new Error(`no persona named ${name} in personas.json`);
    if (persona.role !== 'lens-member') throw new Error(`${name} has role ${persona.role || 'proposer'}, not lens-member`);
    if (!persona.service || !Number.isInteger(persona.service.port)) throw new Error(`${name} needs a service block with an integer port`);
    return persona;
}

/**
 * The lens/run.mjs argv and extra env for a persona. Pure; the caller spawns it.
 * @returns {{ args: string[], env: Record<string,string>, keypairPath: string|null }}
 */
export function lensMemberCommand(persona, { live = false, owners = null, port = null, sourceEnv = {} } = {}) {
    const service = persona.service || {};
    const args = [LENS_RUN, live ? '--live' : '--dry-run', '--port', String(port ?? service.port)];
    if (service.kind) args.push('--kind', service.kind);
    if (service.credentialName) args.push('--credential-name', service.credentialName);
    if (service.identity) args.push('--identity', service.identity);
    let keypairPath = null;
    if (live) {
        if (owners) throw new Error('--owners is a dry-run registry; a live member reads consensus.lens_devnet_owner');
        keypairPath = expandHome(persona.keypairPath);
        if (!keypairPath) throw new Error(`${persona.name} has no keypairPath`);
        args.push('--keypair', keypairPath, '--cluster', 'devnet');
    } else if (owners) {
        args.push('--owners', owners);
    }
    const env = service.priceUsdc ? { LENS_OWNERSHIP_PRICE_USDC: String(service.priceUsdc) } : {};
    // A member that issues verdicts (kind "lifecycle") reads its operator token from the variable the
    // service block names, e.g. AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN, the same one the proposer's retire
    // phase sends, so the two cannot drift apart.
    if (service.operatorTokenEnv) {
        const token = String(sourceEnv[service.operatorTokenEnv] || '').trim();
        if (token) env.LENS_OPERATOR_TOKEN = token;
        else if (live) throw new Error(`${persona.name} (kind ${service.kind}) issues verdicts; set ${service.operatorTokenEnv} before a live run`);
    }
    return { args, env, keypairPath };
}

function parseArgs(argv) {
    if (!argv.length) usage(0);
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (token === '--print') { args.print = true; continue; }
        const value = argv[i + 1];
        if (!token.startsWith('--') || value === undefined || value.startsWith('--')) usage(2);
        args[token.slice(2)] = value;
        i += 1;
    }
    if (args.dryRun && args.live) usage(2);
    if (!args.persona) usage(2);
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    // PM2 starts this without backend/.env loaded; a lifecycle member's operator token lives there.
    dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
    const persona = loadLensMemberPersona(args.persona);
    const port = args.port === undefined ? null : Number(args.port);
    if (port !== null && (!Number.isInteger(port) || port <= 0)) throw new Error(`bad --port ${args.port}`);
    const command = lensMemberCommand(persona, { live: Boolean(args.live), owners: args.owners ?? null, port, sourceEnv: process.env });
    if (command.keypairPath && !fs.existsSync(command.keypairPath)) {
        throw new Error(`${persona.name} keypair ${command.keypairPath} does not exist; generate it (solana-keygen new -o ${persona.keypairPath}) and set its wallet in personas.json`);
    }
    const line = `node ${command.args.join(" ")}`;
    console.log(`[${new Date().toISOString()}] [lens-member-run] ${persona.name} ${args.live ? 'LIVE' : 'dry run'}: ${line}${Object.keys(command.env).length ? ` (env ${Object.entries(command.env).map(([k, v]) => `${k}=${k === 'LENS_OPERATOR_TOKEN' ? '[set]' : v}`).join(' ')})` : ''}`);
    if (args.print) return;
    const child = spawn(process.execPath, command.args, { stdio: 'inherit', env: { ...process.env, ...command.env } });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => {
        console.log(`[${new Date().toISOString()}] [lens-member-run] ${persona.name} exited ${signal ? `on ${signal}` : `with ${code}`}`);
        process.exit(code ?? 1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [lens-member-run] failed: ${error.message}`);
        process.exit(1);
    }
}
