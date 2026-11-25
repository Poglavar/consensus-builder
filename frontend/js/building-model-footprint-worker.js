/* global importScripts, postMessage, BuildingModelGeometry */
'use strict';

importScripts('../vendor/clipper-lib-6.4.2/clipper.js', 'building-model-geometry.js' + self.location.search);

self.onmessage = event => {
    try {
        const footprint = BuildingModelGeometry.projectedFootprint(event.data?.triangles);
        postMessage({ footprint: footprint.geometry });
    } catch (error) {
        postMessage({ error: ['empty', 'disconnected', 'complex', 'outline'].includes(error?.code) ? error.code : 'outline' });
    }
};
