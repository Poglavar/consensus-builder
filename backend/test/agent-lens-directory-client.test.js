// Lens choice for agent proposers: deterministic directory picks, refusals instead of a silent
// self-lens, and the dry-run description the runners print.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
    chooseLens, describeLensChoice, fetchLensMembers, parseLensList, resolveLens
} from '../agents/lens-directory-client.js';

const key = () => Keypair.generate().publicKey.toBase58();
const [A, B, C, D, SELF] = Array.from({ length: 5 }, key);
const member = (k, kind, ownership = 0, name = null) => ({ key: k, kind, name, description: null, coverage: { ownership, parcels: ownership, executed: 0 } });

function directoryFetch(members, status = 200) {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ members }), { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetchImpl, calls };
}

describe('chooseLens', () => {
    it('ranks by ownership coverage, then key, independent of input order', () => {
        const members = [member(A, 'owner-consent', 3), member(B, 'owner-consent', 7), member(C, 'owner-consent', 3), member(D, 'court', 99)];
        const tieFirst = [A, C].sort()[0];
        const forward = chooseLens(members, { min: 2 });
        const reversed = chooseLens([...members].reverse(), { min: 2 });
        expect(forward.map(m => m.key)).toEqual([B, tieFirst]);
        expect(reversed.map(m => m.key)).toEqual(forward.map(m => m.key));
        expect(chooseLens(members).map(m => m.key)).toEqual([B]);
    });

    it('filters by kind and excludes the proposer', () => {
        const members = [member(SELF, 'owner-consent', 50), member(A, 'owner-consent', 1), member(D, 'court', 99)];
        expect(chooseLens(members, { exclude: [SELF] }).map(m => m.key)).toEqual([A]);
        expect(chooseLens(members, { kinds: ['court'] }).map(m => m.key)).toEqual([D]);
        expect(chooseLens(members, { kinds: [], exclude: [SELF] }).map(m => m.key)).toEqual([D]);
    });

    it('refuses an empty directory, too few qualifying members, and a directory of only the proposer', () => {
        expect(() => chooseLens([])).toThrow(/no lens: 0 of 0 .*Refusing to mint with the proposer as its own lens/);
        expect(() => chooseLens([member(A, 'owner-consent')], { min: 2 })).toThrow(/need 2/);
        expect(() => chooseLens([member(SELF, 'owner-consent', 9)], { exclude: [SELF] })).toThrow(/no lens: 0 of 1/);
        expect(() => chooseLens([member(D, 'court', 9)])).toThrow(/kinds owner-consent/);
        expect(() => chooseLens([], { min: 0 })).toThrow(/min must be a positive integer/);
    });
});

describe('resolveLens', () => {
    it('uses explicit keys without touching the directory, and refuses the proposer alone', async () => {
        const { fetchImpl, calls } = directoryFetch([]);
        const choice = await resolveLens({ explicit: `${A}, ${B},${A}`, proposer: SELF, apiBase: 'http://x', fetchImpl });
        expect(choice).toMatchObject({ lens: [A, B], source: 'explicit' });
        expect(calls).toHaveLength(0);
        await expect(resolveLens({ explicit: SELF, proposer: SELF, apiBase: 'http://x', fetchImpl })).rejects.toThrow(/only the proposer's own key/);
        await expect(resolveLens({ explicit: 'not-a-key', proposer: SELF })).rejects.toThrow(/not a base58 public key/);
        // the proposer next to another member is the proposer's choice, not a self-lens
        expect((await resolveLens({ explicit: [SELF, A], proposer: SELF })).lens).toEqual([SELF, A]);
    });

    it('chooses from GET /agent/lenses/members and explains why in the plan line', async () => {
        const { fetchImpl, calls } = directoryFetch([member(SELF, 'owner-consent', 40), member(A, 'owner-consent', 2, 'notary-01')]);
        const choice = await resolveLens({ proposer: SELF, apiBase: 'https://api.example.test/', fetchImpl });
        expect(calls).toEqual(['https://api.example.test/agent/lenses/members']);
        expect(choice.lens).toEqual([A]);
        expect(choice.source).toBe('directory');
        const line = describeLensChoice(choice);
        expect(line).toContain(`lens [${A}]`);
        expect(line).toContain('proposer excluded');
        expect(line).toContain('notary-01 (owner-consent, 2 ownership)');
    });

    it('refuses when the directory is empty or unavailable', async () => {
        await expect(resolveLens({ proposer: SELF, apiBase: 'http://x', fetchImpl: directoryFetch([]).fetchImpl })).rejects.toThrow(/no lens/);
        await expect(fetchLensMembers({ apiBase: 'http://x', fetchImpl: directoryFetch([], 500).fetchImpl })).rejects.toThrow(/HTTP 500/);
        await expect(fetchLensMembers({ apiBase: 'http://x', fetchImpl: async () => { throw new TypeError('fetch failed'); } })).rejects.toThrow(/unreachable/);
    });

    it('parses CLI lists into unique canonical keys', () => {
        expect(parseLensList(`${A},${B}, ${A}`)).toEqual([A, B]);
        expect(parseLensList('')).toEqual([]);
    });
});

describe('proposer runners no longer name themselves as the lens', () => {
    it('run.mjs and canonical-case-run.mjs mint with the resolved lens', () => {
        for (const file of ['../agents/run.mjs', '../agents/canonical-case-run.mjs']) {
            const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
            expect(source).toContain('resolveLens(');
            expect(source).not.toMatch(/lens: \[(keypair\.publicKey|proposer\.wallet)/);
        }
    });
});
