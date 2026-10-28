// LiveParcelFabric.revision(): the O(1) revision read for memo keys, on the committed fabric,
// the active mutation and the commit-participant view. It must agree with snapshot().revision,
// and no frontend source may go back to copying every parcel id just to read the revision.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');

const FRONTEND_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/js');
const REVISION_VIA_SNAPSHOT = /snapshot\s*(?:\?\.)?\s*\(\s*\)\s*\??\.\s*revision\b/;

function box(id, west, south, east, north) {
    return {
        type: 'Feature',
        properties: { parcelId: id },
        geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }
    };
}

async function commit(fabric, operation, meta = {}) {
    const mutation = fabric.beginMutation(meta);
    try {
        const result = await operation(mutation);
        await mutation.prepare();
        mutation.publish();
        return result;
    } catch (error) {
        mutation.rollback();
        throw error;
    }
}

function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return jsFiles(full);
        return /\.(?:c|m)?js$/.test(entry.name) ? [full] : [];
    });
}

describe('LiveParcelFabric.revision()', () => {
    it('matches snapshot().revision on the committed fabric before and after a commit', async () => {
        const fabric = createLiveParcelFabric({ geometry: turf });
        expect(fabric.revision()).toBe(fabric.snapshot().revision);
        const before = fabric.revision();

        await commit(fabric, mutation => mutation.seedCadastre([box('HR-A', 15, 45, 15.001, 45.001)]), { kind: 'ground-load' });

        expect(fabric.revision()).toBeGreaterThan(before);
        expect(fabric.revision()).toBe(fabric.snapshot().revision);
    });

    it('matches snapshot().revision on the active mutation and the participant view', async () => {
        const fabric = createLiveParcelFabric({ geometry: turf });
        await commit(fabric, mutation => mutation.seedCadastre([box('HR-A', 15, 45, 15.001, 45.001)]), { kind: 'ground-load' });

        const seen = [];
        fabric.addCommitParticipant({
            prepare(delta, view) {
                seen.push({ revision: view.revision(), snapshot: view.snapshot().revision, delta: delta.revision });
                return delta;
            }
        });

        const mutation = fabric.beginMutation({ kind: 'ground-load' });
        expect(mutation.revision()).toBe(mutation.snapshot().revision);
        mutation.seedCadastre([box('HR-B', 15.002, 45, 15.003, 45.001)]);
        expect(mutation.revision()).toBe(mutation.snapshot().revision);
        await mutation.prepare();
        mutation.publish();

        expect(seen).toHaveLength(1);
        expect(seen[0].revision).toBe(seen[0].snapshot);
        expect(seen[0].revision).toBe(seen[0].delta);
        expect(fabric.revision()).toBe(seen[0].revision);
        expect(fabric.revision()).toBe(fabric.snapshot().revision);
    });
});

describe('revision reads never copy the parcel ids', () => {
    it('the guard pattern recognises every form of the old read', () => {
        for (const sample of [
            'fabric.snapshot().revision',
            'global.LiveParcelFabric?.snapshot?.().revision',
            'LiveParcelFabric.snapshot()?.revision',
            'fabric.snapshot ( ) . revision'
        ]) expect(sample).toMatch(REVISION_VIA_SNAPSHOT);
        expect('fabric.snapshot().parcelIds').not.toMatch(REVISION_VIA_SNAPSHOT);
        expect('fabric.revision?.()').not.toMatch(REVISION_VIA_SNAPSHOT);
    });

    it('no file under frontend/js reads snapshot().revision', () => {
        const files = jsFiles(FRONTEND_JS);
        expect(files.length).toBeGreaterThan(50);
        const offenders = [];
        for (const file of files) {
            fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
                if (REVISION_VIA_SNAPSHOT.test(line)) offenders.push(`${path.relative(FRONTEND_JS, file)}:${index + 1}`);
            });
        }
        expect(offenders).toEqual([]);
    });
});
