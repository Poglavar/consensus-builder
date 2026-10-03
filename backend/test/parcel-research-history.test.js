// Keeps successful and failed source attempts reviewable and linked to saved evidence.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parcelSourceCatalog } from '../parcels/sources.js';

const registry = JSON.parse(readFileSync(new URL('../../world-parcels/registry.json', import.meta.url), 'utf8'));
const evidence = relative => new URL(`../../world-parcels/${relative}`, import.meta.url);
const latest = JSON.parse(readFileSync(evidence('research/shared-city-batch-2026-10-03.json'), 'utf8'));
describe('saved parcel integration history', () => {
    it('links every dated attempt and runtime assessment to a saved research file', () => {
        for (const source of registry.sources) {
            const refs = [source.liveIntegration?.evidenceFile,
                ...Object.values(source.liveIntegration?.additionalCityEvidence || {})];
            for (const attempt of source.integrationAttempts || []) {
                expect(attempt.checkedAt, source.sourceId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                expect(attempt.endpoint, source.sourceId).toMatch(/^https?:\/\//);
                expect(attempt.operation).toBeTruthy();
                expect(attempt.detail).toBeTruthy();
                expect(attempt.outcome).toBeTruthy();
                refs.push(attempt.evidenceFile);
            }
            for (const ref of refs.filter(Boolean)) {
                expect(ref).toMatch(/^research\/[a-z0-9._/-]+\.json$/);
                expect(ref).not.toContain('..');
                expect(existsSync(evidence(ref)), `${source.sourceId}: ${ref}`).toBe(true);
                expect(() => JSON.parse(readFileSync(evidence(ref), 'utf8'))).not.toThrow();
            }
        }
    });
    it('records every enabled city on the same provider in both catalogs', () => {
        expect(parcelSourceCatalog.schemaVersion).toBe(2);
        for (const descriptor of parcelSourceCatalog.sources) {
            const source = registry.sources.find(s => s.sourceId === descriptor.id);
            expect(source?.liveIntegration?.status, descriptor.id).toBe('enabled');
            expect(source.liveIntegration.cityIds.slice().sort()).toEqual(descriptor.cityIds.slice().sort());
        }
    });
    it('retains the next-batch holds and specific failed protocol checks', () => {
        const held = latest.sources.filter(s => s.status === 'held');
        expect(held).toHaveLength(5); // two separate Lima publishers, not one interchangeable source
        for (const source of held) {
            const saved = registry.sources.find(s => s.sourceId === source.sourceId);
            expect(saved.liveIntegration).toMatchObject({ status: 'held', reason: source.reason });
            expect(saved.integrationAttempts.length).toBeGreaterThan(0);
        }
        const dominican = registry.sources.find(s => s.sourceId === 'do-ri-atlas-geoserver');
        expect(dominican.integrationAttempts.some(a => a.outcome === 'paging-repeated-records')).toBe(true);
        const angola = registry.sources.find(s => s.sourceId === 'ao-arcgis-luanda-agt-property-polygons');
        expect(angola.integrationAttempts.some(a => a.outcome === 'query-rejected' && a.upstreamErrorCode === 400)).toBe(true);
    });
});
