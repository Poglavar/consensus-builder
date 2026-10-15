// Content identities and reference remapping for exchanging immutable topology history between hosts.
import { createHash } from 'node:crypto';

export const TOPOLOGY_TABLES = {
    osm_snapshot: { geometry: null, refs: {}, identity: ['city', 'source_sha256', 'source_timestamp'] },
    lane_topology_solution: { geometry: 'coverage', refs: { parent_id: 'lane_topology_solution', osm_snapshot_id: 'osm_snapshot' },
        identity: ['created_at', 'city', 'area_key', 'source_kind', 'provider', 'model', 'prompt_version', 'graph_schema_version', 'graph'] },
    lane_topology_problem: { geometry: 'point', refs: { solution_id: 'lane_topology_solution' },
        identity: ['solution_id', 'problem_key'] },
    lane_topology_job: { geometry: null, refs: { base_solution_id: 'lane_topology_solution', result_solution_id: 'lane_topology_solution' },
        identity: ['created_at', 'provider', 'city', 'area_key', 'selected_bbox', 'model', 'prompt_version', 'base_solution_id'] },
    lane_topology_decision: { geometry: 'point', refs: { superseded_by: 'lane_topology_decision', osm_snapshot_id: 'osm_snapshot' },
        identity: ['created_at', 'city', 'decision_key', 'assignment', 'author'] },
    lane_width_analysis: { geometry: 'coverage', refs: { parent_id: 'lane_width_analysis', osm_snapshot_id: 'osm_snapshot' },
        identity: ['created_at', 'city', 'area_key', 'method', 'algorithm_version', 'result'] }
};

function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])]));
    return value;
}

export function contentIdentity(table, row, identities = {}) {
    const spec = TOPOLOGY_TABLES[table];
    if (!spec) throw new Error(`Unknown topology table ${table}`);
    const fields = Object.fromEntries(spec.identity.map(key => {
        let value = row[key] ?? null;
        if (value != null && spec.refs[key]) {
            value = identities[spec.refs[key]]?.get(String(value));
            if (!value) throw new Error(`Missing identity for ${table}.${key}=${row[key]}`);
        }
        return [key, value];
    }));
    return createHash('sha256').update(JSON.stringify(sorted(fields))).digest('hex');
}

export function remapReferences(table, row, mappings) {
    const out = { ...row };
    for (const [key, target] of Object.entries(TOPOLOGY_TABLES[table].refs)) {
        if (out[key] == null) continue;
        const mapped = mappings[target]?.get(String(out[key]));
        if (mapped == null) throw new Error(`Unmapped ${table}.${key}=${out[key]}`);
        out[key] = mapped;
    }
    return out;
}

// A status conflict at an identical update instant needs review; a newer timestamp is authoritative.
export function mutableConflict(source, target) {
    const sourceTime = Date.parse(source.updated_at || source.created_at || '') || 0;
    const targetTime = Date.parse(target.updated_at || target.created_at || '') || 0;
    if (sourceTime === targetTime && source.status !== target.status) {
        throw new Error(`Conflicting status at the same update instant: ${source.status}/${target.status}`);
    }
    return sourceTime > targetTime;
}
