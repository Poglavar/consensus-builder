import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const designGoals = require('../../frontend/js/proposals/design-goals.js');
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

// The decision rules an agreement can have (plan-design-agreement.md: they replace the decision
// kinds of proposal-kinds.md): who decides, and whether the decision binds.
export const DECISION_RULES = Object.freeze([
    ['owner-deal', 'Owner deal', 'The owners of the input land decide, and the decision binds: the agreement may execute once its rule is satisfied. The classification does not prove title or consent.', 'owners', true],
    ['owner-vote', 'Owner vote', 'Nonbinding vote of the owners of the input land; no execution.', 'owners', false],
    ['community-vote', 'Community vote', 'Nonbinding community vote; no execution.', 'community', false]
].map(([key, label, definition, electorate, binding]) => Object.freeze({ key, label, definition, electorate, binding })));

/** The decision-rule key of an agreement's `rule` ({ electorate, binding }), or null when it names none of them. */
export function decisionRuleOf(rule) {
    if (!rule || typeof rule !== 'object') return null;
    const match = DECISION_RULES.find(entry => entry.electorate === rule.electorate && entry.binding === (rule.binding === true));
    return match ? match.key : null;
}

// Definitions are the source for the published JSON-LD and its human-readable page. Domains are
// deliberately omitted where a predicate is shared; RDF domains infer types, not input validation.
const classes = [
    ['Design', 'Published design', 'One authored change (a road, a park, a parcel layout, an urban rule, a building), identified by the CID of its canonical content. Its existence does not assert construction, ownership or legal approval.', ['schema:CreativeWork', 'prov:Entity']],
    ['Agreement', 'Published agreement', 'A set of designs plus a decision rule, with optional allocations and money, identified by the CID of its canonical content, which names its designs by their CIDs. Its existence does not assert consent, execution or legal approval.', ['schema:CreativeWork', 'prov:Entity']],
    ['DesignSite', 'Design site', 'The geographic extent authored as the design site. It is not a legal cadastral parcel or an assertion of a constructed project.', ['geo:Feature']],
    ['CadastreReference', 'Declared cadastral reference', 'A cadastral identifier an agreement names as its input land. This node is scoped to the agreement; it does not establish cross-provider parcel identity.', ['prov:Entity']]
];
const properties = [
    ['cid', 'Content identifier', 'The CIDv1 (raw codec, sha2-256, base32) of the record\'s canonical bytes: its identity. Changed content is a different record.', 'xsd:string'],
    ['authorLabel', 'Author label', 'A stored author attribution string; not a verified person, organization or signing authority.', 'xsd:string'],
    ['declaredGoal', 'Declared design goal', 'The exact design-goal string carried by the design, including unclassified values.', 'xsd:string'],
    ['designGoal', 'Design-goal concept', 'An exact match to the current design-goal concept scheme; not a physical-object classification.', 'skos:Concept'],
    ['site', 'Authored site', 'The geographic site declared by this design.', 'cb:DesignSite'],
    ['designs', 'Designs', 'An RDF list of the designs the agreement includes, by CID, in authored order.', 'rdf:List'],
    ['decisionRule', 'Decision rule', 'Who decides the agreement and whether the decision binds, as its content states it.', 'skos:Concept'],
    ['agreementDeadline', 'Agreement deadline', 'The deadline carried by the agreement. It does not promise a settlement or construction time.', 'xsd:dateTime'],
    ['cadastreReference', 'Declared cadastral reference', 'An agreement-scoped declaration of a cadastral identifier of its input land.', 'cb:CadastreReference'],
    ['declaredIdentifier', 'Declared identifier', 'The exact identifier string in a scoped reference.', 'xsd:string']
];

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
            ...['DesignGoals', 'DecisionRules'].map(key => ({ '@id': `cb:${key}`, '@type': 'skos:ConceptScheme', 'rdfs:label': key })),
            ...designGoals.concepts.map(c => concept(`goal-${c.key}`, c.label, c.definition, 'DesignGoals')),
            ...DECISION_RULES.map(rule => concept(`rule-${rule.key}`, rule.label, rule.definition, 'DecisionRules'))
        ]
    };
}
