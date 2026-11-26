// ugt_agreement_evidence reads the walkthrough's sources and answers its checklist: lens member states,
// a retired-program agreement read as not on Solana, and no chain read for a poll.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createAgreementEvidenceTool } from '../agents/mcp-agreement-evidence.js';

const require = createRequire(import.meta.url);
const { cidOfObject } = require('../../frontend/js/cid.js');
const { constants } = require('../../frontend/js/solana/agreement-client.js');

const SPONSOR = 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os';
const A = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const B = 'm8gLfyPspP6ABSNA4ZMFYCzzRGjNLBmrKKwKrGqbUfR';
function record({ lens = [A, B], onchain = null, binding = true } = {}) {
    const content = { schema: 'agreement/v1', title: 'Evidence fixture', sponsor: SPONSOR, city: 'alatau', inputs: { parcels: [], openGroundM2: 0 },
        rule: { electorate: 'owners', binding, approvalConfig: null, lens } };
    return { cid: cidOfObject(content), content, city: 'alatau', onchain };
}
function tool(row, { feed = [] } = {}) {
    const urls = [];
    const fetchImpl = vi.fn(async url => {
        urls.push(url);
        const body = url.endsWith(`/agreements/${row.cid}`) ? row
            : url.includes('/decisions') ? { agreementCid: row.cid, decisions: [] }
                : url.endsWith('/lenses/members') ? { members: [{ key: A, name: 'notary-01' }, { key: B, name: 'lifecycle-01', serviceUrl: 'https://lens.example' }] }
                    : url.startsWith('https://lens.example/lens/attestations') ? { attestations: feed } : null;
        return body ? { ok: true, json: async () => body } : { ok: false, status: 404 };
    });
    const connection = { getAccountInfo: vi.fn(async () => null) };
    const evidence = createAgreementEvidenceTool({ env: { UGT_API_BASE: 'https://api.example' }, fetchImpl, createConnection: () => connection });
    return { evidence, urls, connection };
}

describe('ugt_agreement_evidence', () => {
    it('lists each lens member with what its service reports and reads the account the sponsor and CID derive', async () => {
        const row = record();
        const statement = { authority: B, kind: 'decision', address: '7sS9tUj78sj1ZZzv7B23jscazXAdNKDWhNsqjLEcAmSw', issuedAt: '2026-11-20T10:00:00Z',
            payload: { agreementCid: row.cid, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: 'sha256:x', sourceObservedAt: 1_790_000_000 } };
        const { evidence, connection } = tool(row, { feed: [statement, { ...statement, authority: A }] });
        const result = await evidence.agreementEvidence({ agreementCid: row.cid });
        expect(connection.getAccountInfo).toHaveBeenCalled();
        expect(result.lens.members).toEqual([
            expect.objectContaining({ key: A, name: 'notary-01', state: 'unlisted', reportedStatements: [] }),
            expect.objectContaining({ key: B, name: 'lifecycle-01', state: 'issued', reportedStatements: [expect.objectContaining({ checkedOnSolana: false })] })
        ]);
        expect(result.checks.find(c => c.id === 'execution')).toMatchObject({ state: 'waiting', execution: 'unminted' });
        expect(result.checks.find(c => c.id === 'approvals')).toBeTruthy();
    });

    it('reads an agreement under a retired program as not on Solana, without touching the chain', async () => {
        const row = record({ onchain: { cluster: 'devnet', programId: 'GtdgeRH89fRetired', status: 'executed' } });
        expect(row.onchain.programId).not.toBe(constants.AGREEMENT_PROGRAM_ID);
        const { evidence, connection } = tool(row);
        const result = await evidence.agreementEvidence({ agreementCid: row.cid });
        expect(result.retiredProgram).toBe(true);
        expect(result.execution.state).toBe('retired');
        expect(connection.getAccountInfo).not.toHaveBeenCalled();
    });

    it('answers a non-binding vote as a poll with no chain read', async () => {
        const row = record({ binding: false });
        const { evidence, connection } = tool(row);
        const result = await evidence.agreementEvidence({ agreementCid: row.cid });
        expect(result.kind).toBe('poll');
        expect(result.checks).toEqual([]);
        expect(connection.getAccountInfo).not.toHaveBeenCalled();
    });
});
