// Check the saved public evidence and its runtime gate against actual pilot lots.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPilotEvidence } from '../zoning/pilot.js';
import { computeEnvelope } from '../zoning/envelope.js';
import { normalizePlutoRow } from '../zoning/pluto.js';
import { inputFingerprint } from '../zoning/eligibility.js';

const directory = new URL('../zoning/pilot/2026-10-19/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
const summary = read('summary.json');

describe('Saved NYC pilot evidence', () => {
    it('reconciles all 25 records with their source inputs and does not certify any lot', () => {
        const counts = { clear: 0, flagged: 0 };
        expect(summary.audited).toBe(25);
        expect(new Set(summary.lots.map(lot => lot.bbl)).size).toBe(25);
        for (const lot of summary.lots) {
            const record = read(`${lot.bbl}.json`);
            expect(normalizePlutoRow(record.rawPluto)).toEqual(record.pluto);
            expect(inputFingerprint(record.pluto)).toBe(record.inputFingerprint);
            const evidence = getPilotEvidence(record.pluto);
            expect(evidence).not.toBeNull();
            expect(evidence.flags).toEqual(lot.flags);
            if (evidence.flags.length) counts.flagged++; else counts.clear++;
            expect(computeEnvelope(record.pluto, null, { publicScreen: evidence })).toMatchObject({ status: 'needs-review', result: null });
        }
        expect(counts).toEqual({ clear: summary.withoutMappedConflicts, flagged: summary.flagged });
        expect(summary.failed).toBe(0);
        expect(summary.reviewedEnvelopes).toBe(0);
    });

    it('surfaces a map overlay which PLUTO did not flag', () => {
        const record = read('3016230003.json');
        expect(record.pluto.overlay1).toBeNull();
        expect(getPilotEvidence(record.pluto).flags).toContain('nyco: mapped constraint intersects the tax-lot polygon.');
    });

    it('rejects stale and unrelated audit input', () => {
        const record = read('3016010012.json');
        expect(getPilotEvidence({ ...record.pluto, version: 'different' })).toBeNull();
        expect(getPilotEvidence({ ...record.pluto, lotArea: record.pluto.lotArea + 1 })).toBeNull();
        expect(getPilotEvidence({ ...record.pluto, bbl: '3016019999' })).toBeNull();
    });
});
