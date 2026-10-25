// Recreating experimental records earns new identities without inheriting chain decisions.
import { describe, expect, it } from 'vitest';
import { cidOfObject } from '../cid.js';
import { agreementContent, designContent } from './helpers/content-fixtures.js';
import { prepareAgreementRecreation } from '../scripts/recreate-agreement-contract.mjs';

const AUTHORED_AT = '2026-10-26T00:00:00.000Z';
function snapshotFor({ deadline = '2026-10-25T00:00:00.000Z' } = {}) {
    const design = designContent();
    const designCid = cidOfObject(design);
    const content = agreementContent([design], { deadline });
    content.designs = [{ cid: designCid, goal: design.goal, title: design.title }];
    delete content.planCid;
    return {
        agreements: [{ cid: cidOfObject(content), content, design_cids: [designCid], onchain: { account: 'old-account' } }],
        designs: [{ cid: designCid, content: design }]
    };
}

describe('prepareAgreementRecreation', () => {
    it('creates a new plan-linked agreement and records deadline renewal without carrying chain state', () => {
        const source = snapshotFor();
        const result = prepareAgreementRecreation(source, { authoredAt: AUTHORED_AT });
        const [item] = result.items;
        expect(result).toMatchObject({ schema: 'agreement-recreation/v1', authoredAt: AUTHORED_AT, sourceCount: 1 });
        expect(item).toMatchObject({ sourceCid: source.agreements[0].cid, plan: { cid: expect.any(String) }, changes: expect.arrayContaining([
            'expired-deadline-renewed-7-days', 'new-plan-linked-agreement'
        ]) });
        expect(item.cid).not.toBe(item.sourceCid);
        expect(item.content).toMatchObject({ schema: 'agreement/v1', planCid: item.plan.cid,
            title: `Devnet demo: ${source.agreements[0].content.title}`, author: 'devnet-demo-recreation',
            createdAt: AUTHORED_AT, deadline: '2026-11-02T00:00:00.000Z', money: source.agreements[0].content.money,
            inputs: source.agreements[0].content.inputs, outputs: source.agreements[0].content.outputs,
            rule: source.agreements[0].content.rule, sponsor: source.agreements[0].content.sponsor });
        expect(item.content).not.toHaveProperty('designs');
        expect(item.content).not.toHaveProperty('designCids');
        expect(item.content).not.toHaveProperty('onchain');
        expect(item.plan.content.designCids).toEqual(source.agreements[0].design_cids);
        expect(item.plan.content.view.at).toBeTruthy();
    });

    it('preserves an existing future deadline and renews null deadlines never', () => {
        const future = prepareAgreementRecreation(snapshotFor({ deadline: '2026-11-05T00:00:00.000Z' }), { authoredAt: AUTHORED_AT }).items[0];
        const noDeadline = prepareAgreementRecreation(snapshotFor({ deadline: null }), { authoredAt: AUTHORED_AT }).items[0];
        expect(future.content.deadline).toBe('2026-11-05T00:00:00.000Z');
        expect(future.changes.some(change => change.includes('deadline-renewed'))).toBe(false);
        expect(noDeadline.content.deadline).toBeNull();
        expect(noDeadline.changes.some(change => change.includes('deadline-renewed'))).toBe(false);
    });

    it('fails on a missing referenced design or bad source content CID', () => {
        const missing = snapshotFor();
        missing.designs = [];
        expect(() => prepareAgreementRecreation(missing, { authoredAt: AUTHORED_AT })).toThrow(/missing design/);
        const tampered = snapshotFor();
        tampered.agreements[0].content.title = 'Changed after export';
        expect(() => prepareAgreementRecreation(tampered, { authoredAt: AUTHORED_AT })).toThrow(/does not match its content CID/);
    });
});
