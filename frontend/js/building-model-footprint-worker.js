/* global importScripts, postMessage, BuildingModelGeometry, turf */
'use strict';

importScripts('../vendor/turf-6.5.0/turf.min.js', 'building-model-geometry.js' + self.location.search);

self.onmessage = event => {
    try {
        const footprint = BuildingModelGeometry.projectedFootprint(event.data?.triangles, turf.union);
        postMessage({ footprint: footprint.geometry });
    } catch (error) {
        postMessage({ error: ['empty', 'disconnected', 'complex', 'outline'].includes(error?.code) ? error.code : 'outline' });
    }
};
