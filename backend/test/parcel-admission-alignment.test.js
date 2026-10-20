// Admission records unresolved native-CRS alignment as follow-up while preserving core parcel qualification.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAdmissionEvidence } from '../../scripts/admit-qualified-cities.mjs';
import { alignmentContractHash } from '../../scripts/lib/parcel-alignment.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'parcel-admission-alignment-'));
    const evidence = {};
    const save = (key, data) => {
        const bytes = JSON.stringify(data);
        evidence[key] = join(dir, `${key}.json`); writeFileSync(evidence[key], bytes);
        return digest(bytes);
    };
    const descriptor = { id: 'public-source', adapter: 'arcgis', endpoint: 'https://example.gov/MapServer/0', idPrefix: 'SRC-', idField: 'OBJECTID' };
    const candidate = { city: { code: '123' }, descriptor,
        sourceClassification: { isParcel: true, evidence: ['Official parcel-layer description.'] } };
    const candidateSha256 = save('candidate', candidate);
    const cacheSha256 = save('cache', { type: 'FeatureCollection', features: [{
        type: 'Feature', id: 'SRC-1', properties: { sourceId: descriptor.id, sourceParcelId: '1' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] }
    }] });
    const blockers = Object.fromEntries(['invalidCount', 'duplicateIdCount', 'conflictingSameIdGeometryCount',
        'exactGeometryDuplicateCount', 'overlapPairCount', 'operationErrorCount'].map(key => [key, 0]));
    save('metric', { inputSha256: cacheSha256 });
    save('independent', { inputSha256: cacheSha256, geometryChangedOrRepaired: false, geometryPass: true, ...blockers });
    const metadataSha256 = save('alignmentMetadata', { extent: { spatialReference: { wkid: 3857 } } });
    const nativeSha256 = save('alignmentNative', { type: 'NativeParcelSamples', features: [] });
    const pack = { nativeCrs: 'EPSG:3857', nativeAxisOrder: 'east-north' };
    const evidenceSha256 = save('alignmentEvidence', pack);
    const alignment = { ...pack, passed: true, sourceId: descriptor.id, cityCode: '123',
        contractSha256: alignmentContractHash(descriptor), cacheSha256, evidenceSha256, metadataSha256, nativeSha256,
        sourceGeometryChanged: false, fittedOffsetApplied: false, bestOperationAvailable: true, ballparkAllowed: false,
        maxVertexDifferenceM: 0, maxBoundaryDifferenceM: 0, toleranceM: 0.25 };
    save('alignment', alignment); save('independentAlignment', alignment);
    const checks = Object.fromEntries(['classification', 'exactIds', 'stableGeometry', 'explicitAbsence', 'sampling', 'completeness',
        'binding', 'metric', 'alignment'].map(key => [key, { passed: true }]));
    const qualification = { status: 'technical-qualified', sourceId: descriptor.id, cityCode: '123',
        candidateSha256, cacheSha256, featureCount: 1, checks };
    save('qualification', qualification);
    return { dir, evidence, descriptor, qualification, alignment, save };
}

describe('parcel admission alignment follow-up', () => {
    it('records missing alignment as follow-up after core parcel qualification', () => {
        const f = fixture();
        try {
            delete f.qualification.checks.alignment;
            f.save('qualification', f.qualification);
            const result = verifyAdmissionEvidence(f.evidence, f.descriptor);
            expect(result.checks.alignment.passed).toBe(false);
            expect(result.initialQualificationReview.followUp.map(item => item.check)).toContain('alignment');
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
    it('rejects a production projection changed after qualification', () => {
        const f = fixture();
        try {
            expect(typeof verifyAdmissionEvidence(f.evidence, f.descriptor)).toBe('object');
            expect(verifyAdmissionEvidence(f.evidence, { ...f.descriptor, responseSrid: 3857 })).toContain('coordinate contract differs');
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
    it('records altered native proof bytes or an independent discrepancy as unresolved alignment', () => {
        const f = fixture();
        try {
            f.save('independentAlignment', { ...f.alignment, maxBoundaryDifferenceM: 1 });
            let result = verifyAdmissionEvidence(f.evidence, f.descriptor);
            expect(result.checks.alignment.passed).toBe(false);
            expect(result.initialQualificationReview.followUp.map(item => item.check)).toContain('alignment');
            f.save('independentAlignment', f.alignment);
            f.save('alignmentNative', { changed: true });
            result = verifyAdmissionEvidence(f.evidence, f.descriptor);
            expect(result.checks.alignment.passed).toBe(false);
            expect(result.initialQualificationReview.followUp.map(item => item.check)).toContain('alignment');
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
});
