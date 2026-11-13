// The chain watcher (docs/blockchain-flows.md, "Browser and server pieces"): design and plan records
// minted on EVM chains (RecordRegistry, read through frontend/js/chain/evm-adapter.js) are imported
// into the index once their content is fetched from public IPFS and verified against the CID.
// Designs first, then plans, so a plan whose member designs are on a chain finds them indexed; a
// plan whose members are still missing is left for a later pass. Pure apart from its injected
// dependencies (oracle/chain-records-job.mjs wires the chains, IPFS, the index and the pool).

const KINDS = Object.freeze([['design', 'design/v1'], ['plan', 'plan/v1']]);
const TABLES = Object.freeze({ design: 'consensus.design', plan: 'consensus.plan' });

const emptyCounts = () => ({ listed: 0, indexed: 0, imported: 0, wouldImport: 0, refused: 0, unretrievable: 0, blocked: 0 });

async function indexedCids(pool, kind, cids) {
    if (!cids.length) return new Set();
    const { rows } = await pool.query(`SELECT cid FROM ${TABLES[kind]} WHERE cid = ANY($1::text[])`, [cids]);
    return new Set(rows.map(row => row.cid));
}

/**
 * One pass over `chains` (adapters with chainId, name and listRecords(kind)).
 * fetchContent(cid, schema) → { content } (verified against the CID; throws when not retrievable);
 * indexDesign({ cid, content }) and indexPlan({ cid, content }) → { refusal } or { status, row }.
 * Dry run unless `apply`: content is fetched and checked, nothing is indexed.
 * Resolves { designs, plans (counts), skipped: [{ kind, cid, chainId, reason, ... }], errors: [{ chainId?, kind?, cid?, error }] }.
 * `errors` are failures of the pass itself (a chain or the index unreachable); skipped records
 * (unretrievable, refused by the index, plans with missing members) are the records' own state.
 */
export async function syncChainRecords({ pool, chains, fetchContent, indexDesign, indexPlan, apply = false, log = () => {}, now = () => Date.now() } = {}) {
    const startedAt = now();
    const result = { designs: emptyCounts(), plans: emptyCounts(), skipped: [], errors: [] };
    const index = { design: indexDesign, plan: indexPlan };

    // Every chain's records, by kind; a CID minted on two chains is imported once.
    const listed = { design: new Map(), plan: new Map() };
    for (const chain of chains) {
        for (const [kind] of KINDS) {
            try {
                const rows = await chain.listRecords(kind);
                for (const row of rows) if (!listed[kind].has(row.cid)) listed[kind].set(row.cid, { ...row, chainId: chain.chainId });
                log(`${chain.name} (${chain.chainId}): ${rows.length} ${kind} record(s)`);
            } catch (error) {
                result.errors.push({ chainId: chain.chainId, kind, error: error.message });
                log(`${chain.name} (${chain.chainId}): listing ${kind} records FAILED: ${error.message}`);
            }
        }
    }

    // Designs a dry run would import count as present when checking a plan's members.
    const wouldIndex = new Set();
    for (const [kind, schema] of KINDS) {
        const counts = result[`${kind}s`];
        const records = [...listed[kind].values()];
        counts.listed = records.length;
        let present;
        try {
            present = await indexedCids(pool, kind, records.map(row => row.cid));
        } catch (error) {
            result.errors.push({ kind, error: error.message });
            log(`reading the ${kind} index FAILED: ${error.message}`);
            continue;
        }
        counts.indexed = present.size;
        const pending = records.filter(row => !present.has(row.cid));
        log(`${kind}s: ${records.length} on chain, ${present.size} indexed, ${pending.length} to import`);
        for (const [position, record] of pending.entries()) {
            const at = `${kind} ${position + 1}/${pending.length} ${record.cid} (chain ${record.chainId})`;
            let content;
            try {
                ({ content } = await fetchContent(record.cid, schema));
            } catch (error) {
                counts.unretrievable += 1;
                result.skipped.push({ kind, cid: record.cid, chainId: record.chainId, reason: error.code || 'unretrievable', error: error.message });
                log(`${at}: not retrievable (${error.code || error.message})`);
                continue;
            }
            if (kind === 'plan') {
                const members = Array.isArray(content.designCids) ? content.designCids : [];
                let indexed;
                try {
                    indexed = await indexedCids(pool, 'design', members);
                } catch (error) {
                    result.errors.push({ kind, cid: record.cid, error: error.message });
                    log(`${at}: reading its members FAILED: ${error.message}`);
                    continue;
                }
                const missing = members.filter(cid => !indexed.has(cid) && !wouldIndex.has(cid));
                if (missing.length) {
                    counts.blocked += 1;
                    result.skipped.push({ kind, cid: record.cid, chainId: record.chainId, reason: 'members-missing', missing });
                    log(`${at}: ${missing.length} member design(s) not indexed yet; left for a later pass`);
                    continue;
                }
            }
            if (!apply) {
                counts.wouldImport += 1;
                wouldIndex.add(record.cid);
                log(`${at}: retrievable, would import (dry run)`);
                continue;
            }
            let outcome;
            try {
                outcome = await index[kind]({ cid: record.cid, content });
            } catch (error) {
                result.errors.push({ kind, cid: record.cid, error: error.message });
                log(`${at}: indexing FAILED: ${error.message}`);
                continue;
            }
            if (outcome.refusal) {
                counts.refused += 1;
                const { status, body } = outcome.refusal;
                result.skipped.push({ kind, cid: record.cid, chainId: record.chainId, reason: body?.code || `http-${status}`, error: body?.error || null });
                log(`${at}: the index refused it (${status} ${body?.code || ''} ${body?.error || ''})`);
                continue;
            }
            counts.imported += outcome.status === 201 ? 1 : 0;
            if (outcome.status !== 201) counts.indexed += 1;
            log(`${at}: ${outcome.status === 201 ? 'imported' : 'already indexed'}`);
        }
    }
    log(`pass done in ${Math.round((now() - startedAt) / 1000)} s: designs ${JSON.stringify(result.designs)}, plans ${JSON.stringify(result.plans)}, ${result.errors.length} error(s)`);
    return result;
}

/** The run-stats artifact of one pass (CHAIN_RECORDS_RUN_STATS), in the shape of the land oracle's. */
export function buildChainRecordsRunStats({ startedAt, endedAt, result = null, error = null, dryRun = false, chains = [] } = {}) {
    const errors = error ? 1 : (result?.errors?.length || 0);
    const completed = errors === 0;
    const counts = kind => result?.[kind] || emptyCounts();
    return {
        version: 1,
        job: 'consensus-builder-chain-records',
        runStatus: completed ? 'completed' : 'failed',
        verdict: completed ? 'success' : 'failure',
        startedAt: startedAt || null,
        endedAt: endedAt || null,
        dryRun: Boolean(dryRun),
        chains,
        counters: {
            designsListed: counts('designs').listed,
            designsImported: counts('designs').imported,
            plansListed: counts('plans').listed,
            plansImported: counts('plans').imported,
            refused: counts('designs').refused + counts('plans').refused,
            unretrievable: counts('designs').unretrievable + counts('plans').unretrievable,
            blocked: counts('plans').blocked,
            errors
        },
        error: error ? String(error.message || error) : (errors ? result.errors.map(item => item.error).slice(0, 3).join('; ') : null)
    };
}
