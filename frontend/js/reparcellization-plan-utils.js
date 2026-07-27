// Pure helpers shared by the reparcellization editor and its unit tests.
(function attachReparcellizationPlanUtils(global) {
    function computeJointProRataShares(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return [];

        const normalized = entries.map(entry => ({
            ownerKey: entry?.ownerKey,
            weight: Number.isFinite(Number(entry?.weight)) && Number(entry.weight) > 0
                ? Number(entry.weight)
                : 0
        }));
        const totalWeight = normalized.reduce((sum, entry) => sum + entry.weight, 0);
        const equalShare = 1 / normalized.length;
        let assigned = 0;

        return normalized.map((entry, index) => {
            const share = index === normalized.length - 1
                ? 1 - assigned
                : (totalWeight > 0 ? entry.weight / totalWeight : equalShare);
            assigned += share;
            return { ownerKey: entry.ownerKey, share };
        });
    }

    function deriveCourtyardFromFootprint(footprintFeature) {
        const geometry = footprintFeature?.type === 'Feature'
            ? footprintFeature.geometry
            : footprintFeature;
        if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;

        const polygons = geometry.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry.coordinates;
        const courtyardRings = [];
        polygons.forEach(rings => {
            if (!Array.isArray(rings) || rings.length < 2) return;
            rings.slice(1).forEach(ring => {
                if (!Array.isArray(ring) || ring.length < 4) return;
                courtyardRings.push(ring.map(point => point.slice()).reverse());
            });
        });
        if (!courtyardRings.length) return null;

        return {
            type: 'Feature',
            properties: {},
            geometry: courtyardRings.length === 1
                ? { type: 'Polygon', coordinates: [courtyardRings[0]] }
                : { type: 'MultiPolygon', coordinates: courtyardRings.map(ring => [ring]) }
        };
    }

    function splitPlanPerParcel({ parcelFeatures, jointPolygons, parcelOwnerIndex, jointOwners }, turfApi) {
        const api = turfApi;
        if (!api || typeof api.intersect !== 'function' || typeof api.difference !== 'function'
            || typeof api.area !== 'function' || typeof api.union !== 'function') {
            throw new Error('splitPlanPerParcel requires intersect, difference, area, and union operations');
        }
        const toFeature = value => {
            if (value?.type === 'Feature' && value.geometry) return value;
            if (value?.type && value?.coordinates) return { type: 'Feature', properties: {}, geometry: value };
            return null;
        };
        const jointFeatures = (Array.isArray(jointPolygons) ? jointPolygons : []).map(toFeature).filter(Boolean);
        if (!jointFeatures.length) throw new Error('At least one joint polygon is required');

        let jointUnion = jointFeatures[0];
        for (let index = 1; index < jointFeatures.length; index++) {
            try {
                jointUnion = api.union(jointUnion, jointFeatures[index]);
            } catch (error) {
                throw new Error(`Could not union joint polygons: ${error?.message || error}`);
            }
            if (!jointUnion?.geometry) throw new Error('Could not union joint polygons');
        }

        const readOwners = parcelId => {
            if (parcelOwnerIndex instanceof Map) return parcelOwnerIndex.get(parcelId) || [];
            return parcelOwnerIndex?.[parcelId] || [];
        };
        const cloneOwners = owners => (Array.isArray(owners) ? owners : []).map(owner => ({ ...owner }));
        const makePolygon = (feature, owners, flags = {}) => {
            const clonedOwners = cloneOwners(owners);
            const primary = clonedOwners[0] || null;
            return {
                ownerKey: primary?.ownerKey || '',
                displayName: flags.jointPool
                    ? 'Joint ownership'
                    : (clonedOwners.length > 1
                        ? clonedOwners.map(owner => owner.displayName).join(' + ')
                        : (primary?.displayName || 'Unassigned')),
                percent: 0,
                color: primary?.color || '#cccccc',
                source: 'individual',
                geometry: JSON.parse(JSON.stringify(feature.geometry)),
                owners: clonedOwners,
                jointPool: flags.jointPool === true
            };
        };

        return (Array.isArray(parcelFeatures) ? parcelFeatures : []).map((parcelFeature, index) => {
            const parcel = toFeature(parcelFeature);
            if (!parcel) throw new Error(`Parcel ${index + 1} has no polygon geometry`);
            const props = parcel.properties || {};
            const rawId = props.parcelId ?? props.parcel_id ?? props.id ?? parcel.id ?? index;
            const parcelId = String(rawId);
            let sliver = null;
            try {
                sliver = api.intersect(parcel, jointUnion);
            } catch (error) {
                throw new Error(`Could not intersect joint courtyard with parcel ${parcelId}: ${error?.message || error}`);
            }
            const sliverArea = sliver?.geometry ? Number(api.area(sliver)) || 0 : 0;
            if (sliverArea < 1) return { parcelId, skipped: true };

            let remainder = null;
            try {
                remainder = api.difference(parcel, jointUnion);
            } catch (error) {
                throw new Error(`Could not subtract joint courtyard from parcel ${parcelId}: ${error?.message || error}`);
            }
            if (!remainder?.geometry) {
                throw new Error(`Joint courtyard fully consumes parcel ${parcelId}`);
            }
            const parcelOwners = cloneOwners(readOwners(parcelId));
            return {
                parcelId,
                skipped: false,
                totalArea: Number(api.area(parcel)) || 0,
                polygons: [
                    makePolygon(remainder, parcelOwners),
                    makePolygon(sliver, jointOwners, { jointPool: true })
                ]
            };
        });
    }

    const api = { computeJointProRataShares, deriveCourtyardFromFootprint, splitPlanPerParcel };
    global.ReparcellizationPlanUtils = Object.assign(global.ReparcellizationPlanUtils || {}, api);

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
