import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyCrosswalkDecision, classifyNameCoordinateMatch, hasAttemptSignal,
    isSearchableEvidenceFile, parseWup2025Fields
} from '../overnight-city-queue-classification.mjs';

test('same-name cross-country cities do not match', () => {
    const candidate = { cityCode: 7079, iso2: 'US', name: 'Saint Petersburg', point: [27.77, -82.64] };
    const russianCity = { countryCode: 'RU', name: 'Saint Petersburg', centerLatLon: [59.94, 30.31] };
    assert.equal(classifyNameCoordinateMatch(candidate, russianCity), null);
});

test('same-country duplicate name 52.38 km away remains a review lead, not a confirmed identity', () => {
    const candidate = { cityCode: 10979, iso2: 'IN', name: 'Kalyanpur', point: [26.0, 83.5] };
    const previous = { countryCode: 'IN', name: 'Kalyanpur', centerLatLon: [26.0, 83.5 + 52.38 / ((6371 * Math.PI / 180) * Math.cos(26 * Math.PI / 180))] };
    const match = classifyNameCoordinateMatch(candidate, previous);
    assert.equal(match.kind, 'same-country-name-distance-review');
    assert.ok(Math.abs(match.distanceKm - 52.38) < 0.02);
    const result = applyCrosswalkDecision(candidate, [
        { evidenceFile: 'india-city-10893.json', ...match },
        { evidenceFile: 'india-city-10979-current.json', kind: 'city-name-file-candidate' }
    ], {
        wupCityCode: 10979, countryCode: 'IN', decision: 'different_settlement',
        excludeEvidenceFiles: ['world-parcels/india-city-10893.json']
    });
    assert.equal(result.attempted, false);
    assert.equal(result.holdForReview, true);
    assert.equal(result.resolvedMatches.length, 1);
    assert.equal(result.activeMatches[0].evidenceFile, 'india-city-10979-current.json');
});

test('blank population and coordinates are rejected instead of becoming zeros', () => {
    assert.equal(parseWup2025Fields({ City_Code: '10', Pop: '', PWCent_Latitude: '0', PWCent_Longitude: '0' }), null);
    assert.equal(parseWup2025Fields({ City_Code: '10', Pop: '1', PWCent_Latitude: '', PWCent_Longitude: '0' }), null);
    assert.deepEqual(parseWup2025Fields({ City_Code: '10', Pop: '1', PWCent_Latitude: '0', PWCent_Longitude: '0' }), { cityCode: 10, pop2025k: 1, point: [0, 0] });
});

test('failed city attempts count as prior attempts when evidence is explicit', () => {
    assert.equal(hasAttemptSignal({ status: 'failed' }), true);
    assert.equal(hasAttemptSignal({ status: 'failed', checked: false }), false);
    assert.equal(hasAttemptSignal({ status: 'pending' }), false);
});

test('decision files and generated queue outputs cannot self-certify as attempt evidence', () => {
    assert.equal(isSearchableEvidenceFile('world-parcels/research/overnight-cities-2026-10-08/attempt-crosswalks.json'), false);
    assert.equal(isSearchableEvidenceFile('world-parcels/research/overnight-cities-2026-10-08/ranked-top1000.json'), false);
    assert.equal(isSearchableEvidenceFile('world-parcels/research/city-response.json'), true);
});
