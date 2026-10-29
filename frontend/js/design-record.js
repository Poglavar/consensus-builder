// The published form of a design (plan-design-agreement.md, M2 "Identity: one CID scheme"): the
// canonical design/v1 object a local design record (today's proposal record) is published as, its
// CID, and a check of that shape for whoever receives one.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DesignRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'design/v1';
    // The publication budget is independent of the IPFS file chunk size.
    const fileCodec = root.IpfsFileCid || (typeof require === 'function' ? require('../vendor/ipfs-file-cid/ipfs-file-cid.js') : null);
    if (!fileCodec) throw new Error('The IPFS file codec is not loaded.');
    const MAX_PUBLISHED_OBJECT_BYTES = fileCodec.MAX_BYTES;
    // What the design draws, by its type; a design carries exactly one.
    const PAYLOAD_KEYS = Object.freeze(['roadProposal', 'buildingProposal', 'structureProposal', 'parcelLayout']);
    // State a payload picks up while it is applied in one browser, beyond what apply derives again
    // from the definition (proposals/formation-depth.js stripDerivedPayloadData: the applied flag,
    // the materialization and the demolition scan): the furniture a park or square generates on its
    // first apply (`decorations`, written back by apply/structures.js) and the payload's local `hash`.
    // None of it is part of the design, so applying a design never changes its CID. An explicit
    // decorationDesign is authored furniture and stays in the payload (or in a building groundSurface).
    const RUNTIME_KEYS = Object.freeze(['decorations', 'hash']);
    // Every other field of a design/v1 object, each present and null when the design has none.
    const FIELDS = Object.freeze(['schema', 'goal', 'title', 'description', 'author', 'city', 'site', 'toleranceM', 'geometry', 'origin', 'authoredAt']);
    const TEXT_FIELDS = Object.freeze(['title', 'description', 'author', 'city']);
    const cid = () => {
        const api = root.Cid || (typeof require === 'function' ? require('./cid.js') : null);
        if (!api) throw new Error('Cid (js/cid.js) is not loaded.');
        return api;
    };
    const formationDepth = () => {
        const api = root.__formationDepth || (typeof require === 'function' ? require('./proposals/formation-depth.js') : null);
        if (!api) throw new Error('The authored-record boundary (js/proposals/formation-depth.js) is not loaded.');
        return api;
    };

    const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;
    const textOf = value => typeof value === 'string' && value.trim() ? value.trim() : null;
    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const isInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
        && new Date(Date.parse(value)).toISOString() === value;
    // A deep copy that keeps what a JSON round trip would quietly change (NaN, a Date), so the CID
    // refuses it instead of committing to a substitute.
    const copy = value => value === undefined || value === null ? null : structuredClone(value);

    function instantOf(value) {
        const ms = typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }

    function payloadOf(key, value) {
        if (!isObject(value)) return null;
        const payload = formationDepth().stripDerivedPayloadData(key, copy(value));
        RUNTIME_KEYS.forEach(field => { delete payload[field]; });
        // The store decodes a corridor for drawing. Identity always uses its canonical OSM form,
        // just as persistence and MCP publication do, rather than the expanded drawing fields.
        return key === 'roadProposal'
            ? formationDepth().encodeRoadRecord({ roadProposal: payload }).roadProposal
            : payload;
    }

    /**
     * The design/v1 object of a local design record. It carries the drawing and its authorship only:
     * no cadastral ids (the server derives what the site takes), terms, kind, approval, lens,
     * lifecycle, server ids, thumbnails or local lineage. The origin is a CID link (a fork records
     * `origin.cid`); authoredAt is the record's createdAt. Text is trimmed; empty becomes null.
     */
    function published(localDesign) {
        if (!isObject(localDesign)) throw new TypeError('published needs a local design record.');
        const origin = textOf(isObject(localDesign.origin) ? localDesign.origin.cid : null);
        const authored = root.ProposalAuthoredRecord || (typeof require === 'function' ? require('./proposals/authored-record.js') : null);
        if (!authored) throw new Error('The authored geometry boundary is not loaded.');
        const design = {
            schema: SCHEMA,
            goal: textOf(localDesign.goal),
            title: textOf(localDesign.title),
            description: textOf(localDesign.description),
            author: textOf(localDesign.author),
            city: textOf(localDesign.city),
            site: copy(localDesign.site),
            toleranceM: positive(localDesign.toleranceM) ? localDesign.toleranceM : null,
            geometry: authored.compactBuildingGeometry(copy(localDesign.geometry)),
            origin: origin ? { cid: origin } : null,
            authoredAt: instantOf(localDesign.createdAt)
        };
        PAYLOAD_KEYS.forEach(key => {
            const payload = payloadOf(key, localDesign[key]);
            if (payload) design[key] = payload;
        });
        return design;
    }

    // The identity of a local design as it would be published. Throws (code 'invalid-cid-input')
    // when the record holds something that is not JSON, such as a number that is not finite.
    const cidOf = localDesign => cid().cidOfObject(published(localDesign));

    /**
     * Checks a published design/v1 object, as the courier and index receive one.
     * @returns {{ valid: boolean, errors: { code, message, field? }[] }} with codes design-schema,
     *   design-payload, design-goal, design-shape, design-origin, design-field-missing,
     *   design-field-unknown, design-field-invalid and design-road-frame
     */
    function validate(object) {
        if (!isObject(object)) return { valid: false, errors: [{ code: 'design-schema', message: `A design is a ${SCHEMA} object.` }] };
        const errors = [];
        const add = (code, message, field) => { errors.push(field ? { code, message, field } : { code, message }); };

        if (object.schema !== SCHEMA) add('design-schema', `Expected ${SCHEMA}.`, 'schema');
        // The schema and the goal have checks of their own below.
        FIELDS.filter(field => field !== 'schema' && field !== 'goal' && !has(object, field)).forEach(field => {
            add('design-field-missing', `A design lists ${field}, as null when it has none.`, field);
        });
        Object.keys(object).filter(key => !FIELDS.includes(key) && !PAYLOAD_KEYS.includes(key)).forEach(key => {
            add('design-field-unknown', `A design carries no ${key}.`, key);
        });

        const payloads = PAYLOAD_KEYS.filter(key => has(object, key));
        if (payloads.length !== 1) {
            add('design-payload', payloads.length
                ? `A design carries one payload, not ${payloads.join(' and ')}.`
                : 'A design carries one payload: a road, building, structure or parcel layout drawing.');
        } else if (!isObject(object[payloads[0]])) {
            add('design-payload', `The ${payloads[0]} payload is not an object.`, payloads[0]);
        }

        if (!textOf(object.goal)) add('design-goal', 'A design names its goal (its type).', 'goal');
        TEXT_FIELDS.forEach(field => {
            if (object[field] != null && typeof object[field] !== 'string') add('design-field-invalid', `${field} is text or null.`, field);
        });
        if (object.toleranceM != null && !positive(object.toleranceM)) {
            add('design-field-invalid', 'toleranceM is a positive number of metres or null.', 'toleranceM');
        }
        if (object.authoredAt != null && !isInstant(object.authoredAt)) {
            add('design-field-invalid', 'authoredAt is an ISO instant or null.', 'authoredAt');
        }

        if (object.site == null && object.geometry == null) {
            const partsApi = root.__footprintParts || (typeof require === 'function' ? require('./proposals/footprint-parts.js') : null);
            if (!partsApi) throw new Error('The authored footprint selector is not loaded.');
            const parts = partsApi.footprintParts(object);
            if (parts.invalid || !parts.polygons.length) add('design-shape', 'A design needs a site or a polygon drawing in its payload.');
        }
        if (object.site != null && !(isObject(object.site) && (object.site.type === 'Polygon' || object.site.type === 'MultiPolygon')
            && Array.isArray(object.site.coordinates))) {
            add('design-field-invalid', 'The site is a Polygon or MultiPolygon geometry.', 'site');
        }
        if (object.geometry != null && !isObject(object.geometry)) add('design-field-invalid', 'The geometry is an object.', 'geometry');

        const road = object.roadProposal?.definition;
        if (road?.constructionFrame) {
            // A relocated drawing must be prepared again; an old frame otherwise prevents 3D rendering.
            const frames = root.__metricFrame || (typeof require === 'function' ? require('./metric-frame.js') : null);
            if (!frames) throw new Error('The metric construction-frame helper is not loaded.');
            try {
                const frame = frames.frameFromProvenance(road.constructionFrame);
                const positions = [
                    ...(road.osm?.elements || []).filter(element => element.type === 'node').map(node => [node.lon, node.lat]),
                    ...frames.collectPositions(road.polygon)
                ];
                if (!positions.length) throw new Error('The road has no coordinates.');
                positions.forEach(position => frame.toMetric(position));
            } catch (_) {
                add('design-road-frame', 'Road coordinates do not match their saved construction frame. Re-prepare the road at its current location.', 'roadProposal.definition.constructionFrame');
            }
        }

        if (object.origin != null && !(isObject(object.origin) && Object.keys(object.origin).length === 1
            && cid().isCid(object.origin.cid))) {
            add('design-origin', 'The origin links the design it was forked from by its CID ({ cid }), or is null.', 'origin');
        }
        return { valid: !errors.length, errors };
    }

    const publicationSize = localDesign => cid().canonicalBytes(published(localDesign)).byteLength;

    return { SCHEMA, PAYLOAD_KEYS, MAX_PUBLISHED_OBJECT_BYTES, publicationSize, published, cidOf, validate };
});
