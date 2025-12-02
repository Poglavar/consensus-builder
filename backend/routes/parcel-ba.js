const MAX_LIMIT = 5000;

function parseLimit(rawValue) {
    if (!rawValue) {
        return null;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return Math.min(parsed, MAX_LIMIT);
}

function buildFeature(row) {
    return {
        type: 'Feature',
        properties: {
            smp: row.smp,
            section: row.section,
            block: row.block,
            parcel: row.parcel,
            informationBasic: row.information_basic,
            informationTechnical: row.information_technical,
            propertyHorizontal: row.property_horizontal,
            doors: row.doors,
            dateAdded: row.date_added,
            dateUpdated: row.date_updated
        },
        geometry: row.geometry
    };
}

export function setupParcelBaRoute(app, pool) {
    app.get('/parcel-ba', async (req, res) => {
        const smp = typeof req.query.smp === 'string' ? req.query.smp.trim() : '';
        const section = typeof req.query.section === 'string' ? req.query.section.trim() : '';
        const block = typeof req.query.block === 'string' ? req.query.block.trim() : '';
        const parcel = typeof req.query.parcel === 'string' ? req.query.parcel.trim() : '';
        const limit = parseLimit(req.query.limit);

        const hasSmp = Boolean(smp);
        const hasSection = Boolean(section);
        const hasBlock = Boolean(block);
        const hasParcel = Boolean(parcel);

        if (!hasSmp && !hasSection) {
            return res.status(400).json({
                error: 'Provide either smp or at least section (optionally with block/parcel) to query Buenos Aires parcels.'
            });
        }

        if (hasBlock && !hasSection) {
            return res.status(400).json({ error: 'block filter requires section to be provided.' });
        }

        if (hasParcel && (!hasSection || !hasBlock)) {
            return res.status(400).json({ error: 'parcel filter requires both section and block to be provided.' });
        }

        let sql = `
            SELECT
                smp,
                section,
                block,
                parcel,
                ST_AsGeoJSON(geometry)::json AS geometry,
                information_basic,
                information_technical,
                property_horizontal,
                doors,
                date_added,
                date_updated
            FROM parcel_ba
        `;
        const params = [];
        let queryType = 'section';

        if (hasSmp) {
            sql += ' WHERE smp = $1';
            params.push(smp);
            queryType = 'parcel';
        } else if (hasSection && hasBlock && hasParcel) {
            sql += ' WHERE section = $1 AND block = $2 AND parcel = $3';
            params.push(section, block, parcel);
            queryType = 'parcel';
        } else if (hasSection && hasBlock) {
            sql += ' WHERE section = $1 AND block = $2';
            params.push(section, block);
            queryType = 'block';
        } else if (hasSection) {
            sql += ' WHERE section = $1';
            params.push(section);
            queryType = 'section';
        }

        if (queryType !== 'parcel') {
            sql += ' ORDER BY block, parcel';
        }

        if (limit && queryType !== 'parcel') {
            params.push(limit);
            sql += ` LIMIT $${params.length}`;
        }

        try {
            const { rows } = await pool.query(sql, params);
            if (!rows.length) {
                return res.status(404).json({ error: 'No parcels found for the provided filters.' });
            }

            const features = rows.map(buildFeature);
            res.json({
                type: 'FeatureCollection',
                query: {
                    type: queryType,
                    smp: smp || undefined,
                    section: section || undefined,
                    block: block || undefined,
                    parcel: parcel || undefined,
                    limit: limit || undefined
                },
                features
            });
        } catch (error) {
            console.error('Error in /parcel-ba:', error);
            res.status(500).json({ error: 'Failed to fetch Buenos Aires parcels.' });
        }
    });
}

