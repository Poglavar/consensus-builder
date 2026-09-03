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
            const fabric = global.LiveParcelFabric;
            const pieces = fabric && typeof fabric.entriesForCadastre === 'function'
                ? fabric.entriesForCadastre([id], { includeCorridors: true }).map(feature => fabric.featureId(feature))
                : [];
            out.livePieces = pieces;
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

        const fabric = global.LiveParcelFabric;
        const presenter = global.ParcelPresenter;
        const onMap = fabric && typeof fabric.entriesForCadastre === 'function'
            ? fabric.entriesForCadastre([id], { includeCorridors: true })
                .map(feature => fabric.featureId(feature))
                .filter(pieceId => pieceId !== id && presenter?.getLayer?.(pieceId))
            : [];
        out.piecesOnMap = onMap;
        out.verdict = onMap.length
            ? `It IS cut — ${onMap.length} piece(s) are on the map. What you selected is the cadastral parent.`
            : `INVARIANT FAILURE: it should be cut into ${derived.length} piece(s), but the committed live fabric has none. `
                + 'Cadastral ground must enter through CadastralParcelRepository and its atomic integration callback.';
        return out;
    }

    global.whyIsParcelUncut = (parcelId) => {
        const out = report(parcelId);
        console.log(`[whyIsParcelUncut] ${out.parcelId}: ${out.verdict}`, out);
        return out;
    };

    // "Why can I not click here?" — everything the map knows about one point on the ground.
    //
    // Ground with nothing to click is ground with no parcel UNDER THE POINTER, and there are several
    // ways to arrive at that, all of which look identical: the cadastre was never fetched for that
    // cell; a parcel is there but hidden because something derived claims it, and the derived pieces
    // never arrived; or a structure razed the fabric and put its own non-interactive surface down.
    // So this reports what covers the point, what is hidden under it, and which applied records
    // claim it, rather than making you infer from an empty patch.
    //
    // No arguments: the centre of the map, so you can pan the dead spot into the middle and ask.
    // Async because the last question — does the CADASTRE have anything here — is the backend's.
    async function whatIsHere(lat, lng) {
        const turf = global.turf;
        const out = { covering: [], hidden: [], claimedBy: [] };
        if (!turf || typeof global.map === 'undefined' || !global.map) {
            out.verdict = 'The map or turf is not loaded in this page.';
            console.warn('[whatIsHere]', out.verdict);
            return out;
        }
        let point = null;
        if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
            point = [Number(lng), Number(lat)];
        } else {
            const centre = global.map.getCenter();
            point = [centre.lng, centre.lat];
        }
        out.at = { lat: point[1], lng: point[0] };

        const fabric = global.LiveParcelFabric;
        const presenter = global.ParcelPresenter;
        const epsilon = 0.00004;
        const features = fabric && typeof fabric.queryBounds === 'function'
            ? fabric.queryBounds([point[0] - epsilon, point[1] - epsilon, point[0] + epsilon, point[1] + epsilon], {
                includeCorridors: true
            })
            : [];
        features.forEach(feature => {
            if (!feature || !feature.geometry) return;
            let inside = false;
            try { inside = turf.booleanPointInPolygon(point, feature); } catch (_) { inside = false; }
            if (!inside) return;
            const id = fabric.featureId(feature);
            const presented = !!presenter?.getLayer?.(id);
            (presented ? out.covering : out.hidden).push(String(id));
        });

        // Applied records whose own footprint contains the point — a park or square razes the fabric
        // beneath it and lays down a surface that is deliberately not clickable, which is a complete
        // explanation for an area with nothing under the pointer.
        const planOrder = global.__planOrder;
        (global.proposalStorage?.getAllProposals?.() || []).forEach(record => {
            if (!record || record.applied !== true) return;
            let footprint = null;
            try { footprint = planOrder && planOrder.footprintOf(record); } catch (_) { footprint = null; }
            if (!footprint) return;
            let inside = false;
            try { inside = turf.booleanPointInPolygon(point, footprint); } catch (_) { inside = false; }
            if (!inside) return;
            out.claimedBy.push({
                proposalId: record.proposalId || record.id || null,
                title: record.title || record.name || null,
                kind: record.structureProposal ? (record.structureProposal.kind || 'structure')
                    : (record.roadProposal ? 'corridor' : (record.buildingProposal ? 'building' : 'other'))
            });
        });

        const structure = out.claimedBy.find(entry => entry.kind !== 'corridor' && entry.kind !== 'building');
        if (out.covering.length) {
            out.verdict = `${out.covering.length} parcel(s) cover this point and are on the map — it should be clickable.`;
        } else if (structure) {
            out.verdict = `Nothing to click: "${structure.title || structure.proposalId}" (${structure.kind}) razed the fabric here `
                + 'and its surface is drawn non-interactive. That is by design for a park/square/lake.';
        } else if (out.hidden.length) {
            const affectedCadastreIds = Array.from(new Set(out.hidden.flatMap(parcelKey => {
                const feature = fabric?.get?.(parcelKey);
                return feature ? fabric.explicitCadastreIds(feature) : [];
            })));
            out.affectedCadastreIds = affectedCadastreIds;
            out.verdict = `${out.hidden.length} live parcel(s) cover this point but ParcelPresenter has no layer for them. `
                + 'That is a presentation invariant failure; the fabric itself is intact.';
        } else {
            // Nothing on the map is not the same as nothing in the cadastre, and the difference
            // decides what to do about it: a parcel the backend HAS is a loading gap you can fill,
            // and a parcel it does not have is ground the survey never covered — public road and
            // water routinely are not parcels — in which case an empty block there is correct and
            // there is nothing to fix.
            out.verdict = 'Nothing on the map here. Asking the backend whether the cadastre has anything…';
            const box = 0.00004; // ~4 m, so a click near an edge still lands inside a parcel
            const probe = {
                type: 'Polygon',
                coordinates: [[
                    [point[0] - box, point[1] - box], [point[0] + box, point[1] - box],
                    [point[0] + box, point[1] + box], [point[0] - box, point[1] + box],
                    [point[0] - box, point[1] - box]
                ]]
            };
            try {
                const ground = global.CadastralParcelRepository;
                if (!ground || typeof ground.ensureFootprint !== 'function') {
                    throw new Error('Cadastral ground service is unavailable');
                }
                const loaded = await ground.ensureFootprint(probe, { parcelsOnly: false });
                out.backendParcels = Array.isArray(loaded?.result?.ids) ? loaded.result.ids : [];
                out.verdict = out.backendParcels.length
                    ? `The cadastre HAS ${out.backendParcels.length} parcel(s) here (${out.backendParcels.join(', ')}) `
                        + 'but none reached the map — a loading gap. Pan away and back over this spot to fetch the cell.'
                    : 'The cadastre itself has NO parcel here — this ground was never surveyed as one, which is normal '
                        + 'for public road and water. Nothing to click is correct, and a block cannot form across it.';
            } catch (error) {
                out.backendError = String(error && error.message || error);
                out.verdict = 'Nothing on the map here, and the backend could not be asked whether the cadastre has '
                    + `anything (${out.backendError}). Unresolved — do not read this as either answer.`;
            }
        }
        console.log(`[whatIsHere] ${out.verdict}`, out);
        return out;
    }

    global.whatIsHere = whatIsHere;
})(typeof window !== 'undefined' ? window : globalThis);
