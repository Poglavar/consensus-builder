// Shared configuration for the Trogir–Split corridor generator prototype:
// study-area bbox, grid resolution, endpoints, and cost-model defaults.
// The generator itself is generic; this file pins the first case study.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(DIR, 'data');
export const OUT_DIR = path.join(DIR, 'out');

// Study area (WGS84): Trogir to Split, padded so winding alternatives fit.
export const BBOX_WGS84 = { west: 16.20, south: 43.47, east: 16.58, north: 43.62 };

export const CELL_M = 20; // grid cell size in meters (EPSG:3765)

// Endpoints (WGS84 lon/lat). Destination is Kaštel Sućurac, not Split main
// station: the cadastre for Split city proper is not ingested (checked local
// AND prod, 2026-07-11), and the existing suburban line already covers
// Sućurac -> Split — the corridor to generate is the missing western stretch.
export const ORIGIN = { lon: 16.2516, lat: 43.5170, name: 'Trogir' };
export const DESTINATION = { lon: 16.4300, lat: 43.5480, name: 'Kaštel Sućurac' };

// Generator defaults (CLI-overridable in generate.js)
export const DEFAULTS = {
    minCurveRadius: 800,   // m — ~140 km/h conventional rail
    maxLengthFactor: 2.0,  // × straight-line distance
    corridorWidth: 20,     // m — buffered footprint used for parcel locking
    penaltyFactor: 1.6,    // cost multiplier on cells near an accepted corridor
    rejectPenaltyFactor: 1.25, // milder penalty for rejected (too-similar) candidates
    penaltyRadius: 100,    // m — dilation radius around a path when penalizing
    jaccardThreshold: 0.6, // parcel-set similarity above which a candidate is "the same" proposal
    targetCount: 12,       // stop after this many accepted distinct proposals
    maxIterations: 300,    // hard cap on penalty-loop iterations
};

// Cost model multipliers (per-cell, on a base cost of 1.0 per meter).
export const COST = {
    noParcel: Infinity,    // cells without cadastral parcels = sea / out of cadastre → blocked
    water: Infinity,
    wetland: 15,           // Pantan wetland etc. — near-blocker
    protected: 15,
    builtup: 7,
    aerodrome: 25,         // crossing airport grounds is a last resort
    railDiscount: 0.35,    // within `nearDist` of existing rail
    roadDiscount: 0.75,    // within `nearDist` of a major road
    nearDist: 40,          // m
    fragmentationPerParcel: 0.15, // +15% per extra parcel in a cell, capped
    fragmentationCap: 2.0,
    slopeRef: 0.04,        // slope penalty = (slope/slopeRef)^2, so +1× at 4% grade
    slopeCap: 20,
    slopeBlock: 0.4,       // >40% grade → blocked; below that cuts/short tunnels are plausible and the quadratic penalty governs
};
