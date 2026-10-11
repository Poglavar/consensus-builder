import { afterEach, expect, test, vi } from 'vitest';

const observed = vi.hoisted(() => ({ calls: [] }));
vi.mock('../parcels/hmlr-browser-source.js', () => ({
    createHmlrBrowserParcelSource: (descriptor, options) => {
        observed.calls.push({ descriptor, options });
        return { queryBounds: async () => null, queryIds: async () => null, queryGeometry: async () => null };
    }
}));

import { createParcelSource } from '../parcels/sources.js';
import { disposeSharedNodeHmlrFeatureStores } from '../parcels/node-hmlr-feature-store.js';

afterEach(async () => {
    await disposeSharedNodeHmlrFeatureStores();
    observed.calls.length = 0;
});

test('node HMLR factory reuses its disk store by manifest and snapshot while honoring overrides', async () => {
    const descriptor = { id: 'gb-hmlr-browser-v1', adapter: 'hmlr-browser', idPrefix: 'GB-HMLR-BROWSER-v1-',
        manifestUrl: 'https://metadata.example/hmlr/manifest.json' };
    const first = createParcelSource(descriptor);
    await first.queryIds([]);
    const firstStore = observed.calls[0].options.featureStore;
    const second = createParcelSource({ ...descriptor });
    await second.queryIds([]);
    expect(observed.calls[1].options.featureStore).toBe(firstStore);

    const pinned = createParcelSource({ ...descriptor, snapshotId: 'release-2' });
    await pinned.queryIds([]);
    expect(observed.calls[2].options.featureStore).not.toBe(firstStore);

    const customStore = { getAuthority() {} };
    const custom = createParcelSource(descriptor, { featureStore: customStore });
    await custom.queryIds([]);
    expect(observed.calls[3].options.featureStore).toBe(customStore);
});
