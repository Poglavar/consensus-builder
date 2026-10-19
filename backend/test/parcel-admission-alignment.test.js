// New admissions require intact independent native-CRS evidence matching the production adapter.
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
    const candidate = { city: { code: '123' }, descriptor };
    const candidateSha256 = save('candidate', candidate);
    const cacheSha256 = save('cache', { type: 'FeatureCollection', features: [] });
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
    const qualification = { status: 'technical-qualified', candidateSha256, cacheSha256, checks };
    save('qualification', qualification);
    return { dir, evidence, descriptor, qualification, alignment, save };
}

describe('parcel admission alignment gate', () => {
    it('rejects old eight-gate evidence for a new admission', () => {
        const f = fixture();
        try {
            delete f.qualification.checks.alignment;
            f.save('qualification', f.qualification);
            expect(verifyAdmissionEvidence(f.evidence, f.descriptor)).toBe('not every gate passed');
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
    it('rejects a production projection changed after qualification', () => {
        const f = fixture();
        try {
            expect(typeof verifyAdmissionEvidence(f.evidence, f.descriptor)).toBe('object');
            expect(verifyAdmissionEvidence(f.evidence, { ...f.descriptor, responseSrid: 3857 })).toContain('coordinate contract differs');
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
    it('rejects altered native proof bytes or an independent discrepancy', () => {
        const f = fixture();
        try {
            f.save('independentAlignment', { ...f.alignment, maxBoundaryDifferenceM: 1 });
            expect(verifyAdmissionEvidence(f.evidence, f.descriptor)).toContain('alignment audit does not pass');
            f.save('independentAlignment', f.alignment);
            f.save('alignmentNative', { changed: true });
            expect(verifyAdmissionEvidence(f.evidence, f.descriptor)).toContain('alignment audit does not pass');
        } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
});
