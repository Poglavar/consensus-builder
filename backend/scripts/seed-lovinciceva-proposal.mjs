// Reconstructs Lovinčićeva's 12 approved above-ground volumes as one editable local proposal.
// The script is local-only, validates every footprint against k.č. 4090/1, and upserts only with --apply.

import dotenv from 'dotenv';
import * as turf from '@turf/turf';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
await import('../../frontend/js/building-density-stats.js');

const { Pool } = pg;
const densityStats = globalThis.BuildingDensityStats;

export const PROPOSAL_ID = 'lovinciceva-location-permit-2019';
export const PARCEL_ID = 'HR-335533-4090/1';
export const OFFICIAL_TOTALS = Object.freeze({
    parcelAreaM2: 31332,
    footprintAreaM2: 11519,
    siteCoveragePercent: 36.8,
    aboveGroundGbpM2: 90603,
    undergroundGbpM2: 9832,
    totalGbpM2: 100435,
    kin: 2.9,
    apartments: 1370
});

export const VOLUMES = Object.freeze([
    {
        name: 'A', storeys: 9, apartments: 160, color: '#2f6fed', sourceLayerId: 134407,
        wkt: 'POLYGON ((462656.39 5073433.45, 462663.6 5073433.87, 462663.63 5073433.27, 462677.64 5073434.11, 462679.27 5073432.66, 462680.58 5073434.29, 462678.73 5073465.53, 462698.5 5073466.7, 462701.49 5073416.29, 462664.77 5073414.11, 462664.81 5073413.51, 462657.6 5073413.08, 462656.39 5073433.45))'
    },
    {
        name: 'B1', storeys: 9, apartments: 64, color: '#d63384', sourceLayerId: 165452,
        wkt: 'POLYGON ((462569.45 5073450.22, 462568.07 5073473.38, 462591.23 5073474.76, 462592.6 5073451.6, 462569.45 5073450.22))'
    },
    {
        name: 'B2', storeys: 9, apartments: 64, color: '#d63384', sourceLayerId: 239440,
        wkt: 'POLYGON ((462595.11 5073409.37, 462571.95 5073408, 462570.58 5073431.16, 462593.74 5073432.53, 462595.11 5073409.37))'
    },
    {
        name: 'B3', storeys: 9, apartments: 186, color: '#d63384', sourceLayerId: null,
        wkt: 'POLYGON ((462613.52 5073474.78, 462633.93 5073475.99, 462634.36 5073468.8, 462633.46 5073468.75, 462636.58 5073416.24, 462637.47 5073416.29, 462637.73 5073411.9, 462617.32 5073410.69, 462616.89 5073417.88, 462617.24 5073417.9, 462614.29 5073467.61, 462613.94 5073467.59, 462613.52 5073474.78))'
    },
    {
        name: 'C1', storeys: 9, apartments: 186, color: '#198754', sourceLayerId: 103241,
        wkt: 'POLYGON ((462480.6 5073466.89, 462500.72 5073468.09, 462501.14 5073460.9, 462500.79 5073460.88, 462503.91 5073408.37, 462504.51 5073408.41, 462504.77 5073404.01, 462484.65 5073402.82, 462484.23 5073410.01, 462484.58 5073410.03, 462481.63 5073459.74, 462481.03 5073459.7, 462480.6 5073466.89))'
    },
    {
        name: 'C2', storeys: 9, apartments: 64, color: '#198754', sourceLayerId: 94321,
        wkt: 'POLYGON ((462525.36 5073428.48, 462548.52 5073429.85, 462549.89 5073406.69, 462526.73 5073405.32, 462525.36 5073428.48))'
    },
    {
        name: 'D1', storeys: 8, apartments: 64, color: '#fd7e14', sourceLayerId: 159992,
        wkt: 'POLYGON ((462474.85 5073552, 462498.01 5073553.37, 462499.38 5073530.22, 462476.22 5073528.84, 462474.85 5073552))'
    },
    {
        name: 'D2', storeys: 8, apartments: 64, color: '#fd7e14', sourceLayerId: 122997,
        wkt: 'POLYGON ((462518.87 5073554.61, 462542.03 5073555.99, 462543.41 5073532.83, 462520.25 5073531.45, 462518.87 5073554.61))'
    },
    {
        name: 'D3', storeys: 9, apartments: 195, color: '#fd7e14', sourceLayerId: 138631,
        wkt: 'POLYGON ((462478.67 5073487.61, 462477.35 5073509.87, 462484.64 5073510.31, 462484.74 5073508.51, 462536.45 5073511.58, 462536.43 5073511.93, 462539.23 5073512.09, 462539.14 5073513.54, 462543.53 5073513.8, 462544.85 5073491.54, 462537.67 5073491.11, 462537.59 5073492.41, 462485.48 5073489.32, 462485.47 5073489.47, 462483.08 5073489.33, 462483.16 5073487.88, 462478.67 5073487.61))'
    },
    {
        name: 'E1', storeys: 8, apartments: 64, color: '#6f42c1', sourceLayerId: 9895,
        wkt: 'POLYGON ((462562.1 5073557.18, 462585.26 5073558.55, 462586.63 5073535.39, 462563.47 5073534.02, 462562.1 5073557.18))'
    },
    {
        name: 'E2', storeys: 8, apartments: 64, color: '#6f42c1', sourceLayerId: 172122,
        wkt: 'POLYGON ((462606.12 5073559.79, 462629.28 5073561.16, 462630.65 5073538, 462607.49 5073536.63, 462606.12 5073559.79))'
    },
    {
        name: 'E3', storeys: 9, apartments: 195, color: '#6f42c1', sourceLayerId: 164994,
        wkt: 'POLYGON ((462566.92 5073492.85, 462565.6 5073515.11, 462572.78 5073515.54, 462572.89 5073513.74, 462624.6 5073516.81, 462624.58 5073517.16, 462627.37 5073517.32, 462627.29 5073518.77, 462631.78 5073519.04, 462633.1 5073496.78, 462628.61 5073496.51, 462628.53 5073497.81, 462573.63 5073494.55, 462573.62 5073494.7, 462571.22 5073494.56, 462571.31 5073493.11, 462566.92 5073492.85))'
    }
]);

function usage() {
    console.log(`Usage: node backend/scripts/seed-lovinciceva-proposal.mjs --dry-run|--apply

  --dry-run  Validate the local parcel, geometry and reconstructed totals without writing.
  --apply    Upsert proposal ${PROPOSAL_ID} in the local Consensus Builder database.`);
}

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`Refusing to seed non-local PGHOST=${host || '(empty)'}.`);
    }
}

function geometryBounds(feature) {
    const [minX, minY, maxX, maxY] = turf.bbox(feature);
    return [minX, minY, maxX, maxY];
}

async function readParcel(pool) {
    const result = await pool.query(`
        SELECT cestica_id,
               ST_Area(geom)::double precision AS area_m2,
               ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
        FROM public.parcel
        WHERE current = true
          AND maticni_broj_ko = 335533
          AND broj_cestice = '4090/1'
        LIMIT 1
    `);
    if (result.rowCount !== 1) throw new Error('Local parcel 4090/1, k.o. Pe\u0161\u010denica was not found.');
    const row = result.rows[0];
    return {
        type: 'Feature',
        properties: {
            id: PARCEL_ID,
            cestica_id: row.cestica_id,
            maticni_broj_ko: 335533,
            broj_cestice: '4090/1'
        },
        geometry: row.geometry,
        areaM2: Number(row.area_m2)
    };
}

async function readVolumeFeature(pool, volume) {
    const result = await pool.query(`
        WITH footprint AS (
            SELECT ST_GeomFromText($1, 3765) AS geom
        ), host AS (
            SELECT geom
            FROM public.parcel
            WHERE current = true
              AND maticni_broj_ko = 335533
              AND broj_cestice = '4090/1'
            LIMIT 1
        )
        SELECT ST_Area(footprint.geom)::double precision AS area_m2,
               ST_CoveredBy(footprint.geom, host.geom) AS inside_parcel,
               ST_AsGeoJSON(ST_Transform(footprint.geom, 4326))::json AS geometry
        FROM footprint, host
    `, [volume.wkt]);
    if (result.rowCount !== 1) throw new Error(`Could not transform volume ${volume.name}.`);
    const row = result.rows[0];
    if (!row.inside_parcel) throw new Error(`Volume ${volume.name} is not fully inside parcel 4090/1.`);

    return {
        type: 'Feature',
        properties: {
            name: volume.name,
            block: 'Lovin\u010di\u0107eva \u2013 k.\u010d. 4090/1',
            type: 'proposedBuildingSingle',
            footprintMode: 'polygon',
            height: volume.storeys * 3,
            heightM: volume.storeys * 3,
            floors: volume.storeys,
            storeys: volume.storeys,
            apartments: volume.apartments,
            color: volume.color,
            source: volume.name === 'B3' ? 'gra\u0111evinska dozvola' : 'ISPU lokacijska dozvola',
            sourceLayerId: volume.sourceLayerId,
            footprintAreaM2: Number(row.area_m2)
        },
        geometry: row.geometry
    };
}

export function buildProposal({ parcelFeature, buildings, stats }) {
    const now = new Date().toISOString();
    const parcelIds = [PARCEL_ID];
    const parentParcelNumbers = [{ id: PARCEL_ID, number: '4090/1', cadastre: 'Pe\u0161\u010denica' }];
    const sourceStatistics = {
        geometryDerived: {
            parcelAreaM2: stats.parcelAreaM2,
            footprintAreaM2: stats.footprintAreaM2,
            siteCoveragePercent: stats.siteCoveragePercent,
            aboveGroundGbpM2: stats.aboveGroundGbpM2,
            kin: stats.kin,
            apartments: VOLUMES.reduce((sum, volume) => sum + volume.apartments, 0)
        },
        permitStated: OFFICIAL_TOTALS
    };
    const buildingProposal = {
        parentParcelIds: parcelIds,
        parentParcelNumbers,
        createdFrom: 'single-building',
        typologyType: 'single',
        blockName: 'Lovin\u010di\u0107eva \u2013 k.\u010d. 4090/1',
        parameters: {
            typology: 'single',
            floorHeightM: 3,
            sourceClass: 'UP/I-350-05/20-001/297',
            sourceStatistics
        },
        buildingFeature: buildings[0],
        buildings,
        ancestorKey: PARCEL_ID,
        takeWholeParcels: true,
        metadata: { sourceStatistics }
    };

    return {
        proposalId: PROPOSAL_ID,
        city: 'zagreb',
        name: 'Lovin\u010di\u0107eva \u2013 volumeni iz lokacijske dozvole',
        title: 'Lovin\u010di\u0107eva \u2013 volumeni iz lokacijske dozvole',
        description: 'Radna rekonstrukcija 12 nadzemnih volumena A\u2013E3 na k.\u010d. 4090/1, k.o. Pe\u0161\u010denica, za usporedbu alternativnog urbanog oblika. Polo\u017eaji su preuzeti iz slu\u017ebenih ISPU geometrija lokacijske dozvole, uz B3 iz gra\u0111evinske dozvole; eta\u017enost i stanovi iz dozvole. Nacrtana geometrija daje pribli\u017eno 10.348 m\u00b2 tlocrta, 33,0% izgra\u0111enosti, 90.977 m\u00b2 nadzemnog GBP-a i kin 2,904. Lokacijska dozvola navodi 11.519 m\u00b2 tlocrta, 36,8%, 90.603 m\u00b2 nadzemnog GBP-a, kin 2,9 i 1.370 stanova.',
        author: 'zagreb.lol \u2013 lokalna analiza',
        type: 'building',
        goal: 'single',
        primaryType: 'Urban Rule',
        typologyType: 'single',
        lifecycleStatus: 'Active',
        createdAt: now,
        updatedAt: now,
        tags: ['buildings', 'research', 'location-permit'],
        parentParcelIds: parcelIds,
        cadastreParcelIds: parcelIds,
        parcelIds,
        acceptedParcelIds: [],
        buildingGeometry: buildings[0].geometry,
        buildingProperties: buildings[0].properties,
        properties: buildings[0].properties,
        geometry: {
            superParcel: parcelFeature,
            buildings
        },
        buildingProposal,
        bounds: geometryBounds(parcelFeature),
        source: {
            permitClass: 'UP/I-350-05/20-001/297',
            parcel: 'k.\u010d. 4090/1, MB 335533, k.o. Pe\u0161\u010denica',
            coordinateSystem: 'HTRS96/TM (EPSG:3765), transformed to WGS84 for the app',
            sourceStatistics
        }
    };
}

async function upsertProposal(pool, proposal) {
    const parentIds = JSON.stringify(proposal.parentParcelIds);
    const cadastreIds = JSON.stringify(proposal.cadastreParcelIds);
    const buildingProposal = JSON.stringify(proposal.buildingProposal);
    const bounds = JSON.stringify(proposal.bounds);
    const proposalData = JSON.stringify(proposal);
    const result = await pool.query(`
        INSERT INTO public.proposal (
            proposal_id, city, name, title, description, author, type,
            lifecycle_status, created_at, updated_at,
            ancestor_parcel_ids, cadastre_parcel_ids,
            building_proposal, bounds, proposal_data, applied
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
            building_proposal = EXCLUDED.building_proposal,
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
        parentIds,
        cadastreIds,
        buildingProposal,
        bounds,
        proposalData
    ]);
    return result.rows[0];
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.length || args.includes('--help') || args.includes('-h')) {
        usage();
        return;
    }
    const allowed = new Set(['--dry-run', '--apply']);
    const unknown = args.filter(arg => !allowed.has(arg));
    if (unknown.length || (args.includes('--dry-run') === args.includes('--apply'))) {
        usage();
        throw new Error('Choose exactly one of --dry-run or --apply.');
    }

    assertLocalDatabase();
    const pool = new Pool();
    try {
        const parcelFeature = await readParcel(pool);
        const buildings = [];
        for (const volume of VOLUMES) buildings.push(await readVolumeFeature(pool, volume));
        const stats = densityStats.summarizeDensity({
            parcelFeature,
            buildings,
            turf,
            floorHeightM: 3
        });
        const apartments = VOLUMES.reduce((sum, volume) => sum + volume.apartments, 0);
        if (apartments !== OFFICIAL_TOTALS.apartments) {
            throw new Error(`Apartment total ${apartments} does not match permit total ${OFFICIAL_TOTALS.apartments}.`);
        }
        if (Math.abs(stats.aboveGroundGbpM2 - OFFICIAL_TOTALS.aboveGroundGbpM2) / OFFICIAL_TOTALS.aboveGroundGbpM2 > 0.01) {
            throw new Error('Geometry-derived GBP differs from the permit by more than 1%.');
        }

        const proposal = buildProposal({ parcelFeature, buildings, stats });
        console.log(JSON.stringify({
            proposalId: proposal.proposalId,
            buildings: stats.buildingCount,
            apartments,
            parcelAreaM2: Number(stats.parcelAreaM2.toFixed(2)),
            footprintAreaM2: Number(stats.footprintAreaM2.toFixed(2)),
            siteCoveragePercent: Number(stats.siteCoveragePercent.toFixed(3)),
            aboveGroundGbpM2: Number(stats.aboveGroundGbpM2.toFixed(2)),
            kin: Number(stats.kin.toFixed(4)),
            permitStated: OFFICIAL_TOTALS
        }, null, 2));

        if (args.includes('--apply')) {
            const stored = await upsertProposal(pool, proposal);
            console.log(`Stored local proposal row ${stored.id} (${stored.proposal_id}).`);
        } else {
            console.log('Dry run only; no database row was written.');
        }
    } finally {
        await pool.end();
    }
}

const invokedDirectly = process.argv[1]
    && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));
if (invokedDirectly) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
