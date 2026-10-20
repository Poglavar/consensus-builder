import { CONTEXT, designGoals, decisionKinds, LIFECYCLES } from './vocabulary.js';
import { assertPlanCommitment } from '../plans/plan-commitment.js';
import { memberHash } from '../plans/plan-hash.js';
import { validateSiteGeometry } from '../proposals/binding.js';

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
function date(object, key, value) {
    if (value && Number.isFinite(new Date(value).getTime())) object[key] = literal(new Date(value).toISOString(), 'xsd:dateTime');
}
function money(value, currency) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !text(currency)) return undefined;
    return { '@type': 'schema:MonetaryAmount', 'schema:value': value, 'schema:currency': currency };
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
    if (error) throw Object.assign(new Error(error), { code: SEMANTIC_RECORD_ERROR, status: 422 });
    return { type: site.type, coordinates: site.coordinates };
}
function labels(node, record) {
    optional(node, 'schema:name', text(record.title) || text(record.name));
    optional(node, 'schema:description', text(record.description));
    optional(node, 'cb:authorLabel', text(record.author));
    date(node, 'schema:dateCreated', record.createdAt);
}

// Input is the canonical serializer output, never raw proposal_data. This allowlist excludes local
// map state, unsigned approval claims, unverified execution timestamps and embedded JSON-LD.
export function proposalDocument(proposal, { baseUrl }) {
    const base = canonicalPublicationBase(baseUrl);
    const rowId = String(proposal.id ?? '');
    if (!/^[0-9]+$/.test(rowId)) throw new Error('A publication row ID is required for a proposal IRI.');
    const url = `${base}/proposals/${rowId}`;
    const node = {
        '@context': CONTEXT, '@id': `${url}#proposal`, '@type': ['cb:Proposal', 'schema:CreativeWork', 'prov:Entity'],
        'schema:url': ref(`${url}?format=jsonld`), 'cb:proposalRowId': rowId,
        'cb:recordedLifecycle': ref(`cb:lifecycle-${LIFECYCLES.includes(proposal.lifecycleStatus) ? proposal.lifecycleStatus : 'Unknown'}`)
    };
    labels(node, proposal);
    optional(node, 'cb:authoredProposalId', text(proposal.proposalId));
    optional(node, 'cb:declaredGoal', text(proposal.goal));
    if (designGoals.get(proposal.goal)) node['cb:designGoal'] = ref(`cb:goal-${proposal.goal}`);
    const kind = decisionKinds.kindOf(proposal);
    if (kind) node['cb:decisionKind'] = ref(`cb:kind-${kind}`);
    date(node, 'cb:proposalDeadline', proposal.expiresAt);
    optional(node, 'cb:offeredConsideration', money(proposal.offer, proposal.offerCurrency));
    optional(node, 'cb:budget', money(proposal.budget, proposal.budgetCurrency));
    if (proposal.site) {
        node['cb:site'] = {
            '@id': `${url}#site`, '@type': ['cb:ProposalSite', 'geo:Feature'],
            'geo:hasGeometry': {
                '@id': `${url}#site-geometry`, '@type': 'geo:Geometry',
                'geo:asGeoJSON': literal(JSON.stringify(siteGeometry(proposal.site)), 'geo:geoJSONLiteral')
            }
        };
    }
    if (Array.isArray(proposal.cadastreParcelIds) && proposal.cadastreParcelIds.length) {
        node['cb:cadastreReference'] = proposal.cadastreParcelIds.map(id => ({
            '@id': `${url}#cadastre-${encodeURIComponent(id)}`, '@type': 'cb:CadastreReference', 'cb:declaredIdentifier': id
        }));
    }
    const chain = proposal.onchain;
    if (chain && text(chain.chainType) && text(chain.contractAddress)
        && [chain.chainId, chain.proposalId].every(value => text(value) || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
        node['cb:declaredChainReference'] = {
            '@id': `${url}#chain-reference`, '@type': 'cb:ChainReference',
            'cb:chainType': String(chain.chainType), 'cb:chainId': String(chain.chainId),
            'cb:contract': String(chain.contractAddress), 'cb:tokenId': String(chain.proposalId)
        };
    }
    return node;
}

export function planDocument(row, members, supersededBy, { baseUrl }) {
    assertPlanCommitment(row);
    const base = canonicalPublicationBase(baseUrl);
    const url = `${base}/plans/${encodeURIComponent(row.slug)}`;
    const byId = new Map(members.map(member => [String(member.id), member]));
    const node = {
        '@context': CONTEXT, '@id': `${url}#plan`, '@type': ['cb:NamedPlan', 'schema:Collection', 'prov:Entity'],
        'schema:url': ref(`${url}?format=jsonld`), 'cb:planHash': row.plan_hash,
        'cb:memberships': { '@list': row.proposal_ids.map((id, index) => {
            const member = byId.get(id);
            let currentHash = null;
            let invalid = false;
            if (member) {
                try { currentHash = memberHash(member); }
                catch (error) {
                    // Match changedMembers(): invalid current readjustment content is drift,
                    // while an unexpected hashing failure must still surface.
                    if (error?.code !== 'invalid-readjustment-deal') throw error;
                    invalid = true;
                }
            }
            const membership = {
                '@id': `${url}#membership-${index + 1}`, '@type': 'cb:PlanMembership',
                'cb:member': ref(`${base}/proposals/${id}#proposal`),
                'cb:committedMemberHash': row.member_hashes[id],
                'cb:memberMissing': !member, 'cb:memberInvalid': invalid,
                'cb:memberChanged': currentHash !== row.member_hashes[id]
            };
            optional(membership, 'cb:currentMemberHash', currentHash);
            return membership;
        }) }
    };
    labels(node, { ...row, createdAt: row.created_at });
    if (row.supersedes) node['cb:supersedes'] = ref(`${base}/plans/${encodeURIComponent(row.supersedes)}#plan`);
    if (supersededBy.length) node['cb:supersededBy'] = supersededBy.map(slug => ref(`${base}/plans/${encodeURIComponent(slug)}#plan`));
    return node;
}
