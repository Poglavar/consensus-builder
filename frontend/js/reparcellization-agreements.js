// Build independent courtyard agreements and resume their save/apply operations without duplicates.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationAgreements = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

    function miniLedger(plan, part) {
        const unit = plan.poolUnitValue > 0 ? plan.poolUnitValue : 1;
        const owners = new Map();
        const ensure = owner => {
            if (!owners.has(owner.ownerKey)) owners.set(owner.ownerKey, {
                ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color,
                contributedArea: 0, assignedArea: 0
            });
            return owners.get(owner.ownerKey);
        };
        for (const owner of part.input.owners) ensure(owner).contributedArea += part.totalArea * owner.share;
        for (const polygon of part.polygons) {
            for (const owner of polygon.owners) ensure(owner).assignedArea += polygon.area * owner.share;
        }
        return [...owners.values()].map(owner => {
            const source = (plan.ownerShares || []).find(entry => entry.ownerKey === owner.ownerKey);
            const contributedValue = owner.contributedArea * unit;
            const assignedValue = owner.assignedArea * unit;
            const cashOffer = source?.contributedArea > 0 && source.cashOffer > 0
                ? source.cashOffer * owner.contributedArea / source.contributedArea : 0;
            return { ...owner, percent: owner.contributedArea / part.totalArea,
                contributedValue, entitledValue: contributedValue, assignedValue,
                cashBalance: assignedValue - contributedValue, cashOffer };
        });
    }

    function buildBatch({ proposal, parts, cadastralParcels, groupId, titleForParcel }, turfApi) {
        if (!parts.length) throw new Error('No parcel agreements to create.');
        const totalArea = parts.reduce((sum, part) => sum + part.totalArea, 0);
        let allocatedOffer = 0;
        const items = parts.map((part, index) => {
            const cadastreParcelIds = cadastralParcels.filter(entry => {
                const hit = turfApi.intersect(feature(part.input.geometry), entry.feature);
                return hit && turfApi.area(hit) > 0;
            }).map(entry => String(entry.id));
            if (!cadastreParcelIds.length) throw new Error('A parcel agreement has no cadastral anchors.');
            const record = clone(proposal);
            ['proposalId', 'proposalDraftId', 'proposalDraftRevision', 'onchain', 'nft', 'tokenId'].forEach(key => delete record[key]);
            const name = titleForParcel(proposal.title || proposal.name, part.input.label || String(index + 1));
            const offer = index === parts.length - 1 ? proposal.offer - allocatedOffer
                : proposal.offer * part.totalArea / totalArea;
            allocatedOffer += offer;
            const ownerShares = miniLedger(proposal.reparcellization, part);
            const bounds = turfApi.bbox(feature(part.input.geometry));
            Object.assign(record, {
                title: name, name, proposalName: name, cadastreParcelIds, offer, budget: offer,
                applied: false, isMinted: false, termsConfirmed: true,
                acceptedParcelIds: [], ownerAcceptances: {},
                bounds: { south: bounds[1], west: bounds[0], north: bounds[3], east: bounds[2],
                    center: { lat: (bounds[1] + bounds[3]) / 2, lng: (bounds[0] + bounds[2]) / 2 } },
                reparcellizationAgreement: { groupId, index, count: parts.length },
                reparcellization: {
                    algorithm: 'amend', agreementMode: 'single', generatedAt: proposal.createdAt,
                    poolGeometry: clone(part.input.geometry), totalArea: part.totalArea,
                    contributionBasis: proposal.reparcellization.contributionBasis,
                    poolUnitValue: proposal.reparcellization.poolUnitValue,
                    contributionRatio: 1, totalValue: part.totalArea * (proposal.reparcellization.poolUnitValue || 0),
                    isSingleOwner: false, inputParcels: [clone(part.input)], ownerShares,
                    totalCashOffer: ownerShares.reduce((sum, owner) => sum + owner.cashOffer, 0),
                    polygons: clone(part.polygons)
                }
            });
            return { record, proposalId: null };
        });
        return { groupId, items };
    }

    // Read back both persistence and application. The caller keeps this batch in the draft until
    // complete. Group/index tags recover a save even if the following receipt write was interrupted.
    async function resumeBatch(batch, deps) {
        const failures = [];
        const persist = () => deps.persistBatch(clone(batch));
        await persist();
        for (const item of batch.items) {
            try {
                const existing = (item.proposalId && deps.storage.getProposal(item.proposalId))
                    || deps.storage.getAllProposals().find(record =>
                        record.reparcellizationAgreement?.groupId === batch.groupId
                        && record.reparcellizationAgreement?.index === item.record.reparcellizationAgreement.index);
                const id = existing?.proposalId || deps.storage.addProposal(clone(item.record));
                if (!id || !deps.storage.getProposal(id)) throw new Error('The parcel agreement was not saved.');
                item.proposalId = String(id);
                await persist();
            } catch (error) {
                failures.push({ index: item.record.reparcellizationAgreement.index, phase: 'save', message: error.message || String(error) });
            }
        }
        // Do not retire the combined preview until every replacement instruction exists.
        const readyToApply = !failures.length;
        if (readyToApply) {
            for (const item of batch.items) {
                try {
                    if (!deps.isApplied(deps.storage.getProposal(item.proposalId))) {
                        const applied = await deps.apply(item.proposalId);
                        if (!applied || !deps.isApplied(deps.storage.getProposal(item.proposalId))) {
                            throw new Error(deps.applyFailure?.(item.proposalId) || 'The parcel agreement could not be applied.');
                        }
                    }
                    await persist();
                } catch (error) {
                    failures.push({ index: item.record.reparcellizationAgreement.index, phase: 'apply', message: error.message || String(error) });
                }
            }
        }
        // Later applications may displace an earlier one. Completion describes the final state,
        // not the number of apply calls that happened to return true along the way.
        for (const item of batch.items) {
            const index = item.record.reparcellizationAgreement.index;
            if (readyToApply && item.proposalId && !deps.isApplied(deps.storage.getProposal(item.proposalId))
                && !failures.some(failure => failure.index === index)) {
                failures.push({ index, phase: 'apply', message: 'The parcel agreement is not applied.' });
            }
        }
        return { complete: !failures.length, batch, failures,
            created: batch.items.filter(item => item.proposalId && deps.storage.getProposal(item.proposalId)).length,
            applied: batch.items.filter(item => item.proposalId && deps.isApplied(deps.storage.getProposal(item.proposalId))).length };
    }

    return { buildBatch, resumeBatch };
});
