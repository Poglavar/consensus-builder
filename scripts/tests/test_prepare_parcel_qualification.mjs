import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareCandidate } from '../prepare-parcel-qualification.mjs';
import { parcelSourceCatalog } from '../../backend/parcels/sources.js';
import { decodeSnapshotNativeId } from '../../backend/parcels/geojson-snapshot-source.js';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const source = parcelSourceCatalog.sources.find(row => row.id === 'gh-ama-public-property-app');
const polygon = n => ({ type: 'Polygon', coordinates: [[[n, 5], [n + 0.001, 5], [n + 0.001, 5.001], [n, 5], [n, 5]]] });

async function fixture(features, overrides = {}) {
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-preparer-'));
    const samplePath = 'sample.geojson';
    await fs.writeFile(path.join(sourceRoot, samplePath), JSON.stringify({ type: 'FeatureCollection', features }));
    await fs.writeFile(path.join(sourceRoot, 'provider-proof.json'), JSON.stringify({
        purpose: 'Official parcel register geometry for the municipality.',
        sources: [{ id: source.id, name: source.name, scope: source.scope }]
    }));
    const city = {
        cityCode: 'new-city', cityName: 'New City', point: [5.1, -3.2],
        providerReuse: {
            sourceId: source.id,
            descriptor: { id: source.id, adapter: source.adapter, idPrefix: source.idPrefix },
            sourceEvidenceFiles: [{ path: 'provider-proof.json' }]
        },
        sampleFiles: [{ path: samplePath }],
        ...overrides
    };
    return { city, sourceRoot };
}

test('prepares exact prefixed native IDs, preserves UN point orientation, and uses snapshot codecs', async t => {
    const { city, sourceRoot } = await fixture([
        { type: 'Feature', properties: { parcelid: '001/7' }, geometry: polygon(-3.2) },
        { type: 'Feature', properties: { parcelid: '002' }, geometry: polygon(-3.3) }
    ]);
    t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
    const result = await prepareCandidate(city, { repoRoot, sourceRoot });
    assert.equal(result.status, 'prepared', result.reason);
    assert.deepEqual(result.candidate.city.point, [-3.2, 5.1]);
    assert.equal(result.candidate.metricEpsg, 'EPSG:32630');
    assert.deepEqual(result.candidate.sampleIds, [`${source.idPrefix}001%2F7`, `${source.idPrefix}002`]);
    assert.deepEqual(decodeSnapshotNativeId(result.candidate.absentId.slice(source.idPrefix.length), 1), ['qualification-absent']);
    assert.deepEqual(result.candidate.descriptor.cityIds.slice(-1), ['new-city']);
    assert.equal(result.candidate.sourceClassification.isParcel, true);
});

test('routes conflicting sample geometry for one native ID to LLM review', async t => {
    const { city, sourceRoot } = await fixture([
        { type: 'Feature', properties: { parcelid: 'same' }, geometry: polygon(-3.2) },
        { type: 'Feature', properties: { parcelid: 'same' }, geometry: polygon(-3.3) }
    ]);
    t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
    const result = await prepareCandidate(city, { repoRoot, sourceRoot });
    assert.equal(result.status, 'needs-llm');
    assert.match(result.reason, /conflicting geometry/);
});

test('does not emit unsafe descriptor fields or infer a web source without a provider packet', async t => {
    const unsafe = await fixture([{ type: 'Feature', properties: { parcelid: 'one' }, geometry: polygon(-3.2) }]);
    t.after(() => fs.rm(unsafe.sourceRoot, { recursive: true, force: true }));
    unsafe.city.providerReuse.descriptor.outFields = ['ownerName'];
    const result = await prepareCandidate(unsafe.city, { repoRoot, sourceRoot: unsafe.sourceRoot });
    assert.equal(result.status, 'needs-llm');
    assert.match(result.reason, /sensitive fields/);

    const webCity = { cityCode: 'web-city', cityName: 'Web City', point: [0, 0], discoveryMethod: 'web' };
    const webResult = await prepareCandidate(webCity, { repoRoot, sourceRoot: unsafe.sourceRoot });
    assert.equal(webResult.status, 'needs-llm');
    assert.match(webResult.reason, /provider reuse descriptor/);
});

test('rejects conflicting packet descriptor identity rather than replacing production settings', async t => {
    const { city, sourceRoot } = await fixture([{ type: 'Feature', properties: { parcelid: 'one' }, geometry: polygon(-3.2) }]);
    t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
    city.providerReuse.descriptor.idPrefix = 'WRONG-';
    const result = await prepareCandidate(city, { repoRoot, sourceRoot });
    assert.equal(result.status, 'needs-llm');
    assert.match(result.reason, /conflicts with catalog identity field idPrefix/);
});

test('uses frozen queue identity and verifies the sample file hash before preparation', async t => {
    const { city, sourceRoot } = await fixture([{ type: 'Feature', properties: { parcelid: 'queue-id' }, geometry: polygon(-3.2) }]);
    t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
    const packet = {
        cityCode: city.cityCode, cityName: city.cityName, point: city.point,
        providerReuse: city.providerReuse, sampleFiles: city.sampleFiles
    };
    await fs.writeFile(path.join(sourceRoot, 'provider-packet.json'), JSON.stringify(packet));
    const bytes = await fs.readFile(path.join(sourceRoot, 'sample.geojson'));
    const frozen = {
        cityCode: city.cityCode, cityName: city.cityName, point: city.point,
        packetRepoRelativePath: 'provider-packet.json',
        sampleFiles: [{ repoRelativePath: 'sample.geojson', sha256: createHash('sha256').update(bytes).digest('hex') }]
    };
    const result = await prepareCandidate(frozen, { repoRoot, sourceRoot });
    assert.equal(result.status, 'prepared', result.reason);
    frozen.sampleFiles[0].sha256 = '0'.repeat(64);
    const changed = await prepareCandidate(frozen, { repoRoot, sourceRoot });
    assert.equal(changed.status, 'needs-llm');
    assert.match(changed.reason, /[Ss]ample file hash/);

    frozen.point = [city.point[0] + 1, city.point[1]];
    const mismatched = await prepareCandidate(frozen, { repoRoot, sourceRoot });
    assert.equal(mismatched.status, 'needs-llm');
    assert.match(mismatched.reason, /does not match frozen queue/);
});

test('creates a pattern-valid unobserved GUID using the descriptor format', async t => {
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-preparer-guid-'));
    t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
    const guidSource = parcelSourceCatalog.sources.find(row => row.id === 'ca-qc-cadastre-bd-allegee');
    await fs.writeFile(path.join(sourceRoot, 'sample.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { id: '02a8dd9d-4b90-488e-b71f-b974d8c2763c' }, geometry: polygon(-73.5) }
    ] }));
    await fs.writeFile(path.join(sourceRoot, 'proof.json'), JSON.stringify({ purpose: 'Official cadastre.', sources: [{
        id: guidSource.id, name: guidSource.name, scope: guidSource.scope
    }] }));
    const city = {
        cityCode: 'guid-city', cityName: 'GUID City', point: [45.5, -73.5], sampleFiles: [{ path: 'sample.geojson' }],
        providerReuse: { descriptor: { id: guidSource.id, adapter: guidSource.adapter, idPrefix: guidSource.idPrefix,
            endpoint: guidSource.endpoint, idField: guidSource.idField, idType: guidSource.idType,
            idPattern: guidSource.idPattern, objectIdField: guidSource.objectIdField,
            outFields: ['GlobalID', 'OBJECTID'] }, sourceEvidenceFiles: [{ path: 'proof.json' }] }
    };
    const result = await prepareCandidate(city, { repoRoot, sourceRoot });
    assert.equal(result.status, 'prepared', result.reason);
    assert.match(result.candidate.absentId, /^CA-QC-CADASTRE-[0-9f-]{36}$/);
    assert.notEqual(result.candidate.absentId, result.candidate.sampleIds[0]);
    assert.equal(result.candidate.descriptor.metricSridByCity['guid-city'], 32618);
});

test('CLI writes a safe needs-llm preparation record and exits 2', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-preparer-cli-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const requestPath = path.join(temp, 'request.json');
    const outputPath = path.join(temp, 'candidate.json');
    await fs.writeFile(requestPath, JSON.stringify({ city: { cityCode: 'web-city' }, repoRoot, sourceRoot: temp }));
    const script = path.resolve(new URL('../prepare-parcel-qualification.mjs', import.meta.url).pathname);
    const run = spawnSync(process.execPath, [script, '--request', requestPath, '--output', outputPath], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.equal(await fs.stat(outputPath).then(() => true, () => false), false);
    const preparation = JSON.parse(await fs.readFile(path.join(temp, 'preparation.json'), 'utf8'));
    assert.equal(preparation.status, 'needs-llm');
    assert.match(preparation.reason, /repository root is missing|provider reuse descriptor/);
});

test('accepts a provider jurisdiction basis backed by evidence as source-purpose proof', async t => {
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'parcel-preparer-jurisdiction-'));
    t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
    const uldk = parcelSourceCatalog.sources.find(row => row.id === 'pl-gugik-uldk');
    await fs.writeFile(path.join(sourceRoot, 'sample.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { id: '146506_8.0104.1' }, geometry: polygon(21.0) }
    ] }));
    // A country research file with no purpose/scope text, as for Poland.
    await fs.writeFile(path.join(sourceRoot, 'country.json'), JSON.stringify({ countryCode: 'PL', status: 'verified' }));
    const city = () => ({
        cityCode: '2093', cityName: 'Example', point: [52.2, 21.0], sampleFiles: [{ path: 'sample.geojson' }],
        providerReuse: { descriptor: { id: uldk.id, adapter: uldk.adapter, idPrefix: uldk.idPrefix, endpoint: uldk.endpoint,
            idField: uldk.idField, idPattern: uldk.idPattern, outFields: uldk.outFields }, sourceEvidenceFiles: [{ path: 'country.json' }] }
    });
    const prepared = await prepareCandidate(city(), { repoRoot, sourceRoot });
    assert.equal(prepared.status, 'prepared', prepared.reason);
    assert.ok(prepared.candidate.sourceClassification.evidence.includes(uldk.discovery.jurisdiction.basis));
    assert.equal(prepared.candidate.absentId, 'PL-ULDK-146506_8.0104.999999');
    await fs.writeFile(path.join(sourceRoot, 'sample.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { id: '247301_1.0089.AR_7.3035/160' }, geometry: polygon(18.5) }
    ] }));
    const sheet = await prepareCandidate(city(), { repoRoot, sourceRoot });
    assert.equal(sheet.status, 'prepared', sheet.reason);
    assert.equal(sheet.candidate.absentId, 'PL-ULDK-247301_1.0089.AR_7.999999');
    await fs.writeFile(path.join(sourceRoot, 'sample.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { id: '146506_8.0104.1' }, geometry: polygon(21.0) }
    ] }));
    const profile = uldk.discovery;
    delete uldk.discovery;
    t.after(() => { uldk.discovery = profile; });
    const unbacked = await prepareCandidate(city(), { repoRoot, sourceRoot });
    assert.equal(unbacked.status, 'needs-llm');
    assert.match(unbacked.reason, /source-purpose evidence/);
    const packetScope = city();
    packetScope.providerReuse.scopeEvidence = [{ basis: 'National parcel lookup.', countryCode: 'PL', evidence: ['research/countries/PL.json'] }];
    assert.equal((await prepareCandidate(packetScope, { repoRoot, sourceRoot })).status, 'prepared');
});
