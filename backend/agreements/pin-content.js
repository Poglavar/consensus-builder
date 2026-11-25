// Content before the mint (docs/ipfs-storage.md): the index and IPFS are separate stores. Publishing
// writes only to the index; a mint commits to the agreement's CID and, through the CIDs inside each
// record, to its plan and the plan's designs, so all of them are pinned before it (POST
// /agreements/:cid/pin). A CID already in consensus.ipfs_pin is skipped (a design shared by several
// agreements is pinned once) and nothing is ever unpinned. Every object is pinned from the index's own
// copy only when its canonical bytes hash to its CID, and recorded only once the provider confirmed that
// CID. One object's failure is recorded and the rest carry on.

import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { pinBytes as defaultPinBytes } from '../storage/pinning.js';

/** The index reads and the one write the pass needs, over PostgreSQL. */
export function createPinStore(pool) {
    const byCid = async (table, cids) => cids.length
        ? (await pool.query(`SELECT cid, content FROM consensus.${table} WHERE cid = ANY($1)`, [cids])).rows
        : [];
    return {
        agreement: async cid => (await byCid('agreement', [cid]))[0] || null,
        plans: cids => byCid('plan', cids),
        designs: cids => byCid('design', cids),
        async pinnedCids(cids) {
            if (!cids.length) return new Set();
            const { rows } = await pool.query('SELECT cid FROM consensus.ipfs_pin WHERE cid = ANY($1)', [cids]);
            return new Set(rows.map(row => row.cid));
        },
        async recordPin({ cid, kind, pinnedAt }) {
            await pool.query(`INSERT INTO consensus.ipfs_pin (cid, kind, pinned_at) VALUES ($1, $2, $3)
                ON CONFLICT (cid) DO NOTHING`, [cid, kind, pinnedAt]);
        }
    };
}

/** Every object the given agreements reference, agreement first, each CID once, plus the CIDs
 * referenced but missing from the index (they cannot be pinned from here). */
export async function mintedTree(store, agreements) {
    const objects = new Map();
    const missing = [];
    for (const row of agreements) objects.set(row.cid, { kind: 'agreement', cid: row.cid, content: row.content });
    const planCids = [...new Set(agreements.map(row => row.content?.planCid).filter(isCid))];
    for (const row of agreements) {
        if (!isCid(row.content?.planCid)) missing.push({ kind: 'plan', cid: null, referencedBy: row.cid });
    }
    const plans = new Map((await store.plans(planCids)).map(row => [row.cid, row]));
    for (const cid of planCids) {
        const plan = plans.get(cid);
        if (plan) objects.set(cid, { kind: 'plan', cid, content: plan.content });
        else missing.push({ kind: 'plan', cid });
    }
    const designCids = [...new Set([...plans.values()].flatMap(plan => (Array.isArray(plan.content?.designCids) ? plan.content.designCids : [])).filter(isCid))];
    const designs = new Map((await store.designs(designCids)).map(row => [row.cid, row]));
    for (const cid of designCids) {
        const design = designs.get(cid);
        if (design) objects.set(cid, { kind: 'design', cid, content: design.content });
        else missing.push({ kind: 'design', cid });
    }
    return { objects: [...objects.values()], missing };
}

/**
 * Pins whatever the agreements reference that is not pinned yet.
 * @param {{ store, agreements: {cid, content}[], pinBytes?: Function, log?: Function }} options
 * @returns {Promise<{ objects: {kind, cid}[], referenced: number, alreadyPinned: number, pinned: object[],
 *   failed: object[], missing: object[] }>}
 */
export async function pinAgreementTrees({ store, agreements, pinBytes = defaultPinBytes, log = () => {} }) {
    const { objects, missing } = await mintedTree(store, agreements);
    const pinnedBefore = await store.pinnedCids(objects.map(object => object.cid));
    const todo = objects.filter(object => !pinnedBefore.has(object.cid));
    const result = { objects: objects.map(({ kind, cid }) => ({ kind, cid })), referenced: objects.length,
        alreadyPinned: objects.length - todo.length, pinned: [], failed: [], missing };
    for (const item of missing) log(`pin: ${item.kind} ${item.cid ?? `(none named by ${item.referencedBy})`} is referenced but not in the index`);
    for (const [index, object] of todo.entries()) {
        const step = `pin ${index + 1}/${todo.length} ${object.kind} ${object.cid}`;
        try {
            const bytes = canonicalBytes(object.content);
            const computed = cidOf(bytes);
            if (computed !== object.cid) throw new Error(`the index copy hashes to ${computed}`);
            const pinned = await pinBytes({ bytes, name: `${object.kind}-${object.cid}`, cid: object.cid });
            await store.recordPin({ cid: object.cid, kind: object.kind, pinnedAt: pinned.pinnedAt });
            result.pinned.push({ kind: object.kind, cid: object.cid, bytes: bytes.length });
            log(`${step}: pinned (${bytes.length} bytes)`);
        } catch (error) {
            result.failed.push({ kind: object.kind, cid: object.cid, error: error.message });
            log(`${step}: FAILED ${error.message}`);
        }
    }
    return result;
}
