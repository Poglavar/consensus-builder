// Adds defensible surface circulation to the completed Pionir/Paron reconstructions.
//
// Buildings remain their own canonical proposals. Every contiguous surface-road component is a
// companion road proposal, and an ens_plan row groups those roads with the building proposal so a
// single /proposals/<slug> link reconstructs the project. Planned/location-permit schemes are
// deliberately ignored: today's OSM roads are not evidence of their accepted design state.
//
// Geometry gates are intentionally conservative:
//   * only OSM service roads, plus unnamed residential roads predominantly inside the site;
//   * no tunnel, negative-layer or covered segments;
//   * no modelled corridor footprint overlapping a non-underground DGU structure by >= 1 m²;
//   * no fragment shorter than 8 m or connected component shorter than 30 m;
//   * parking only where an OSM parking polygon contains a matching parking_aisle centreline and
//     its measured cross-section supports two rows of perpendicular bays.
//
// Dry-run by default is not allowed: state intent explicitly.
//   PGHOST=localhost node backend/scripts/seed-pionir-observed-circulation.mjs --dry-run --export
//   PGHOST=localhost node backend/scripts/seed-pionir-observed-circulation.mjs --apply --export

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import * as turf from '@turf/turf';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reconstructionGeoJSONToProposal } from '../proposals/reconstruction-geojson.js';
import { assertCorridorReconstructionGeoJSONRoundTrip } from '../proposals/corridor-reconstruction-geojson.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const require = createRequire(import.meta.url);
const {
    corridorProfileFromOsmTags,
    corridorProfileWidth
} = require('../../frontend/js/corridor-profile.js');

const { Pool } = pg;
const ARCHIVE_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/', import.meta.url));
const RECONSTRUCTION_DATE = '2026-08-13T00:00:00.000Z';

export const MIN_SEGMENT_LENGTH_M = 8;
export const MIN_COMPONENT_LENGTH_M = 30;
export const MAX_BUILDING_OVERLAP_M2 = 1;
export const COMPONENT_JOIN_TOLERANCE_M = 0.75;
export const MIN_PARKING_AISLE_LENGTH_M = 20;
export const MIN_DOUBLE_SIDED_PARKING_WIDTH_M = 12.5;
export const MAX_DOUBLE_SIDED_PARKING_WIDTH_M = 20;

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function usage() {
    console.log(`Usage: node backend/scripts/seed-pionir-observed-circulation.mjs --dry-run|--apply [--export] [--only key,key]

  --dry-run  Analyse and validate without writing database rows.
  --apply    Upsert companion road proposals and named project plans locally.
  --export   Write canonical corridor GeoJSON, plan manifests and the audit report.
  --only     Limit the run to comma-separated reconstruction directory names.`);
}

export function parseArgs(argv) {
    const args = { apply: false, dryRun: false, export: false, only: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--export') args.export = true;
        else if (arg === '--only') {
            args.only = new Set(String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean));
            if (!args.only.size) throw new Error('--only requires at least one project key.');
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!args.help && args.apply === args.dryRun) throw new Error('Choose exactly one of --dry-run or --apply.');
    return args;
}

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!LOCAL_DB_HOSTS.has(host)) {
        throw new Error(`Refusing to seed non-local PGHOST=${host || '(empty)'}.`);
    }
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function linePoints(geometry) {
    if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
        throw new Error('Expected a LineString centreline.');
    }
    return geometry.coordinates.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
}

function roadIsBelowGrade(tags) {
    const source = tags || {};
    return ['yes', 'building_passage'].includes(String(source.tunnel || '').toLowerCase())
        || String(source.covered || '').toLowerCase() === 'yes'
        || String(source.location || '').toLowerCase() === 'underground'
        || (Number.isFinite(Number(source.layer)) && Number(source.layer) < 0);
}

function roadClassIsEligible(candidate) {
    if (candidate.highwayType === 'service') return true;
    if (candidate.highwayType !== 'residential') return false;
    return !candidate.name && candidate.insideRatio >= 0.75;
}

export function preclassifyRoadCandidate(candidate, representedParkingAisles = new Set()) {
    if (!roadClassIsEligible(candidate)) return 'road-class-or-public-edge';
    if (roadIsBelowGrade(candidate.tags)) return 'below-grade-or-covered';
    if (candidate.insideLengthM < MIN_SEGMENT_LENGTH_M) return 'fragment-too-short';
    if (representedParkingAisles.has(candidate.osmId)) return 'represented-by-parking-court';
    return null;
}

function profileForCandidate(candidate) {
    const profile = corridorProfileFromOsmTags(candidate.tags || {}, Number(candidate.widthMeters) || undefined);
    const widthM = corridorProfileWidth(profile);
    if (!profile || !Number.isFinite(widthM) || widthM <= 0) {
        throw new Error(`OSM way ${candidate.osmId} did not produce a usable corridor profile.`);
    }
    return { profile, widthM };
}

async function readArchivedProjects() {
    const entries = await readdir(ARCHIVE_ROOT, { withFileTypes: true });
    const projects = [];
    for (const entry of entries.filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${ARCHIVE_ROOT}${entry.name}/proposal.geojson`;
        try {
            const collection = JSON.parse(await readFile(path, 'utf8'));
            const proposal = reconstructionGeoJSONToProposal(collection);
            projects.push({ key: entry.name, path, collection, proposal });
        } catch (error) {
            if (error?.code !== 'ENOENT') throw new Error(`${entry.name}: ${error.message}`);
        }
    }
    return projects;
}

async function readRoadCandidates(pool, siteFeature) {
    const { rows } = await pool.query(`
        WITH context AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 3765) AS site
        ), candidates AS (
            SELECT r.osm_id,
                   r.highway_type,
                   r.name,
                   r.width_meters::double precision AS width_meters,
                   r.tags,
                   ST_Length(r.geom_3765)::double precision AS total_length_m,
                   ST_CollectionExtract(ST_Intersection(r.geom_3765, context.site), 2) AS clipped
            FROM public.osm_road r
            CROSS JOIN context
            WHERE r.current = true
              AND r.highway_type IN ('service', 'residential')
              AND r.geom_3765 && context.site
              AND ST_Intersects(r.geom_3765, context.site)
        ), pieces AS (
            SELECT candidate.*,
                   COALESCE(dumped.path[1], 1)::integer AS part_index,
                   dumped.geom
            FROM candidates candidate
            CROSS JOIN LATERAL ST_Dump(candidate.clipped) AS dumped
            WHERE GeometryType(dumped.geom) = 'LINESTRING'
              AND ST_Length(dumped.geom) > 0
        )
        SELECT osm_id,
               highway_type,
               name,
               width_meters,
               tags,
               part_index,
               total_length_m,
               ST_Length(geom)::double precision AS inside_length_m,
               ST_Length(geom) / NULLIF(total_length_m, 0) AS inside_ratio,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM pieces
        ORDER BY osm_id, part_index
    `, [JSON.stringify(siteFeature.geometry)]);
    return rows.map(row => ({
        id: `osm-${row.osm_id}-${row.part_index}`,
        osmId: Number(row.osm_id),
        partIndex: Number(row.part_index),
        highwayType: row.highway_type,
        name: row.name || null,
        widthMeters: row.width_meters === null ? null : Number(row.width_meters),
        tags: row.tags || {},
        totalLengthM: Number(row.total_length_m),
        insideLengthM: Number(row.inside_length_m),
        insideRatio: Number(row.inside_ratio),
        geometry: row.geometry
    }));
}

async function measureAndClusterCandidates(pool, siteFeature, candidates) {
    if (!candidates.length) return new Map();
    const payload = candidates.map(candidate => ({
        id: candidate.id,
        geometry: candidate.geometry,
        widthM: candidate.widthM,
        clusterable: candidate.clusterable === true
    }));
    const { rows } = await pool.query(`
        WITH context AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 3765) AS site
        ), obstacles AS (
            SELECT ST_UnaryUnion(ST_Collect(building.geom)) AS geom
            FROM public.dgu_building building
            CROSS JOIN context
            WHERE building.current = true
              AND building.geom && context.site
              AND ST_Intersects(building.geom, context.site)
              AND COALESCE(upper(building.naziv_vrste_zgrade), '') NOT LIKE 'PODZEMNA GARAŽA%'
        ), entries AS (
            SELECT value->>'id' AS id,
                   (value->>'widthM')::double precision AS width_m,
                   COALESCE((value->>'clusterable')::boolean, false) AS clusterable,
                   ST_Transform(
                       ST_SetSRID(ST_GeomFromGeoJSON((value->'geometry')::text), 4326),
                       3765
                   ) AS geom
            FROM jsonb_array_elements($2::jsonb) AS value
        ), measured AS (
            SELECT entry.*,
                   CASE
                       WHEN obstacles.geom IS NULL THEN 0
                       ELSE COALESCE(ST_Area(ST_Intersection(
                           ST_Buffer(entry.geom, entry.width_m / 2.0, 'endcap=flat join=round'),
                           obstacles.geom
                       )), 0)
                   END::double precision AS building_overlap_m2
            FROM entries entry
            CROSS JOIN obstacles
        ), eligible AS (
            SELECT *
            FROM measured
            WHERE clusterable = true
              AND building_overlap_m2 < $3
        ), clustered AS (
            SELECT eligible.*,
                   ST_ClusterDBSCAN(
                       geom,
                       eps := $4,
                       minpoints := 1
                   ) OVER (ORDER BY id) AS component
            FROM eligible
        )
        SELECT measured.id,
               measured.building_overlap_m2,
               clustered.component
        FROM measured
        LEFT JOIN clustered USING (id)
        ORDER BY measured.id
    `, [
        JSON.stringify(siteFeature.geometry),
        JSON.stringify(payload),
        MAX_BUILDING_OVERLAP_M2,
        COMPONENT_JOIN_TOLERANCE_M
    ]);
    return new Map(rows.map(row => [row.id, {
        buildingOverlapM2: Number(row.building_overlap_m2),
        component: row.component === null ? null : Number(row.component)
    }]));
}

async function buildBufferedFootprint(pool, siteFeature, segments) {
    const payload = segments.map(segment => ({
        geometry: segment.geometry,
        widthM: segment.widthM
    }));
    const { rows } = await pool.query(`
        WITH context AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 3765) AS site
        ), entries AS (
            SELECT ST_Transform(
                       ST_SetSRID(ST_GeomFromGeoJSON((value->'geometry')::text), 4326),
                       3765
                   ) AS geom,
                   (value->>'widthM')::double precision AS width_m
            FROM jsonb_array_elements($2::jsonb) AS value
        ), merged AS (
            SELECT ST_CollectionExtract(
                       ST_Intersection(
                           ST_UnaryUnion(ST_Collect(ST_Buffer(geom, width_m / 2.0, 'endcap=flat join=round'))),
                           context.site
                       ),
                       3
                   ) AS geom
            FROM entries
            CROSS JOIN context
            GROUP BY context.site
        )
        SELECT ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM merged
        WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    `, [JSON.stringify(siteFeature.geometry), JSON.stringify(payload)]);
    if (!rows[0]?.geometry) throw new Error('Could not build a surface-road footprint.');
    return { geometry: rows[0].geometry, areaM2: Number(rows[0].area_m2) };
}

async function readParkingCandidates(pool, siteFeature) {
    const { rows } = await pool.query(`
        WITH context AS (
            SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 3765) AS site
        ), obstacles AS (
            SELECT ST_UnaryUnion(ST_Collect(building.geom)) AS geom
            FROM public.dgu_building building
            CROSS JOIN context
            WHERE building.current = true
              AND building.geom && context.site
              AND ST_Intersects(building.geom, context.site)
              AND COALESCE(upper(building.naziv_vrste_zgrade), '') NOT LIKE 'PODZEMNA GARAŽA%'
        ), parking AS (
            SELECT p.*,
                   ST_Transform(p.geom, 3765) AS native_geom
            FROM parking.osm_parking p
            CROSS JOIN context
            WHERE p.current = true
              AND GeometryType(p.geom) IN ('POLYGON', 'MULTIPOLYGON')
              AND ST_Transform(p.geom, 3765) && context.site
              AND ST_Intersects(ST_Transform(p.geom, 3765), context.site)
        ), clipped AS (
            SELECT parking.*,
                   ST_CollectionExtract(ST_Intersection(parking.native_geom, context.site), 3) AS site_geom,
                   ST_Area(ST_Intersection(parking.native_geom, context.site))
                       / NULLIF(ST_Area(parking.native_geom), 0) AS site_ratio,
                   CASE
                       WHEN obstacles.geom IS NULL THEN 0
                       ELSE COALESCE(ST_Area(ST_Intersection(parking.native_geom, obstacles.geom)), 0)
                   END AS building_overlap_m2
            FROM parking
            CROSS JOIN context
            CROSS JOIN obstacles
        )
        SELECT clipped.osm_id AS parking_osm_id,
               clipped.parking,
               clipped.parking_kind,
               clipped.access,
               clipped.capacity,
               clipped.capacity_source,
               clipped.all_tags,
               clipped.site_ratio,
               clipped.building_overlap_m2,
               ST_Area(clipped.site_geom)::double precision AS inside_area_m2,
               ST_AsGeoJSON(ST_Transform(clipped.site_geom, 4326))::json AS geometry,
               aisle.osm_id AS aisle_osm_id,
               aisle.tags AS aisle_tags,
               aisle.line_inside_m,
               aisle.geometry AS aisle_geometry
        FROM clipped
        LEFT JOIN LATERAL (
            SELECT road.osm_id,
                   road.tags,
                   ST_Length(piece.geom)::double precision AS line_inside_m,
                   ST_AsGeoJSON(ST_Transform(piece.geom, 4326))::json AS geometry
            FROM public.osm_road road
            CROSS JOIN LATERAL ST_Dump(
                ST_CollectionExtract(ST_Intersection(road.geom_3765, clipped.site_geom), 2)
            ) AS piece
            WHERE road.current = true
              AND road.highway_type = 'service'
              AND road.tags->>'service' = 'parking_aisle'
              AND road.geom_3765 && clipped.site_geom
              AND ST_Intersects(road.geom_3765, clipped.site_geom)
              AND GeometryType(piece.geom) = 'LINESTRING'
            ORDER BY ST_Length(piece.geom) DESC
            LIMIT 1
        ) aisle ON true
        WHERE NOT ST_IsEmpty(clipped.site_geom)
        ORDER BY clipped.osm_id
    `, [JSON.stringify(siteFeature.geometry)]);
    return rows.map(row => ({
        parkingOsmId: Number(row.parking_osm_id),
        parking: row.parking || null,
        parkingKind: row.parking_kind || null,
        access: row.access || null,
        capacity: row.capacity === null ? null : Number(row.capacity),
        capacitySource: row.capacity_source || null,
        tags: row.all_tags || {},
        siteRatio: Number(row.site_ratio),
        buildingOverlapM2: Number(row.building_overlap_m2),
        insideAreaM2: Number(row.inside_area_m2),
        geometry: row.geometry,
        aisleOsmId: row.aisle_osm_id === null ? null : Number(row.aisle_osm_id),
        aisleTags: row.aisle_tags || null,
        aisleLengthM: row.line_inside_m === null ? 0 : Number(row.line_inside_m),
        aisleGeometry: row.aisle_geometry
    }));
}

export function assessParkingCandidate(candidate) {
    if (candidate.siteRatio < 0.9) return { included: false, reason: 'less-than-90%-inside-site' };
    if (candidate.buildingOverlapM2 >= MAX_BUILDING_OVERLAP_M2) {
        return { included: false, reason: 'parking-polygon-overlaps-building' };
    }
    if (!candidate.aisleOsmId || !candidate.aisleGeometry) {
        return { included: false, reason: 'no-matching-parking-aisle' };
    }
    if (candidate.aisleLengthM < MIN_PARKING_AISLE_LENGTH_M) {
        return { included: false, reason: 'matching-aisle-too-short' };
    }
    if (!Number.isFinite(candidate.capacity) || candidate.capacity <= 0) {
        return { included: false, reason: 'parking-capacity-missing' };
    }
    const measuredWidthM = candidate.insideAreaM2 / candidate.aisleLengthM;
    if (measuredWidthM < MIN_DOUBLE_SIDED_PARKING_WIDTH_M
        || measuredWidthM > MAX_DOUBLE_SIDED_PARKING_WIDTH_M) {
        return { included: false, reason: 'parking-cross-section-ambiguous', measuredWidthM };
    }
    const drivingWidthM = measuredWidthM - 10;
    if (drivingWidthM < 2.5) {
        return { included: false, reason: 'parking-aisle-width-implausible', measuredWidthM };
    }
    return { included: true, measuredWidthM, drivingWidthM };
}

function commonProposalFields(buildingProposal, proposalId, title, description, parentParcelIds, footprint) {
    return {
        proposalId,
        city: buildingProposal.city || 'zagreb',
        name: title,
        title,
        description,
        author: 'zagreb.lol – lokalna analiza',
        type: 'road',
        goal: 'road-track',
        primaryType: 'Road',
        isCorridor: true,
        lifecycleStatus: 'Active',
        createdAt: RECONSTRUCTION_DATE,
        updatedAt: RECONSTRUCTION_DATE,
        tags: ['roads', 'research', 'reconstruction', 'observed-built-state'],
        parentParcelIds,
        cadastreParcelIds: parentParcelIds,
        parcelIds: parentParcelIds,
        acceptedParcelIds: [],
        geometry: clone(footprint.geometry),
        bounds: turf.bbox({ type: 'Feature', properties: {}, geometry: footprint.geometry })
    };
}

async function buildRoadComponentProposal(pool, project, component, componentIndex) {
    const sorted = [...component].sort((left, right) => left.osmId - right.osmId || left.partIndex - right.partIndex);
    const firstOsmId = sorted[0].osmId;
    const footprint = await buildBufferedFootprint(pool, project.site, sorted);
    const titleSuffix = project.componentCount === 1
        ? 'interna prometna mreža'
        : `interna prometnica ${componentIndex + 1}`;
    const title = `${project.proposal.title} – ${titleSuffix}`;
    const lengthM = sorted.reduce((sum, candidate) => sum + candidate.insideLengthM, 0);
    const description = `Rekonstrukcija ${Math.round(lengthM)} m površinskih internih pristupnih i servisnih prometnica uz izvedeni sklop. `
        + 'Središnjice i oznake namjene preuzete su iz aktualnog lokalnog OSM sloja; širine slijede OSM oznake, a kada ih nema, standarde profila aplikacije. '
        + 'Ovo nije geodetska snimka ni geometrija iz dozvole. Podzemni, prekratki i zgradama preklopljeni potezi nisu uključeni.';
    const proposalId = `${project.proposal.proposalId}-access-${firstOsmId}`;
    const parentParcelIds = [...new Set(project.proposal.parentParcelIds || [])];
    const points = sorted.map(candidate => linePoints(candidate.geometry));
    const segmentIds = sorted.map(candidate => candidate.id);
    const defaultProfile = clone(sorted[0].profile);
    const segmentProfiles = {};
    sorted.forEach(candidate => {
        if (JSON.stringify(candidate.profile) !== JSON.stringify(defaultProfile)) {
            segmentProfiles[candidate.id] = clone(candidate.profile);
        }
    });
    const sourceRows = sorted.map(candidate => ({
        segmentId: candidate.id,
        osmWayId: candidate.osmId,
        osmPartIndex: candidate.partIndex,
        highway: candidate.highwayType,
        service: candidate.tags?.service || null,
        surface: candidate.tags?.surface || null,
        tags: clone(candidate.tags),
        insideLengthM: candidate.insideLengthM,
        modelledWidthM: candidate.widthM
    }));
    const definition = {
        points,
        segments: clone(points),
        segmentIds,
        profile: defaultProfile,
        width: corridorProfileWidth(defaultProfile),
        segmentProfiles,
        tunnels: [],
        gradeSeparations: [],
        polygon: clone(footprint.geometry),
        metadata: {
            mode: 'import',
            type: 'road',
            isTrack: false,
            isRoad: true,
            isCorridor: true,
            source: 'osm-observed-state',
            observedReconstruction: true,
            sourceRows
        }
    };
    const proposal = {
        ...commonProposalFields(project.proposal, proposalId, title, description, parentParcelIds, footprint),
        roadProposal: {
            definition,
            parentParcelIds: clone(parentParcelIds),
            childParcelIds: [],
            mode: 'import',
            isCorridor: true
        },
        source: {
            geometryBasis: 'current OSM centrelines clipped to the reconstructed current parcel union',
            widthBasis: 'OSM tags, then consensus-builder OSM profile defaults',
            footprintBasis: 'projected per-segment profile buffers in HTRS96/TM (EPSG:3765)',
            exclusions: `tunnel/covered/negative-layer; fragment < ${MIN_SEGMENT_LENGTH_M} m; component < ${MIN_COMPONENT_LENGTH_M} m; building overlap >= ${MAX_BUILDING_OVERLAP_M2} m²`,
            osmWayIds: [...new Set(sorted.map(candidate => candidate.osmId))],
            lengthM,
            footprintAreaM2: footprint.areaM2,
            snapshotDate: RECONSTRUCTION_DATE.slice(0, 10)
        }
    };
    return { proposal, firstOsmId, lengthM, footprintAreaM2: footprint.areaM2 };
}

function buildParkingProposal(project, candidate, assessment, parkingIndex, parkingCount) {
    const footprint = { geometry: clone(candidate.geometry), areaM2: candidate.insideAreaM2 };
    const parkingLabel = parkingCount > 1
        ? `površinsko parkiralište ${parkingIndex + 1}`
        : 'površinsko parkiralište';
    const title = `${project.proposal.title} – ${parkingLabel}`;
    const proposalId = `${project.proposal.proposalId}-parking-${candidate.parkingOsmId}`;
    const parentParcelIds = [...new Set(project.proposal.parentParcelIds || [])];
    const profile = {
        strips: [
            { type: 'parking_perpendicular', width: 5 },
            { type: 'driving', width: assessment.drivingWidthM, direction: 'both' },
            { type: 'parking_perpendicular', width: 5 }
        ]
    };
    const segmentId = `osm-${candidate.aisleOsmId}-parking-${candidate.parkingOsmId}`;
    const points = [linePoints(candidate.aisleGeometry)];
    const capacityLabel = candidate.capacitySource === 'osm'
        ? `${candidate.capacity} evidentiranih mjesta`
        : `približno ${candidate.capacity} mjesta prema površinskoj procjeni`;
    const description = `Rekonstrukcija izvedenog površinskog parkirališta iz aktualnog lokalnog OSM sloja: ${capacityLabel} na ${Math.round(candidate.insideAreaM2)} m². `
        + 'Poligon parkirališta i središnjica prolaza izravno su preuzeti iz OSM-a. Dvostrani okomiti raspored izveden je iz izmjerene prosječne širine poligona; položaji pojedinih mjesta nisu geodetski snimljeni.';
    const definition = {
        points,
        segments: clone(points),
        segmentIds: [segmentId],
        profile,
        width: assessment.measuredWidthM,
        segmentProfiles: {},
        tunnels: [],
        gradeSeparations: [],
        polygon: clone(candidate.geometry),
        metadata: {
            mode: 'import',
            type: 'road',
            isTrack: false,
            isRoad: true,
            isCorridor: true,
            source: 'osm-observed-parking',
            observedReconstruction: true,
            parking: {
                osmParkingId: candidate.parkingOsmId,
                osmAisleId: candidate.aisleOsmId,
                capacity: candidate.capacity,
                capacitySource: candidate.capacitySource,
                access: candidate.access,
                areaM2: candidate.insideAreaM2,
                layoutBasis: 'double-sided perpendicular bays inferred from parking polygon area / aisle length',
                tags: clone(candidate.tags)
            }
        }
    };
    return {
        proposal: {
            ...commonProposalFields(project.proposal, proposalId, title, description, parentParcelIds, footprint),
            tags: ['roads', 'parking', 'research', 'reconstruction', 'observed-built-state'],
            roadProposal: {
                definition,
                parentParcelIds: clone(parentParcelIds),
                childParcelIds: [],
                mode: 'import',
                isCorridor: true
            },
            source: {
                geometryBasis: 'current OSM parking polygon and paired parking_aisle centreline',
                layoutBasis: 'inferred double-sided perpendicular bays; individual bay positions are not surveyed',
                osmParkingId: candidate.parkingOsmId,
                osmAisleId: candidate.aisleOsmId,
                capacity: candidate.capacity,
                capacitySource: candidate.capacitySource,
                areaM2: candidate.insideAreaM2,
                snapshotDate: RECONSTRUCTION_DATE.slice(0, 10)
            }
        },
        parkingOsmId: candidate.parkingOsmId,
        aisleOsmId: candidate.aisleOsmId,
        capacity: candidate.capacity,
        footprintAreaM2: candidate.insideAreaM2
    };
}

async function analyseProject(pool, archived) {
    const proposal = archived.proposal;
    const site = proposal.geometry?.superParcel;
    const buildings = proposal.geometry?.buildings || [];
    if (!site?.geometry || !buildings.length) throw new Error(`${archived.key}: missing site or buildings.`);
    const project = { ...archived, site, buildings, proposal };

    if (!(proposal.tags || []).includes('observed-built-state')) {
        return {
            project,
            status: 'skipped-different-design-state',
            reason: 'The proposal is permit-derived rather than an observed completed site.',
            proposals: [],
            roadAudit: [],
            parkingAudit: []
        };
    }

    const parkingCandidates = await readParkingCandidates(pool, site);
    const parkingAudit = parkingCandidates.map(candidate => ({
        candidate,
        assessment: assessParkingCandidate(candidate)
    }));
    const includedParkingAisles = new Set(parkingAudit
        .filter(entry => entry.assessment.included)
        .map(entry => entry.candidate.aisleOsmId));

    const rawRoads = await readRoadCandidates(pool, site);
    const profiled = rawRoads.map(candidate => {
        const preReason = preclassifyRoadCandidate(candidate, includedParkingAisles);
        return {
            ...candidate,
            ...profileForCandidate(candidate),
            preReason,
            clusterable: preReason === null
        };
    });
    const measurements = await measureAndClusterCandidates(pool, site, profiled);
    const roadAudit = profiled.map(candidate => {
        const measured = measurements.get(candidate.id) || { buildingOverlapM2: 0, component: null };
        let reason = candidate.preReason;
        if (!reason && measured.buildingOverlapM2 >= MAX_BUILDING_OVERLAP_M2) {
            reason = 'modelled-footprint-overlaps-building';
        }
        return {
            candidate,
            buildingOverlapM2: measured.buildingOverlapM2,
            component: measured.component,
            reason
        };
    });
    const eligible = roadAudit.filter(entry => !entry.reason);
    const grouped = new Map();
    eligible.forEach(entry => {
        if (!grouped.has(entry.component)) grouped.set(entry.component, []);
        grouped.get(entry.component).push(entry.candidate);
    });
    const components = [...grouped.values()]
        .map(entries => ({
            entries,
            lengthM: entries.reduce((sum, entry) => sum + entry.insideLengthM, 0),
            firstOsmId: Math.min(...entries.map(entry => entry.osmId))
        }))
        .sort((left, right) => left.firstOsmId - right.firstOsmId);
    const acceptedComponents = components.filter(component => component.lengthM >= MIN_COMPONENT_LENGTH_M);
    const rejectedComponentIds = new Set(components
        .filter(component => component.lengthM < MIN_COMPONENT_LENGTH_M)
        .flatMap(component => component.entries.map(entry => entry.id)));
    roadAudit.forEach(entry => {
        if (!entry.reason && rejectedComponentIds.has(entry.candidate.id)) entry.reason = 'component-too-short';
    });

    project.componentCount = acceptedComponents.length;
    const roadProposals = [];
    for (const [index, component] of acceptedComponents.entries()) {
        const built = await buildRoadComponentProposal(pool, project, component.entries, index);
        roadProposals.push({ ...built, kind: 'access-road' });
        component.entries.forEach(candidate => {
            const audit = roadAudit.find(entry => entry.candidate.id === candidate.id);
            if (audit) audit.proposalId = built.proposal.proposalId;
        });
    }
    const includedParking = parkingAudit.filter(entry => entry.assessment.included);
    const parkingProposals = includedParking
        .map((entry, index) => {
            const built = buildParkingProposal(
                project,
                entry.candidate,
                entry.assessment,
                index,
                includedParking.length
            );
            entry.proposalId = built.proposal.proposalId;
            return { ...built, kind: 'parking' };
        });
    const proposals = [...roadProposals, ...parkingProposals];
    return {
        project,
        status: proposals.length ? 'ready' : 'no-safe-surface-circulation',
        reason: proposals.length ? null : 'No OSM surface component passed the geometry and building-overlap gates.',
        proposals,
        roadAudit,
        parkingAudit
    };
}

async function upsertRoadProposal(pool, proposal) {
    const { rows } = await pool.query(`
        INSERT INTO public.proposal (
            proposal_id, city, name, title, description, author, type,
            lifecycle_status, created_at, updated_at,
            ancestor_parcel_ids, cadastre_parcel_ids,
            road_proposal, bounds, proposal_data, applied
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $9,
            $10::jsonb, $11::jsonb,
            $12::jsonb, $13::jsonb, $14::jsonb, false
        )
        ON CONFLICT (proposal_id) DO UPDATE SET
            city = EXCLUDED.city,
            name = EXCLUDED.name,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            author = EXCLUDED.author,
            type = EXCLUDED.type,
            lifecycle_status = EXCLUDED.lifecycle_status,
            updated_at = NOW(),
            ancestor_parcel_ids = EXCLUDED.ancestor_parcel_ids,
            cadastre_parcel_ids = EXCLUDED.cadastre_parcel_ids,
            road_proposal = EXCLUDED.road_proposal,
            bounds = EXCLUDED.bounds,
            proposal_data = EXCLUDED.proposal_data,
            applied = false
        RETURNING id, proposal_id
    `, [
        proposal.proposalId,
        proposal.city,
        proposal.name,
        proposal.title,
        proposal.description,
        proposal.author,
        proposal.type,
        proposal.lifecycleStatus,
        proposal.createdAt,
        JSON.stringify(proposal.parentParcelIds),
        JSON.stringify(proposal.cadastreParcelIds),
        JSON.stringify(proposal.roadProposal),
        JSON.stringify(proposal.bounds),
        JSON.stringify(proposal)
    ]);
    return rows[0];
}

async function buildingRow(pool, proposalId) {
    const { rows } = await pool.query(
        'SELECT id, proposal_id FROM public.proposal WHERE proposal_id = $1 LIMIT 1',
        [proposalId]
    );
    return rows[0] || null;
}

async function upsertNamedPlan(pool, slug, title, proposalIds) {
    const tokenHash = crypto.createHash('sha256').update(`local-reconstruction:${slug}`).digest('hex');
    const { rows } = await pool.query(`
        INSERT INTO public.ens_plan (slug, proposal_ids, title, city, edit_token_hash)
        VALUES ($1, $2::jsonb, $3, 'zagreb', $4)
        ON CONFLICT (slug) DO UPDATE SET
            proposal_ids = EXCLUDED.proposal_ids,
            title = EXCLUDED.title,
            city = EXCLUDED.city,
            updated_at = NOW()
        RETURNING slug, proposal_ids
    `, [slug, JSON.stringify(proposalIds.map(String)), title, tokenHash]);
    return rows[0];
}

function planTitle(analysis) {
    const hasRoads = analysis.proposals.some(item => item.kind === 'access-road');
    const hasParking = analysis.proposals.some(item => item.kind === 'parking');
    const contents = hasRoads && hasParking
        ? 'zgrade, prometnice i parkirališta'
        : (hasRoads ? 'zgrade i prometnice' : (hasParking ? 'zgrade i parkirališta' : 'zgrade'));
    return `${analysis.project.proposal.title} – ${contents}`;
}

function planSlug(projectKey) {
    return `pionir-${projectKey}`;
}

async function exportAnalysis(analysis) {
    const directory = `${ARCHIVE_ROOT}${analysis.project.key}`;
    await mkdir(directory, { recursive: true });
    const existing = await readdir(directory, { withFileTypes: true });
    for (const entry of existing) {
        if (entry.isFile() && /^circulation-(?:access|parking)-.+\.geojson$/.test(entry.name)) {
            await unlink(`${directory}/${entry.name}`);
        }
    }
    const circulation = [];
    for (const item of analysis.proposals) {
        const suffix = item.kind === 'parking'
            ? `parking-${item.parkingOsmId}`
            : `access-${item.firstOsmId}`;
        const filename = `circulation-${suffix}.geojson`;
        const { collection, segmentCount } = assertCorridorReconstructionGeoJSONRoundTrip(
            item.proposal,
            analysis.project.site
        );
        await writeFile(`${directory}/${filename}`, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
        circulation.push({
            proposalId: item.proposal.proposalId,
            kind: item.kind,
            file: filename,
            segmentCount,
            osmWayIds: item.proposal.source?.osmWayIds || [item.aisleOsmId].filter(Boolean),
            parkingOsmId: item.parkingOsmId || null,
            capacity: item.capacity || null,
            lengthM: item.lengthM || null,
            footprintAreaM2: item.footprintAreaM2
        });
    }
    const manifest = {
        schema: 'consensus-builder.reconstruction-plan.v1',
        project: analysis.project.key,
        title: analysis.project.proposal.title,
        status: analysis.status,
        reason: analysis.reason,
        generatedAt: RECONSTRUCTION_DATE,
        planSlug: planSlug(analysis.project.key),
        planTitle: planTitle(analysis),
        localPath: `/proposals/${planSlug(analysis.project.key)}?city=zagreb`,
        building: {
            proposalId: analysis.project.proposal.proposalId,
            file: 'proposal.geojson'
        },
        circulation
    };
    await writeFile(`${directory}/plan.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

function compactRoadAudit(entry) {
    return {
        segmentId: entry.candidate.id,
        osmWayId: entry.candidate.osmId,
        highway: entry.candidate.highwayType,
        service: entry.candidate.tags?.service || null,
        insideLengthM: entry.candidate.insideLengthM,
        insideRatio: entry.candidate.insideRatio,
        modelledWidthM: entry.candidate.widthM,
        buildingOverlapM2: entry.buildingOverlapM2,
        decision: entry.reason || 'included',
        proposalId: entry.proposalId || null
    };
}

function compactParkingAudit(entry) {
    const candidate = entry.candidate;
    return {
        osmParkingId: candidate.parkingOsmId,
        osmAisleId: candidate.aisleOsmId,
        parking: candidate.parking,
        access: candidate.access,
        capacity: candidate.capacity,
        insideAreaM2: candidate.insideAreaM2,
        siteRatio: candidate.siteRatio,
        buildingOverlapM2: candidate.buildingOverlapM2,
        aisleLengthM: candidate.aisleLengthM,
        measuredWidthM: entry.assessment.measuredWidthM || null,
        decision: entry.assessment.included ? 'included' : entry.assessment.reason,
        proposalId: entry.proposalId || null
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { usage(); return; }
    assertLocalDatabase();

    const archived = await readArchivedProjects();
    const selected = args.only ? archived.filter(project => args.only.has(project.key)) : archived;
    if (args.only && selected.length !== args.only.size) {
        const known = new Set(archived.map(project => project.key));
        const missing = [...args.only].filter(key => !known.has(key));
        throw new Error(`Unknown project key(s): ${missing.join(', ')}.`);
    }

    const pool = new Pool();
    const audit = {
        schema: 'consensus-builder.pionir-circulation-audit.v1',
        generatedAt: RECONSTRUCTION_DATE,
        thresholds: {
            minimumSegmentLengthM: MIN_SEGMENT_LENGTH_M,
            minimumConnectedComponentLengthM: MIN_COMPONENT_LENGTH_M,
            maximumBuildingOverlapM2: MAX_BUILDING_OVERLAP_M2,
            componentJoinToleranceM: COMPONENT_JOIN_TOLERANCE_M,
            minimumParkingAisleLengthM: MIN_PARKING_AISLE_LENGTH_M
        },
        projects: []
    };
    try {
        for (const archivedProject of selected) {
            const analysis = await analyseProject(pool, archivedProject);
            const stored = { buildingId: null, roadIds: new Map() };
            if (args.apply) {
                const building = await buildingRow(pool, analysis.project.proposal.proposalId);
                if (!building) {
                    throw new Error(`${analysis.project.key}: building proposal ${analysis.project.proposal.proposalId} is not stored locally.`);
                }
                stored.buildingId = Number(building.id);
                const orderedIds = [];
                for (const item of analysis.proposals) {
                    const row = await upsertRoadProposal(pool, item.proposal);
                    stored.roadIds.set(item.proposal.proposalId, Number(row.id));
                    orderedIds.push(Number(row.id));
                }
                orderedIds.push(stored.buildingId);
                await upsertNamedPlan(
                    pool,
                    planSlug(analysis.project.key),
                    planTitle(analysis),
                    orderedIds
                );
            }
            const manifest = args.export ? await exportAnalysis(analysis) : null;
            const summary = {
                project: analysis.project.key,
                status: analysis.status,
                roadProposals: analysis.proposals.filter(item => item.kind === 'access-road').length,
                parkingProposals: analysis.proposals.filter(item => item.kind === 'parking').length,
                includedRoadLengthM: analysis.proposals.reduce((sum, item) => sum + (item.lengthM || 0), 0),
                planSlug: planSlug(analysis.project.key)
            };
            console.log(JSON.stringify(summary));
            audit.projects.push({
                ...summary,
                reason: analysis.reason,
                manifest: manifest ? `${analysis.project.key}/plan.json` : null,
                roadCandidates: analysis.roadAudit.map(compactRoadAudit),
                parkingCandidates: analysis.parkingAudit.map(compactParkingAudit)
            });
        }
        if (args.export && !args.only) {
            await writeFile(
                `${ARCHIVE_ROOT}circulation-audit.json`,
                `${JSON.stringify(audit, null, 2)}\n`,
                'utf8'
            );
        }
        if (args.dryRun) console.log('Dry run complete; no database row was written.');
    } finally {
        await pool.end();
    }
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    main().catch(error => {
        console.error(error?.stack || error?.message || error);
        process.exitCode = 1;
    });
}
