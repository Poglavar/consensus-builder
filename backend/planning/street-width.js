// Street width in front of a lot, for node: the shared measure (frontend/js/planning/street-width.js)
// with this process's turf. The width feeds the street-wall rule (a facade may rise to a multiple of
// the distance across the street); a lot whose rays reach nothing within the search distance has no
// measurable width.
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
const Shared = createRequire(import.meta.url)('../../frontend/js/planning/street-width.js');

export const streetWidthAcross = (parcel, frontEdge, obstacles, options = {}) => Shared.streetWidthAcross(parcel, frontEdge, obstacles, { turf, ...options });
// Street frontage and the dimensional evaluator share their edge numbering. A missing neighbour
// is only an open side of a block if a mapped street actually faces it.
export const edgeStanding = (parcel, obstacles = [], streets, options = {}) => Shared.edgeStanding(parcel, obstacles, streets, { turf, ...options });
// The street a parcel faces and the existing buildings along it (relative rule terms).
export const streetSetting = (input) => Shared.streetSetting({ turf, ...input });
