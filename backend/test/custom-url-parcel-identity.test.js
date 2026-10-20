import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const identity = require('../../frontend/js/parcels/custom-url-identity.js');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const url = 'https://data.example.org/parcels.geojson';
const geometry = { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] };
const feature = properties => ({ type: 'Feature', properties, geometry });

describe('custom register identity', () => {
    it('commits to the exact trimmed source URL with SHA-256', () => {
        expect(identity.sourceId(` ${url} `)).toBe(`custom-url:sha256:${sha256(url)}`);
        expect(identity.sourceId(`${url}?edition=2`)).not.toBe(identity.sourceId(url));
        expect(() => identity.sourceId('')).toThrow(/URL is required/);
    });

    it('keeps the same native ID separate across sources, even with equal geometry', () => {
        const a = identity.featureIdentity(feature({ OBJECTID: 7 }), identity.sourceId(url));
        const b = identity.featureIdentity(feature({ OBJECTID: 7 }), identity.sourceId('https://other.example.org/parcels'));
        expect(a).toEqual({ parcelId: `URL:${sha256(url)}:native:7`, sourceId: identity.sourceId(url),
            sourceParcelId: '7', sourceIdentityKind: 'native-id' });
        expect(a.parcelId).not.toBe(b.parcelId);
        expect(() => identity.featureIdentity(feature({ id: 7 }))).toThrow(/qualified custom source ID/);
    });

    it('retains native identity across geometry edits and safely encodes delimiters', () => {
        const input = feature({ id: 'a#b:/c% d' });
        const source = identity.sourceId(url);
        const first = identity.featureIdentity(input, source);
        expect(first.parcelId).toBe(`URL:${sha256(url)}:native:a%23b%3A%2Fc%25%20d`);
        expect(identity.featureIdentity({ ...input, geometry: { ...geometry, coordinates: [] } }, source)).toEqual(first);
        expect(identity.featureIdentity(feature({ OBJECTID: 0 }), source).sourceParcelId).toBe('0');
    });

    it('names anonymous geometry content without inventing a provider ID', () => {
        const source = identity.sourceId(url);
        const first = identity.featureIdentity(feature({}), source);
        const hash = sha256(JSON.stringify(geometry));
        expect(first).toEqual({ parcelId: `URL:${sha256(url)}:geometry:${hash}`, sourceId: source,
            sourceParcelId: null, sourceIdentityKind: 'geometry-content' });
        expect(identity.featureIdentity(feature({ name: 'Cosmetic label' }), source)).toEqual(first);
        expect(identity.featureIdentity(feature({ id: hash }), source).parcelId).not.toBe(first.parcelId);
        const changed = structuredClone(feature({})); changed.geometry.coordinates[0][1][0] = 3;
        expect(identity.featureIdentity(changed, source).parcelId).not.toBe(first.parcelId);
        expect(identity.featureIdentity(feature({}), identity.sourceId(`${url}?other`)).parcelId).not.toBe(first.parcelId);
    });
});
