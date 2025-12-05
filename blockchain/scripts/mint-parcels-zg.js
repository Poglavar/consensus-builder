#!/usr/bin/env node

const { ethers } = require('ethers');
const { createMintParcelsService, metadataHelpers } = require('./mint-parcels');

function formatZagrebParcelId(maticniBrojKo, brojCestice) {
    const idPart = String(maticniBrojKo).trim();
    const numberPart = String(brojCestice).trim();
    if (!idPart || !numberPart) {
        throw new Error('Invalid parcel row: missing cadastral or parcel number.');
    }
    return `HR-${idPart}-${numberPart}`;
}

function buildParcelSelectionQuery({ limit, offset, bbox }) {
    const conditions = [`p.current = true`];

    const params = [];
    let paramIndex = 1;

    if (bbox) {
        conditions.push(`
            ST_Intersects(
                p.geom,
                ST_Transform(
                    ST_SetSRID(ST_MakeEnvelope($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}), 4326),
                    ST_SRID(p.geom)
                )
            )
        `);
        params.push(bbox.west, bbox.south, bbox.east, bbox.north);
        paramIndex += 4;
    }

    const limitPlaceholder = `$${paramIndex++}`;
    params.push(limit);
    const offsetPlaceholder = `$${paramIndex++}`;
    params.push(offset);

    const sql = `
        SELECT
            p.cestica_id,
            p.broj_cestice,
            p.maticni_broj_ko,
            NULL AS cadastral_name,
            NULL AS area_sqm,
            MD5(ST_AsBinary(p.geom)) AS geometry_hash,
            ST_AsGeoJSON(ST_Transform(p.geom, 4326)) AS geojson_geometry
        FROM parcel p
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY p.cestica_id
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `;
    return { sql, params };
}

function mapDbRowToParcel(row) {
    const parcelId = formatZagrebParcelId(row.maticni_broj_ko, row.broj_cestice);
    const tokenId = ethers.id(parcelId);
    return {
        parcelId,
        tokenId,
        brojCestice: row.broj_cestice,
        maticniBrojKo: row.maticni_broj_ko,
        cadastralName: row.cadastral_name,
        cityName: 'Zagreb', // Used as secondary label in SVG
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
        { trait_type: 'Municipality', value: parcel.cadastralName || 'Unknown' },
        { trait_type: 'Cadastral Number', value: parcel.maticniBrojKo }
    ];

    let roundedArea = null;
    if (typeof parcel.areaSqM === 'number' && Number.isFinite(parcel.areaSqM)) {
        roundedArea = Math.round(parcel.areaSqM * 100) / 100;
        attributes.push({ trait_type: 'Area (m²)', value: roundedArea, display_type: 'number' });
    }

    if (parcel.geometryHash) {
        attributes.push({ trait_type: 'Geometry Hash', value: parcel.geometryHash });
    }

    const metadata = {
        name: `Parcel ${parcel.parcelId}`,
        description: `Digitized cadastral parcel ${parcel.parcelId}${parcel.cadastralName ? ` in ${parcel.cadastralName}` : ''}.`,
        image: helpers.buildImageUrl(parcel),
        external_url: helpers.buildExternalUrl(parcel),
        attributes,
        background_color: '0d3b66',
        parcelId: parcel.parcelId,
        cadastralMunicipality: parcel.cadastralName,
        cadastralNumber: parcel.maticniBrojKo,
        areaSquareMeters: roundedArea,
        geometryHash: parcel.geometryHash || null
    };

    return helpers.cleanMetadataObject(metadata);
}

const zagrebService = createMintParcelsService({
    cityName: 'Zagreb',
    introText: 'Mint Zagreb parcels from the parcel table (grad_opcina = ZAGREB).',
    buildParcelSelectionQuery,
    mapDbRowToParcel,
    buildParcelMetadata
});

zagrebService.run().catch(err => {
    console.error('Minting script failed:', err.message);
    console.error(err);
    process.exit(1);
});

