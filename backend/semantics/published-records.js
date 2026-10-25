// JSON-LD of published designs and agreements (plan-design-agreement.md M2), served as
// GET /designs/:cid?format=jsonld and GET /agreements/:cid?format=jsonld. A record's IRI is its CID
// under PUBLIC_API_BASE_URL, and only its CID-addressed content is read: no server-side column that a
// later write could change speaks for the record.
import { CONTEXT, designGoals, decisionRuleOf } from './vocabulary.js';
import { validateSiteGeometry } from '../proposals/binding.js';
import { publicApiBaseUrl } from '../utils/public-base-url.js';
import { isCid } from '../cid.js';

export const SEMANTIC_BASE_ERROR = 'semantic-public-base-unconfigured';
export const SEMANTIC_RECORD_ERROR = 'semantic-record-invalid';

export function canonicalPublicationBase(value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        return url.href.replace(/\/+$/, '');
    } catch {
        throw Object.assign(new Error('JSON-LD requires a canonical PUBLIC_API_BASE_URL.'), { code: SEMANTIC_BASE_ERROR, status: 503 });
    }
}

const ref = id => ({ '@id': id });
const literal = (value, type) => ({ '@value': value, '@type': type });
const text = value => typeof value === 'string' && value.length ? value : undefined;
const optional = (object, key, value) => { if (value !== undefined && value !== null) object[key] = value; };
const recordError = message => Object.assign(new Error(message), { code: SEMANTIC_RECORD_ERROR, status: 422 });
function date(object, key, value) {
    if (value && Number.isFinite(new Date(value).getTime())) object[key] = literal(new Date(value).toISOString(), 'xsd:dateTime');
}
function siteGeometry(site) {
    let error = validateSiteGeometry(site);
    if (!error) {
        const polygons = site.type === 'Polygon' ? [site.coordinates] : site.coordinates;
        if (!['Polygon', 'MultiPolygon'].includes(site.type) || site.crs
            || polygons.some(rings => rings.some(ring => ring.some(position =>
                ![2, 3].includes(position.length) || !position.every(Number.isFinite))
                || JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))))) {
            error = 'Site GeoJSON must use closed rings with CRS84 positions.';
        }
    }
    if (error) throw recordError(error);
    return { type: site.type, coordinates: site.coordinates };
}
function labels(node, content, createdAt) {
    optional(node, 'schema:name', text(content.title));
    optional(node, 'schema:description', text(content.description));
    optional(node, 'cb:authorLabel', text(content.author));
    date(node, 'schema:dateCreated', createdAt);
}
// The row's CID and its content of the given schema; anything else is not a published record.
function publishedOf(row, schema) {
    const cid = typeof row?.cid === 'string' ? row.cid : '';
    if (!isCid(cid)) throw recordError('A published record needs its CID.');
    const content = row.content;
    if (!content || typeof content !== 'object' || Array.isArray(content) || content.schema !== schema) {
        throw recordError(`Record ${cid} is not ${schema} content.`);
    }
    return { cid, content };
}

/**
 * The JSON-LD node of a design row ({ cid, content: design/v1 }), IRI `<base>/designs/<cid>#design`.
 * @param {{ cid: string, content: object }} row
 * @param {{ baseUrl?: string }} [options] defaults to PUBLIC_API_BASE_URL; unset or not canonical → SEMANTIC_BASE_ERROR (503)
 */
export function designDocument(row, { baseUrl = publicApiBaseUrl() } = {}) {
    const base = canonicalPublicationBase(baseUrl);
    const { cid, content } = publishedOf(row, 'design/v1');
    const url = `${base}/designs/${cid}`;
    const node = {
        '@context': CONTEXT, '@id': `${url}#design`, '@type': ['cb:Design', 'schema:CreativeWork', 'prov:Entity'],
        'schema:url': ref(`${url}?format=jsonld`), 'cb:cid': cid
    };
    labels(node, content, content.authoredAt);
    optional(node, 'cb:declaredGoal', text(content.goal));
    if (designGoals.get(content.goal)) node['cb:designGoal'] = ref(`cb:goal-${content.goal}`);
    if (content.site) {
        node['cb:site'] = {
            '@id': `${url}#site`, '@type': ['cb:DesignSite', 'geo:Feature'],
            'geo:hasGeometry': {
                '@id': `${url}#site-geometry`, '@type': 'geo:Geometry',
                'geo:asGeoJSON': literal(JSON.stringify(siteGeometry(content.site)), 'geo:geoJSONLiteral')
            }
        };
    }
    // A fork links the design it came from by CID.
    const origin = content.origin && typeof content.origin === 'object' ? content.origin.cid : null;
    if (isCid(origin)) node['prov:wasDerivedFrom'] = ref(`${base}/designs/${origin}#design`);
    return node;
}

/**
 * The JSON-LD node of an agreement row ({ cid, content: agreement/v1 }), IRI
 * `<base>/agreements/<cid>#agreement`: its exact plan, its decision
 * rule (content.rule), its deadline (content.deadline) and its input parcels (content.inputs.parcels).
 * @param {{ cid: string, content: object }} row
 * @param {{ baseUrl?: string }} [options] defaults to PUBLIC_API_BASE_URL; unset or not canonical → SEMANTIC_BASE_ERROR (503)
 */
export function agreementDocument(row, { baseUrl = publicApiBaseUrl() } = {}) {
    const base = canonicalPublicationBase(baseUrl);
    const { cid, content } = publishedOf(row, 'agreement/v1');
    const url = `${base}/agreements/${cid}`;
    const node = {
        '@context': CONTEXT, '@id': `${url}#agreement`, '@type': ['cb:Agreement', 'schema:CreativeWork', 'prov:Entity'],
        'schema:url': ref(`${url}?format=jsonld`), 'cb:cid': cid
    };
    labels(node, content, content.createdAt);
    if (!isCid(content.planCid)) throw recordError(`Agreement ${cid} has no plan CID.`);
    node['cb:plan'] = ref(`${base}/plans/${content.planCid}#plan`);
    const rule = decisionRuleOf(content.rule);
    if (rule) node['cb:decisionRule'] = ref(`cb:rule-${rule}`);
    date(node, 'cb:agreementDeadline', content.deadline);
    const parcels = Array.isArray(content.inputs?.parcels) ? content.inputs.parcels : [];
    if (parcels.length) {
        node['cb:cadastreReference'] = parcels.map((parcel, index) => {
            const id = parcel && typeof parcel === 'object' ? text(parcel.parcelId) : undefined;
            if (!id) throw recordError(`Input parcel ${index + 1} of agreement ${cid} has no id.`);
            return { '@id': `${url}#cadastre-${encodeURIComponent(id)}`, '@type': 'cb:CadastreReference', 'cb:declaredIdentifier': id };
        });
    }
    return node;
}
