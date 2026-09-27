import { describe, expect, it } from 'vitest';
import { settledNodeIndex } from '../scripts/lib/stored-solutions.js';

describe('settledNodeIndex', () => {
    it('keeps a node open when its stored graph reports a node-level error', async () => {
        const fetchImpl = async url => new Response(JSON.stringify(
            String(url).endsWith('/7')
                ? {
                    solution: {
                        graph: {
                            connections: [
                                { nodeId: 'osm-node:1' },
                                { nodeId: 'osm-node:2' }
                            ],
                            problems: [{
                                type: 'nonbinary_transition',
                                severity: 'error',
                                nodeIds: ['osm-node:1']
                            }]
                        }
                    }
                }
                : {
                    solutions: [{ id: 7, sourceKind: 'codex' }],
                    total: 1,
                    hasMore: false
                }
        ), { status: 200, headers: { 'content-type': 'application/json' } });

        const { settled } = await settledNodeIndex({
            api: 'http://localhost',
            city: 'zagreb',
            fetchImpl
        });

        expect(settled.has('osm-node:1')).toBe(false);
        expect(settled.has('osm-node:2')).toBe(true);
    });

    it('leaves a resolved node open when a drivable inbound lane is unassigned', async () => {
        const response = body => new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
        const fetchImpl = async url => response(
            String(url).endsWith('/7')
                ? {
                    solution: {
                        graph: {
                            nodes: [{ id: 'osm-node:1', degree: 3 }],
                            lanes: [
                                { id: 'missing', type: 'driving', direction: 'forward', access: 'yes', toNode: 'osm-node:1' },
                                { id: 'assigned', type: 'driving', direction: 'forward', access: 'yes', toNode: 'osm-node:1' },
                                { id: 'private', type: 'driving', direction: 'forward', access: 'private', toNode: 'osm-node:1' }
                            ],
                            connections: [{ nodeId: 'osm-node:1', fromLaneId: 'assigned' }],
                            problems: []
                        }
                    }
                }
                : {
                    solutions: [{ id: 7, sourceKind: 'codex' }],
                    total: 1,
                    hasMore: false
                }
        );

        const { settled } = await settledNodeIndex({
            api: 'http://localhost',
            city: 'zagreb',
            fetchImpl
        });

        expect(settled.has('osm-node:1')).toBe(false);
    });

    it('does not count a centre-lane junction as settled by ordinary connections', async () => {
        const fetchImpl = async url => new Response(JSON.stringify(String(url).endsWith('/7')
            ? { solution: { graph: {
                nodes: [{ id: 'osm-node:1', degree: 3 }],
                lanes: [
                    { id: 'ordinary', type: 'driving', direction: 'forward', access: 'yes', toNode: 'osm-node:1' },
                    { id: 'centre', type: 'driving', direction: 'both', access: 'yes',
                        fromNode: 'osm-node:2', toNode: 'osm-node:1' }
                ],
                connections: [{ nodeId: 'osm-node:1', fromLaneId: 'ordinary' }],
                problems: []
            } } }
            : { solutions: [{ id: 7, sourceKind: 'codex' }], total: 1, hasMore: false }),
        { status: 200, headers: { 'content-type': 'application/json' } });
        const { settled } = await settledNodeIndex({
            api: 'http://localhost', city: 'zagreb', fetchImpl
        });
        expect(settled.has('osm-node:1')).toBe(false);
    });

    it('excludes a child with a new error identity', async () => {
        const fetchImpl = async url => {
            const body = String(url).endsWith('/8')
                ? {
                    solution: {
                        parentId: 6,
                        errorProblemKeys: ['existing-error', 'new-error'],
                        graph: {
                            stats: { errors: 2 },
                            connections: [{ nodeId: 'osm-node:2' }],
                            problems: [
                                { id: 'existing-error', severity: 'error' },
                                { id: 'new-error', severity: 'error' }
                            ]
                        }
                    }
                }
                : String(url).endsWith('/6')
                    ? { solution: { errorProblemKeys: ['existing-error'], graph: { stats: { errors: 1 }, problems: [
                        { id: 'existing-error', severity: 'error' }
                    ] } } }
                    : { solutions: [{ id: 8, sourceKind: 'codex', parentId: 6 }], total: 1, hasMore: false };
            return new Response(JSON.stringify(body), { status: 200 });
        };
        const { settled, consulted } = await settledNodeIndex({
            api: 'http://localhost', city: 'zagreb', fetchImpl
        });
        expect(settled.has('osm-node:2')).toBe(false);
        expect(consulted).toBe(0);
    });

    it('excludes a child that strands an inbound lane at another junction', async () => {
        const fetchImpl = async url => {
            const graph = {
                nodes: [{ id: 'osm-node:1', degree: 3 }, { id: 'osm-node:2', degree: 3 }],
                lanes: [
                    { id: 'lane:1', type: 'driving', direction: 'forward', access: 'yes',
                        toNode: 'osm-node:1' },
                    { id: 'lane:2', type: 'driving', direction: 'forward', access: 'yes',
                        toNode: 'osm-node:2' }
                ],
                problems: []
            };
            const body = String(url).endsWith('/8')
                ? { solution: { parentId: 6, errorProblemKeys: [], graph: {
                    ...graph, connections: [{ nodeId: 'osm-node:2', fromLaneId: 'lane:2' }]
                } } }
                : String(url).endsWith('/6')
                    ? { solution: { errorProblemKeys: [], graph: {
                        ...graph, connections: [{ nodeId: 'osm-node:1', fromLaneId: 'lane:1' }]
                    } } }
                    : { solutions: [{ id: 8, sourceKind: 'codex', parentId: 6 }],
                        total: 1, hasMore: false };
            return new Response(JSON.stringify(body), { status: 200 });
        };
        const { settled, consulted } = await settledNodeIndex({
            api: 'http://localhost', city: 'zagreb', fetchImpl
        });
        expect(settled.has('osm-node:2')).toBe(false);
        expect(consulted).toBe(0);
    });

    it('accepts a child with duplicate inherited errors but no new error identity', async () => {
        const fetchImpl = async url => {
            const body = String(url).endsWith('/8')
                ? {
                    solution: {
                        parentId: 6,
                        errorProblemKeys: ['existing-error'],
                        graph: {
                            stats: { errors: 2 },
                            connections: [{ nodeId: 'osm-node:2' }],
                            problems: [
                                { id: 'existing-error', severity: 'error' },
                                { id: 'existing-error', severity: 'error' }
                            ]
                        }
                    }
                }
                : String(url).endsWith('/6')
                    ? { solution: { errorProblemKeys: ['existing-error'], graph: { stats: { errors: 1 }, problems: [
                        { id: 'existing-error', severity: 'error' }
                    ] } } }
                    : { solutions: [{ id: 8, sourceKind: 'codex', parentId: 6 }], total: 1, hasMore: false };
            return new Response(JSON.stringify(body), { status: 200 });
        };
        const { settled, consulted } = await settledNodeIndex({
            api: 'http://localhost', city: 'zagreb', fetchImpl
        });
        expect(settled.has('osm-node:2')).toBe(true);
        expect(consulted).toBe(1);
    });

    it('ignores unassigned access=no lanes when settling a junction', async () => {
        const fetchImpl = async url => new Response(JSON.stringify(String(url).endsWith('/7') ? { solution: { graph: { nodes: [{ id: 'osm-node:1', degree: 3 }], lanes: [{ id: 'closed', type: 'driving', direction: 'forward', access: 'no', toNode: 'osm-node:1' }, { id: 'assigned', type: 'driving', direction: 'forward', access: 'yes', toNode: 'osm-node:1' }], connections: [{ nodeId: 'osm-node:1', fromLaneId: 'assigned' }], problems: [] } } } : { solutions: [{ id: 7, sourceKind: 'codex' }], total: 1, hasMore: false }), { status: 200, headers: { 'content-type': 'application/json' } });
        const { settled } = await settledNodeIndex({ api: 'http://localhost', city: 'zagreb', fetchImpl });
        expect(settled.has('osm-node:1')).toBe(true);
    });

    it('excludes a child whose turn-restriction violations rose from its parent', async () => {
        const fetchImpl = async url => new Response(JSON.stringify(String(url).endsWith('/8') ? { solution: { parentId: 6, errorProblemKeys: [], graph: { stats: { errors: 0, turnRestrictions: { violations: 1 } }, connections: [{ nodeId: 'osm-node:2' }], problems: [] } } } : String(url).endsWith('/6') ? { solution: { errorProblemKeys: [], graph: { stats: { errors: 0, turnRestrictions: { violations: 0 } }, connections: [], problems: [] } } } : { solutions: [{ id: 8, sourceKind: 'codex', parentId: 6 }], total: 1, hasMore: false }), { status: 200, headers: { 'content-type': 'application/json' } });
        const { settled, consulted } = await settledNodeIndex({ api: 'http://localhost', city: 'zagreb', fetchImpl });
        expect(settled.has('osm-node:2')).toBe(false);
        expect(consulted).toBe(0);
    });

});
