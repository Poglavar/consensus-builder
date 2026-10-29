// Prepare labelled Candlestick devnet demos from the reviewed stored designs. Source hashes and
// parcel identities are checked before publication; a demo never supplies real landowner consent.
import { createHash } from 'node:crypto';
import * as turf from '@turf/turf';
import { canonicalBytes } from '../../cid.js';
import { footprintParts } from '../../proposals/footprint.js';
import { designObject, agreementObject, noMoney, ownersRule, planForDesigns } from '../../agents/agreement-objects.js';

export function prepareSfDemoDesigns(records, intents, { authoredAt } = {}) {
    if (!Array.isArray(records) || !Array.isArray(intents?.intents) || intents.intents.length !== 2) {
        throw new Error('Both reviewed SF agreement intents and their stored source records are required.');
    }
    if (typeof authoredAt !== 'string' || new Date(authoredAt).toISOString() !== authoredAt) {
        throw new Error('An explicit canonical authoredAt is required.');
    }
    return intents.intents.map(intent => {
        const row = records.find(row => row.proposal_id === intent.sourceRecord.proposalId);
        if (!row?.proposal_data) throw new Error(`Missing stored source ${intent.sourceRecord.proposalId}.`);
        const hash = createHash('sha256').update(canonicalBytes(row.proposal_data)).digest('hex');
        if (hash !== intent.sourceRecord.contentSha256) throw new Error(`Stored source hash differs for ${intent.key}.`);
        const sourceIds = [...(row.cadastre_parcel_ids || [])].sort();
        const expectedIds = [...intent.land.parcelIds].sort();
        if (JSON.stringify(sourceIds) !== JSON.stringify(expectedIds)) throw new Error(`Stored parcel identities differ for ${intent.key}.`);
        const title = `DEVNET DEMO: ${intent.agreementLabel}`;
        // The archived Courtyard footprint spills slightly outside its old site. Make the authored
        // site contain the actual imported footprint; building coordinates remain unchanged.
        let site = turf.feature(row.proposal_data.site);
        for (const polygon of footprintParts(row.proposal_data).polygons) site = turf.union(site, turf.feature(polygon));
        const design = designObject({ ...row.proposal_data, site: site.geometry, title, author: 'devnet-demonstration', createdAt: authoredAt,
            description: `Labelled devnet demonstration with simulated rights. Imported design provenance does not establish landowner consent, a permit, or construction. ${row.proposal_data.description || ''}` });
        return { key: intent.key, title, deadline: new Date(intent.proposedDeadline).toISOString(),
            sourceProposalId: row.proposal_id, sourceContentSha256: hash, parcelSourceId: intent.land.sourceId,
            expectedParcelIds: expectedIds, sitePreparation: { method: 'union-with-imported-footprints' }, design };
    });
}

export function buildSfDemoAgreement({ item, sponsor, lens, rights, binding, ground, authoredAt }) {
    const ids = ground.inputs.map(parcel => String(parcel.parcelId)).sort();
    const boundIds = binding.parcels.map(parcel => String(parcel.parcelId)).sort();
    if (JSON.stringify(ids) !== JSON.stringify(boundIds) || item.expectedParcelIds.some(id => !ids.includes(id))) {
        throw new Error('Captured input parcels must match the current source binding and retain the reviewed source inputs.');
    }
    if (typeof ground.openGroundM2 !== 'number' || !Number.isFinite(ground.openGroundM2) || ground.openGroundM2 < 0) {
        throw new Error('Captured open ground must be explicitly measured.');
    }
    const plan = planForDesigns(item.title, [item.design]);
    // Each parcel is its owners' abstract party; the simulated holders live only in the rule's rights.
    const contentParcels = ground.inputs.map(parcel => ({ ...parcel, parcelSourceId: item.parcelSourceId }));
    return agreementObject({ title: item.title, author: 'devnet-demonstration', sponsor, city: 'san_francisco',
        createdAt: authoredAt, deadline: item.deadline, designs: [{ cid: item.design.cid, goal: 'buildings', title: item.title }],
        plan, parcels: contentParcels, outputs: ground.outputs, openGroundM2: ground.openGroundM2, money: noMoney('USD'),
        rule: ownersRule({ lens, rights }) });
}
