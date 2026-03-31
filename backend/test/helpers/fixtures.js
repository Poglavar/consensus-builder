const now = new Date('2026-01-15T12:00:00Z');

export function validProposalBody(overrides = {}) {
    return {
        proposalId: 'test-proposal-001',
        city: 'zagreb',
        name: 'Test Proposal',
        title: 'Test Proposal Title',
        description: 'A test proposal for urban development',
        author: '0xABCDEF1234567890',
        type: 'parcel',
        status: 'unapplied',
        offer: 1.5,
        offerCurrency: 'ETH',
        parentParcelIds: ['HR-1234-5678', 'HR-1234-5679'],
        childParcelIds: [],
        ...overrides,
    };
}

export function insertResult(overrides = {}) {
    return {
        rows: [{
            id: 1,
            proposal_id: 'test-proposal-001',
            created_at: now,
            ...overrides,
        }],
        rowCount: 1,
    };
}

export function updateResult() {
    return { rows: [], rowCount: 1 };
}

export function proposalDbRow(overrides = {}) {
    return {
        id: 1,
        proposal_id: 'test-proposal-001',
        city: 'zagreb',
        name: 'Test Proposal',
        title: 'Test Proposal Title',
        description: 'A test proposal',
        author: '0xABCDEF',
        type: 'parcel',
        status: 'unapplied',
        offer: '1.5',
        offer_currency: 'ETH',
        budget: null,
        budget_currency: null,
        created_at: now,
        expires_at: null,
        updated_at: now,
        decay_enabled: false,
        decay_percent: null,
        decay_duration_ms: null,
        deposit_enabled: false,
        deposit_percent: null,
        is_conditional: false,
        disbursement_mode: null,
        ancestor_parcel_ids: ['HR-1234-5678', 'HR-1234-5679'],
        descendant_parcel_ids: null,
        accepted_parcel_ids: null,
        owner_acceptances: null,
        road_proposal: null,
        building_proposal: null,
        structure_proposal: null,
        reparcellization: null,
        parent_features: null,
        child_features: null,
        parent_proposal_ids: null,
        child_proposal_ids: null,
        lens: null,
        bounds: null,
        onchain_data: null,
        proposal_data: { name: 'From JSONB', extra: 'field' },
        ...overrides,
    };
}

export function summaryDbRow(overrides = {}) {
    return {
        id: 1,
        proposal_id: 'test-proposal-001',
        city: 'zagreb',
        display_name: 'Test Proposal',
        display_title: 'Test Proposal Title',
        author: '0xABCDEF',
        type: 'parcel',
        status: 'unapplied',
        created_at: now,
        total_count: '3',
        ...overrides,
    };
}
