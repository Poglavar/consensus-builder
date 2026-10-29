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
    const openGroundApi = () => root.__openGround
        || (typeof require === 'function' ? require('./proposals/open-ground.js') : null);
    const siteBindingApi = () => root.__siteBinding
        || (typeof require === 'function' ? require('./proposals/site-binding.js') : null);
    const turfApi = () => root.turf || null;

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

    // A layout's own role wins; then the fabric's corridor test (live-fabric.js isCorridor), then a
    // split part; anything else is a whole parcel.
    function roleOf(props) {
        const role = props.readjustmentPiece && props.readjustmentPiece.role;
        if (role === 'plot' || role === 'remainder') return role;
        if (props.isCorridor === true || props.isRoad === true || props.isTrack === true) return 'corridor';
        return props.cadastralPart === true ? 'part' : 'parcel';
    }

    // The fabric displays a one-part cadastral MultiPolygon as a connected Polygon. An untouched
    // parcel still commits to its source geometry, just as server-authored agreements do. Only
    // restore that representation when the actual coordinates match; changed land stays changed.
    function outputGeometry(feature, original, role) {
        const geometry = feature.geometry;
        const source = original?.type === 'Feature' ? original.geometry : original;
        if (role === 'parcel' && !feature.properties?.producedByProposalId
            && source?.type === 'MultiPolygon' && source.coordinates.length === 1
            && geometry?.type === 'Polygon'
            && record().outputHash({ type: 'Polygon', coordinates: source.coordinates[0] }) === record().outputHash(geometry)) {
            return source;
        }
        return geometry;
    }

    /**
     * The land the designs take and what stands on it once they are applied.
     * @param designs applied design records ({ proposalId, cadastreParcelIds?, parcelLayout?, … })
     * @param fabric the live parcel fabric: producedBy(proposalId) and entriesForCadastre(ids, query)
     * @param originals Map of cadastral id → original cadastral Feature (may lack some)
     * @param area (feature) → m² (turf.area)
     * @returns {{ inputs: { parcels: { parcelId, areaM2 }[], openGroundM2 }, outputs: object[] }}
     *   Each input parcel stands for its abstract owners' party; nobody is named here.
     */
    function derive({ designs, fabric, originals, area = areaOf,
        openGround: openGroundOption, siteBinding: siteBindingOption, turf: turfOption } = {}) {
        if (!Array.isArray(designs) || designs.some(design => !design || design.proposalId == null)) {
            throw new TypeError('derive needs design records with a proposalId.');
        }
        if (!fabric || typeof fabric.producedBy !== 'function' || typeof fabric.entriesForCadastre !== 'function') {
            throw new TypeError('derive needs the live parcel fabric.');
        }
        if (typeof area !== 'function') throw new TypeError('derive needs an area function.');

        // Each design's declared parcels and the cadastral anchors of every piece it produced.
        const parcelIds = sortedUnique(designs.flatMap(design => [
            ...idsOf(design.cadastreParcelIds),
            ...(fabric.producedBy(design.proposalId) || []).flatMap(piece => idsOf(piece && piece.properties && piece.properties.cadastreParcelIds))
        ]));
        const parcels = parcelIds.map(parcelId => {
            const original = originals && typeof originals.get === 'function' ? originals.get(parcelId) : null;
            const measured = original ? area(original) : null;
            return { parcelId, areaM2: finite(measured) && measured >= 0 ? committedArea(measured) : null };
        });
        const featureById = new Map();
        (fabric.entriesForCadastre(parcelIds, { includeCorridors: true }) || []).forEach(feature => {
            const id = feature?.properties?.parcelId;
            if (id === undefined || id === null || String(id) === '') {
                featureById.set(`!missing:${featureById.size}`, feature);
                return;
            }
            if (!featureById.has(String(id))) featureById.set(String(id), feature);
        });

        // Reconstruct the actual unsurveyed part from design geometry and immutable parcel geometry.
        // binding.unsurveyedM2 is only an area summary and cannot stand in for the missing polygon.
        const openGround = openGroundOption || openGroundApi();
        const siteBinding = siteBindingOption || siteBindingApi();
        const turf = turfOption || turfApi();
        const openGroundEligible = design => {
            if (openGround && typeof openGround.hasOpenGround === 'function' && siteBinding) {
                return openGround.hasOpenGround(design, { siteBinding, turf });
            }
            const coverage = design?.binding?.coverage;
            return !!siteBinding?.siteOf?.(design, { turf })
                && (!idsOf(design?.cadastreParcelIds).length || coverage === 'partial' || coverage === 'none');
        };
        const anyOpenGroundDesign = designs.some(openGroundEligible);
        if (anyOpenGroundDesign && (!openGround || !siteBinding || !turf
            || typeof openGround.openGroundGeometry !== 'function' || typeof siteBinding.siteOf !== 'function')) {
            throw new Error('Agreement ground cannot measure open-ground sites without its geometry services.');
        }
        const hostGeometries = [];
        if (anyOpenGroundDesign) {
            designs.filter(openGroundEligible).forEach(design => {
                const site = siteBinding.siteOf(design, { turf });
                if (!site) throw new Error(`Agreement ground cannot resolve the open-ground site for ${design.proposalId}.`);
                const parcels = idsOf(design.cadastreParcelIds).map(id => ({
                    id, geometry: originals?.get?.(id)?.geometry || originals?.get?.(id)
                }));
                const missing = parcels.filter(parcel => !parcel.geometry).map(parcel => parcel.id);
                if (missing.length) throw new Error(`Agreement ground cannot resolve open ground; original parcel geometry is missing for ${missing.join(', ')}.`);
                const geometry = openGround.openGroundGeometry(site, parcels, { turf, siteBinding, toleranceM: design.toleranceM });
                if (geometry) hostGeometries.push(geometry);
            });
        }
        const clip = (operation, left, right) => {
            const arrangement = root.__parcelArrangement;
            if (arrangement && typeof arrangement.clip === 'function') return arrangement.clip(operation, left, right);
            return turf[operation](left, right);
        };
        const featureOf = geometry => geometry?.type === 'Feature' ? geometry : turf.feature(geometry);
        let hostGeometry = null;
        hostGeometries.forEach(geometry => {
            const feature = featureOf(geometry);
            hostGeometry = hostGeometry ? clip('union', hostGeometry, feature) : feature;
            if (!hostGeometry) throw new Error('Agreement ground could not combine open-ground host geometries.');
        });
        let openGroundM2 = 0;
        const syntheticOutputs = [];
        if (hostGeometry) {
            const hostArea = area(hostGeometry);
            if (!finite(hostArea) || hostArea < 0) throw new Error('Agreement open-ground host could not be measured.');
            openGroundM2 = committedArea(hostArea);
            if (typeof fabric.list !== 'function') throw new Error('Agreement ground needs LiveParcelFabric.list() to resolve open-ground descendants.');
            const descendants = fabric.list().filter(feature => Array.isArray(feature.properties?.groundIds)
                && feature.properties.groundIds.length > 0 && feature.geometry);
            let represented = null;
            descendants.forEach(feature => {
                const intersection = clip('intersect', featureOf(feature.geometry), hostGeometry);
                if (!intersection) return;
                const measured = area(intersection);
                if (!finite(measured) || measured <= 0) return;
                represented = represented ? clip('union', represented, intersection) : intersection;
                if (!represented) throw new Error(`Agreement open-ground descendants could not be combined at ${feature.properties?.parcelId || 'unknown piece'}.`);
                const id = feature.properties?.parcelId;
                if (id !== undefined && id !== null && String(id) !== '' && !featureById.has(String(id))) featureById.set(String(id), feature);
            });
            const residual = represented ? clip('difference', hostGeometry, represented) : hostGeometry;
            if (residual) {
                const geometry = outputGeometry({ geometry: residual.geometry || residual }, null, 'parcel');
                const hash = record().outputHash(geometry);
                const residualArea = area(geometry);
                if (!finite(residualArea) || residualArea <= 0) throw new Error('Residual open-ground geometry could not be measured.');
                syntheticOutputs.push({ hash, pieceId: `open-ground:${hash.slice('piece1-sha256:'.length)}`,
                    areaM2: committedArea(residualArea), fromParcelIds: [], producedBy: null,
                    role: 'parcel', geometry });
            }
        }
        const outputFeatures = Array.from(featureById.values());

        const seen = new Set();
        const outputs = [];
        outputFeatures.forEach(feature => {
            const props = (feature && feature.properties) || {};
            if (props.parcelId === undefined || props.parcelId === null || String(props.parcelId) === '') {
                throw new Error('A piece on the agreement land has no parcelId.');
            }
            const pieceId = String(props.parcelId);
            if (seen.has(pieceId)) return;
            seen.add(pieceId);
            const areaM2 = area(feature);
            if (!finite(areaM2) || areaM2 < 0) throw new Error(`Piece ${pieceId} could not be measured.`);
            const role = roleOf(props);
            const geometry = outputGeometry(feature, originals?.get?.(pieceId), role);
            outputs.push({
                hash: record().outputHash(geometry),
                pieceId,
                areaM2: committedArea(areaM2),
                fromParcelIds: sortedUnique(idsOf(props.cadastreParcelIds)),
                producedBy: props.producedByProposalId ? String(props.producedByProposalId) : null,
                role,
                geometry
            });
        });
        outputs.push(...syntheticOutputs);
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
    function check(agreement, { designOf, isApplied, fingerprintOf, fabric, originals, area = areaOf } = {}) {
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
            const fresh = derive({ designs: records, fabric, originals, area });
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
     * The ownerOf lookup over the local owner records (parcel_<id>_owner → agent id), the people
     * behind the default local rights snapshot (AgreementRecord.rightsFromInputs). A joint-pool agent
     * stands for its members and their shares; an owner record without an agent record still names
     * its holder.
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
