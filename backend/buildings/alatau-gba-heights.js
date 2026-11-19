// Optional, locally prepared GlobalBuildingAtlas estimates for Alatau's OSM way footprints.
import { openSync, readSync, closeSync } from 'node:fs';

export const ALATAU_GBA_SOURCE = 'global-building-atlas';
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const WAY_ID = /^w[1-9]\d*$/;

export function plausibleAlatauHeight(heightM) {
    return Number.isFinite(heightM) && heightM >= 2 && heightM <= 30;
}

export function readAlatauHeightEstimates(path) {
    if (!path) return undefined;
    const fd = openSync(path, 'r');
    let snapshot;
    try {
        const bytes = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
            const size = readSync(fd, bytes, length, bytes.length - length, null);
            if (!size) break;
            length += size;
        }
        if (length > MAX_SNAPSHOT_BYTES) throw new Error('Alatau height snapshot exceeds 2 MiB');
        snapshot = JSON.parse(bytes.toString('utf8', 0, length));
    } finally {
        closeSync(fd);
    }
    if (snapshot?.source !== ALATAU_GBA_SOURCE || !snapshot.heights || typeof snapshot.heights !== 'object' || Array.isArray(snapshot.heights)) {
        throw new Error('Invalid Alatau height snapshot');
    }
    const heights = new Map(Object.entries(snapshot.heights).filter(([id, height]) => WAY_ID.test(id) && plausibleAlatauHeight(height)));
    if (!heights.size) throw new Error('Alatau height snapshot has no usable estimates');
    return feature => {
        const heightM = heights.get(feature.properties?.osm_id);
        return heightM === undefined ? null : { heightM, source: ALATAU_GBA_SOURCE };
    };
}
