// API lookup identifiers have disjoint namespaces: digits address a database row; every other
// identifier addresses proposal.proposal_id (the authored ID). A chain token/account is only
// meaningful inside a qualified chain reference and is never searched here.
export const isProposalRowId = value => /^\d+$/.test(String(value));

export function oneProposalByIdentifierClause(identifier, placeholder = '$1') {
    const column = isProposalRowId(identifier) ? 'id::text' : 'proposal_id';
    return `WHERE ${column} = ${placeholder} LIMIT 1`;
}

export function partitionProposalIdentifiers(identifiers) {
    const proposalRowIds = [];
    const authoredProposalIds = [];
    for (const value of identifiers) {
        const id = String(value);
        (isProposalRowId(id) ? proposalRowIds : authoredProposalIds).push(id);
    }
    return { proposalRowIds, authoredProposalIds };
}

export function indexProposalRows(rows) {
    const byIdentifier = new Map();
    for (const row of rows) {
        if (row.id != null) byIdentifier.set(String(row.id), row);
        if (row.proposal_id != null && !isProposalRowId(row.proposal_id)) {
            byIdentifier.set(String(row.proposal_id), row);
        }
    }
    return byIdentifier;
}
