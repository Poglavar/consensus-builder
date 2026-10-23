// An agreement's land on the current ground (plan-design-agreement.md, M1 (b)): the input parcels
// its designs take, the pieces standing on them once the designs are applied, whether a stored
// agreement still matches that ground, and the holders the local owner records name.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgreementGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const record = () => root.AgreementRecord
        || (typeof require === 'function' ? require('./agreement-record.js') : null);

    // Locale-independent natural order (digit runs by value, the rest by code point), so the input
    // order is the same on every machine: it will be part of the agreement's content in M2.
    const chunks = text => String(text).match(/\d+|\D+/g) || [];
    const numeric = (a, b) => {
        const left = chunks(a);
        const right = chunks(b);
        for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
            const digits = /^\d/.test(left[i]) && /^\d/.test(right[i]);
            const diff = digits ? Number(left[i]) - Number(right[i]) : (left[i] < right[i] ? -1 : left[i] > right[i] ? 1 : 0);
            if (diff) return diff < 0 ? -1 : 1;
        }
        return left.length - right.length || (a < b ? -1 : a > b ? 1 : 0);
    };
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    // Areas enter the agreement CID. Native Math.sin differs at its last bit between JS engines;
    // near a rounding boundary that gives the SAME parcel two committed areas. This fixed series
    // implements the same spherical ring formula as Turf using IEEE arithmetic only. Fourteen
    // terms cover geographic latitudes with double precision; published areas resolve to 1 mm².
    const committedArea = value => Math.round(value * 1e6) / 1e6;
    function areaOf(value) {
        const geometry = value?.type === 'Feature' ? value.geometry : value;
        const sine = radians => {
            let term = radians, sum = radians;
            for (let k = 1; k <= 14; k++) { term *= -(radians * radians) / ((2 * k) * (2 * k + 1)); sum += term; }
            return sum;
        };
        const ringArea = ring => {
            let sum = 0;
            const length = ring.length - 1, radians = Math.PI / 180;
            for (let i = 0; i < length; i++) {
                const previous = ring[(i + length - 1) % length], next = ring[(i + 1) % length];
                sum += (next[0] - previous[0]) * radians * sine(ring[i][1] * radians);
            }
            // @turf/area 6.5 uses the WGS84 semi-major radius, 6378137 m.
            return Math.abs(sum * (6378137 * 6378137 / 2));
        };
        const polygonArea = rings => ringArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
        if (geometry?.type === 'Polygon') return committedArea(polygonArea(geometry.coordinates));
        if (geometry?.type === 'MultiPolygon') return committedArea(geometry.coordinates.reduce((sum, rings) => sum + polygonArea(rings), 0));
        return null;
    }
    const idsOf = list => (Array.isArray(list) ? list : [])
        .map(id => id === undefined || id === null ? '' : String(id).trim()).filter(Boolean);
    const sortedUnique = list => Array.from(new Set(list)).sort(numeric);
    const sameSet = (a, b) => a.size === b.size && Array.from(a).every(item => b.has(item));

    function holdersOf(ownerOf, id) {
        const list = ownerOf(id);
        return (Array.isArray(list) ? list : []).map(holder => ({
            ownerKey: String(holder.ownerKey),
            displayName: holder.displayName ? String(holder.displayName) : String(holder.ownerKey),
            share: holder.share
        }));
    }

    // A layout's own role wins; then the fabric's corridor test (live-fabric.js isCorridor), then a
    // split part; anything else is a whole parcel.
    function roleOf(props) {
        const role = props.readjustmentPiece && props.readjustmentPiece.role;
        if (role === 'plot' || role === 'remainder') return role;
        if (props.isCorridor === true || props.isRoad === true || props.isTrack === true) return 'corridor';
        return props.cadastralPart === true ? 'part' : 'parcel';
    }

    /**
     * The land the designs take and what stands on it once they are applied.
     * @param designs applied design records ({ proposalId, cadastreParcelIds?, parcelLayout?, … })
     * @param fabric the live parcel fabric: producedBy(proposalId) and entriesForCadastre(ids, query)
     * @param originals Map of cadastral id → original cadastral Feature (may lack some)
     * @param ownerOf (parcelId) → [{ ownerKey, displayName, share }], [] when nobody holds it
     * @param area (feature) → m² (turf.area)
     * @returns {{ inputs: { parcels: { parcelId, areaM2, holders }[], openGroundM2 }, outputs: object[] }}
     */
    function derive({ designs, fabric, originals, ownerOf, area = areaOf } = {}) {
        if (!Array.isArray(designs) || designs.some(design => !design || design.proposalId == null)) {
            throw new TypeError('derive needs design records with a proposalId.');
        }
        if (!fabric || typeof fabric.producedBy !== 'function' || typeof fabric.entriesForCadastre !== 'function') {
            throw new TypeError('derive needs the live parcel fabric.');
        }
        if (typeof ownerOf !== 'function' || typeof area !== 'function') throw new TypeError('derive needs ownerOf and area functions.');

        // Each design's declared parcels and the cadastral anchors of every piece it produced.
        const parcelIds = sortedUnique(designs.flatMap(design => [
            ...idsOf(design.cadastreParcelIds),
            ...(fabric.producedBy(design.proposalId) || []).flatMap(piece => idsOf(piece && piece.properties && piece.properties.cadastreParcelIds))
        ]));
        const parcels = parcelIds.map(parcelId => {
            const original = originals && typeof originals.get === 'function' ? originals.get(parcelId) : null;
            const measured = original ? area(original) : null;
            return { parcelId, areaM2: finite(measured) && measured >= 0 ? committedArea(measured) : null, holders: holdersOf(ownerOf, parcelId) };
        });
        const openGroundM2 = designs.reduce((sum, design) => sum + Math.max(0, Number(design.parcelLayout && design.parcelLayout.openGroundM2) || 0), 0);

        const seen = new Set();
        const outputs = [];
        (fabric.entriesForCadastre(parcelIds, { includeCorridors: true }) || []).forEach(feature => {
            const props = (feature && feature.properties) || {};
            if (props.parcelId === undefined || props.parcelId === null || String(props.parcelId) === '') {
                throw new Error('A piece on the agreement land has no parcelId.');
            }
            const pieceId = String(props.parcelId);
            if (seen.has(pieceId)) return;
            seen.add(pieceId);
            const areaM2 = area(feature);
            if (!finite(areaM2) || areaM2 < 0) throw new Error(`Piece ${pieceId} could not be measured.`);
            outputs.push({
                hash: record().outputHash(feature.geometry),
                pieceId,
                areaM2: committedArea(areaM2),
                fromParcelIds: sortedUnique(idsOf(props.cadastreParcelIds)),
                producedBy: props.producedByProposalId ? String(props.producedByProposalId) : null,
                role: roleOf(props),
                holders: holdersOf(ownerOf, pieceId),
                geometry: feature.geometry
            });
        });
        outputs.sort((a, b) => numeric(a.fromParcelIds.join(','), b.fromParcelIds.join(','))
            || b.areaM2 - a.areaM2 || compare(a.hash, b.hash));
        return { inputs: { parcels, openGroundM2 }, outputs };
    }

    /**
     * Whether a stored agreement still matches the map: every design present, applied and
     * unchanged, and the same input parcels and output pieces when derived again. The ground is
     * derived again only when every design is present and applied.
     * @returns {{ current: boolean, reasons: { code: 'design-missing' | 'design-not-applied'
     *   | 'design-changed' | 'ground-changed', proposalId?: string }[] }}
     */
    function check(agreement, { designOf, isApplied, fingerprintOf, fabric, originals, ownerOf, area = areaOf } = {}) {
        if (typeof designOf !== 'function' || typeof isApplied !== 'function' || typeof fingerprintOf !== 'function') {
            throw new TypeError('check needs designOf, isApplied and fingerprintOf functions.');
        }
        const reasons = [];
        const records = ((agreement && agreement.designs) || []).map(design => {
            const proposalId = String(design.proposalId);
            const found = designOf(proposalId);
            if (!found) {
                reasons.push({ code: 'design-missing', proposalId });
                return null;
            }
            if (!isApplied(found)) {
                reasons.push({ code: 'design-not-applied', proposalId });
                return null;
            }
            if (fingerprintOf(found) !== design.cid) reasons.push({ code: 'design-changed', proposalId });
            return found;
        });
        if (records.every(Boolean)) {
            const fresh = derive({ designs: records, fabric, originals, ownerOf, area });
            const storedInputs = new Set(((agreement.inputs && agreement.inputs.parcels) || []).map(parcel => String(parcel.parcelId)));
            const storedOutputs = new Set((agreement.outputs || []).map(output => output.hash));
            if (!sameSet(storedInputs, new Set(fresh.inputs.parcels.map(parcel => parcel.parcelId)))
                || !sameSet(storedOutputs, new Set(fresh.outputs.map(output => output.hash)))) {
                reasons.push({ code: 'ground-changed' });
            }
        }
        return { current: !reasons.length, reasons };
    }

    /**
     * The ownerOf lookup over the local owner records (parcel_<id>_owner → agent id). A joint-pool
     * agent stands for its members and their shares; an owner record without an agent record still
     * names its holder.
     * @param storage { getItem(key) } (PersistentStorage)
     * @param agents { getAgent(id) } (agentStorage)
     */
    function localHolders({ storage, agents } = {}) {
        if (!storage || typeof storage.getItem !== 'function') throw new TypeError('localHolders needs the owner record storage.');
        return parcelId => {
            const agentId = storage.getItem(`parcel_${parcelId}_owner`);
            if (agentId === undefined || agentId === null || String(agentId).trim() === '') return [];
            const id = String(agentId);
            const agent = agents && typeof agents.getAgent === 'function' ? agents.getAgent(id) : null;
            if (agent && agent.jointPool === true && Array.isArray(agent.members)) {
                return agent.members.map(member => ({
                    ownerKey: String(member.agentId),
                    displayName: member.name ? String(member.name) : String(member.agentId),
                    share: member.share
                }));
            }
            return [{ ownerKey: id, displayName: (agent && agent.name) ? String(agent.name) : id, share: 1 }];
        };
    }

    return { derive, check, localHolders, areaOf };
});
