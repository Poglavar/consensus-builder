// Verify idempotent publication and readback of ordinary Freeform buildings and their named plan.
import { describe, expect, it, vi } from 'vitest';
import { publish, publishNamedPlan } from '../scripts/lib/candlestick-common.mjs';

const plan = { slug: 'candlestick-plan', title: 'Candlestick plan', proposalRowIds: ['101', '102'] };
const response = (status, json = null) => ({ status, json, text: '' });

describe('Candlestick named-plan publication', () => {
    it('creates the immutable named plan with database row IDs', async () => {
        const requestFn = vi.fn()
            .mockResolvedValueOnce(response(404))
            .mockResolvedValueOnce(response(201, { slug: plan.slug }))
            .mockResolvedValueOnce(response(200, { ...plan }));
        await expect(publishNamedPlan(plan, { backend: 'http://api', origin: 'http://site', requestFn }))
            .resolves.toMatchObject({ skipped: false, slug: plan.slug });
        expect(requestFn).toHaveBeenNthCalledWith(2, 'http://api', 'http://site', 'POST', '/plans', expect.objectContaining({
            slug: plan.slug, proposalRowIds: ['101', '102']
        }));
    });

    it('leaves an exact existing named collection alone and refuses changed membership', async () => {
        const requestFn = vi.fn().mockResolvedValue(response(200, { proposalRowIds: ['101', '102'] }));
        await expect(publishNamedPlan(plan, { backend: 'http://api', origin: 'http://site', requestFn }))
            .resolves.toMatchObject({ skipped: true });
        const changedRequest = vi.fn().mockResolvedValue(response(200, { proposalRowIds: ['102', '101'] }));
        await expect(publishNamedPlan(plan, { backend: 'http://api', origin: 'http://site', requestFn: changedRequest }))
            .rejects.toThrow(/immutable/);
    });


});


describe('ordinary Freeform publication restart safety', () => {
    const building = { type:'Feature',properties:{height:15},geometry:{type:'Polygon',coordinates:[[[16,45],[16.001,45],[16.001,45.001],[16,45.001],[16,45]]]}};
    const record={proposalId:'imported-house',goal:'single',typologyType:'single',geometry:{buildings:[building]},buildingProposal:{typologyType:'single'}};
    const options={backend:'http://api',origin:'http://site',city:'san_francisco'};
    it('skips only an exact existing building and rejects a changed source or failed lookup',async()=>{
        const requestFn=vi.fn().mockResolvedValue(response(200,{...record,id:41}));
        await expect(publish(record,{...options,requestFn})).resolves.toMatchObject({skipped:true,id:41});
        expect(requestFn).toHaveBeenCalledOnce();
        const different=vi.fn().mockResolvedValue(response(200,{...record,geometry:{buildings:[]}}));
        await expect(publish(record,{...options,requestFn:different})).rejects.toThrow(/new proposal-id prefix/);
        const failure=vi.fn().mockResolvedValue(response(503));
        await expect(publish(record,{...options,requestFn:failure})).rejects.toThrow(/lookup failed/);
        expect(failure).toHaveBeenCalledOnce();
    });
    it('checks the stored artifact after creating a prepared building',async()=>{
        const requestFn=vi.fn().mockResolvedValueOnce(response(404))
            .mockResolvedValueOnce(response(201,{proposal:record,artifact:{binding:{coverage:'complete'},cadastreParcelIds:[]},preparationId:'ready'}))
            .mockResolvedValueOnce(response(201,{id:41}))
            .mockResolvedValueOnce(response(200,{...record,id:41}));
        await expect(publish(record,{...options,requestFn})).resolves.toMatchObject({skipped:false,id:41});
        expect(requestFn).toHaveBeenCalledTimes(4);
    });
});
