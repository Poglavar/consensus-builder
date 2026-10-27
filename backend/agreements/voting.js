// Votes are scoped to an immutable agreement and its fixed code hashes. Possession permits history and revision.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isCid} from '../cid.js';
const require=createRequire(import.meta.url);
const V=require('../../frontend/js/community/voting.js');
const digest=value=>createHash('sha256').update(value).digest('hex');
const error=(status,code,message,extra={})=>({status,body:{code,error:message,...extra}});
const success=body=>({status:200,body});
const closed=(agreement,now)=>Boolean(agreement.content.deadline && Date.parse(agreement.content.deadline)<=now);
export function createVotingService({store,loadAgreement,now=()=>Date.now()}) {
    async function subject(cid) {
        if(!isCid(cid)) return {failure:error(400,'invalid-cid','Choose a published agreement.')};
        const agreement=await loadAgreement(cid);
        if(!agreement) return {failure:error(404,'agreement-not-found','Agreement not found.')};
        if(agreement.content.rule?.electorate!=='community' || agreement.content.rule.binding) return {failure:error(400,'not-community','Code voting belongs to community agreements.')};
        return {agreement};
    }
    async function summary(tx,agreement) {
        const config=V.configuration(agreement.content.consultation?.voting);
        const counts={support:0,oppose:0,abstain:0};
        for(const row of await tx.counts()) counts[row.choice]=row.count;
        return {agreementCid:agreement.cid,enabled:Boolean(config),eligible:config?.codeHashes.length || 0,
            votes:Object.values(counts).reduce((a,b)=>a+b,0),counts,deadline:agreement.content.deadline,closed:closed(agreement,now())};
    }
    async function view(tx,agreement,hash) {
        return {...await summary(tx,agreement),entry:{...await tx.ballot(hash),history:await tx.history(hash)}};
    }
    return {
        async summary(cid) {
            const {agreement,failure}=await subject(cid);
            return failure || store.transaction(cid,async tx=>success(await summary(tx,agreement)));
        },
        async access(cid,body,ip,cast=false) {
            const keys=cast?['code','choice','expectedVersion','requestId']:['code'];
            if(!V.exact(body,keys) || typeof body.code!=='string' || body.code.length>100
                || (cast && (!V.CHOICES.includes(body.choice) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion<0 || !V.UUID.test(body.requestId)))) return error(400,'bad-request','Invalid voting request.');
            const {agreement,failure}=await subject(cid);if(failure)return failure;
            const config=V.configuration(agreement.content.consultation?.voting);
            if(!config) return error(409,'voting-disabled','This agreement has no voting codes.');
            const scope='ip:'+digest(String(ip));
            // Reserve a bounded authentication attempt BEFORE the expensive KDF. Shared database
            // counters stop both parallel requests and API-process restarts bypassing the delay.
            const gate=await store.transaction(cid,async tx=>{
                const retry=Math.max(await tx.throttle(scope,now(),20,true,false),await tx.throttle('failures',now(),1000,false,false));
                if(retry)return retry;
                return Math.max(await tx.throttle('requests:'+digest(String(ip)),now(),120,false),
                    await tx.throttle('all-requests',now(),1500,false));
            });
            if(gate)return error(429,'try-later','Please wait before trying another code.',{retryAfter:gate});
            let hash;try{hash=await V.codeHash(config.id,body.code);}catch{hash='invalid';}
            return store.transaction(cid,async tx=>{
                if(!config.codeHashes.includes(hash)) {
                    const wait=Math.max(await tx.throttle(scope,now(),20,true),await tx.throttle('failures',now(),1000,false));
                    return error(401,'invalid-code','That code was not recognised. Check the letters and try again.',{retryAfter:wait});
                }
                if(!cast)return success(await view(tx,agreement,hash));
                const entry=await tx.ballot(hash),history=await tx.history(hash);
                const previous=history.find(event=>event.requestId===body.requestId);
                if(previous)return previous.choice===body.choice?success({...await view(tx,agreement,hash),duplicate:true}):error(409,'request-conflict','This request ID was used for a different vote.');
                if(closed(agreement,now()))return error(409,'voting-closed','Voting has closed. The history remains available.');
                if(entry.version!==body.expectedVersion)return error(409,'vote-changed','The vote changed. Read the history before submitting again.');
                if(entry.choice===body.choice)return success(await view(tx,agreement,hash));
                const last=history.at(-1);
                if(last && now()-Date.parse(last.occurredAt)<1000)return error(429,'try-later','Please wait before changing your vote again.',{retryAfter:1});
                entry.version++;entry.choice=body.choice;await tx.update(hash,entry);
                await tx.append(hash,{version:entry.version,choice:entry.choice,requestId:body.requestId,occurredAt:new Date(now()).toISOString()});
                return success(await view(tx,agreement,hash));
            });
        }
    };
}
export function setupVotingRoutes(app,{store,loadAgreement,now,limiter}) {
    const service=createVotingService({store,loadAgreement,now});
    app.use('/agreements/:cid/voting',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
    const handler=work=>async(req,res)=>{
        res.set('Cache-Control','no-store');
        try {
            const result=await work(req);
            if(result.body.retryAfter)res.set('Retry-After',String(result.body.retryAfter));
            res.status(result.status).json(result.body);
        }catch(e){
            console.error(`[${new Date().toISOString()}] Voting request failed (${e.code || 'internal'}).`);
            res.status(500).json({code:'voting-unavailable',error:'Voting is temporarily unavailable. Please retry.'});
        }
    };
    app.get('/agreements/:cid/voting',limiter,handler(req=>service.summary(req.params.cid)));
    app.post('/agreements/:cid/voting/access',limiter,handler(req=>service.access(req.params.cid,req.body,req.ip)));
    app.post('/agreements/:cid/voting/ballot',limiter,handler(req=>service.access(req.params.cid,req.body,req.ip,true)));
}
