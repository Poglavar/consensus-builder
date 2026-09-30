// The notary-01 persona runner: which lens/run.mjs command it starts in dry run and live, and what it refuses.
import { describe, expect, it } from 'vitest';
import { lensMemberCommand, loadLensMemberPersona } from '../agents/lens-member-run.mjs';

describe('lens-member persona runner', () => {
    it('starts the reference member in dry run from the persona service block', () => {
        const persona = loadLensMemberPersona('notary-01');
        const { args, env, keypairPath } = lensMemberCommand(persona, { owners: '/tmp/owners.json' });
        expect(args[0]).toMatch(/backend\/lens\/run\.mjs$/);
        expect(args.slice(1)).toEqual(['--dry-run', '--port', '3095', '--credential-name', 'LensMember', '--identity', 'devnet-registry', '--owners', '/tmp/owners.json']);
        expect(env).toEqual({ LENS_OWNERSHIP_PRICE_USDC: '0.01' });
        expect(keypairPath).toBeNull();
    });

    it('passes the persona keypair only in live mode and refuses a dry-run owners file there', () => {
        const persona = loadLensMemberPersona('notary-01');
        const live = lensMemberCommand(persona, { live: true, port: 4000 });
        expect(live.args).toEqual(expect.arrayContaining(['--live', '--port', '4000', '--keypair', live.keypairPath, '--cluster', 'devnet']));
        expect(live.keypairPath).toMatch(/\.config\/solana\/ugt-notary-01\.json$/);
        expect(() => lensMemberCommand(persona, { live: true, owners: 'x.json' })).toThrow(/dry-run registry/);
    });

    it('refuses personas that are not lens members', () => {
        expect(() => loadLensMemberPersona('densifier-01')).toThrow(/not lens-member/);
        expect(() => loadLensMemberPersona('nobody')).toThrow(/no persona named/);
    });
});
