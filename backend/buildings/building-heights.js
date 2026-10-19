// Heights for building footprints that may carry none: measured → storeys × 3 m → a seeded
// estimate, with the source recorded. The rules live in frontend/js/building-extrusion.js, shared
// with the browser, which extrudes buildings it reads straight from a public source.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../../frontend/js/building-extrusion.js');

export const { resolveBuildingHeight, footprintAreaM2, STOREY_M, TYPE_STOREYS } = shared;
