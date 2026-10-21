// Build the chain's site and consent list locally from immutable cadastral facts. The geometry
// snapshot travels on IPFS so later audits can use the same source shapes, even without versions.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__mintBinding = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const dependency = (name, path) => global[name] || (typeof require === 'function' ? require(path) : null);
    const clone = value => JSON.parse(JSON.stringify(value));
    const fail = message => { throw Object.assign(new Error(message), { code: 'mint-binding-invalid' }); };

    function buildLand(proposal) {
        const record = clone(proposal);
        delete record.preparation;
        delete record.preparedArtifact;
        delete record.binding;
        delete record.cadastreSnapshot;
        const profile = typeof global.corridorCenterlineOf === 'function'
            ? global : dependency('__corridorProfile', '../corridor-profile.js');
        const definition = record.roadProposal?.definition;
        if (definition && profile.corridorCenterlineOf(definition).length) {
            const land = dependency('__corridorFootprint', '../corridor-footprint.js').materialize(definition);
            Object.assign(definition, land);
            delete definition.latLngPairs;
        }
        return record;
    }

    async function buildRecord(proposal, { parcels = [], source = null, regionHasCadastre = true,
        now = () => new Date(), turf = global.turf } = {}) {
        const siteApi = dependency('__siteBinding', './site-binding.js');
        const chain = dependency('__chainRecord', './chain-record.js');
        const hash = dependency('__siteHash', './site-hash.js');
        const record = buildLand(proposal);
        const declared = chain.parcelIds(record.cadastreParcelIds || []);
        const facts = parcels.map(feature => ({
            id: String(feature.properties?.parcelId ?? feature.id ?? ''),
            geometry: feature.geometry,
            properties: feature.properties || {}
        }));
        const parcelAct = siteApi.requiresParcels(record);
        if (parcelAct && (!declared.length || declared.some(id => !facts.some(fact => fact.id === id)))) {
            fail('Load every declared cadastral parcel before minting this parcel act.');
        }
        const site = siteApi.siteOf(record, { parcels: facts, turf })
            || (parcelAct ? siteApi.siteOf({ goal: 'ownership-transfer', cadastreParcelIds: declared }, { parcels: facts, turf }) : null);
        if (!site) fail('This proposal has no site geometry to mint.');
        // An authored site may contain the design; it cannot hide land taken outside its boundary.
        if (record.site && siteApi.hasOwnFootprint(record)) {
            const footprint = siteApi.siteOf({ ...record, site: null }, { turf });
            const outside = footprint && turf.difference(turf.feature(footprint), turf.feature(site));
            if (outside && siteApi.intrusionWidth(outside, { turf }) > siteApi.INTRUSION_NOISE_M) {
                fail('The proposal geometry extends outside its site. Widen the site before minting.');
            }
        }
        const used = parcelAct ? facts.filter(fact => declared.includes(fact.id)) : facts;
        const knownSources = used.map(fact => siteApi.normalizeParcelSource(fact.properties?.parcelSource));
        const parcelSource = knownSources.length && knownSources.every(value => value
            && value.sourceId === knownSources[0].sourceId && value.snapshotId === knownSources[0].snapshotId)
            ? knownSources[0] : null;
        const binding = siteApi.bindingFromParcels(site, used, {
            toleranceM: record.toleranceM ?? proposal.binding?.toleranceM,
            regionHasCadastre, source: 'client-cadastre', parcelSource, turf
        });
        if (binding.unresolved?.length) fail('The site reaches a parcel by almost exactly its tolerance. Adjust the design before minting.');
        if (parcelAct) {
            binding.parcels = used.map(fact => ({ parcelId: fact.id, overlapM2: turf.area(fact.geometry), intrusionM: null }));
            binding.subject = 'declared-parcels';
        }
        record.site = site;
        record.binding = binding;
        record.toleranceM = binding.toleranceM;
        record.cadastreParcelIds = binding.parcels.map(hit => hit.parcelId).sort();
        const relevant = new Set([...binding.parcels, ...binding.touched].map(hit => hit.parcelId));
        const snapshotParcels = await Promise.all(used.filter(fact => relevant.has(fact.id)).map(async fact => ({
            id: fact.id,
            sourceId: fact.properties.sourceId ?? source,
            // A capture time is not the publisher's revision. Missing source versions stay null.
            sourceVersion: fact.properties.sourceVersion ?? fact.properties.version ?? null,
            sourceGeometryHash: fact.properties.sourceGeometryHash ?? fact.properties.geom_hash ?? null,
            geometryHash: await hash.siteHashHex(fact.geometry),
            geometry: clone(fact.geometry)
        })));
        record.cadastreSnapshot = { protocol: 'cadastre-snapshot/1', source, capturedAt: now().toISOString(),
            regionHasCadastre, parcels: snapshotParcels.sort((a, b) => a.id.localeCompare(b.id)) };
        dependency('ProposalAuthoredRecord', './authored-record.js').restrictLandClaimsToAnchors(record);
        return chain.authoredRecord(record);
    }

    async function prepareForMint(proposal, options = {}) {
        // A parcel layout is minted only as part of its agreement (ProposalPublishTerms.publishRefusal).
        dependency('ProposalPublishTerms', './publish-terms.js').assertPublishable(proposal);
        const city = proposal.city || options.city || null;
        const config = options.cityConfig || global.CityConfigManager?.getCityConfig?.(city);
        if (!city || !config?.parcels?.source) fail('The proposal must name its city and cadastral source before minting.');
        const repository = options.repository || global.CadastralParcelRepository;
        const localSource = global.ParcelGroundFallback?.activeSource?.(city);
        const hasCadastre = !!localSource || config.parcels.source !== 'none';
        const record = buildLand({ ...proposal, city });
        const siteApi = dependency('__siteBinding', './site-binding.js');
        let parcels = [];
        if (hasCadastre) {
            if (!repository) fail('Cadastral ground is unavailable.');
            if (siteApi.requiresParcels(record)) {
                const answer = await repository.ensureIds(record.cadastreParcelIds, { city });
                if (answer.missingIds?.length) fail('Some declared cadastral parcels are unavailable.');
                parcels = answer.features;
            } else {
                const site = siteApi.siteOf(record, { turf: options.turf || global.turf });
                if (!site) fail('This proposal has no site geometry to mint.');
                // Uses retained immutable ground when it covers the site, otherwise fetches the
                // missing source data. A failed source read never becomes empty/open ground.
                const answer = await repository.ensureFootprint(site, { city, parcelsOnly: true });
                parcels = answer.result.features;
            }
        }
        return buildRecord(record, { parcels, regionHasCadastre: hasCadastre,
            source: localSource?.id || config.parcels.sourceId || config.parcels.source, turf: options.turf || global.turf,
            ...(options.now ? { now: options.now } : {}) });
    }

    function adoptMintRecord(target, record) {
        delete target.preparation;
        delete target.preparedArtifact;
        Object.assign(target, clone(record));
        dependency('ProposalAuthoredRecord', './authored-record.js').restrictLandClaimsToAnchors(target);
    }

    return { buildLand, buildRecord, prepareForMint, adoptMintRecord };
});
