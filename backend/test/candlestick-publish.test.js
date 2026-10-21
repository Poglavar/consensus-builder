// Verify idempotent readback of ordinary Freeform buildings. Creating one went with the server's
// proposal writes (POST /proposals/prepare and POST /proposals, plan-design-agreement.md M2), so only
// the restart check against an existing record is covered.
import { describe, expect, it, vi } from 'vitest';
import { publish } from '../scripts/lib/candlestick-common.mjs';

const response = (status, json = null) => ({ status, json, text: '' });

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
});
