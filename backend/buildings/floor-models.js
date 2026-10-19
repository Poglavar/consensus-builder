// Stores versioned floor evidence and joins it to proposals or native city building identities.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateFloorPlans, buildingSourceId } = require('../../frontend/js/building-floor-plans.js');
export { buildingSourceId };

// JSONB changes object-key order; identity and no-op imports must not depend on that order.
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

// Two custom feeds may both call a building "123". Bind to the selected feed's portable
// descriptor, not its generic adapter label, and expose this key in /buildings/near.
export function nativeFloorModelSource(requestSource, providerSource) {
    return requestSource ? `custom:${fingerprint(requestSource)}` : providerSource;
}

export function validateModelIdentity({ city, source, ownerId = '', buildingId }) {
    for (const [name, value, max] of [['city', city, 100], ['source', source, 100], ['buildingId', buildingId, 255]]) {
        if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
            throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
        }
    }
    if (typeof ownerId !== 'string' || ownerId !== ownerId.trim() || ownerId.length > 255
        || (source === 'proposal' ? !ownerId : ownerId !== '')) {
        throw new Error('ownerId is required only for proposal buildings.');
    }
    return { city, source, ownerId, buildingId };
}

function validateFootprint(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error('A WGS84 building footprint is required.');
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length) throw new Error('Empty building footprint.');
    let points = 0;
    for (const polygon of polygons) {
        if (!Array.isArray(polygon) || !polygon.length) throw new Error('Invalid building polygon.');
        for (const ring of polygon) {
            if (!Array.isArray(ring) || ring.length < 4) throw new Error('Building footprint rings must be closed.');
            for (const p of ring) {
                if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) {
                    throw new Error('Building footprint coordinates must be WGS84 pairs.');
                }
                if (++points > 100000) throw new Error('Building footprint exceeds 100000 points.');
            }
            if (canonicalJson(ring[0]) !== canonicalJson(ring.at(-1))) throw new Error('Building footprint rings must be closed.');
        }
    }
}

export function prepareFloorModel(record) {
    const identity = validateModelIdentity(record);
    validateFootprint(record.footprint);
    const errors = validateFloorPlans(record.floorPlans);
    if (errors.length) throw new Error(`Invalid architectural model: ${errors.join('; ')}`);
    // The registry holds evidence. A suggested default layout (default-floor-plans.js) is derived from
    // the footprint at read time and would masquerade as a source if it were ever stored here.
    if (record.floorPlans.suggested === true) throw new Error('Suggested layouts are generated for display and are not registry evidence.');
    return { ...identity, footprint: record.footprint, floorPlans: record.floorPlans,
        geomHash: fingerprint(record.footprint), modelHash: fingerprint(record.floorPlans) };
}

const identityValues = model => [model.city, model.source, model.ownerId, model.buildingId];
const IDENTITY_WHERE = 'city = $1 AND source = $2 AND owner_id = $3 AND building_id = $4';

// The caller owns the transaction. A lock serializes concurrent versions for the same identity.
export async function saveFloorModel(client, record, { apply = false } = {}) {
    const model = prepareFloorModel(record);
    const key = identityValues(model);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [canonicalJson(key)]);
    const existing = await client.query(`SELECT version, current, geom_hash, model_hash
        FROM consensus.building_floor_model WHERE ${IDENTITY_WHERE} ORDER BY version DESC FOR UPDATE`, key);
    const active = existing.rows.find(row => row.current);
    if (active?.geom_hash === model.geomHash && active?.model_hash === model.modelHash) {
        return { ...model, changed: false, version: active.version };
    }
    const version = Number(existing.rows[0]?.version || 0) + 1;
    if (apply) {
        await client.query(`UPDATE consensus.building_floor_model SET current = false, updated_at = now()
            WHERE ${IDENTITY_WHERE} AND current`, key);
        await client.query(`INSERT INTO consensus.building_floor_model
            (city, source, owner_id, building_id, version, footprint, geom_hash, model_hash, floor_plans)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)`,
        [...key, version, JSON.stringify(model.footprint), model.geomHash, model.modelHash, JSON.stringify(model.floorPlans)]);
        const verified = await client.query(`SELECT footprint, floor_plans FROM consensus.building_floor_model
            WHERE ${IDENTITY_WHERE} AND current`, key);
        if (verified.rows.length !== 1 || fingerprint(verified.rows[0].footprint) !== model.geomHash
            || fingerprint(verified.rows[0].floor_plans) !== model.modelHash) {
            throw new Error(`Floor model read-back failed for ${model.buildingId}.`);
        }
    }
    return { ...model, changed: true, version };
}

// One indexed join for a whole response, including chains of proposals from different cities.
export async function fetchFloorModels(pool, identities) {
    if (!identities.length) return new Map();
    const queryKeys = identities.map(identity => {
        const valid = validateModelIdentity(identity);
        return { city: valid.city, source: valid.source, owner_id: valid.ownerId, building_id: valid.buildingId };
    });
    const result = await pool.query(`SELECT m.city, m.source, m.owner_id, m.building_id,
            m.version, m.updated_at, m.geom_hash, m.floor_plans, m.footprint
        FROM consensus.building_floor_model m
        JOIN jsonb_to_recordset($1::jsonb) AS q(city text, source text, owner_id text, building_id text)
            USING (city, source, owner_id, building_id)
        WHERE m.current`, [JSON.stringify(queryKeys)]);
    return new Map(result.rows.map(row => [canonicalJson([row.city, row.source, row.owner_id, row.building_id]), row]));
}

function attachModel(target, row) {
    target.floorPlans = row.floor_plans;
    target.floorModel = { city: row.city, source: row.source, ownerId: row.owner_id,
        buildingId: row.building_id, version: row.version, updatedAt: row.updated_at, footprint: row.footprint };
}

export async function attachProposalFloorModels(pool, proposals) {
    const entries = [];
    for (const proposal of proposals) {
        if (!proposal?.city || !proposal.proposalId) continue;
        for (const building of proposal.geometry?.buildings || []) {
            const buildingId = buildingSourceId(building);
            if (!buildingId || !building.geometry) continue;
            entries.push({ building, identity: { city: proposal.city, source: 'proposal',
                ownerId: String(proposal.proposalId), buildingId } });
        }
    }
    const models = await fetchFloorModels(pool, entries.map(entry => entry.identity));
    for (const { building, identity } of entries) {
        const row = models.get(canonicalJson(identityValues(identity)));
        if (row && row.geom_hash === fingerprint(building.geometry)) attachModel(building.properties, row);
    }
    return proposals;
}

export async function attachNearbyFloorModels(pool, city, source, buildings) {
    if (!buildings.length) return buildings;
    const identities = buildings.map(building => ({ city, source, ownerId: '', buildingId: String(building.object_id) }));
    const models = await fetchFloorModels(pool, identities);
    return buildings.map((building, index) => {
        const row = models.get(canonicalJson(identityValues(identities[index])));
        if (!row) return building;
        const result = { ...building };
        attachModel(result, row);
        return result;
    });
}
