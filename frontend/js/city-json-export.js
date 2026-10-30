// CityJSON export of a plan file (plan-file.js), offered beside our own files: buildings as LoD1
// buildings with their height, storeys and use; roads, squares, parks, lakes and surroundings as flat
// surfaces of their CityJSON types; each design a CityObjectGroup with its CID. The plan file itself
// rides in the root group's attributes, so the file reads back without loss. Coordinates are the WGS84
// UTM zone of the plan in metres; heights are above the ground the design stands on. Pure.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CityJsonExport = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const reader = () => (root && root.CityModelReader) || require('./city-model-reader.js');
    const PLAN_GROUP = 'ugt-plan';
    // A structure design's CityJSON type and the semantic type of its surface.
    const STRUCTURE_TYPES = { park: ['PlantCover', null], square: ['TransportSquare', 'TrafficArea'], lake: ['WaterBody', 'WaterSurface'] };

    const polygonsOf = geometry => !geometry ? [] : geometry.type === 'Polygon' ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];

    // The WGS84 UTM zone (EPSG 326zz north, 327zz south) of a longitude/latitude.
    function utmCode(lng, lat) {
        const zone = Math.min(60, Math.floor((lng + 180) / 6) + 1);
        return (lat >= 0 ? 32600 : 32700) + zone;
    }

    // file: a plan file ({ plan, designs: [{ cid, content }] }); proj4: the projection library.
    function fromPlanFile(file, { proj4 }) {
        if (!file || !file.plan || !Array.isArray(file.designs)) throw new Error('A plan file is required.');
        const pieces = [];
        for (const { cid, content } of file.designs) {
            const add = (kind, id, polygons, extra = {}) => { if (polygons.length) pieces.push({ cid, content, kind, id, polygons, ...extra }); };
            (content.geometry && content.geometry.buildings || []).forEach((feature, i) =>
                add('building', `${cid}-building-${i}`, polygonsOf(feature && feature.geometry), { properties: (feature && feature.properties) || {} }));
            const road = content.roadProposal && content.roadProposal.definition;
            if (road) add('road', `${cid}-road`, polygonsOf(road.polygon));
            const structure = content.structureProposal;
            if (structure) add('structure', `${cid}-${content.goal}`, polygonsOf(structure.geometry), { goal: content.goal });
            const around = content.geometry && content.geometry.surroundings;
            if (around && around.polygon) add('surroundings', `${cid}-surroundings`, polygonsOf(around.polygon), { treatment: around.treatment });
        }
        let lngSum = 0, latSum = 0, n = 0;
        for (const piece of pieces) for (const rings of piece.polygons) for (const [lng, lat] of rings[0]) { lngSum += lng; latSum += lat; n++; }
        const code = n ? utmCode(lngSum / n, latSum / n) : 32633;
        const projection = proj4('EPSG:4326', reader().crsDefinition(code).definition);
        const vertices = [], index = new Map();
        const vertex = (lng, lat, z) => {
            const [x, y] = projection.forward([lng, lat]);
            const key = [Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000)];
            const k = key.join(',');
            if (!index.has(k)) { index.set(k, vertices.length); vertices.push(key); }
            return index.get(k);
        };
        // Rings as projected, open, oriented loops: the exterior counterclockwise, holes clockwise.
        const loops = rings => rings.map((ring, r) => {
            const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
            const xy = open.map(([lng, lat]) => projection.forward([lng, lat]));
            const area = xy.reduce((sum, p, i) => sum + p[0] * xy[(i + 1) % xy.length][1] - xy[(i + 1) % xy.length][0] * p[1], 0);
            return (r === 0) === (area > 0) ? open : open.reverse();
        }).filter(loop => loop.length >= 3);

        const objects = {};
        const groups = new Map();
        for (const piece of pieces) {
            const attributes = { name: piece.content.title || null, ugtDesignCid: piece.cid, ugtDesignGoal: piece.content.goal };
            let object;
            if (piece.kind === 'building') {
                const height = Number(piece.properties.height) > 0 ? Number(piece.properties.height) : 3;
                const boundaries = [], values = [];
                for (const rings of piece.polygons) {
                    const shape = loops(rings);
                    if (!shape.length) continue;
                    boundaries.push(shape.map(loop => loop.slice().reverse().map(([lng, lat]) => vertex(lng, lat, 0)))); values.push(0);
                    boundaries.push(shape.map(loop => loop.map(([lng, lat]) => vertex(lng, lat, height)))); values.push(2);
                    for (const loop of shape) loop.forEach((a, i) => {
                        const b = loop[(i + 1) % loop.length];
                        boundaries.push([[vertex(a[0], a[1], 0), vertex(b[0], b[1], 0), vertex(b[0], b[1], height), vertex(a[0], a[1], height)]]);
                        values.push(1);
                    });
                }
                if (!boundaries.length) continue;
                const p = piece.properties;
                object = { type: 'Building', attributes: { ...attributes, name: p.name || attributes.name, measuredHeight: height,
                    ...(Number.isInteger(p.floors) && p.floors > 0 ? { storeysAboveGround: p.floors } : {}),
                    ...(p.use ? { function: p.use } : {}), ...(p.modelUrl ? { ugtModelUrl: p.modelUrl } : {}) },
                    geometry: [{ type: 'MultiSurface', lod: '1', boundaries,
                        semantics: { surfaces: [{ type: 'GroundSurface' }, { type: 'WallSurface' }, { type: 'RoofSurface' }], values } }] };
            } else {
                const [type, semantic] = piece.kind === 'road' ? ['Road', 'TrafficArea']
                    : piece.kind === 'structure' ? (STRUCTURE_TYPES[piece.goal] || ['LandUse', null])
                    : piece.treatment === 'green' ? ['PlantCover', null] : ['LandUse', null];
                const boundaries = piece.polygons.map(rings => loops(rings).map(loop => loop.map(([lng, lat]) => vertex(lng, lat, 0)))).filter(surface => surface.length);
                if (!boundaries.length) continue;
                object = { type, attributes: { ...attributes, ...(piece.kind === 'surroundings' ? { function: piece.treatment === 'green' ? 'green' : 'paved' } : {}) },
                    geometry: [{ type: 'MultiSurface', lod: '1', boundaries,
                        ...(semantic ? { semantics: { surfaces: [{ type: semantic }], values: boundaries.map(() => 0) } } : {}) }] };
            }
            object.parents = [piece.cid];
            objects[piece.id] = object;
            if (!groups.has(piece.cid)) groups.set(piece.cid, { content: piece.content, children: [] });
            groups.get(piece.cid).children.push(piece.id);
        }
        // Every design is a group, also one with no physical objects (a rule, a parcel layout).
        for (const { cid, content } of file.designs) {
            const group = groups.get(cid) || { content, children: [] };
            objects[cid] = { type: 'CityObjectGroup', attributes: { name: content.title || null, ugtDesignCid: cid, ugtDesignGoal: content.goal },
                children: group.children, parents: [PLAN_GROUP] };
        }
        objects[PLAN_GROUP] = { type: 'CityObjectGroup', attributes: { name: file.plan.title, ugtSchema: file.schema, ugtPlanFile: file },
            children: file.designs.map(row => row.cid) };

        const mins = [0, 1, 2].map(k => vertices.length ? Math.min(...vertices.map(v => v[k])) : 0);
        const maxs = [0, 1, 2].map(k => vertices.length ? Math.max(...vertices.map(v => v[k])) : 0);
        return {
            type: 'CityJSON', version: '2.0',
            transform: { scale: [0.001, 0.001, 0.001], translate: mins.map(value => value / 1000) },
            metadata: { referenceSystem: `https://www.opengis.net/def/crs/EPSG/0/${code}`, title: file.plan.title,
                geographicalExtent: [...mins, ...maxs].map(value => value / 1000) },
            CityObjects: objects,
            vertices: vertices.map(v => v.map((value, k) => value - mins[k]))
        };
    }

    return Object.freeze({ fromPlanFile, utmCode, PLAN_GROUP });
});
