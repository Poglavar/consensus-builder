// Run road noding and block polygonization off the map's main thread.
const build = new URL(self.location.href).searchParams.get('build') || '';
importScripts(`../vendor/turf-6.5.0/turf.min.js?build=${encodeURIComponent(build)}`,
    `urban-blocks-model.js?build=${encodeURIComponent(build)}`);
self.onmessage = ({ data }) => {
    try {
        self.postMessage({ blocks: self.UrbanBlocksModel.detectBlocks(data.roads, data.bbox, self.turf) });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
