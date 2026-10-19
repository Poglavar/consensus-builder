// Extrudes a 2D building footprint into the flat-face mesh shape the 3D renderer consumes. The
// code lives in frontend/js/building-extrusion.js, shared with the browser, so a building drawn
// from a server answer and one the browser reads from a public source rise by the same rule.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const { extrudeFootprint } = require('../../frontend/js/building-extrusion.js');
