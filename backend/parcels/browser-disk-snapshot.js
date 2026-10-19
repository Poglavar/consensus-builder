// Browser memory path for a descriptor that explicitly selects the backend's disk index.
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
export function createDiskGeojsonSnapshotParcelSource(descriptor, options) {
    return createGeojsonSnapshotParcelSource({ ...descriptor, snapshotStorage: undefined }, options);
}
