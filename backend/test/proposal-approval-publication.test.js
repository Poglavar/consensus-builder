// Checks canonical approval setup survives publication and separates otherwise identical proposals.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createMockPool } from './helpers/mock-pool.js';
import { createTestApp } from './helpers/create-app.js';
import { insertResult, proposalDbRow, updateResult, validProposalBody } from './helpers/fixtures.js';
import { memberHash } from '../plans/plan-hash.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const sharing = require('../../frontend/js/proposals/sharing.js');

const config = () => ({
    schema: 'proposal-approval/v1',
    rights: {
        schema: 'parcel-rights/v1',
        source: { provider: 'upload', reference: 'rights-register-17' },
        parcels: [{
            parcelId: 'HR-1234-5678', complete: true, areaM2: 100,
            owners: [{ ownerId: 'owner-a', share: '1/2' }, { ownerId: 'owner-b', share: '1/2' }]
        }]
    },
    policy: { type: 'unanimous' }
});

describe('proposal approval publication', () => {
    it('stores canonical approval config, serves it from GET, and strips uploader approval state', async () => {
        const pool = createMockPool();
        pool.setResults([insertResult(), updateResult()]);
        const app = createTestApp(pool);
        const approvalConfig = config();

        const posted = await request(app).post('/proposals').send(validProposalBody({
            approvalConfig,
            ownerApprovals: { 'owner-a': true },
            ownerApprovalHistory: [{ ownerId: 'owner-a', approved: true }],
            approvalRuntimeState: { status: 'approved' },
            authorityRuntimeState: { signer: 'client' }
        }));

        expect(posted.status).toBe(201);
        const stored = JSON.parse(pool.getCalls()[0].params[32]);
        expect(stored.approvalConfig).toEqual(approval.normalizeConfig(approvalConfig));
        for (const key of ['ownerApprovals', 'ownerApprovalHistory', 'approvalRuntimeState', 'authorityRuntimeState']) {
            expect(stored).not.toHaveProperty(key);
        }

        pool.setResult({ rows: [proposalDbRow({ proposal_data: stored })] });
        const fetched = await request(app).get('/proposals/1');
        expect(fetched.status).toBe(200);
        expect(fetched.body.approvalConfig).toEqual(approval.normalizeConfig(approvalConfig));
        expect(fetched.body).not.toHaveProperty('ownerApprovals');
        expect(fetched.body).not.toHaveProperty('ownerApprovalHistory');
    });

    it('refuses malformed explicit approval configuration with 422 before touching publication storage', async () => {
        const pool = createMockPool();
        const app = createTestApp(pool);
        const response = await request(app).post('/proposals').send(validProposalBody({
            approvalConfig: { schema: 'wrong', rights: [], policy: { type: 'unanimous' } }
        }));

        expect(response.status).toBe(422);
        expect(response.body.code).toBe('invalid-proposal-approval');
        expect(pool.getCalls()).toHaveLength(0);
        expect(pool.getBindingCalls()).toHaveLength(0);
    });

    it('allows a geometry-only proposal with explicit null rights', async () => {
        const pool = createMockPool();
        pool.setResults([insertResult(), updateResult()]);
        const app = createTestApp(pool);
        const response = await request(app).post('/proposals').send(validProposalBody({
            cadastreParcelIds: [],
            site: { type: 'Polygon', coordinates: [[[16, 45.8], [16.001, 45.8], [16.001, 45.801], [16, 45.8]]] },
            approvalConfig: { schema: 'proposal-approval/v1', rights: null, policy: { type: 'unanimous' } }
        }));

        expect(response.status).toBe(201);
        expect(JSON.parse(pool.getCalls()[0].params[32]).approvalConfig.rights).toBeNull();
    });

    it('binds rights, policy, and lens into generic share and named-member fingerprints', () => {
        const base = { goal: 'as-is', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, approvalConfig: config() };
        const fingerprint = proposal => sharing.proposalContentFingerprint(proposal);
        const member = proposal => memberHash({
            id: 1, type: 'parcel', goal: proposal.goal,
            cadastre_parcel_ids: ['HR-1234-5678'], geometry: proposal.geometry,
            proposal_data: proposal
        });

        const rightsChanged = structuredClone(base);
        rightsChanged.approvalConfig.rights.source.reference = 'rights-register-18';
        const policyChanged = structuredClone(base);
        policyChanged.approvalConfig.policy = {
            type: 'threshold',
            owners: { numerator: 1, denominator: 2, strict: true },
            area: { numerator: 1, denominator: 2, strict: true }
        };
        const lensChanged = { ...base, lens: ['lens-b', 'lens-a'] };
        const lensReordered = { ...base, lens: ['lens-a', 'lens-b'] };

        expect(fingerprint(rightsChanged)).not.toBe(fingerprint(base));
        expect(member(rightsChanged)).not.toBe(member(base));
        expect(fingerprint(policyChanged)).not.toBe(fingerprint(base));
        expect(member(policyChanged)).not.toBe(member(base));
        expect(fingerprint(lensChanged)).toBe(fingerprint(lensReordered));
        expect(member(lensChanged)).toBe(member(lensReordered));
        expect(fingerprint(lensChanged)).not.toBe(fingerprint(base));
        expect(member(lensChanged)).not.toBe(member(base));
    });

    it('keeps display-only lens labels out of legacy unconfigured fingerprints', () => {
        const plain = { goal: 'as-is', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
        const labelOnly = { ...plain, lens: [{ name: 'Display label' }] };
        const member = proposal => memberHash({
            id: 1, type: 'parcel', goal: proposal.goal,
            cadastre_parcel_ids: ['HR-1234-5678'], geometry: proposal.geometry,
            proposal_data: proposal
        });

        expect(sharing.proposalContentFingerprint(labelOnly)).toBe(sharing.proposalContentFingerprint(plain));
        expect(member(labelOnly)).toBe(member(plain));
    });
});
