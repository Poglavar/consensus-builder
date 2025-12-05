#!/usr/bin/env node

const { ethers } = require('ethers');
const { createMintParcelsService, metadataHelpers } = require('./mint-parcels');

function parseBatchMintArg(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const parts = raw.trim().split('-').map(part => part.trim()).filter(Boolean);
    if (parts.length === 3) {
        // section-block-parcel
        return { section: parts[0], block: parts[1], parcel: parts[2] };
    }
    if (parts.length === 2) {
        // section-block
        return { section: parts[0], block: parts[1], parcel: null };
    }
    if (parts.length === 1) {
        // section only
        return { section: parts[0], block: null, parcel: null };
    }
    return null;
}

function formatBaParcelId(smp) {
    const smpPart = String(smp || '').trim();
    if (!smpPart) {
        throw new Error('Invalid Buenos Aires parcel row: missing SMP identifier.');
    }
    return smpPart; // Use pure SMP for parcelId (frontend expects this)
}

function buildParcelSelectionQuery({ limit, offset, bbox, batch }) {
    const conditions = ['TRUE'];
    const params = [];
    let paramIndex = 1;

    const batchSelector = parseBatchMintArg(batch);
    const hasBatch = !!batchSelector;

    if (bbox) {
        conditions.push(`
            geometry && ST_Transform(
                ST_SetSRID(ST_MakeEnvelope($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}), 4326),
                ST_SRID(geometry)
            )
        `);
        params.push(bbox.west, bbox.south, bbox.east, bbox.north);
        paramIndex += 4;
    }

    if (batchSelector && batchSelector.section) {
        // Use LIKE patterns on SMP when possible to avoid limit/offset and fetch exactly needed parcels
        if (batchSelector.block && batchSelector.parcel) {
            // Exact parcel
            conditions.push(`smp = $${paramIndex++}`);
            params.push(`${batchSelector.section}-${batchSelector.block}-${batchSelector.parcel}`);
        } else if (batchSelector.block) {
            // Entire block
            conditions.push(`smp LIKE $${paramIndex++}`);
            params.push(`${batchSelector.section}-${batchSelector.block}-%`);
        } else {
            // Entire section
            conditions.push(`smp LIKE $${paramIndex++}`);
            params.push(`${batchSelector.section}-%`);
        }
    }

    // For batch minting, do not use limit/offset; fetch all matched rows
    let limitPlaceholder = null;
    let offsetPlaceholder = null;
    if (!hasBatch) {
        limitPlaceholder = `$${paramIndex++}`;
        params.push(limit);
        offsetPlaceholder = `$${paramIndex++}`;
        params.push(offset);
    }

    const sql = `
        SELECT
            smp,
            section,
            block,
            parcel,
            MD5(ST_AsBinary(geometry)) AS geometry_hash,
            ST_AsGeoJSON(ST_Transform(geometry, 4326)) AS geojson_geometry
        FROM parcel_ba
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY section, block, parcel
        ${hasBatch ? '' : `LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`}
    `;
    return { sql, params };
}

function mapDbRowToParcel(row) {
    const parcelId = formatBaParcelId(row.smp);
    const tokenId = ethers.id(parcelId);
    return {
        parcelId,
        tokenId,
        section: row.section,
        block: row.block,
        parcel: row.parcel,
        smp: row.smp,
        cityName: 'Buenos Aires', // Used as secondary label in SVG
        geometryHash: row.geometry_hash || null,
        geometry: row.geojson_geometry || null // GeoJSON geometry for SVG generation
    };
}

function buildParcelMetadata(parcel, helpers = metadataHelpers) {
    const attributes = [
        { trait_type: 'Parcel ID', value: parcel.parcelId },
        { trait_type: 'SMP', value: parcel.smp || 'Unknown' },
        { trait_type: 'Section', value: parcel.section },
        { trait_type: 'Block', value: parcel.block },
        { trait_type: 'Parcel', value: parcel.parcel }
    ].filter(attr => attr.value !== undefined && attr.value !== null && attr.value !== '');

    const metadata = {
        name: `Parcel ${parcel.parcelId}`,
        description: `Buenos Aires parcel ${parcel.parcelId}.`,
        image: helpers.buildImageUrl(parcel),
        external_url: helpers.buildExternalUrl(parcel),
        attributes,
        background_color: '0d3b66',
        parcelId: parcel.parcelId,
        smp: parcel.smp || null,
        section: parcel.section,
        block: parcel.block,
        parcel: parcel.parcel,
        geometryHash: parcel.geometryHash || null
    };

    return helpers.cleanMetadataObject(metadata);
}

const buenosAiresService = createMintParcelsService({
    cityName: 'Buenos Aires',
    introText: 'Mint Buenos Aires parcels from the parcel_ba table.',
    buildParcelSelectionQuery,
    mapDbRowToParcel,
    buildParcelMetadata
});

buenosAiresService.run().catch(err => {
    console.error('Minting script failed:', err.message);
    console.error(err);
    process.exit(1);
});

