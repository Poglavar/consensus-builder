import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agents = readFileSync(fileURLToPath(new URL('../../frontend/js/agents.js', import.meta.url)), 'utf8');

describe('parcel ownership storage scan', () => {
    it('uses the storage cache linear iterator on the normal path', () => {
        const helper = agents.slice(
            agents.indexOf('function forEachPersistentParcelOwnership(iterator)'),
            agents.indexOf('function getAgentOwnedParcels(')
        );
        expect(helper).toContain("typeof PersistentStorage.forEach === 'function'");
        expect(helper).toContain('PersistentStorage.forEach((ownerId, key) => {');
    });

    it('does not repeat key(i) scans in either ownership consumer', () => {
        const owned = agents.slice(
            agents.indexOf('function getAgentOwnedParcels('),
            agents.indexOf('function updateAgentOwnedParcels(')
        );
        expect(owned).toContain('forEachPersistentParcelOwnership((ownerId, parcelId) => {');
        expect(owned).toContain('forEachPersistentParcelOwnership(addOwnership);');
        expect(owned).not.toContain('PersistentStorage.key(');
    });
});
