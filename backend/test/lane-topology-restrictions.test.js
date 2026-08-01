// Junction connections come from an LLM run and nothing deterministic could contradict one until
// now. OSM turn restrictions state a subset of the same facts, so these lock the one thing that
// matters: a graph movement OSM forbids must be reported as an ERROR, and a restriction we cannot
// place must be reported as unusable rather than silently dropped — otherwise coverage looks
// better than it is.
import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Restrictions = require('../../frontend/js/lane-topology-restrictions.js');

const { checkConnections, describe: describeRestriction } = Restrictions;

// Way 100 arrives at node 500; ways 200 (left) and 300 (straight) leave it.
function graph() {
    return {
        sections: [
            { id: 's:from', sourceWayId: 100 },
            { id: 's:left', sourceWayId: 200 },
            { id: 's:ahead', sourceWayId: 300 }
        ],
        lanes: [
            { id: 'l:from', sectionId: 's:from', sourceWayId: 100 },
            { id: 'l:left', sectionId: 's:left', sourceWayId: 200 },
            { id: 'l:ahead', sectionId: 's:ahead', sourceWayId: 300 }
        ],
        connections: [
            { id: 'c:left', nodeId: 'osm-node:500', fromLaneId: 'l:from', toLaneId: 'l:left', type: 'turn' },
            { id: 'c:ahead', nodeId: 'osm-node:500', fromLaneId: 'l:from', toLaneId: 'l:ahead', type: 'continue' }
        ]
    };
}

function restriction(kind, { from = 100, to = 200, via = 500, viaType = 'node' } = {}) {
    return {
        osm_id: 9001,
        restriction: kind,
        members: [
            { role: 'from', type: 'way', ref: from },
            { role: 'via', type: viaType, ref: via },
            { role: 'to', type: 'way', ref: to }
        ]
    };
}

describe('describe', () => {
    it('pulls from / via / to out of the member list regardless of order', () => {
        const parsed = describeRestriction({
            osm_id: 7, restriction: 'no_left_turn',
            members: [
                { role: 'to', type: 'way', ref: 200 },
                { role: 'via', type: 'node', ref: 500 },
                { role: 'from', type: 'way', ref: 100 }
            ]
        });
        expect(parsed).toEqual({
            osmId: 7, kind: 'no_left_turn',
            fromWayId: '100', toWayId: '200',
            viaNodeId: '500', viaNodeKey: 'osm-node:500'
        });
    });
});

describe('prohibitive restrictions', () => {
    it('flags a movement OSM forbids', () => {
        const { problems, stats } = checkConnections(graph(), [restriction('no_left_turn')]);
        expect(problems).toHaveLength(1);
        expect(problems[0].severity).toBe('error');
        expect(problems[0].type).toBe('turn_restriction_violation');
        expect(problems[0].connectionIds).toEqual(['c:left']);
        expect(problems[0].restriction).toBe('no_left_turn');
        expect(stats.violations).toBe(1);
        expect(stats.applicable).toBe(1);
    });

    it('leaves the other movements out of the same approach alone', () => {
        const { problems } = checkConnections(graph(), [restriction('no_left_turn')]);
        expect(problems.map(p => p.connectionIds[0])).not.toContain('c:ahead');
    });

    it('says nothing when the graph already respects it', () => {
        const withoutLeft = graph();
        withoutLeft.connections = withoutLeft.connections.filter(c => c.id !== 'c:left');
        const { problems, stats } = checkConnections(withoutLeft, [restriction('no_left_turn')]);
        expect(problems).toEqual([]);
        expect(stats.applicable).toBe(1);
    });
});

describe('mandatory restrictions', () => {
    it('flags every OTHER movement out of the approach, not the permitted one', () => {
        // only_left_turn from way 100: going straight to 300 is therefore forbidden.
        const { problems } = checkConnections(graph(), [restriction('only_left_turn', { to: 200 })]);
        expect(problems).toHaveLength(1);
        expect(problems[0].connectionIds).toEqual(['c:ahead']);
        expect(problems[0].message).toMatch(/permits only/);
    });

    it('is satisfied when the approach only does the mandated movement', () => {
        const onlyLeft = graph();
        onlyLeft.connections = onlyLeft.connections.filter(c => c.id === 'c:left');
        expect(checkConnections(onlyLeft, [restriction('only_left_turn')]).problems).toEqual([]);
    });
});

describe('scope', () => {
    it('ignores a restriction whose via node is a different junction', () => {
        const { problems, stats } = checkConnections(graph(), [restriction('no_left_turn', { via: 999 })]);
        expect(problems).toEqual([]);
        expect(stats.applicable).toBe(0);
    });

    it('ignores a restriction whose from-way is not the one connecting here', () => {
        const { problems, stats } = checkConnections(graph(), [restriction('no_left_turn', { from: 888 })]);
        expect(problems).toEqual([]);
        expect(stats.applicable).toBe(0);
    });

    it('reports a via-WAY restriction as unusable rather than dropping it silently', () => {
        const { problems, stats } = checkConnections(
            graph(), [restriction('no_left_turn', { viaType: 'way' })]
        );
        expect(problems).toEqual([]);
        expect(stats.unusable).toEqual([{ osmId: 9001, kind: 'no_left_turn', reason: 'no_via_node' }]);
        expect(stats.usable).toBe(0);
    });

    it('reports a relation with no restriction tag as unusable', () => {
        const untagged = restriction(null);
        const { stats } = checkConnections(graph(), [untagged]);
        expect(stats.unusable).toHaveLength(1);
        expect(stats.usable).toBe(0);
    });

    it('decides nothing on a kind that is neither a prohibition nor a mandate', () => {
        // Neither no_* nor only_*: it is placeable, so it counts as usable and applicable, but it
        // states no movement rule and must not produce a verdict either way.
        const { problems, stats } = checkConnections(graph(), [restriction('restriction:conditional')]);
        expect(stats.usable).toBe(1);
        expect(stats.applicable).toBe(1);
        expect(problems).toEqual([]);
    });

    it('matches the way through the section when a lane carries no sourceWayId of its own', () => {
        const viaSection = graph();
        viaSection.lanes = viaSection.lanes.map(({ sourceWayId, ...lane }) => lane);
        expect(checkConnections(viaSection, [restriction('no_left_turn')]).problems).toHaveLength(1);
    });

    it('survives an empty graph and an empty restriction list', () => {
        expect(checkConnections(null, null).problems).toEqual([]);
        expect(checkConnections({}, []).stats.restrictions).toBe(0);
        expect(checkConnections(graph(), []).problems).toEqual([]);
    });
});

describe('against the real snapshot payload shape', () => {
    // The exact member shape /api/roads/topology emits, so the parser cannot drift from the API.
    const fromApi = {
        osm_id: 9001,
        restriction: 'no_left_turn',
        tags: { type: 'restriction', restriction: 'no_left_turn' },
        members: [
            { ref: 75384529, role: 'to', type: 'way' },
            { ref: 2060104613, role: 'via', type: 'node' },
            { ref: 146655284, role: 'from', type: 'way' }
        ]
    };

    it('reads numeric refs the API sends and matches them to string way ids', () => {
        const real = {
            sections: [{ id: 's:a', sourceWayId: 146655284 }, { id: 's:b', sourceWayId: 75384529 }],
            lanes: [
                { id: 'l:a', sectionId: 's:a', sourceWayId: 146655284 },
                { id: 'l:b', sectionId: 's:b', sourceWayId: 75384529 }
            ],
            connections: [{
                id: 'c:1', nodeId: 'osm-node:2060104613',
                fromLaneId: 'l:a', toLaneId: 'l:b', type: 'turn'
            }]
        };
        const { problems } = checkConnections(real, [fromApi]);
        expect(problems).toHaveLength(1);
        expect(problems[0].sourceWayIds).toEqual(['146655284', '75384529']);
    });
});

// The wiring, not just the checker: a violation must ship WITH the solution, and the counts must
// admit that sparse coverage can only refute.
describe('withRestrictionProblems', () => {
    let withRestrictionProblems;
    beforeAll(async () => {
        ({ withRestrictionProblems } = await import('../routes/lane-topology.js'));
    });

    it('merges violations into the graph problems and re-counts errors', () => {
        const base = {
            ...graph(),
            problems: [{ id: 'problem:existing', type: 'other', severity: 'warning' }],
            stats: { lanes: 3, problems: 1, errors: 0 }
        };
        const merged = withRestrictionProblems(base, [restriction('no_left_turn')]);

        expect(merged.problems).toHaveLength(2);
        expect(merged.problems[1].type).toBe('turn_restriction_violation');
        expect(merged.stats.problems).toBe(2);
        expect(merged.stats.errors).toBe(1);
        expect(merged.stats.lanes).toBe(3);
    });

    it('records coverage, so zero violations cannot be mistaken for verified', () => {
        const merged = withRestrictionProblems(graph(), []);
        expect(merged.problems).toEqual([]);
        expect(merged.stats.turnRestrictions).toEqual({
            restrictions: 0, usable: 0, applicable: 0, violations: 0, unusable: []
        });
    });

    it('leaves an absent graph alone', () => {
        expect(withRestrictionProblems(null, [restriction('no_left_turn')])).toBeNull();
    });
});

// A solution must be able to say WHICH evidence it saw. osm_snapshot_at is a timestamp and
// area_key is a sha256 of a rectangle — neither can tell you the evidence changed underneath a
// stored decision. Two serializers read solution rows, and only one of them had it at first.
describe('solution snapshot reference', () => {
    let serializers;
    beforeAll(async () => {
        const source = await import('node:fs').then(fs =>
            fs.readFileSync(new URL('../routes/lane-topology.js', import.meta.url), 'utf8'));
        serializers = source;
    });

    it('every reader of a solution row exposes the snapshot id', () => {
        const readers = serializers.match(/snapshotAt: row\.osm_snapshot_at/g) || [];
        const withId = serializers.match(/snapshotId: row\.osm_snapshot_id/g) || [];
        expect(readers.length).toBeGreaterThan(0);
        expect(withId.length).toBe(readers.length);
    });

    it('every place that records evidence provenance records the id, not only the date', () => {
        // Solution rows, width-analysis rows, and the selection handed to the model. Each one
        // previously stored a bare timestamp, which cannot say the evidence has since changed.
        const dated = serializers.match(/snapshotAt: evidence\.snapshotAt/g) || [];
        const identified = serializers.match(/snapshotId: evidence\.snapshot\?\.id/g) || [];
        expect(dated.length).toBeGreaterThan(2);
        expect(identified.length).toBe(dated.length);
    });

    it('the column is created idempotently, so an existing deployment migrates itself', async () => {
        const ddl = await import('node:fs').then(fs =>
            fs.readFileSync(new URL('../routes/lane-topology-ddl.sql', import.meta.url), 'utf8'));
        // Both tables that carry a snapshot date must carry its id too.
        expect(ddl).toMatch(/lane_topology_solution\s+ADD COLUMN IF NOT EXISTS osm_snapshot_id BIGINT/);
        expect(ddl).toMatch(/lane_width_analysis\s+ADD COLUMN IF NOT EXISTS osm_snapshot_id BIGINT/);
    });
});
