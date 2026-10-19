// scripts/build-rpc-config.py turns backend/.env browser endpoints into the public rpc-config.js:
// SOLANA_BROWSER_* and EVM_BROWSER_RPC_URL_<chainId>, so a provider swap is one .env line. The file is
// public, so the API's keyed SOLANA_RPC_URL / EVM_RPC_URL_<chainId> must never reach it, and the script
// prints no endpoint.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const SCRIPT = new URL('../../scripts/build-rpc-config.py', import.meta.url).pathname;

function generate(envText) {
    const dir = mkdtempSync(path.join(tmpdir(), 'rpc-config-'));
    const envFile = path.join(dir, '.env');
    const outFile = path.join(dir, 'rpc-config.js');
    writeFileSync(envFile, envText);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(EVM|SOLANA)_/.test(key)));
    const stdout = execFileSync('python3', [SCRIPT, '--env', envFile, '--out', outFile], { env, encoding: 'utf8' });
    const context = {};
    vm.runInNewContext(readFileSync(outFile, 'utf8').replaceAll('globalThis.', 'this.'), context);
    return { stdout, context };
}

describe('build-rpc-config.py', () => {
    it('maps EVM_BROWSER_RPC_URL_<chainId> to EVM_RPC_URLS beside the Solana maps, printing no endpoint', () => {
        const { stdout, context } = generate([
            'EVM_BROWSER_RPC_URL_11155111=https://eth-sepolia.example.test/v2/secret-key',
            'SOLANA_BROWSER_RPC_URL=https://solana-devnet.example.test/v2/secret-key',
            'UNRELATED_URL=https://elsewhere.example.test'
        ].join('\n'));
        expect({ ...context.EVM_RPC_URLS }).toEqual({ '11155111': 'https://eth-sepolia.example.test/v2/secret-key' });
        expect({ ...context.SOLANA_RPC_URLS }).toEqual({ devnet: 'https://solana-devnet.example.test/v2/secret-key' });
        expect(stdout).not.toContain('secret-key');
    });

    it("never ships the API's keyed endpoints, so the browser keeps the public defaults", () => {
        const { context } = generate([
            'EVM_RPC_URL_11155111=https://eth-sepolia.example.test/v2/server-key',
            'SOLANA_RPC_URL=https://solana-devnet.example.test/v2/server-key',
            'SOLANA_MAINNET_RPC_URL=https://solana-mainnet.example.test/v2/server-key',
            'SOLANA_PROGRAM_ACCOUNTS_RPC_URL=https://devnet.example.test/?api-key=server-key'
        ].join('\n'));
        expect({ ...context.EVM_RPC_URLS }).toEqual({});
        expect({ ...context.SOLANA_RPC_URLS }).toEqual({});
        expect({ ...context.SOLANA_PROGRAM_ACCOUNTS_RPC_URLS }).toEqual({});
    });
});
