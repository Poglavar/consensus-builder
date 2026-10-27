// Shared PostgreSQL locks make ballot updates and guessing limits atomic across API workers.
const prefix='consensus.community_voting_';
export function createVotingStore(pool) {
    return {
        async transaction(cid,work) {
            const db=await pool.connect();
            try {
                await db.query('BEGIN');
                await db.query('SELECT pg_advisory_xact_lock(480405,hashtext($1))',[cid]);
                const result=await work({
                    async counts() { return (await db.query(`SELECT choice,count(*)::integer AS count FROM ${prefix}ballot WHERE agreement_cid=$1 AND choice IS NOT NULL GROUP BY choice`,[cid])).rows; },
                    async ballot(hash) { return (await db.query(`SELECT version,choice FROM ${prefix}ballot WHERE agreement_cid=$1 AND code_hash=$2`,[cid,hash])).rows[0] || {version:0,choice:null}; },
                    async update(hash,ballot) { await db.query(`INSERT INTO ${prefix}ballot(agreement_cid,code_hash,version,choice) VALUES($1,$2,$3,$4)
                        ON CONFLICT(agreement_cid,code_hash) DO UPDATE SET version=$3,choice=$4,updated_at=now()`,[cid,hash,ballot.version,ballot.choice]); },
                    async history(hash) { return (await db.query(`SELECT version,choice,request_id AS "requestId",occurred_at AS "occurredAt" FROM ${prefix}event WHERE agreement_cid=$1 AND code_hash=$2 ORDER BY version`,[cid,hash])).rows.map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()})); },
                    async append(hash,event) { await db.query(`INSERT INTO ${prefix}event(agreement_cid,code_hash,version,choice,request_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6)`,[cid,hash,event.version,event.choice,event.requestId,event.occurredAt]); },
                    async throttle(scope,now,limit,delayed,consume=true) {
                        const key=`${cid}:${scope}`;
                        const row=(await db.query(`SELECT attempts,window_at,blocked_until FROM ${prefix}throttle WHERE scope=$1`,[key])).rows[0];
                        const fresh=!row || now-new Date(row.window_at).getTime()>=300000;
                        const attempts=fresh?0:row.attempts, until=fresh?0:new Date(row.blocked_until).getTime();
                        if(until>now) return Math.ceil((until-now)/1000);
                        if(!consume) return 0;
                        const next=attempts+1;
                        const windowAt=fresh?new Date(now):row.window_at;
                        const delay=next>=limit?Math.max(1000,300000-(now-new Date(windowAt).getTime()))
                            :delayed?Math.min(60000,1000*2**Math.min(6,next-1)):0;
                        await db.query(`INSERT INTO ${prefix}throttle(scope,attempts,window_at,blocked_until) VALUES($1,$2,$3,$4)
                            ON CONFLICT(scope) DO UPDATE SET attempts=$2,window_at=$3,blocked_until=$4,updated_at=now()`,[key,next,windowAt,new Date(now+delay)]);
                        // Expired limiter bookkeeping is disposable; ballot history is never pruned.
                        await db.query(`DELETE FROM ${prefix}throttle WHERE updated_at<now()-interval '1 day' AND blocked_until<now()`);
                        return Math.ceil(delay/1000);
                    }
                });
                await db.query('COMMIT');return result;
            } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
        }
    };
}
