// Place a design into an agent's working plan with the browser's apply rules (docs/agent-working-plan.md):
// a road joins the plan's roads, an explicit Apply's rival rule decides which members stand on its
// ground, and the formation order decides which ground a road cuts. Pure: returns the new membership
// and what changed, and never takes a member off the plan unless the caller displaces it.
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installAppGeometry } from './mcp-geometry.js';
import { cidOfObject } from './agreement-objects.js';
import { joinEditedRoad, joinNewRoads } from './mcp-road-network.js';
import { describeRoadCuts } from './mcp-ground-effects.js';

const root = new URL('../../frontend/js/', import.meta.url);
// claims.js and plan-order.js read turf and their sibling modules from the page; this host gives them the app's.
const context = createContext({ console, structuredClone });
installAppGeometry(context);
context.window = context;
for (const path of ['proposals/footprint-parts.js', 'proposals/parcel-arrangement.js', 'proposals/plan-order.js', 'proposals/claims.js']) {
    context.__moduleRequire = createRequire(new URL(path, root));
    runInContext(`(function(require) {\n${readFileSync(new URL(path, root), 'utf8')}\n})(__moduleRequire);`, context, { filename: path, timeout: 10_000 });
}
const claims = context.__claims;
const planOrder = context.__planOrder;

const isCorridor = content => Boolean(content?.roadProposal);
// A plan member as the browser's apply sees an applied record.
const record = row => ({ ...row.content, proposalId: row.cid, createdAt: row.content.authoredAt, applied: true });
const round = value => Math.round(value * 100) / 100;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/**
 * members:  [{ cid, content, parcelSourceId }] the plan's designs
 * incoming: { cid, content, parcelSourceId } the design to place
 * before:   the member cid this design revises (an edit), or null for a new member
 * displace: take members standing on the incoming ground off the plan instead of refusing
 */
export function placeInPlan({ members, incoming, before = null, displace = false }) {
    if (before && !members.some(row => row.cid === before)) fail('plan-member-not-found', 'The edited design is not a member of this plan.');
    const others = members.filter(row => row.cid !== before && row.cid !== incoming.cid);
    let placed = incoming;
    const junctions = [];
    let membership = others;
    if (isCorridor(incoming.content)) {
        const corridors = others.filter(row => isCorridor(row.content));
        const beforeRow = before ? members.find(row => row.cid === before) : null;
        const joined = beforeRow && isCorridor(beforeRow.content)
            ? joinEditedRoad(beforeRow.content, incoming.content, corridors, incoming.content.authoredAt)
            : joinNewRoads([incoming.content], corridors, incoming.content.authoredAt);
        const design = joined.design || joined.designs[0];
        placed = { ...incoming, cid: cidOfObject(design), content: design };
        const revised = new Map(joined.revisions.map(row => [row.before.cid, row]));
        membership = others.map(row => revised.has(row.cid)
            ? { cid: revised.get(row.cid).cid, content: revised.get(row.cid).design, parcelSourceId: row.parcelSourceId }
            : row);
        junctions.push(...joined.changes.map(change => ({ beforeCid: change.beforeCid, afterCid: change.afterCid, title: change.title })));
    }

    const incomingRecord = record(placed);
    const target = planOrder.footprintOf(incomingRecord);
    const rivals = claims.appliedRivals(incomingRecord, membership.map(record), { replaceOccupiedGround: true, planOrder })
        .map(rival => {
            const row = membership.find(member => member.cid === rival.proposalId);
            const footprint = planOrder.footprintOf(rival);
            return { cid: row.cid, title: row.content.title || null, goal: row.content.goal || null,
                overlapM2: round(target && footprint ? planOrder.intersectionArea(target, footprint) : 0) };
        });
    if (rivals.length && !displace) {
        const names = rivals.map(rival => `"${rival.title || rival.cid}"`).join(', ');
        return { placement: { status: 'refused', code: 'ground-occupied', conflicts: rivals,
            message: `It stands on ground that ${rivals.length === 1 ? 'this plan design holds' : 'these plan designs hold'}: ${names}. Ask the person: move it clear, or place it with displace to take ${rivals.length === 1 ? 'that design' : 'them'} off the plan.` },
            design: placed, members, consequences: { removed: [], junctions: [], cuts: [] } };
    }
    const removed = new Set(rivals.map(rival => rival.cid));
    const next = [...membership.filter(row => !removed.has(row.cid)), placed];
    const involved = new Set([placed.cid]);
    const cuts = describeRoadCuts(next).filter(effect => involved.has(effect.designCid) || involved.has(effect.roadCid))
        .map(effect => ({ designCid: effect.designCid, designTitle: effect.designTitle, surfaceKind: effect.surfaceKind,
            roadCid: effect.roadCid, roadTitle: effect.roadTitle, overlapM2: effect.overlapM2,
            remainingAreaM2: effect.remainingAreaM2AfterAllRoadCuts }));
    return { placement: { status: 'placed' }, design: placed, members: next,
        consequences: { removed: rivals, junctions, cuts } };
}
