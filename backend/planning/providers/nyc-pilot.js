// Read the existing, bounded NYC audit as evidence. It contains no accepted massing.
import { getSavedPilotRecords } from '../../zoning/pilot.js';
import { withSourceProposal, sourceRevision } from '../source-proposal.js';

export const nycPilotSource = Object.freeze({
    id: 'nyc-r6a-pilot-2026-10-19', city: 'new_york', label: 'NYC R6A · 2026-10-19',
    edition: '2026-10-19', default: true, kind: 'regulation', coverage: 'pilot-records',
    url: 'https://zoningresolution.planning.nyc.gov/', storage: 'zoning/pilot/2026-10-19',
    capabilities: { volumes: false, parcelEvidence: true, constraintEvaluation: false },
    scenario: 'new-attached-multifamily'
});

export function pilotRecord(record) {
    const parcel = `US-NY-${record.bbl}`;
    return withSourceProposal({
        id: `${nycPilotSource.id}:${record.bbl}`, role: 'permitted', proposalId: null,
        title: record.address, site: null, volumes: [],
        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
        source: { ...nycPilotSource, recordId: record.bbl, parcel, version: sourceRevision(record),
            fetchedAt: record.fetchedAt, url: record.zolaUrl },
        authority: { effect: 'obligatory', basis: 'public-screen', applicability: 'unresolved' },
        assessment: { meaning: 'public-screen', status: record.publicScreen,
            reason: record.flags?.length ? record.flags.join('\n') : null,
            geometry: 'not-available', constraints: 'not-evaluated', current: true },
        metrics: { floorAreaM2: null, heightM: null }, constraints: [],
        sourceEvidence: { publicScreen: record.publicScreen, flags: record.flags,
            snapshotHash: record.snapshotHash, inputFingerprint: record.inputFingerprint, pluto: record.pluto }
    });
}

export async function readNycPilotParcel(_pool, { parcel }) {
    const bbl = parcel.replace(/^(US-NY-|US-NYC-BBL-)/, '');
    return getSavedPilotRecords().filter(record => record.bbl === bbl).map(pilotRecord);
}

export async function queryNycPilot(_pool, { bbox }) {
    const records = getSavedPilotRecords().filter(({ pluto }) => pluto.longitude >= bbox[0]
        && pluto.latitude >= bbox[1] && pluto.longitude <= bbox[2] && pluto.latitude <= bbox[3]);
    const statuses = {};
    for (const record of records) statuses[record.publicScreen] = (statuses[record.publicScreen] || 0) + 1;
    return { items: [], nextAfter: null, omitted: 0, summary: {
        sourceId: nycPilotSource.id, cachedResults: records.length, withGeometry: 0,
        withoutGeometry: records.length, statuses
    } };
}
