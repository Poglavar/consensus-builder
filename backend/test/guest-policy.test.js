// Guest rules (frontend/js/guest-policy.js): device-local acts are open to guests, acts that leave
// the device need a profile name, and Offer my land needs a wallet with an ownership attestation.
// Also checks that the browser gates are wired to the policy at the places acts leave the device.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const policy = require('../../frontend/js/guest-policy.js');
const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/js');
const read = rel => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');

const GUEST = { isGuest: true, walletConnected: false, ownershipAttested: false };
const NAMED = { isGuest: false, walletConnected: false, ownershipAttested: false };
const OWNER = { isGuest: false, walletConnected: true, ownershipAttested: true };

describe('GuestPolicy.requires', () => {
    it.each([
        ['create', 'none'], ['edit', 'none'], ['fork', 'none'], ['apply', 'none'], ['compare', 'none'],
        ['publish', 'name'], ['share', 'name'], ['mint', 'name'], ['joinList', 'name'],
        ['ownerOffer', 'ownership-proof']
    ])('%s -> %s', (action, requirement) => {
        expect(policy.requires(action)).toBe(requirement);
    });

    it('throws on an action it does not know, instead of letting it through', () => {
        expect(() => policy.requires('deleteEverything')).toThrow(/unknown action/);
    });
});

describe('GuestPolicy.check', () => {
    it('lets a guest do everything that stays on the device', () => {
        for (const action of ['create', 'edit', 'fork', 'apply', 'compare']) {
            expect(policy.check(action, GUEST)).toMatchObject({ allowed: true, missing: [] });
        }
    });

    it('asks a guest for a name for everything that leaves the device, and nothing more', () => {
        for (const action of ['publish', 'share', 'mint', 'joinList']) {
            expect(policy.check(action, GUEST)).toMatchObject({ allowed: false, missing: ['name'] });
            expect(policy.check(action, NAMED).allowed).toBe(true);
        }
    });

    it('a name alone is not proof of ownership', () => {
        expect(policy.check('ownerOffer', NAMED)).toMatchObject({ allowed: false, missing: ['wallet', 'attestation'] });
    });

    it('lists every gap of a guest without a wallet, wallet first', () => {
        expect(policy.missing('ownerOffer', GUEST)).toEqual(['wallet', 'attestation', 'name']);
    });

    it('a connected wallet without an attestation still lacks the attestation', () => {
        expect(policy.missing('ownerOffer', { ...OWNER, ownershipAttested: false })).toEqual(['attestation']);
    });

    it('an attested owner with a name may offer', () => {
        expect(policy.check('ownerOffer', OWNER)).toMatchObject({ allowed: true, requirement: 'ownership-proof' });
    });

    it('treats unknown facts as unmet (no profile = guest)', () => {
        expect(policy.missing('publish', {})).toEqual(['name']);
        expect(policy.missing('publish', undefined)).toEqual(['name']);
    });
});

describe('browser gates follow the policy', () => {
    it('the old blanket "personalize to create" gate is gone everywhere', () => {
        const offenders = [];
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return walk(full);
            if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('requirePersonalizedUser')) offenders.push(full);
        });
        walk(FRONTEND);
        expect(offenders).toEqual([]);
    });

    it('every name gate names an action the policy gates on a name', () => {
        const calls = [];
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return walk(full);
            if (!entry.name.endsWith('.js')) return;
            for (const m of fs.readFileSync(full, 'utf8').matchAll(/guestPolicyBlocks\('([^']+)'\)/g)) calls.push(m[1]);
        });
        walk(FRONTEND);
        expect(calls.length).toBeGreaterThanOrEqual(4);
        for (const action of calls) expect(policy.requires(action)).toBe('name');
    });

    it('publish, share and mint are gated where they leave the device; Offer goes through the ownership proof', () => {
        const upload = read('proposals/server-sync.js');
        const uploadBody = upload.slice(upload.indexOf('async function uploadProposalToServer('));
        expect(uploadBody.slice(0, 600)).toContain("guestPolicyBlocks('publish')");

        const sharing = read('proposals/sharing-routes.js');
        for (const fn of ['function shareAppliedProposals(', 'function shareSingleProposal(']) {
            expect(sharing.slice(sharing.indexOf(fn), sharing.indexOf(fn) + 300)).toContain("guestPolicyBlocks('share')");
        }

        expect(read('proposals/create.js')).toMatch(/shouldMintOnchain && guestPolicyBlocks\('mint'\)/);
        expect(read('proposals/create.js')).toContain("GuestPolicy.check('ownerOffer'");
        const actions = read('parcels/ui/proposal-actions.js');
        expect(actions).toContain('requireOwnerOfferProof');
    });
});
