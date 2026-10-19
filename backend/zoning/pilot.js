// Expose the dated public audit only when its BBL and normalized PLUTO inputs
// still match. The audit is evidence for screening, never a site review.
import { readFileSync } from 'node:fs';
import { inputFingerprint } from './eligibility.js';
import { RULE_VERSION } from './districts.js';

const directory = new URL('./pilot/2026-10-19/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
const manifest = read('manifest.json');
const records = new Map(manifest.candidates.map(({ bbl }) => [bbl, read(`${bbl}.json`)]));

export function getPilotEvidence(pluto) {
    const record = records.get(pluto.bbl);
    if (manifest.ruleVersion !== RULE_VERSION || !record || record.error
        || record.snapshotHash !== manifest.snapshotHash || record.inputFingerprint !== inputFingerprint(pluto)) return null;
    return {
        status: record.publicScreen,
        fetchedAt: record.fetchedAt,
        snapshotHash: record.snapshotHash,
        flags: record.flags,
        districts: [...new Set(record.intersections.nyzd.features.map(feature => feature.attributes.ZONEDIST))],
        sources: manifest.metadata,
        zolaUrl: record.zolaUrl,
        scope: 'Dated GIS intersection screen of a tax-lot polygon; surveyed zoning boundaries and legal rights remain unverified.',
    };
}
