// Provides cited B-1 constraints, boundary and one explicitly conditional formed-plot massing.
import { validateGeometry } from '../../parcels/source-contract.js';
import * as turf from '@turf/turf';
import { massingFor } from '../../agents/housing-massing.js';
import { sourceRevision, withSourceProposal } from '../source-proposal.js';
import b1SourceGeometry from './zagreb-upu-staro-trnje-b1-source.json' with { type: 'json' };

export const zagrebUpuStaroTrnjeB1Source = Object.freeze({
    id: 'zagreb-upu-staro-trnje-b1', label: 'UPU Staro Trnje-Savica · B-1', city: 'zagreb', edition: 'SGGZ 6/12', default: false,
    url: 'https://zagreb.hr/urbanisticki-plan-ure%C4%91enja-staro-trnje-savica-za-z/89119',
    coverageGeometry: b1SourceGeometry.coverageGeometry, geometryLabel: 'B-1',
    coverage: 'derived-from-official-drawing', kind: 'regulation', storage: 'public.parcel',
    capabilities: { volumes: true, parcelEvidence: true, constraintEvaluation: true },
    scenario: 'adopted-2012', sourceHash: `sha256:${b1SourceGeometry.officialDrawing.sha256}`
});

const PLAN_TEXT_URL = 'https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009';
const B1_BOUNDARY_UNCERTAINTY_M = b1SourceGeometry.geometry.boundaryUncertaintyM;
const MIN_BUILDING_PLOT_M2 = 2000;
const BUILDING_LINE_M = 4;
const ASSUMED_STOREY_HEIGHT_M = 3;
const B1_RING_3765 = b1SourceGeometry.geometry.coordinates[0];
export const B1_WKT_3765 = `POLYGON((${B1_RING_3765.map(point => point.join(' ')).join(',')}))`;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const largestPolygon = geometry => {
    if (geometry?.type === 'Polygon') return geometry;
    if (geometry?.type !== 'MultiPolygon') return null;
    return geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }))
        .sort((a, b) => turf.area(turf.feature(b)) - turf.area(turf.feature(a)))[0] || null;
};
const singleDetachedMassing = (massing, candidateBuildingPlotAreaM2) => {
    const geometry = largestPolygon(massing?.massing?.geometry);
    if (!geometry) return null;
    const footprintM2 = turf.area(turf.feature(geometry));
    if (!(footprintM2 > 0)) return null;
    return { ...massing, massing: { ...massing.massing, geometry }, footprintM2,
        gfaM2: footprintM2 * massing.floors, coveragePct: footprintM2 / candidateBuildingPlotAreaM2 * 100 };
};

export function b1Constraints() {
    return [
        { quantity: 'lotArea', subject: 'building-plot', value: MIN_BUILDING_PLOT_M2, unit: 'm2', bound: 'minimum', sourceArticle: 27, evaluation: 'not-evaluated' },
        { quantity: 'siteCoverage', subject: 'building-plot', value: 0.5, unit: 'ratio', bound: 'maximum', sourceArticle: 27, evaluation: 'not-evaluated' },
        { quantity: 'floorAreaRatioAboveGround', subject: 'building-plot', numerator: 'above-ground-GBP', value: 2.5, unit: 'ratio', bound: 'maximum', sourceArticle: 27, evaluation: 'not-evaluated' },
        { quantity: 'storeys', subject: 'building', verticalScope: 'above-ground', sourceWording: 'podrum i 5 etaža', value: 5, unit: 'count', bound: 'maximum', sourceArticle: 27, evaluation: 'not-evaluated' },
        { quantity: 'naturalTerrain', subject: 'building-plot', value: 0.2, unit: 'ratio', bound: 'minimum', sourceArticle: 27, evaluation: 'not-evaluated' }
    ];
}

export function b1Representation(row) {
    if (!row?.parcel_id || !validateGeometry(row.parcel_geometry) || !finite(row.parcel_area_m2)
        || !finite(row.intersection_area_m2) || row.intersection_area_m2 <= 0.0001) return null;
    const coreOverlap = finite(row.core_intersection_area_m2) && row.core_intersection_area_m2 > 0.0001;
    const boundaryUncertain = !coreOverlap;
    const parcelTooSmall = coreOverlap && row.reference_inside_b1 === true && row.parcel_area_m2 < MIN_BUILDING_PLOT_M2;
    const boundaryRelation = boundaryUncertain ? 'boundary-uncertain' : (row.reference_inside_b1 === true ? 'inside' : 'crosses');
    const reason = boundaryUncertain ? 'plan-boundary-uncertain' : (parcelTooSmall ? 'parcel-too-small' : 'b1-reparcelation-and-competition-required');
    const candidateBuildingPlot = validateGeometry(row.candidate_building_plot_geometry) ? row.candidate_building_plot_geometry : null;
    const buildingLineMask = validateGeometry(row.building_line_geometry) ? row.building_line_geometry : null;
    const candidateBuildingPlotAreaM2 = finite(row.candidate_building_plot_area_m2) ? row.candidate_building_plot_area_m2 : null;
    const privateEdgeMask = candidateBuildingPlot ? turf.buffer(turf.feature(candidateBuildingPlot), -(ASSUMED_STOREY_HEIGHT_M * 5 / 2), { units: 'meters', steps: 4 }) : null;
    const detachedGround = privateEdgeMask && buildingLineMask ? largestPolygon(turf.intersect(privateEdgeMask, turf.feature(buildingLineMask))?.geometry) : null;
    const rawMassing = !boundaryUncertain && detachedGround && candidateBuildingPlotAreaM2 >= MIN_BUILDING_PLOT_M2
        && row.parcel_area_m2 >= MIN_BUILDING_PLOT_M2
        ? massingFor({ geometry: detachedGround, areaM2: candidateBuildingPlotAreaM2 }, 'compact', {
            floors: 5, setbackM: 0, coveragePct: 50,
            maxGfaM2: candidateBuildingPlotAreaM2 * 2.5, minPlotM2: MIN_BUILDING_PLOT_M2
        }, turf) : null;
    const massing = rawMassing ? singleDetachedMassing(rawMassing, candidateBuildingPlotAreaM2) : null;
    const id = `${zagrebUpuStaroTrnjeB1Source.id}:${row.parcel_id}`;
    const b1 = {
        planName: 'UPU Staro Trnje, Savica za zonu Prisavlje - Ulica V. Ruždjaka, planirana Strojarska',
        block: 'B-1', article: 27, procedureArticle: 76, planEdition: 'SGGZ 6/12',
        indicativeBlockAreaM2: 10310, indicativeAboveGroundGfaM2: 25774,
        minBuildingPlotAreaM2: MIN_BUILDING_PLOT_M2, assessedParcelAreaM2: row.parcel_area_m2,
        areaComparison: row.parcel_area_m2 < MIN_BUILDING_PLOT_M2 ? 'below-minimum' : 'meets-minimum',
        intersectionAreaM2: row.intersection_area_m2, coreIntersectionAreaM2: row.core_intersection_area_m2,
        candidateBuildingPlotAreaM2, candidateBuildingPlotGeometry: candidateBuildingPlot,
        plotFormationCondition: 'Candidate plot is the B-1 intersection; it requires preparcelation and the required competition.',
        buildingLineInsetM: BUILDING_LINE_M, detachedBoundaryInsetM: ASSUMED_STOREY_HEIGHT_M * 5 / 2,
        boundaryTreatment: 'all-edges-conservative', footprintForm: 'compact', assumedStoreyHeightM: ASSUMED_STOREY_HEIGHT_M,
        boundaryRelation, boundaryUncertaintyM: B1_BOUNDARY_UNCERTAINTY_M,
        requiresPreparcellation: true, requiresUrbanDesignCompetition: true,
        infrastructurePlotException: { applicability: 'unclassified', condition: 'separate-infrastructure-plot', sourceArticle: 27 },
        citations: [{ kind: 'provision', article: 25, url: PLAN_TEXT_URL }, { kind: 'provision', article: 27, url: PLAN_TEXT_URL }, { kind: 'procedure', article: 76, url: PLAN_TEXT_URL },
            { kind: 'drawing', sheet: b1SourceGeometry.officialDrawing.sheet, url: b1SourceGeometry.officialDrawing.url },
            { kind: 'drawing', sheet: b1SourceGeometry.constructionDrawing.sheet, url: b1SourceGeometry.constructionDrawing.url }],
        geometryRegistration: b1SourceGeometry.registration
    };
    return withSourceProposal({
        id, role: 'permitted', proposalId: null, title: 'UPU Staro Trnje-Savica · B-1', site: row.parcel_geometry,
        volumes: massing ? [{ id: `${id}:conditional-detached`, geometry: massing.massing.geometry, baseM: 0, topM: massing.floors * ASSUMED_STOREY_HEIGHT_M }] : [],
        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
        source: { ...zagrebUpuStaroTrnjeB1Source, recordId: row.parcel_id, parcel: row.parcel_id,
            version: sourceRevision({ b1, b1SourceGeometry, parcelGeometry: row.parcel_geometry }) },
        authority: { effect: 'obligatory', basis: 'UPU-article-27-and-76', applicability: boundaryRelation === 'inside' ? 'source-mapped' : 'partially-source-mapped' },
        assessment: { geometry: 'not-evaluated', meaning: parcelTooSmall ? 'source-rule-warning' : 'source-rule-precondition',
            constraints: 'not-evaluated', status: parcelTooSmall ? 'unavailable' : 'unresolved', reason,
            requiresLandAssembly: true, preconditions: ['preparcelation-required', 'urban-design-competition-required'] },
        metrics: { floorAreaM2: massing?.gfaM2 ?? null, footprintM2: massing?.footprintM2 ?? null,
            heightM: massing ? massing.floors * ASSUMED_STOREY_HEIGHT_M : null }, configurations: massing ? [{
            id: 'conditional-formed-b1-plot-detached', title: 'Conditional formed B-1 plot · detached',
            condition: 'Requires preparcelation and urban design competition.', volumes: [{ id: 'detached', geometry: massing.massing.geometry, baseM: 0, topM: massing.floors * ASSUMED_STOREY_HEIGHT_M }],
            metrics: { floorAreaM2: massing.gfaM2, footprintM2: massing.footprintM2, heightM: massing.floors * ASSUMED_STOREY_HEIGHT_M }, constraints: b1Constraints()
        }] : [], constraints: b1Constraints(), sourceEvidence: {
            ...b1, parcelReference: { sourceId: 'cadastral', parcelId: row.parcel_id }, minLotAreaM2: MIN_BUILDING_PLOT_M2,
            sourceUrl: zagrebUpuStaroTrnjeB1Source.url
        }
    });
}

const B1_VISIBLE_QUERY = `WITH b1 AS (
    SELECT ST_MakeValid(ST_GeomFromText($1, 3765)) AS geom
), candidates AS (
    SELECT p.cestica_id, p.maticni_broj_ko, p.broj_cestice, p.geom, b1.geom AS b1_geom,
        ST_Area(ST_Intersection(p.geom,b1.geom)) AS intersection_area_m2,
        ST_Area(ST_Intersection(p.geom,b1.geom)) AS candidate_building_plot_area_m2,
        ST_AsGeoJSON(ST_Transform(ST_Intersection(p.geom,b1.geom),4326),9)::jsonb AS candidate_building_plot_geometry,
        ST_AsGeoJSON(ST_Transform(ST_Intersection(ST_Intersection(p.geom,b1.geom),ST_Buffer(b1.geom,-${BUILDING_LINE_M})),4326),9)::jsonb AS building_line_geometry,
        ST_Area(ST_Intersection(p.geom,ST_Buffer(b1.geom,-${B1_BOUNDARY_UNCERTAINTY_M}))) AS core_intersection_area_m2,
        ST_Covers(ST_Buffer(b1.geom,-${B1_BOUNDARY_UNCERTAINTY_M}), p.geom) AS reference_inside_b1
    FROM public.parcel p CROSS JOIN b1
    WHERE p.current AND p.geom && b1.geom AND ST_Intersects(p.geom, b1.geom)
      AND p.geom && ST_Transform(ST_MakeEnvelope($2,$3,$4,$5,4326),3765)
), selected AS (
    SELECT * FROM candidates WHERE ($6::integer IS NULL OR cestica_id > $6)
    ORDER BY cestica_id LIMIT $7
)
SELECT cestica_id, ('HR-' || maticni_broj_ko || '-' || broj_cestice) AS parcel_id,
    ST_Area(geom) AS parcel_area_m2,
    intersection_area_m2, candidate_building_plot_area_m2, candidate_building_plot_geometry, building_line_geometry, core_intersection_area_m2, reference_inside_b1,
    ST_AsGeoJSON(ST_Transform(geom,4326),9)::jsonb AS parcel_geometry
FROM selected
ORDER BY cestica_id`;

const B1_PARCEL_QUERY = `WITH b1 AS (
    SELECT ST_MakeValid(ST_GeomFromText($1, 3765)) AS geom
)
SELECT p.cestica_id, ('HR-' || p.maticni_broj_ko || '-' || p.broj_cestice) AS parcel_id,
    ST_Area(p.geom) AS parcel_area_m2,
    ST_Area(ST_Intersection(p.geom,b1.geom)) AS intersection_area_m2,
    ST_Area(ST_Intersection(p.geom,b1.geom)) AS candidate_building_plot_area_m2,
    ST_AsGeoJSON(ST_Transform(ST_Intersection(p.geom,b1.geom),4326),9)::jsonb AS candidate_building_plot_geometry,
    ST_AsGeoJSON(ST_Transform(ST_Intersection(ST_Intersection(p.geom,b1.geom),ST_Buffer(b1.geom,-${BUILDING_LINE_M})),4326),9)::jsonb AS building_line_geometry,
    ST_Area(ST_Intersection(p.geom,ST_Buffer(b1.geom,-${B1_BOUNDARY_UNCERTAINTY_M}))) AS core_intersection_area_m2,
    ST_Covers(ST_Buffer(b1.geom,-${B1_BOUNDARY_UNCERTAINTY_M}), p.geom) AS reference_inside_b1,
    ST_AsGeoJSON(ST_Transform(p.geom,4326),9)::jsonb AS parcel_geometry
FROM public.parcel p CROSS JOIN b1
WHERE p.current AND p.maticni_broj_ko=$2 AND p.broj_cestice=$3
  AND p.geom && b1.geom AND ST_Intersects(p.geom,b1.geom)`;

export async function queryZagrebUpuStaroTrnjeB1(pool, { bbox, limit = 200, after = null }) {
    if (after !== null && (!/^\d{1,10}$/.test(after) || Number(after) > 2147483647)) {
        throw Object.assign(new Error('Invalid source cursor'), { status: 400 });
    }
    const { rows } = await pool.query(B1_VISIBLE_QUERY, [B1_WKT_3765, ...bbox, after, limit + 1]);
    const page = rows.slice(0, limit), items = page.map(b1Representation).filter(Boolean);
    const statuses = {};
    for (const item of items) statuses[item.assessment.status] = (statuses[item.assessment.status] || 0) + 1;
    return { items, nextAfter: rows.length > limit ? String(page.at(-1).cestica_id) : null,
        omitted: page.length - items.length, summary: { sourceId: zagrebUpuStaroTrnjeB1Source.id,
            cachedResults: page.length, withGeometry: items.length, withoutGeometry: page.length - items.length, statuses,
            block: 'B-1', boundaryUncertaintyM: B1_BOUNDARY_UNCERTAINTY_M, candidates: page.length } };
}

export async function readZagrebUpuStaroTrnjeB1Parcel(pool, { parcel }) {
    const match = /^HR-(\d+)-(.+)$/.exec(parcel || '');
    if (!match) return [];
    const { rows } = await pool.query(B1_PARCEL_QUERY, [B1_WKT_3765, Number(match[1]), match[2]]);
    return rows.map(b1Representation).filter(Boolean);
}
