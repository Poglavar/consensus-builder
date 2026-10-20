import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const designGoals = require('../../frontend/js/proposals/design-goals.js');
export const decisionKinds = require('../../frontend/js/proposals/proposal-kind.js');
export const NAMESPACE = 'https://urbangametheory.xyz/vocabulary/1/#';
export const CONTEXT = Object.freeze({
    cb: NAMESPACE,
    schema: 'https://schema.org/',
    geo: 'http://www.opengis.net/ont/geosparql#',
    prov: 'http://www.w3.org/ns/prov#',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd: 'http://www.w3.org/2001/XMLSchema#'
});

// Definitions are the source for the published JSON-LD and its human-readable page. Domains are
// deliberately omitted where a predicate is shared; RDF domains infer types, not input validation.
const classes = [
    ['Proposal', 'Published proposal', 'An authored proposal record in a publication store. Its existence does not assert construction, ownership or legal approval.', ['schema:CreativeWork', 'prov:Entity']],
    ['NamedPlan', 'Named plan', 'An immutable named commitment to an ordered set of proposal members and their saved content hashes.', ['schema:Collection', 'prov:Entity']],
    ['PlanMembership', 'Plan membership commitment', 'A position in a named plan, identifying a published proposal and the member content hash saved when the plan was named.', ['prov:Entity']],
    ['ProposalSite', 'Proposal site', 'The geographic extent authored as the proposal site. It is not a legal cadastral parcel or an assertion of a constructed project.', ['geo:Feature']],
    ['CadastreReference', 'Declared cadastral reference', 'A cadastral identifier declared by this proposal. This node is scoped to the proposal; it does not establish cross-provider parcel identity.', ['prov:Entity']],
    ['ChainReference', 'Declared chain reference', 'A complete chain family, network, contract or program, and token or account location declared by the server-owned attachment. This alone is not verified execution evidence.', ['prov:Entity']]
];
const properties = [
    ['proposalRowId', 'Publication row ID', 'Decimal database row key within the canonical publication API.', 'xsd:string'],
    ['authoredProposalId', 'Authored proposal ID', 'Authored identifier carried by the published record, separate from a database row key or chain account.', 'xsd:string'],
    ['authorLabel', 'Author label', 'A stored author attribution string; not a verified person, organization or signing authority.', 'xsd:string'],
    ['declaredGoal', 'Declared design goal', 'The exact design-goal string carried by the record, including unclassified values.', 'xsd:string'],
    ['designGoal', 'Design-goal concept', 'An exact match to the current design-goal concept scheme; not a physical-object classification.', 'skos:Concept'],
    ['decisionKind', 'Decision kind', 'The decision kind interpreted by the current application contract. A missing historical kind is interpreted as owner-deal.', 'skos:Concept'],
    ['recordedLifecycle', 'Recorded lifecycle', 'The API record lifecycle, including its Active-only deadline rule. This is not an independently observed chain or construction state.', 'skos:Concept'],
    ['proposalDeadline', 'Proposal deadline', 'The deadline carried by the proposal. It does not promise a settlement or construction time.', 'xsd:dateTime'],
    ['site', 'Authored site', 'The geographic site declared by this proposal.', 'cb:ProposalSite'],
    ['cadastreReference', 'Declared cadastral reference', 'A proposal-scoped declaration of a cadastral identifier.', 'cb:CadastreReference'],
    ['declaredIdentifier', 'Declared identifier', 'The exact identifier string in a scoped reference.', 'xsd:string'],
    ['declaredChainReference', 'Declared chain location', 'A complete location from the server-owned chain attachment; not proof of current chain state.', 'cb:ChainReference'],
    ['chainType', 'Chain family', 'Declared blockchain family, such as evm or solana.', 'xsd:string'],
    ['chainId', 'Chain network', 'Declared network identifier in the chain family.', 'xsd:string'],
    ['contract', 'Contract or program', 'Declared contract or program identifier. Case is retained.', 'xsd:string'],
    ['tokenId', 'Token or account', 'Declared proposal token or account identifier. Case is retained.', 'xsd:string'],
    ['offeredConsideration', 'Offered consideration', 'An explicit authored offer amount and currency. It is not a balance, paid amount or escrow observation.', 'schema:MonetaryAmount'],
    ['budget', 'Authored budget', 'An explicit authored budget amount and currency, distinct from offered consideration.', 'schema:MonetaryAmount'],
    ['memberships', 'Ordered memberships', 'An RDF list of the plan membership commitments, preserving their saved order.', 'rdf:List'],
    ['member', 'Member proposal', 'The published proposal record named by a membership commitment.', 'cb:Proposal'],
    ['committedMemberHash', 'Committed member hash', 'Saved SHA-256 memberContent digest, under the application commitment contract; not a digest of this JSON-LD document.', 'xsd:string'],
    ['currentMemberHash', 'Current member hash', 'The current memberContent digest calculated during this read, when the member exists.', 'xsd:string'],
    ['memberChanged', 'Member changed', 'True when the current member is missing, has invalid commitment content, or its memberContent digest differs from the saved commitment.', 'xsd:boolean'],
    ['memberMissing', 'Member missing', 'True when the referenced member could not be found during this read.', 'xsd:boolean'],
    ['memberInvalid', 'Member content invalid', 'True when the current member exists but cannot be hashed under the current readjustment commitment contract.', 'xsd:boolean'],
    ['planHash', 'Saved plan hash', 'Saved aggregate commitment over ordered authored proposal identifiers and member hashes. It does not identify every field in this export.', 'xsd:string'],
    ['supersedes', 'Supersedes named plan', 'An explicit link to the previous named plan revision.', 'cb:NamedPlan'],
    ['supersededBy', 'Superseded by named plan', 'A named plan that explicitly declares this plan as its previous revision.', 'cb:NamedPlan']
];

const lifecycle = [
    ['draft', 'Stored draft state.'], ['Active', 'Stored active state with no elapsed recorded deadline.'],
    ['Executed', 'Stored execution state; physical realization and independent chain proof are separate.'],
    ['Cancelled', 'Stored cancellation state.'], ['Expired', 'Stored expiry state or an Active record whose recorded deadline elapsed.'],
    ['Unknown', 'Missing or unrecognized stored lifecycle; no Active or terminal state is inferred.']
];
export const LIFECYCLES = Object.freeze(lifecycle.map(([key]) => key));

const ref = id => ({ '@id': id });
const concept = (id, label, definition, scheme) => ({
    '@id': `cb:${id}`, '@type': 'skos:Concept', 'skos:prefLabel': label,
    'skos:definition': definition, 'skos:inScheme': ref(`cb:${scheme}`)
});

export function vocabularyDocument() {
    return {
        '@context': CONTEXT,
        '@graph': [
            ...classes.map(([key, label, definition, parents]) => ({
                '@id': `cb:${key}`, '@type': 'rdfs:Class', 'rdfs:label': label,
                'rdfs:comment': definition, 'rdfs:subClassOf': parents.map(ref)
            })),
            ...properties.map(([key, label, definition, range]) => ({
                '@id': `cb:${key}`, '@type': 'rdf:Property', 'rdfs:label': label,
                'rdfs:comment': definition, 'rdfs:range': ref(range)
            })),
            ...['DesignGoals', 'DecisionKinds', 'RecordLifecycles'].map(key => ({ '@id': `cb:${key}`, '@type': 'skos:ConceptScheme', 'rdfs:label': key })),
            ...designGoals.concepts.map(c => concept(`goal-${c.key}`, c.label, c.definition, 'DesignGoals')),
            concept('kind-owner-deal', 'Owner deal', 'Binding proposal path, subject to its applicable terms and approvals; the classification does not prove title or consent.', 'DecisionKinds'),
            concept('kind-owner-vote', 'Owner vote', 'Nonbinding vote addressed to the proposal owner electorate; no money or execution.', 'DecisionKinds'),
            concept('kind-community-vote', 'Community vote', 'Nonbinding community vote; no money or execution.', 'DecisionKinds'),
            ...lifecycle.map(([key, definition]) => concept(`lifecycle-${key}`, key === 'draft' ? 'Draft' : key, definition, 'RecordLifecycles'))
        ]
    };
}
