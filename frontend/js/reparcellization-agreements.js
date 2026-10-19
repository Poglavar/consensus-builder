// Build independent courtyard agreements and resume their save/apply operations without duplicates.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationAgreements = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

    function miniLedger(plan, part, offerCents) {
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
            const contributedValue = owner.contributedArea * unit;
            const assignedValue = owner.assignedArea * unit;
            const cashOffer = (offerCents.get(String(owner.ownerKey)) || 0) / 100;
            return { ...owner, percent: owner.contributedArea / part.totalArea,
                contributedValue, entitledValue: contributedValue, assignedValue,
                cashBalance: assignedValue - contributedValue, cashOffer };
        });
    }

    function moneyCents(value, label) {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} must be a finite non-negative amount.`);
        const cents = Math.round((amount + Number.EPSILON * Math.max(1, amount)) * 100);
        if (!Number.isSafeInteger(cents)) throw new Error(`${label} is too large to represent in cents.`);
        return cents;
    }

    function cashOffersInCents(plan) {
        const entries = plan && plan.ownerShares;
        if (entries != null && !Array.isArray(entries)) throw new Error('Owner cash-offer ledger must be an array.');
        const offers = new Map();
        for (const owner of entries || []) {
            if (!owner || owner.noOwner === true) continue;
            if (owner.ownerKey == null || String(owner.ownerKey).trim() === '') {
                throw new Error('Each cash-offer ledger entry needs an owner key.');
            }
            const key = String(owner.ownerKey);
            if (offers.has(key)) throw new Error(`Owner cash-offer ledger contains duplicate owner ${key}.`);
            offers.set(key, moneyCents(owner.cashOffer ?? 0, `Cash offer for ${key}`));
        }
        return offers;
    }

    // Total EUR paid out to owners (the proposal's offer), rounding each owner's amount to cents
    // first. Owner payments are not part of it; the deal's money schedule carries them.
    function cashOfferTotal(plan) {
        const cents = [...cashOffersInCents(plan).values()].reduce((sum, value) => sum + value, 0);
        if (!Number.isSafeInteger(cents)) throw new Error('Owner cash-offer ledger total is too large to represent in cents.');
        return cents / 100;
    }

    // Allocate each owner's declared EUR offer by their contribution to each input parcel.
    // Largest remainder makes every owner's per-parcel cents sum back to the declared amount.
    function offersByPart(plan, parts, proposalOffer) {
        // A payment by one owner funds others across the whole pool; split agreements cannot carry it.
        const payer = (plan?.ownerShares || []).find(owner => owner && owner.noOwner !== true && Number(owner.cashPayment) > 0);
        if (payer) throw new Error(`Owner ${payer.ownerKey} pays cash; owner payments need one joint readjustment agreement.`);
        const declared = cashOffersInCents(plan);
        const declaredTotal = moneyCents(cashOfferTotal(plan), 'Owner cash-offer ledger total');
        const proposalCents = moneyCents(proposalOffer ?? 0, 'Proposal offer');
        if (proposalCents !== declaredTotal) {
            throw new Error(`Proposal offer (${(proposalCents / 100).toFixed(2)} EUR) must equal the owner cash-offer ledger total (${(declaredTotal / 100).toFixed(2)} EUR).`);
        }

        const allocations = parts.map(() => new Map());
        const contributions = new Map();
        parts.forEach((part, index) => {
            if (!Number.isFinite(part.totalArea) || part.totalArea <= 0) {
                throw new Error(`Input parcel ${index + 1} must have a finite positive area.`);
            }
            const inputOwnerKeys = new Set();
            let shareTotal = 0;
            for (const owner of part.input.owners || []) {
                if (!owner || owner.noOwner === true) continue;
                if (owner.ownerKey == null || String(owner.ownerKey).trim() === '') {
                    throw new Error(`Input parcel ${index + 1} has an owner without an owner key.`);
                }
                const key = String(owner.ownerKey);
                if (inputOwnerKeys.has(key)) throw new Error(`Input parcel ${index + 1} contains duplicate owner ${key}.`);
                inputOwnerKeys.add(key);
                const share = Number(owner.share);
                if (!Number.isFinite(share) || share < 0 || share > 1) {
                    throw new Error(`Input parcel ${index + 1} has an invalid ownership share for ${key}.`);
                }
                shareTotal += share;
                const contribution = part.totalArea * share;
                if (contribution > 0) {
                    if (!contributions.has(key)) contributions.set(key, []);
                    contributions.get(key).push({ index, contribution });
                }
            }
            if (inputOwnerKeys.size && Math.abs(shareTotal - 1) > 1e-6) {
                throw new Error(`Input parcel ${index + 1} owner shares must total 100%.`);
            }
        });
        for (const [ownerKey, cents] of declared) {
            if (!cents) continue;
            const shares = contributions.get(ownerKey) || [];
            const total = shares.reduce((sum, entry) => sum + entry.contribution, 0);
            if (!(total > 0)) throw new Error(`Cash offer for ${ownerKey} cannot be allocated because the owner has no input contribution.`);
            const rows = shares.map(entry => {
                const exact = cents * entry.contribution / total;
                return { ...entry, cents: Math.floor(exact), remainder: exact - Math.floor(exact) };
            });
            let remaining = cents - rows.reduce((sum, row) => sum + row.cents, 0);
            rows.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
            for (let i = 0; i < remaining; i++) rows[i].cents += 1;
            for (const row of rows) {
                allocations[row.index].set(ownerKey, (allocations[row.index].get(ownerKey) || 0) + row.cents);
            }
        }
        return allocations;
    }

    function buildBatch({ proposal, parts, cadastralParcels, groupId, titleForParcel }, turfApi) {
        if (!parts.length) throw new Error('No parcel agreements to create.');
        const offers = offersByPart(proposal.reparcellization, parts, proposal.offer);
        const items = parts.map((part, index) => {
            const cadastreParcelIds = cadastralParcels.filter(entry => {
                const hit = turfApi.intersect(feature(part.input.geometry), entry.feature);
                return hit && turfApi.area(hit) > 0;
            }).map(entry => String(entry.id));
            if (!cadastreParcelIds.length) throw new Error('A parcel agreement has no cadastral anchors.');
            const record = clone(proposal);
            ['proposalId', 'proposalDraftId', 'proposalDraftRevision', 'onchain', 'nft', 'tokenId',
                'ownerApprovals', 'ownerApprovalHistory', 'ownerAcceptanceHistory'].forEach(key => delete record[key]);
            const name = titleForParcel(proposal.title || proposal.name, part.input.label || String(index + 1));
            const offerCents = [...offers[index].values()].reduce((sum, cents) => sum + cents, 0);
            const offer = offerCents / 100;
            const ownerShares = miniLedger(proposal.reparcellization, part, offers[index]);
            const bounds = turfApi.bbox(feature(part.input.geometry));
            // A child is a new authored site over this input only. The parent's binding is a
            // snapshot of the combined sibling scope and must be recomputed when this child publishes.
            record.site = clone(part.input.geometry);
            delete record.binding;
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
                    totalCashOffer: offer,
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

    return { buildBatch, resumeBatch, cashOfferTotal };
});
