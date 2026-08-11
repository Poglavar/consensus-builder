// Purpose: answer "why is this parcel not cut by the road crossing it?" from the console, in one
// call, with facts instead of inference — `whyIsParcelUncut('HR-330264-519')`.
//
// A parcel's pieces are a function of that parcel and the takes over it, and every step of that
// function can fail quietly: the parcel may not be loaded, no applied corridor may claim to reach
// it, the overlap may fall under the minimum piece area, the arrangement may throw and be recorded
// as "left untouched", or the pieces may exist and simply not be on the map. Each of those looks
// identical on screen — a whole parcel under a road — so this walks the chain and says which one it
// is.
(function attachParcelCutDebug(global) {
    'use strict';

    function report(parcelId) {
        const A = global.__parcelArrangement;
        const ancestry = global.__cadastreAncestry;
        const planOrder = global.__planOrder;
        const turf = global.turf;
        const id = String(parcelId || '');
        const out = { parcelId: id };
        if (!A || !ancestry || !planOrder || !turf) {
            out.verdict = 'The arrangement engine is not loaded in this page.';
            return out;
        }

        const loaded = ancestry.loadedCadastreParcels();
        const entry = loaded.find(candidate => String(candidate.id) === id);
        out.loadedCadastreParcels = loaded.length;
        if (!entry) {
            const pieces = (global.parcelLayerById instanceof Map)
                ? Array.from(global.parcelLayerById.keys()).filter(key => String(key).split('#')[0] === id)
                : [];
            out.piecesOnMap = pieces;
            out.verdict = pieces.length
                ? `Not a cadastral parcel here — it is already cut into ${pieces.length} piece(s).`
                : 'That parcel is not loaded in this session (nothing can derive it).';
            return out;
        }
        out.areaM2 = Math.round(turf.area(entry.feature));

        // Every applied corridor's take, and which of them claim to reach this parcel.
        const takes = (global.proposalStorage?.getAllProposals?.() || [])
            .filter(proposal => proposal?.roadProposal && proposal.applied === true)
            .map(proposal => {
                let geometry = null;
                try { geometry = planOrder.footprintOf(proposal); } catch (_) { geometry = null; }
                return {
                    id: String(proposal.proposalId),
                    title: proposal.title || String(proposal.proposalId),
                    geometry: geometry && geometry.geometry ? geometry : null
                };
            });
        out.appliedCorridors = takes.length;
        out.corridorsWithoutFootprint = takes.filter(take => !take.geometry).map(take => take.title);

        const usable = takes.filter(take => take.geometry);
        const overlapping = A.takesOverlapping(entry.feature, usable);
        out.takesReachingIt = overlapping.map(take => take.title);

        // How much each corridor actually covers — a near miss and a real crossing look the same on
        // screen, and anything under MIN_PIECE_M2 is deliberately not a cut.
        out.overlapM2 = usable.map(take => {
            let m2 = 0;
            try {
                const hit = turf.intersect(entry.feature, take.geometry.geometry ? take.geometry : turf.feature(take.geometry));
                m2 = hit ? turf.area(hit) : 0;
            } catch (error) { m2 = `error: ${error && error.message}`; }
            return { road: take.title, m2: typeof m2 === 'number' ? Math.round(m2 * 100) / 100 : m2 };
        }).filter(row => row.m2 !== 0).sort((a, b) => (b.m2 || 0) - (a.m2 || 0)).slice(0, 8);
        out.minimumPieceM2 = A.MIN_PIECE_M2;

        if (!overlapping.length) {
            out.verdict = out.overlapM2.length
                ? `No corridor reaches it by more than ${A.MIN_PIECE_M2} m² — the biggest overlap is ${out.overlapM2[0].m2} m² ("${out.overlapM2[0].road}").`
                : 'No applied corridor overlaps this parcel at all. Its footprint is elsewhere, or the road has no stored footprint (see corridorsWithoutFootprint).';
            return out;
        }

        // What the engine says the pieces SHOULD be, right now.
        const { pieces, failed } = A.fabricOver([entry], overlapping);
        out.wouldBePieces = pieces.map(piece => piece.id);
        out.arrangementFailed = failed;
        if (failed && failed.length) {
            out.verdict = `The arrangement THROWS for this parcel, so it is left untouched: ${failed[0].error}`;
            return out;
        }
        const derived = pieces.filter(piece => piece.id !== piece.parcelId);
        if (!derived.length) {
            out.verdict = 'The engine arranges it as one whole parcel — the takes do not divide it (they may only touch its edge).';
            return out;
        }

        const onMap = (global.parcelLayerById instanceof Map)
            ? Array.from(global.parcelLayerById.keys()).filter(key => String(key).split('#')[0] === id && String(key) !== id)
            : [];
        out.piecesOnMap = onMap;
        out.verdict = onMap.length
            ? `It IS cut — ${onMap.length} piece(s) are on the map. What you selected is the cadastral parent.`
            : `It SHOULD be cut into ${derived.length} piece(s) and none are on the map — the derivation never ran over it. `
                + 'Run ProposalManager.deriveArrivingParcels(["' + id + '"]) to cut it now.';
        return out;
    }

    global.whyIsParcelUncut = (parcelId) => {
        const out = report(parcelId);
        console.log(`[whyIsParcelUncut] ${out.parcelId}: ${out.verdict}`, out);
        return out;
    };
})(typeof window !== 'undefined' ? window : globalThis);
