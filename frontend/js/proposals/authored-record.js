// Canonical authored-proposal boundary.
//
// A proposal is a portable instruction: authored geometry plus references to immutable cadastral
// parcels.  GeoJSON features used by the live materializer acquire parcel/proposal stamps while
// they are on screen; those stamps describe one browser's current fabric and must never become
// part of the instruction.  This module is deliberately pure and dependency-free so the browser,
// API serializer and one-time database migration all enforce the same projection.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalAuthoredRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const LEGACY_DERIVED_PARCEL = /^HR-\d+-.+?_[a-z0-9]+_\d+$/i;
    const RUNTIME_FEATURE_PROPERTIES = Object.freeze([
        'parcelId', 'parcel_id', 'sourceParcelId', 'sourceParcelIds',
        'parentParcelId', 'parentParcelIds', 'parentParcelNumber', 'parentParcelNumbers',
        'rootParcelId', 'rootParcelNumber', 'baseParcelIds', 'cadastreParcelIds',
        'proposalId', 'proposalState', 'producedByProposalId', 'ancestorProposal',
        'buildingIndex', 'BROJ_CESTICE', 'broj_cestice'
    ]);
    const GENERATED_CADASTRE_TOKEN = /(HR-\d+-[A-Za-z0-9./-]+)(?:#[A-Za-z0-9._-]+|_[a-z0-9]+_\d+)/gi;

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function isDerivedParcelId(value) {
        const id = String(value == null ? '' : value);
        return /#/.test(id) || LEGACY_DERIVED_PARCEL.test(id);
    }

    // Auto-generated labels used to embed the live piece selected in one browser (for example
    // "Parcel HR-330264-502#pabc-1"). Labels are not land declarations, but retaining such a token
    // still leaks a disposable fabric identity into the portable proposal. Keep the human text and
    // collapse only recognisable Croatian parcel tokens to their immutable cadastral identity.
    function stripGeneratedParcelTokens(value) {
        return typeof value === 'string'
            ? value.replace(GENERATED_CADASTRE_TOKEN, '$1')
            : value;
    }

    function cleanFeature(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const feature = clone(value);
        if (feature.type !== 'Feature') return feature;
        const properties = feature.properties && typeof feature.properties === 'object'
            && !Array.isArray(feature.properties)
            ? { ...feature.properties }
            : {};
        RUNTIME_FEATURE_PROPERTIES.forEach(key => delete properties[key]);
        Object.keys(properties).forEach(key => {
            if (typeof properties[key] === 'string') {
                properties[key] = stripGeneratedParcelTokens(properties[key]);
            }
        });
        feature.properties = properties;
        return feature;
    }

    function cleanReparcellizationMetadata(plan) {
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return;
        if (Array.isArray(plan.ownerShares)) {
            plan.ownerShares = plan.ownerShares.map(entry => {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
                const clean = clone(entry);
                // Contribution parcel membership is the proposal's root cadastreParcelIds. The
                // per-owner accounting needs areas/values and owner identity, not a second list of
                // whichever live pieces happened to be selected in the authoring browser.
                delete clean.parcelIds;
                if (typeof clean.ownerKey === 'string') {
                    clean.ownerKey = stripGeneratedParcelTokens(clean.ownerKey);
                }
                return clean;
            });
        }
        if (Array.isArray(plan.polygons)) {
            plan.polygons.forEach(polygon => {
                if (!polygon || typeof polygon !== 'object' || Array.isArray(polygon)) return;
                if (typeof polygon.ownerKey === 'string') {
                    polygon.ownerKey = stripGeneratedParcelTokens(polygon.ownerKey);
                }
                if (Array.isArray(polygon.owners)) {
                    polygon.owners.forEach(owner => {
                        if (owner && typeof owner === 'object' && typeof owner.ownerKey === 'string') {
                            owner.ownerKey = stripGeneratedParcelTokens(owner.ownerKey);
                        }
                    });
                }
            });
        }
    }

    function authoredBuildingFeatures(record) {
        return Array.isArray(record?.geometry?.buildings)
            ? record.geometry.buildings.filter(value => value && value.geometry)
            : [];
    }

    function cleanFeatureContainers(record) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
        const out = clone(record);
        delete out.similarityHash;
        const hasBuilding = !!out.buildingProposal
            || Array.isArray(out.geometry?.buildings)
            || !!out.buildingGeometry;

        if (hasBuilding) {
            if (!out.buildingProposal || typeof out.buildingProposal !== 'object'
                || Array.isArray(out.buildingProposal)) {
                out.buildingProposal = {};
            }
            const buildings = authoredBuildingFeatures(out).map(cleanFeature).filter(Boolean);
            if (!out.geometry || typeof out.geometry !== 'object' || Array.isArray(out.geometry)) {
                out.geometry = {};
            }
            if (buildings.length) out.geometry.buildings = buildings;
            else delete out.geometry.buildings;

            delete out.buildingGeometry;
            delete out.buildingProperties;
            // Old creators copied the first building feature's properties to the proposal root.
            // Authored feature properties already live beside their geometry; the root copy is
            // neither a proposal attribute nor an independent source of truth.
            delete out.properties;

            if (out.buildingProposal && typeof out.buildingProposal === 'object'
                && !Array.isArray(out.buildingProposal)) {
                delete out.buildingProposal.buildingFeature;
                delete out.buildingProposal.buildings;
                // Whole-block membership is the proposal's one root cadastre declaration.  The
                // old nested copy frequently contained live materialization ids and became a
                // second, conflicting source of land truth.
                delete out.buildingProposal.blockParcelIds;
                delete out.buildingProposal.parentParcelNumbers;
                delete out.buildingProposal.ancestorKey;
                if (Array.isArray(out.buildingProposal.ineligibleParcels)) {
                    out.buildingProposal.ineligibleParcels = out.buildingProposal.ineligibleParcels
                        .map(entry => {
                            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
                            const clean = clone(entry);
                            delete clean.parcelId;
                            delete clean.parcel_id;
                            delete clean.parentParcelId;
                            delete clean.parentParcelIds;
                            if (clean.wouldBe?.type === 'Feature') clean.wouldBe = cleanFeature(clean.wouldBe);
                            return clean;
                        })
                        .filter(Boolean);
                }
            }
        }

        if (out.geometry && typeof out.geometry === 'object' && !Array.isArray(out.geometry)) {
            ['blockMassing', 'groundSurface', 'parkGraphics', 'squareGraphics', 'lakeGraphics', 'stationGraphics']
                .forEach(key => {
                    if (out.geometry[key]?.type === 'Feature') {
                        out.geometry[key] = cleanFeature(out.geometry[key]);
                    }
                });
            if (Object.keys(out.geometry).length === 0) delete out.geometry;
        }
        ['name', 'title', 'description', 'proposalName', 'blockName'].forEach(key => {
            if (typeof out[key] === 'string') out[key] = stripGeneratedParcelTokens(out[key]);
        });
        ['buildingProposal', 'structureProposal'].forEach(key => {
            if (typeof out[key]?.blockName === 'string') {
                out[key].blockName = stripGeneratedParcelTokens(out[key].blockName);
            }
        });
        cleanReparcellizationMetadata(out.reparcellization);
        delete out.childFeatures;
        ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
            .forEach(key => {
                const sub = out[key];
                if (sub && typeof sub === 'object' && !Array.isArray(sub)) delete sub.childFeatures;
            });
        if (Array.isArray(out.roadProposal?.definition?.features)) {
            out.roadProposal.definition.features = out.roadProposal.definition.features
                .map(cleanFeature)
                .filter(feature => feature && feature.geometry);
        }
        return out;
    }

    // A proposal has one durable land relationship.  Compatibility aliases were useful during
    // the cut-over from live-parent ids, but retaining them on the record recreates a second source
    // of truth and lets old generated ids poison otherwise canonical data.  Migration may inspect
    // those aliases before calling this projection; ordinary runtime code may not retain them.
    function stripCadastreAliases(record) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
        const out = clone(record);
        delete out.parentParcelIds;
        delete out.parcelIds;
        ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
            .forEach(key => {
                const sub = out[key];
                if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
                delete sub.parentParcelIds;
                if (key === 'reparcellization') delete sub.parcelIds;
            });
        return out;
    }

    function legacyCadastreDeclarations(proposal) {
        if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return [];
        const found = [];
        const own = (value, key) => value && typeof value === 'object'
            && Object.prototype.hasOwnProperty.call(value, key);
        const add = (path, owner, key) => {
            if (own(owner, key)) found.push({ path, value: owner[key] });
        };
        add('parentParcelIds', proposal, 'parentParcelIds');
        add('parcelIds', proposal, 'parcelIds');
        ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
            .forEach(key => add(`${key}.parentParcelIds`, proposal[key], 'parentParcelIds'));
        add('reparcellization.parcelIds', proposal.reparcellization, 'parcelIds');
        add('buildingProposal.blockParcelIds', proposal.buildingProposal, 'blockParcelIds');
        add('buildingProposal.parentParcelNumbers', proposal.buildingProposal, 'parentParcelNumbers');
        add('buildingProposal.ancestorKey', proposal.buildingProposal, 'ancestorKey');
        if (Array.isArray(proposal.buildingProposal?.ineligibleParcels)) {
            proposal.buildingProposal.ineligibleParcels.forEach((entry, index) => {
                if (entry && (Object.prototype.hasOwnProperty.call(entry, 'parcelId')
                    || Object.prototype.hasOwnProperty.call(entry, 'parcel_id'))) {
                    found.push({
                        path: `buildingProposal.ineligibleParcels[${index}].parcelId`,
                        value: entry.parcelId ?? entry.parcel_id
                    });
                }
            });
        }
        if (Array.isArray(proposal.reparcellization?.ownerShares)) {
            proposal.reparcellization.ownerShares.forEach((entry, index) => {
                add(`reparcellization.ownerShares[${index}].parcelIds`, entry, 'parcelIds');
            });
        }
        return found;
    }

    function findNonCadastralReference(proposal) {
        if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return null;
        const anchors = new Set((Array.isArray(proposal.cadastreParcelIds)
            ? proposal.cadastreParcelIds : []).map(String));
        if (!anchors.size) return null;
        const accepted = Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds : [];
        const acceptedIndex = accepted.findIndex(id => !anchors.has(String(id)));
        if (acceptedIndex >= 0) {
            return { path: `acceptedParcelIds[${acceptedIndex}]`, id: String(accepted[acceptedIndex]) };
        }
        const flow = proposal.ownershipFlow;
        if (Array.isArray(flow)) {
            const index = flow.findIndex(entry => entry?.parcelId && !anchors.has(String(entry.parcelId)));
            if (index >= 0) return { path: `ownershipFlow[${index}].parcelId`, id: String(flow[index].parcelId) };
        }
        for (const parcelId of Object.keys(proposal.ownerAcceptances || {})) {
            if (!anchors.has(parcelId)) return { path: `ownerAcceptances.${parcelId}`, id: parcelId };
        }
        return null;
    }

    return {
        RUNTIME_FEATURE_PROPERTIES,
        cleanFeature,
        cleanFeatureContainers,
        stripCadastreAliases,
        legacyCadastreDeclarations,
        findNonCadastralReference,
        isDerivedParcelId,
        stripGeneratedParcelTokens
    };
});
