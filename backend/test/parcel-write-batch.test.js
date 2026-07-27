import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parcelId = require('../../frontend/js/proposals/parcel-id.js');

describe('parcel display numbers', () => {
    it('owns and resolves the cadastral display-number fields without a sharing-module global', () => {
        expect(parcelId.PARCEL_NUMBER_PROPERTY_CANDIDATES).toContain('BROJ_CESTICE');
        expect(parcelId.getParcelDisplayNumberFromProperties({
            BROJ_CESTICE: '1607/1543',
            parcelId: 'HR-123-456'
        })).toBe('1607/1543');
    });

    it('falls back to canonical parcel identity and then the caller fallback', () => {
        expect(parcelId.getParcelDisplayNumberFromProperties({ parcel_id: 'HR-123-456' })).toBe('HR-123-456');
        expect(parcelId.getParcelDisplayNumberFromProperties({}, 'unknown parcel')).toBe('unknown parcel');
    });
});

describe('withParcelWriteBatch', () => {
    const originalStorage = globalThis.PersistentStorage;

    beforeEach(() => {
        globalThis._parcelRecordWriteCache = null;
        globalThis.PersistentStorage = {
            values: new Map(),
            getItem(key) { return this.values.get(key) || null; },
            setItem(key, value) { this.values.set(key, value); }
        };
    });
    afterEach(() => {
        globalThis._parcelRecordWriteCache = null;
        if (originalStorage === undefined) delete globalThis.PersistentStorage;
        else globalThis.PersistentStorage = originalStorage;
    });

    it('flushes writes after a successful operation', async () => {
        const result = await parcelId.withParcelWriteBatch(async () => {
            parcelId.writePersistedParcelRecord('1', record => { record.properties.test = true; });
            expect(globalThis.PersistentStorage.values.size).toBe(0);
            return 'ok';
        });
        expect(result).toBe('ok');
        expect(JSON.parse(globalThis.PersistentStorage.values.get('parcel_1')).properties.test).toBe(true);
        expect(parcelId.isParcelWriteBatchActive()).toBe(false);
    });

    it('discards writes and closes the batch when the operation returns false', async () => {
        expect(await parcelId.withParcelWriteBatch(async () => {
            parcelId.writePersistedParcelRecord('2', record => { record.properties.test = true; });
            return false;
        })).toBe(false);
        expect(globalThis.PersistentStorage.values.size).toBe(0);
        expect(parcelId.isParcelWriteBatchActive()).toBe(false);
    });

    it('discards writes and closes the batch when the operation throws', async () => {
        await expect(parcelId.withParcelWriteBatch(async () => {
            parcelId.writePersistedParcelRecord('3', record => { record.properties.test = true; });
            throw new Error('boom');
        })).rejects.toThrow('boom');
        expect(globalThis.PersistentStorage.values.size).toBe(0);
        expect(parcelId.isParcelWriteBatchActive()).toBe(false);
    });
});
