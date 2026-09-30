#!/usr/bin/env node
// Registers the lens-model SAS schemas (ParcelOwnership-v1, ProposalVerdict-v1) under one lens
// member's own SAS credential. Dry run by default: prints the derived credential and schema PDAs
// and the exact layouts, sends nothing. --live creates whatever is missing with sas-lib (the same
// library and derivations as the court oracle's registration).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as kit from '@solana/kit';
import * as sas from 'sas-lib';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
    deriveLensSchemaPdas,
    LENS_SCHEMA_KINDS,
    LENS_SCHEMAS,
    SAS_PROGRAM_ID
} from '../oracle/lens-schemas.js';

const CLUSTERS = {
    devnet: 'https://api.devnet.solana.com',
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
    localhost: 'http://127.0.0.1:8899'
};
const DEFAULT_CREDENTIAL_NAME = 'LensMember';

function usage(code = 0) {
    console.log([
        'Usage: node scripts/register-lens-schemas.mjs (--keypair <path> | --authority <base58>) [options]',
        '',
        '  --keypair <path>          Solana keypair JSON of the credential authority (payer for --live).',
        '  --authority <base58>      Authority public key; dry run only (no keypair needed).',
        '  --cluster <name>          devnet (default) | mainnet-beta | localhost.',
        '  --rpc <url>               RPC URL override for --live.',
        `  --credential-name <name>  SAS credential name (default ${DEFAULT_CREDENTIAL_NAME}, max 32 bytes).`,
        `  --schemas <list>          Comma list of ${LENS_SCHEMA_KINDS.join(',')} (default all).`,
        '  --dry-run                 Default. Print PDAs and layouts; send nothing.',
        '  --live                    Create the missing credential and schemas (needs sas-lib installed).',
        '  --help                    This text.'
    ].join('\n'));
    process.exit(code);
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function readKeypair(path) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))));
}

export function planRegistration({ authority, credentialName, kinds }) {
    const { credential, schemas } = deriveLensSchemaPdas({ authority, credentialName });
    return {
        sasProgram: SAS_PROGRAM_ID,
        authority,
        credentialName,
        credential,
        schemas: kinds.map(kind => {
            const { id, name, version, layout, sasLayout, fields, description } = LENS_SCHEMAS[kind];
            return { kind, id, name, version, layout, sasLayout, fieldNames: fields.map(f => f.name), description, pda: schemas[kind] };
        })
    };
}

async function registerLive(plan, keypairPath, rpcUrl) {
    const signer = await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))));
    const rpc = kit.createSolanaRpc(rpcUrl);
    const rpcSubscriptions = kit.createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, 'ws'));
    const sendAndConfirm = kit.sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    // Cross-check: the PDAs we print must be the ones sas-lib derives.
    const [libCredential] = await sas.deriveCredentialPda({ authority: signer.address, name: plan.credentialName });
    if (libCredential !== plan.credential) throw new Error(`credential PDA mismatch: sas-lib ${libCredential} vs ${plan.credential}`);

    const exists = async address => (await rpc.getAccountInfo(kit.address(address), { encoding: 'base64' }).send()).value !== null;
    const send = async (instruction, label) => {
        const { value: blockhash } = await rpc.getLatestBlockhash().send();
        const message = kit.pipe(
            kit.createTransactionMessage({ version: 0 }),
            tx => kit.setTransactionMessageFeePayerSigner(signer, tx),
            tx => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
            tx => kit.appendTransactionMessageInstructions([instruction], tx)
        );
        const signed = await kit.signTransactionMessageWithSigners(message);
        await sendAndConfirm(signed, { commitment: 'confirmed' });
        log(`${label}: ${kit.getSignatureFromTransaction(signed)}`);
    };

    if (await exists(plan.credential)) {
        log(`credential ${plan.credential} exists, skipped`);
    } else {
        await send(sas.getCreateCredentialInstruction({
            payer: signer, credential: kit.address(plan.credential), authority: signer,
            name: plan.credentialName, signers: [signer.address]
        }), `credential ${plan.credential} created`);
    }
    for (const schema of plan.schemas) {
        const [libSchema] = await sas.deriveSchemaPda({ credential: kit.address(plan.credential), name: schema.name, version: schema.version });
        if (libSchema !== schema.pda) throw new Error(`${schema.id} PDA mismatch: sas-lib ${libSchema} vs ${schema.pda}`);
        if (await exists(schema.pda)) {
            log(`${schema.id} ${schema.pda} exists, skipped`);
            continue;
        }
        await send(sas.getCreateSchemaInstruction({
            authority: signer, payer: signer, name: schema.name, credential: kit.address(plan.credential),
            description: schema.description, fieldNames: schema.fieldNames, schema: kit.address(schema.pda),
            layout: Buffer.from(schema.sasLayout)
        }), `${schema.id} ${schema.pda} created`);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                keypair: { type: 'string' },
                authority: { type: 'string' },
                cluster: { type: 'string', default: 'devnet' },
                rpc: { type: 'string' },
                'credential-name': { type: 'string', default: DEFAULT_CREDENTIAL_NAME },
                schemas: { type: 'string', default: LENS_SCHEMA_KINDS.join(',') },
                'dry-run': { type: 'boolean' },
                live: { type: 'boolean' },
                help: { type: 'boolean' }
            }
        }));
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (values.help) usage(0);
    if (values.live && values['dry-run']) usage(2);
    if (!CLUSTERS[values.cluster]) throw new Error(`unknown --cluster ${values.cluster}`);
    if (!!values.keypair === !!values.authority) throw new Error('pass exactly one of --keypair or --authority');
    if (values.live && !values.keypair) throw new Error('--live needs --keypair (the authority signs)');
    const kinds = values.schemas.split(',').map(s => s.trim()).filter(Boolean);
    for (const kind of kinds) if (!LENS_SCHEMAS[kind]) throw new Error(`unknown schema ${kind}`);

    const authority = values.keypair ? readKeypair(values.keypair).publicKey.toBase58() : new PublicKey(values.authority).toBase58();
    const plan = planRegistration({ authority, credentialName: values['credential-name'], kinds });

    console.log(`Lens SAS registration (${values.live ? 'LIVE' : 'dry run'})`);
    console.log(`  cluster:         ${values.cluster}`);
    console.log(`  SAS program:     ${plan.sasProgram}`);
    console.log(`  authority:       ${plan.authority}`);
    console.log(`  credential name: ${plan.credentialName}`);
    console.log(`  credential PDA:  ${plan.credential}   (seeds of sas-lib deriveCredentialPda)`);
    for (const schema of plan.schemas) {
        console.log(`  ${schema.id}`);
        console.log(`    schema PDA:    ${schema.pda}   (seeds of sas-lib deriveSchemaPda, name ${schema.name}, version ${schema.version})`);
        console.log(`    layout:        ${schema.layout}`);
        console.log(`    SAS layout:    [${schema.sasLayout.join(', ')}]`);
    }
    if (!values.live) {
        console.log('Dry run: nothing sent. Re-run with --live --keypair <path> to register.');
        return;
    }
    await registerLive(plan, values.keypair, values.rpc || CLUSTERS[values.cluster]);
    log('done');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] register-lens-schemas failed: ${error.message}`);
        process.exit(1);
    });
}
