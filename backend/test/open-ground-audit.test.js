// Tests for oracle/open-ground-audit.js: the pure account-vs-record comparison (every mismatch kind,
// a clean match, legacy accounts told apart by layout_version) and the I/O wrapper over a stub connection and the mock pool.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
    MISMATCH_KINDS,
    PROPOSAL_ACCOUNT_DISCRIMINATOR,
    RECORDS_SQL,
    auditOpenGround,
    runOpenGroundAudit
} from '../oracle/open-ground-audit.js';
import { PROPOSAL_DISCRIMINATOR, proposalAccountBytes } from './fixtures/proposal-account.js';
import { createMockPool } from './helpers/mock-pool.js';

const siteHashApi = createRequire(import.meta.url)('../../frontend/js/proposals/site-hash.js');

const SITE = { type: 'MultiPolygon', coordinates: [[[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]]] };
const OTHER_SITE = { type: 'MultiPolygon', coordinates: [[[[15.98, 45.8], [15.981, 45.8], [15.981, 45.801], [15.98, 45.801], [15.98, 45.8]]]] };
const HASH = await siteHashApi.siteHashHex(SITE);
const OTHER_HASH = await siteHashApi.siteHashHex(OTHER_SITE);

const binding = (coverage, ids, extra = {}) => ({ coverage, parcels: ids.map(parcelId => ({ parcelId })), source: 'server', ...extra });
const account = (address, fields = {}) => ({ address, parcelIds: ['HR-1', 'HR-2'], siteHash: HASH, openGround: false, layoutVersion: 3, ...fields });
const record = (id, address, fields = {}) => ({
    id, proposalId: `p-${id}`, account: address, site: SITE,
    binding: binding('complete', ['HR-1', 'HR-2']), cadastreParcelIds: ['HR-2', 'HR-1'],
    createdAt: '2026-10-02T00:00:00Z', ...fields
});

async function single(acc, rec, options) {
    return auditOpenGround([acc], rec ? [rec].flat() : [], options);
}

describe('auditOpenGround (pure)', () => {
    it('passes a v3 account that matches its record (parcel order irrelevant)', async () => {
        const report = await single(account('A', { parcelIds: ['HR-2', 'HR-1'] }), record(1, 'A'));
        expect(report).toMatchObject({ accounts: 1, checked: 1, mismatches: [], skipped: [] });
    });

    it('passes an empty binding on open ground', async () => {
        const report = await single(
            account('A', { parcelIds: [], openGround: true }),
            record(1, 'A', { binding: binding('partial', [], { unsurveyedM2: 1000 }), cadastreParcelIds: [] })
        );
        expect(report.mismatches).toEqual([]);
        expect(report.checked).toBe(1);
    });

    it('reports site-hash-mismatch when the account hash is not the record site hash', async () => {
        const report = await single(account('A', { siteHash: OTHER_HASH }), record(1, 'A'));
        expect(report.mismatches).toEqual([{
            kind: 'site-hash-mismatch', proposal: { account: 'A', recordId: 1, proposalId: 'p-1' },
            account: OTHER_HASH, record: HASH
        }]);
    });

    it('reports site-missing on the record side when the account has a hash and the record no site', async () => {
        const report = await single(account('A'), record(1, 'A', { site: null, binding: null }));
        expect(report.mismatches.map(item => [item.kind, item.side])).toEqual([['site-missing', 'record']]);
    });

    it('reports site-missing on the account side (plus understated) for an empty binding minted without a hash', async () => {
        const report = await single(
            account('A', { parcelIds: [], siteHash: null, openGround: false }),
            record(1, 'A', { binding: binding('none', []), cadastreParcelIds: [] })
        );
        expect(report.mismatches.map(item => item.kind)).toEqual(['site-missing', 'open-ground-understated']);
        expect(report.mismatches[0]).toMatchObject({ side: 'account', expectedSiteHash: HASH });
    });

    it('reports open-ground-understated for partial, none and unknown coverage', async () => {
        for (const coverage of ['partial', 'none', 'unknown']) {
            const report = await single(account('A'), record(1, 'A', { binding: binding(coverage, ['HR-1', 'HR-2']) }));
            expect(report.mismatches, coverage).toEqual([expect.objectContaining({ kind: 'open-ground-understated', coverage })]);
        }
    });

    it('reports open-ground-overstated when the binding is complete with parcels', async () => {
        const report = await single(account('A', { openGround: true }), record(1, 'A'));
        expect(report.mismatches).toEqual([expect.objectContaining({ kind: 'open-ground-overstated', coverage: 'complete', recordParcels: 2 })]);
    });

    it('reports parcels-mismatch against the declaration and the binding', async () => {
        const report = await single(account('A', { parcelIds: ['HR-1', 'HR-9'] }), record(1, 'A'));
        expect(report.mismatches).toEqual([
            expect.objectContaining({ kind: 'parcels-mismatch', against: 'declaration', missing: ['HR-2'], extra: ['HR-9'] }),
            expect.objectContaining({ kind: 'parcels-mismatch', against: 'binding', missing: ['HR-2'], extra: ['HR-9'] })
        ]);
    });

    it('reports record-missing for a v3 account no record claims, and record-ambiguous for two claims', async () => {
        const missing = await single(account('A'), null);
        expect(missing.mismatches).toEqual([expect.objectContaining({ kind: 'record-missing', siteHash: HASH })]);
        const ambiguous = await single(account('A'), [record(1, 'A'), record(2, 'A')]);
        expect(ambiguous.mismatches).toEqual([expect.objectContaining({ kind: 'record-ambiguous', recordIds: [1, 2] })]);
    });

    it('skips v1/v2 accounts (layout_version 0 or absent) whatever their record says', async () => {
        const legacy = account('L', { siteHash: null, layoutVersion: 0 });
        const report = await auditOpenGround([
            legacy,
            { ...legacy, address: 'M' },
            { ...legacy, address: 'N' },
            { ...legacy, address: 'O', layoutVersion: undefined }
        ], [
            record(1, 'L', { site: null, binding: null }),
            record(2, 'M', { binding: binding('complete', ['HR-1', 'HR-2'], { source: 'migration:declaration', migration: 'proposal-sites-v1' }) }),
            // A record with its own site and partial coverage: on a v3 account this would be two mismatches.
            record(3, 'N', { binding: binding('partial', ['HR-1', 'HR-2']) })
        ]);
        expect(report.mismatches).toEqual([]);
        expect(report.checked).toBe(0);
        expect(report.skippedByReason).toEqual({ 'legacy-layout': 4 });
    });

    it('classifies a zero hash by layout_version: legacy at 0, site-missing at 3 unless the site was migrated', async () => {
        const legacy = await single(account('A', { siteHash: null, layoutVersion: 0 }), record(1, 'A'));
        expect(legacy.mismatches).toEqual([]);
        expect(legacy.skippedByReason).toEqual({ 'legacy-layout': 1 });
        const v3 = await single(account('A', { siteHash: null }), record(1, 'A'));
        expect(v3.mismatches.map(item => [item.kind, item.side])).toEqual([['site-missing', 'account']]);
        expect(v3.checked).toBe(1);
        // The record's age no longer matters: an old record on a v3 account is still a v3 claim.
        const old = await single(account('A', { siteHash: null }), record(1, 'A', { createdAt: '2020-01-01T00:00:00Z' }));
        expect(old.mismatches.map(item => item.kind)).toEqual(['site-missing']);
        const migrated = await single(account('A', { siteHash: null }),
            record(1, 'A', { binding: binding('complete', ['HR-1', 'HR-2'], { migration: 'proposal-sites-v1' }) }));
        expect(migrated.mismatches).toEqual([]);
        expect(migrated.skippedByReason).toEqual({ 'site-migrated': 1 });
    });

    it('checks a v3 mint without a site against a record without one (parcels and open ground still compared)', async () => {
        const clean = await single(account('A', { siteHash: null }), record(1, 'A', { site: null, binding: null }));
        expect(clean).toMatchObject({ checked: 1, mismatches: [], skipped: [] });
        const wrong = await single(account('A', { siteHash: null, parcelIds: ['HR-1'] }), record(1, 'A', { site: null, binding: null }));
        expect(wrong.mismatches).toEqual([expect.objectContaining({ kind: 'parcels-mismatch', against: 'declaration', missing: ['HR-2'] })]);
        const unclaimed = await single(account('A', { siteHash: null }), null);
        expect(unclaimed).toMatchObject({ checked: 0, mismatches: [], skippedByReason: { 'no-record-no-site': 1 } });
    });

    it('covers every declared mismatch kind', async () => {
        const kinds = new Set();
        const cases = [
            [account('A', { siteHash: OTHER_HASH }), record(1, 'A')],
            [account('A'), record(1, 'A', { site: null, binding: null })],
            [account('A'), record(1, 'A', { binding: binding('partial', ['HR-1', 'HR-2']) })],
            [account('A', { openGround: true }), record(1, 'A')],
            [account('A', { parcelIds: ['HR-1'] }), record(1, 'A')],
            [account('A'), null],
            [account('A'), [record(1, 'A'), record(2, 'A')]]
        ];
        for (const [acc, rec] of cases) (await single(acc, rec)).mismatches.forEach(item => kinds.add(item.kind));
        expect([...kinds].sort()).toEqual([...MISMATCH_KINDS].sort());
    });
});

describe('runOpenGroundAudit (I/O wrapper)', () => {
    it('reads proposal accounts by discriminator and records from the proposal table', async () => {
        const owner = new PublicKey(Buffer.alloc(32, 7));
        const good = new PublicKey(Buffer.alloc(32, 1));
        const lying = new PublicKey(Buffer.alloc(32, 2));
        const legacy = new PublicKey(Buffer.alloc(32, 3));
        const broken = new PublicKey(Buffer.alloc(32, 4));
        const hashBytes = Buffer.from(HASH, 'hex');
        const rpc = [];
        const connection = {
            async getProgramAccounts(program, config) {
                rpc.push({ program: program.toBase58(), config });
                return [
                    { pubkey: good, account: { owner, data: proposalAccountBytes({ parcelIds: ['HR-1', 'HR-2'], siteHash: hashBytes }) } },
                    { pubkey: lying, account: { owner, data: proposalAccountBytes({ parcelIds: ['HR-1'], siteHash: hashBytes }) } },
                    { pubkey: legacy, account: { owner, data: proposalAccountBytes({ parcelIds: ['HR-1'], layoutVersion: 0 }) } },
                    { pubkey: broken, account: { owner, data: Buffer.alloc(20) } }
                ];
            }
        };
        const row = (id, address, fields = {}) => ({
            id, proposal_id: `p-${id}`, proposal_account: address.toBase58(), cadastre_parcel_ids: ['HR-1', 'HR-2'],
            site_geojson: JSON.stringify(SITE), binding: binding('complete', ['HR-1', 'HR-2']), proposal_data: {},
            created_at: new Date('2026-10-02T00:00:00Z'), ...fields
        });
        const pool = createMockPool();
        pool.setResult({ rows: [
            row(1, good),
            // The site only in proposal_data (no column value): still the record's site.
            row(2, lying, { site_geojson: null, binding: null, proposal_data: { site: SITE, binding: binding('partial', ['HR-1', 'HR-2']) } }),
            row(3, legacy, { site_geojson: null, binding: null, cadastre_parcel_ids: ['HR-1'] })
        ] });

        const report = await runOpenGroundAudit({ pool, connection });
        expect(rpc[0].config.filters[0].memcmp.offset).toBe(0);
        expect(PROPOSAL_ACCOUNT_DISCRIMINATOR.equals(PROPOSAL_DISCRIMINATOR)).toBe(true);
        expect(pool.getCalls()[0].sql).toBe(RECORDS_SQL);
        expect(report).toMatchObject({ accounts: 3, records: 3, checked: 2, skippedByReason: { 'legacy-layout': 1 } });
        expect(report.undecodable).toEqual([expect.objectContaining({ address: broken.toBase58() })]);
        expect(report.mismatches.map(item => [item.proposal.recordId, item.kind])).toEqual([
            [2, 'open-ground-understated'],
            [2, 'parcels-mismatch'],
            [2, 'parcels-mismatch']
        ]);
    });
});
