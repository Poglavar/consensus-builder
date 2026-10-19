import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ChainProposalRef = require('../../frontend/js/proposals/chain-ref.js');
const source = readFileSync(new URL('../../frontend/js/proposals/server-sync.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function uploadProposalToServer('), source.indexOf('async function headProposalExists('));

function client(response) {
    const fetch = vi.fn(async () => ({ ok: response.status < 400, status: response.status, json: async () => response.body }));
    const gate = vi.fn(() => false);
    const stored = {};
    const save = vi.fn();
    const upload = new Function('window', 'fetch', 'resolveBackendBaseUrl', 'syncProposalWithServerId',
        'guestPolicyBlocks', 'proposalStorage', `${body}; return uploadProposalToServer;`)(
        { ChainProposalRef }, fetch, () => 'https://api.example', () => stored, gate, { save });
    return { upload, fetch, gate, stored, save };
}

describe('chain mirror client', () => {
    it.each([201, 409])('mirrors only the location, retaining the canonical mirror ID (%s)', async status => {
        const mirrorId = `chain_${'a'.repeat(64)}`;
        const api = client({ status, body: { id: 7, proposalId: mirrorId } });
        const draft = { title: 'Local edits must never be uploaded', preparation: { id: 'expired' },
            onchain: { chainId: '84532', contractAddress: '0xC', proposalId: '8' } };
        await expect(api.upload(draft)).resolves.toEqual({ ok: true, id: 7, proposalId: mirrorId });
        expect(api.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = api.fetch.mock.calls[0];
        expect(url).toBe('https://api.example/proposals/mirror');
        expect(JSON.parse(init.body)).toEqual({ chainRef: { chainType: 'evm', chainId: '84532', contract: '0xC', tokenId: '8' } });
        expect(api.gate).not.toHaveBeenCalled();
        expect(api.stored.chainMirrorProposalId).toBe(mirrorId);
        expect(api.save).toHaveBeenCalledTimes(1);
    });

    it('reports a failed mirror while leaving the minted receipt intact', async () => {
        const api = client({ status: 503, body: { code: 'chain-proof-unavailable', error: 'RPC unavailable' } });
        const draft = { onchain: { chainId: '84532', contractAddress: '0xC', proposalId: '8' } };
        const before = structuredClone(draft);
        await expect(api.upload(draft)).resolves.toEqual({ ok: false, code: 'chain-proof-unavailable', message: 'RPC unavailable' });
        expect(draft).toEqual(before);
        expect(api.save).not.toHaveBeenCalled();
    });
});
