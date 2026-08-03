// The owner's dossier (rethink-proposals.md §10, §12 step 3): one base parcel, every proposal
// claiming ground on it, triaged into the four consent channels —
//
//   acceptance  — the proposal takes or reshapes this parcel's RETAINED ground: binding, the veto
//   offer       — content proposed on ground the owner keeps: accept or decline
//   vote        — rules and vote-proposals: political, never per-owner vetoed
//   disclosure  — anything standing on ground this parcel already cedes to an EARLIER formation
//                 (the school on the strip taken for it), or a formation that reaches this
//                 parcel's ancestry but takes nothing measurable: prices the owner's decision on
//                 the ceding formation, not theirs to veto
//
// The acceptance/disclosure split is §10's chain rule made computable: walk the chain, track whose
// rights each step consumes. A take is a DISCLOSURE when it falls (within noise) inside ground an
// earlier-created formation already takes from this parcel — the owner's rights there are consumed
// by that earlier step, which is the one they accept or refuse. "Earlier" is creation time, the
// same total order A6 uses, so the deferral can never be circular.
//
// Plus the remainder report (decided 2026-08: remainders STAY with the owner — a formation owes
// disclosure of the fragments it leaves, never an automatic reshape): what is left of the parcel
// once every formation that cuts it has taken its ground, piece by piece.
//
// Pure: plain objects in and out, no DOM, no map. Callers supply live accessors via options.

(function (global) {
    'use strict';

    const planOrder = () => (global && global.__planOrder)
        ? global.__planOrder
        : (typeof require === 'function' ? require('./plan-order.js') : null);
    const claims = () => (global && global.__claims)
        ? global.__claims
        : (typeof require === 'function' ? require('./claims.js') : null);
    const ownershipFlow = () => (global && global.__ownershipFlow)
        ? global.__ownershipFlow
        : (typeof require === 'function' ? require('./ownership-flow.js') : null);

    const T = () => (typeof turf !== 'undefined' && turf)
        ? turf
        : (typeof require === 'function' ? require('@turf/turf') : null);

    const CHANNELS = Object.freeze(['acceptance', 'offer', 'vote', 'disclosure']);
    const CHANNEL_RANK = Object.freeze({ acceptance: 4, offer: 3, vote: 2, disclosure: 1 });

    function compareCreation(a, b) {
        const at = Date.parse(a && a.createdAt) || 0;
        const bt = Date.parse(b && b.createdAt) || 0;
        if (at !== bt) return at - bt;
        return String(a && a.id).localeCompare(String(b && b.id));
    }

    // The flow to triage against: the published stamp when present, else computed from geometry
    // against whatever base parcels the caller supplies (may be [] — then formations triage as
    // "takes nothing measurable", which is the honest reading of no data).
    function flowOf(proposal, baseParcels) {
        if (Array.isArray(proposal && proposal.ownershipFlow)) return proposal.ownershipFlow;
        const flowApi = ownershipFlow();
        if (!flowApi) return [];
        try { return flowApi.computeOwnershipFlow(proposal, baseParcels || []); } catch (_) { return []; }
    }

    // How much of `footprint`'s overlap with the parcel lies inside earlier formations' ground.
    // Returns { takeM2, deferredM2 } — deferredM2 counts only overlap with formations that precede
    // `self` in creation order (and are not self).
    function deferredTake(footprint, parcelFeature, cedingFlows, self, api) {
        const t = T();
        if (!t || !footprint || !parcelFeature) return null;
        let take = null;
        try { take = t.intersect(footprint, parcelFeature); } catch (_) { return null; }
        if (!take) return { takeM2: 0, deferredM2: 0 };
        const takeM2 = t.area(take);

        let earlierGround = null;
        (Array.isArray(cedingFlows) ? cedingFlows : []).forEach(ceding => {
            if (!ceding || !ceding.footprint) return;
            if (self && String(ceding.id) === String(self.id)) return;
            if (self && compareCreation(ceding, self) >= 0) return; // only EARLIER steps consume first
            try {
                earlierGround = earlierGround
                    ? (t.union(earlierGround, ceding.footprint) || earlierGround)
                    : ceding.footprint;
            } catch (_) { /* keep what we have */ }
        });
        if (!earlierGround) return { takeM2, deferredM2: 0 };
        const deferredM2 = api.intersectionArea(take, earlierGround);
        return { takeM2, deferredM2 };
    }

    // Which channel one proposal lands in for one parcel root. `ctx`:
    //   flow          — this proposal's ownership flow entries
    //   isVote        — the app's real vote predicate (isVoteProposal)
    //   cedingFlows   — [{ id, createdAt, footprint, cededM2 }] of formations ceding this ground
    //   parcelFeature — the parcel's polygon, for the on-ceded-ground geometry checks
    function channelFor(proposal, parcelRoot, ctx) {
        const api = planOrder();
        const flowApi = ownershipFlow();
        const context = ctx || {};
        const isVote = typeof context.isVote === 'function'
            ? context.isVote
            : (p => !!(p && p.isVote === true));
        const goal = String(proposal && proposal.goal !== undefined && proposal.goal !== null ? proposal.goal : '').trim();

        // Rules are political whatever ground they touch; votes reuse the same channel.
        if (goal === 'urban-rule' || isVote(proposal)) return 'vote';

        const flow = Array.isArray(context.flow) ? context.flow : [];
        const mine = flow.find(entry => entry && String(entry.parcelId) === String(parcelRoot));
        const myTakeM2 = mine ? Math.round(Number(mine.cededM2) || 0) : 0;

        let footprint = null;
        if (api) { try { footprint = api.footprintOf(proposal); } catch (_) { footprint = null; } }

        if (myTakeM2 > 0) {
            // A take wholly on ground an earlier formation already consumes defers to that step.
            // When geometry for the check is missing, ASK — over-asking the owner is the safe
            // direction, silently skipping them is the §3.5 bug.
            const split = deferredTake(footprint, context.parcelFeature, context.cedingFlows,
                { id: proposal && proposal.proposalId, createdAt: proposal && proposal.createdAt }, api);
            if (split && api && (split.takeM2 - split.deferredM2) < api.MIN_INTERSECTION_M2) {
                return 'disclosure';
            }
            return 'acceptance';
        }

        // A formation that reaches this parcel's ancestry but takes nothing measurable from it is
        // information, not a demand.
        if (flowApi && flowApi.hasFormation(goal)) return 'disclosure';

        // Non-forming content (an offer, a purchase): on ceded ground it is a disclosure, on
        // retained ground — or with no footprint at all — an offer addressed to the owner.
        if (api && footprint && Array.isArray(context.cedingFlows) && context.cedingFlows.length) {
            const t = T();
            for (const ceding of context.cedingFlows) {
                if (!ceding || !ceding.footprint) continue;
                try {
                    const overlap = t ? t.intersect(footprint, ceding.footprint) : null;
                    if (!overlap) continue;
                    const within = context.parcelFeature
                        ? api.intersectionArea(overlap, context.parcelFeature)
                        : (t ? t.area(overlap) : 0);
                    if (within >= api.MIN_INTERSECTION_M2) return 'disclosure';
                } catch (_) { /* a degenerate footprint cannot reclassify the entry */ }
            }
        }
        return 'offer';
    }

    // What is left of the parcel once the given formation footprints have taken their ground.
    // Returns { takenM2, remainderM2, pieces: [{ areaM2 }] } (pieces largest-first), or null when
    // there is nothing to subtract or the geometry is unusable.
    function remainderReport(parcelFeature, formationFootprints) {
        const t = T();
        const footprints = (Array.isArray(formationFootprints) ? formationFootprints : []).filter(Boolean);
        if (!t || !parcelFeature || !footprints.length) return null;
        try {
            let taken = null;
            footprints.forEach(fp => {
                try { taken = taken ? (t.union(taken, fp) || taken) : fp; } catch (_) { /* keep what we have */ }
            });
            if (!taken) return null;
            const takenPart = t.intersect(parcelFeature, taken);
            const takenM2 = takenPart ? Math.round(t.area(takenPart)) : 0;
            if (takenM2 < 1) return null;
            const leftover = t.difference(parcelFeature, taken);
            const geometry = leftover && leftover.geometry;
            const polys = !geometry ? []
                : geometry.type === 'Polygon' ? [t.feature(geometry)]
                    : geometry.type === 'MultiPolygon' ? geometry.coordinates.map(c => t.polygon(c))
                        : [];
            const pieces = polys
                .map(piece => ({ areaM2: Math.round(t.area(piece)) }))
                .filter(piece => piece.areaM2 >= 1)
                .sort((a, b) => b.areaM2 - a.areaM2);
            return {
                takenM2,
                remainderM2: pieces.reduce((sum, piece) => sum + piece.areaM2, 0),
                pieces
            };
        } catch (_) {
            return null;
        }
    }

    // The dossier itself. `proposals` is every proposal the caller knows about; membership is by
    // base ancestry (the claims-rescue rule). Options:
    //   isVote, isApplied — the app's real predicates
    //   baseParcels       — [{ id, feature }] for computing unstamped flows
    //   parcelFeature     — this parcel's polygon (enables the ceded-ground checks + remainder)
    //   assumeMembership  — the caller already decided which proposals belong (e.g. the parcel
    //                       panel's list, which adds geometry rescues the ancestry filter would
    //                       miss); triage the given list as-is.
    function buildDossier(parcelId, proposals, options) {
        const api = planOrder();
        const claimsApi = claims();
        const opts = options || {};
        const root = api ? api.cadastreRootId(parcelId) : String(parcelId || '');
        const empty = { root, entries: [], remainder: null };
        if (!root || !claimsApi) return empty;

        const isApplied = typeof opts.isApplied === 'function'
            ? opts.isApplied
            : (p => !!(p && p.applied === true));

        const list = (Array.isArray(proposals) ? proposals : []).filter(Boolean);
        const members = opts.assumeMembership === true
            ? list
            : list.filter(p => claimsApi.baseParcelIdsOf(p).indexOf(root) !== -1);
        if (!members.length) return empty;

        // Flows first: the ceding formations are context for every entry's triage.
        const flows = new Map();
        members.forEach(p => flows.set(p, flowOf(p, opts.baseParcels)));
        const cedingFlows = [];
        members.forEach(p => {
            const entry = (flows.get(p) || []).find(f => f && String(f.parcelId) === root
                && Math.round(Number(f.cededM2) || 0) > 0);
            if (!entry || !api) return;
            let footprint = null;
            try { footprint = api.footprintOf(p); } catch (_) { footprint = null; }
            if (footprint) {
                cedingFlows.push({
                    id: p.proposalId ? String(p.proposalId) : '',
                    createdAt: p.createdAt || null,
                    footprint,
                    cededM2: entry.cededM2
                });
            }
        });

        const entries = members.map(p => {
            const flow = flows.get(p) || [];
            const mine = flow.find(f => f && String(f.parcelId) === root) || null;
            const channel = channelFor(p, root, {
                flow,
                isVote: opts.isVote,
                cedingFlows,
                parcelFeature: opts.parcelFeature
            });
            return {
                proposalId: p.proposalId ? String(p.proposalId) : null,
                serverProposalId: p.serverProposalId ? String(p.serverProposalId) : null,
                title: p.title || p.name || '',
                goal: p.goal || '',
                channel,
                cededM2: mine ? Math.round(Number(mine.cededM2) || 0) : 0,
                destination: mine ? String(mine.destination || '') : null,
                applied: !!isApplied(p)
            };
        });
        entries.sort((a, b) => (CHANNEL_RANK[b.channel] - CHANNEL_RANK[a.channel])
            || (b.cededM2 - a.cededM2)
            || String(a.title).localeCompare(String(b.title)));

        // The remainder subtracts only the ground of ACCEPTANCE-channel formations: a deferred
        // (disclosure) take lies inside an earlier formation's ground, so unioning it in would
        // double-subtract nothing but would misattribute who took it.
        const acceptedIds = new Set(entries.filter(e => e.channel === 'acceptance').map(e => e.proposalId));
        const remainder = remainderReport(
            opts.parcelFeature,
            cedingFlows.filter(c => acceptedIds.has(c.id)).map(c => c.footprint)
        );

        return { root, entries, remainder };
    }

    const api = { CHANNELS, CHANNEL_RANK, channelFor, remainderReport, buildDossier };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__dossier = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
