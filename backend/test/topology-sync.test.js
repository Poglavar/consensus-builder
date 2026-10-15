// Protects content identity and parent remapping against cross-host ID collisions and incomplete exports.
import { describe, it, expect } from 'vitest';
import { contentIdentity, remapReferences, mutableConflict } from '../scripts/lib/topology-sync.js';

describe('topology reconciliation', () => {
    it('recognizes the same graph under another database ID and object key order', () => {
        const a = { id: 1, created_at: '2026-09-28', city: 'zagreb', graph: { nodes: [1, 2], lanes: [] } };
        expect(contentIdentity('lane_topology_solution', a)).toBe(contentIdentity('lane_topology_solution', { ...a, id: 9, parent_id: 8, graph: { lanes: [], nodes: [1, 2] } }));
        expect(contentIdentity('lane_topology_solution', a)).not.toBe(contentIdentity('lane_topology_solution', { ...a, graph: { nodes: [3], lanes: [] } }));
    });
    it('uses solution content identity to identify a job despite a remapped base ID', () => {
        const a = { created_at: '2026-09-28', base_solution_id: 1 };
        const b = { ...a, base_solution_id: 10 };
        expect(contentIdentity('lane_topology_job', a, { lane_topology_solution: new Map([['1', 'same']]) }))
            .toBe(contentIdentity('lane_topology_job', b, { lane_topology_solution: new Map([['10', 'same']]) }));
    });
    it('remaps every solution reference and refuses an absent parent', () => {
        const row = { id: 4, parent_id: 1, osm_snapshot_id: 2 };
        const mappings = { lane_topology_solution: new Map([['1', '100']]), osm_snapshot: new Map([['2', '20']]) };
        expect(remapReferences('lane_topology_solution', row, mappings)).toEqual({ id: 4, parent_id: '100', osm_snapshot_id: '20' });
        expect(() => remapReferences('lane_topology_solution', row, {})).toThrow(/Unmapped/);
    });
    it('preserves newer status changes and exposes ambiguous concurrent edits', () => {
        expect(mutableConflict({ updated_at: '2026-09-29', status: 'canonical' }, { updated_at: '2026-09-28', status: 'candidate' })).toBe(true);
        expect(mutableConflict({ updated_at: '2026-09-27', status: 'candidate' }, { updated_at: '2026-09-28', status: 'canonical' })).toBe(false);
        expect(() => mutableConflict({ updated_at: '2026-09-28', status: 'canonical' }, { updated_at: '2026-09-28', status: 'candidate' })).toThrow(/Conflicting status/);
    });
});
