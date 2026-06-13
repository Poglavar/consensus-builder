#!/usr/bin/env node

// Mints New York City parcels as ParcelNFTs from the parcel_nyc_geom + parcel_nyc_unit tables.
// One NFT per tax lot (swis_sbl_id), parcel id formatted as US-NY-<swis_sbl_id>. Uses the shared
// mint-parcels harness; run with --storage=walrus to store metadata on Walrus (Sui).

const { ethers } = require('ethers');
const { createMintParcelsService, metadataHelpers } = require('./mint-parcels');

const PARCEL_ID_PREFIX = 'US-NY';
const PLACEHOLDER_OWNER = /^(unavailable[\s_]*owner|unknown|n\/?a)$/i;

function formatNycParcelId(swisSblId) {
    const idPart = String(swisSblId ?? '').trim();
    if (!idPart) {
        throw new Error('Invalid parcel row: missing swis_sbl_id.');
    }
    return `${PARCEL_ID_PREFIX}-${idPart}`;
}

function buildParcelSelectionQuery({ limit, offset, bbox }) {
    // parcel_nyc_geom.geom is stored in WGS84 (SRID 4326), so no transform is needed.
    const conditions = [`u.swis_sbl_id IS NOT NULL`];
    const params = [];
    let paramIndex = 1;

    if (bbox) {
        const envelope = `ST_MakeEnvelope($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, 4326)`;
        conditions.push(`g.geom && ${envelope}`);
        conditions.push(`ST_Intersects(g.geom, ${envelope})`);
        params.push(bbox.west, bbox.south, bbox.east, bbox.north);
        paramIndex += 4;
    }

    const limitPlaceholder = `$${paramIndex++}`;
    params.push(limit);
    const offsetPlaceholder = `$${paramIndex++}`;
    params.push(offset);

    const sql = `
        SELECT
            g.geom_id,
            u.swis_sbl_id,
            u.sbl,
            u.primary_owner,
            ROUND(ST_Area(g.geom::geography))::int AS area_sqm,
            MD5(ST_AsBinary(g.geom)) AS geometry_hash,
            ST_AsGeoJSON(g.geom) AS geojson_geometry
        FROM parcel_nyc_geom g
        JOIN parcel_nyc_unit u ON u.geom_id = g.geom_id
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY g.geom_id
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `;
    return { sql, params };
}

function mapDbRowToParcel(row) {
    const parcelId = formatNycParcelId(row.swis_sbl_id);
    const tokenId = ethers.id(parcelId);
    const owner = (row.primary_owner || '').toString().trim();
    return {
        parcelId,
        tokenId,
        swisSblId: row.swis_sbl_id,
        sbl: row.sbl || null,
        primaryOwner: owner && !PLACEHOLDER_OWNER.test(owner) ? owner : null,
        cityName: 'New York', // Secondary label in SVG
        areaSqM: (() => {
            if (row.area_sqm === null || row.area_sqm === undefined) return null;
            const areaValue = Number(row.area_sqm);
            return Number.isFinite(areaValue) ? areaValue : null;
        })(),
        geometryHash: row.geometry_hash || null,
        geometry: row.geojson_geometry || null // GeoJSON geometry for SVG generation
    };
}

function buildParcelMetadata(parcel, helpers = metadataHelpers) {
    const attributes = [
        { trait_type: 'Parcel ID', value: parcel.parcelId },
        { trait_type: 'City', value: 'New York' }
    ];

    if (parcel.sbl) {
        attributes.push({ trait_type: 'SBL', value: parcel.sbl });
    }
    if (parcel.primaryOwner) {
        attributes.push({ trait_type: 'Primary Owner', value: parcel.primaryOwner });
    }

    let roundedArea = null;
    if (typeof parcel.areaSqM === 'number' && Number.isFinite(parcel.areaSqM)) {
        roundedArea = Math.round(parcel.areaSqM * 100) / 100;
        attributes.push({ trait_type: 'Area (m²)', value: roundedArea, display_type: 'number' });
    }

    if (parcel.geometryHash) {
        attributes.push({ trait_type: 'Geometry Hash', value: parcel.geometryHash });
    }

    let parsedGeometry = null;
    if (parcel.geometry) {
        try {
            parsedGeometry = typeof parcel.geometry === 'string' ? JSON.parse(parcel.geometry) : parcel.geometry;
        } catch (err) {
            console.warn(`Failed to parse geometry for parcel ${parcel.parcelId}:`, err);
        }
    }

    const metadata = {
        name: `Parcel ${parcel.parcelId}`,
        description: `Digitized New York City parcel ${parcel.parcelId}${parcel.primaryOwner ? `, owner of record: ${parcel.primaryOwner}` : ''}.`,
        image: helpers.buildImageUrl(parcel),
        external_url: helpers.buildExternalUrl(parcel),
        attributes,
        background_color: '0d3b66',
        parcelId: parcel.parcelId,
        swisSblId: parcel.swisSblId,
        sbl: parcel.sbl,
        primaryOwner: parcel.primaryOwner,
        areaSquareMeters: roundedArea,
        geometryHash: parcel.geometryHash || null,
        geometry: parsedGeometry
    };

    return helpers.cleanMetadataObject(metadata);
}

function run() {
    const nycService = createMintParcelsService({
        cityName: 'New York',
        introText: 'Mint New York City parcels from parcel_nyc_geom + parcel_nyc_unit (one NFT per swis_sbl_id).',
        buildParcelSelectionQuery,
        mapDbRowToParcel,
        buildParcelMetadata
    });

    return nycService.run();
}

if (require.main === module) {
    run().catch(err => {
        console.error('Minting script failed:', err.message);
        console.error(err);
        process.exit(1);
    });
}

module.exports = { buildParcelSelectionQuery, mapDbRowToParcel, buildParcelMetadata, run };
