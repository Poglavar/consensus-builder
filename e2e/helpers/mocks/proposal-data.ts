/**
 * Sample proposal payloads for test mocking.
 */

let nextServerId = 100;

export function makeRoadProposal(overrides: Record<string, any> = {}) {
  return {
    id: nextServerId++,
    proposal_id: `local-road-${Date.now()}`,
    name: 'Test Road Proposal',
    type: 'road',
    status: 'draft',
    created_at: new Date().toISOString(),
    proposal_data: {
      type: 'road',
      name: 'Test Road Proposal',
      parcels: ['HR-335754-1234', 'HR-335754-1235'],
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [15.9819, 45.8000],
          [15.9832, 45.8000],
          [15.9832, 45.8005],
          [15.9819, 45.8005],
          [15.9819, 45.8000],
        ]],
      },
      ...overrides.proposal_data,
    },
    ...overrides,
  };
}

export function makeParkProposal(overrides: Record<string, any> = {}) {
  return {
    id: nextServerId++,
    proposal_id: `local-park-${Date.now()}`,
    name: 'Test Park Proposal',
    type: 'park',
    status: 'draft',
    created_at: new Date().toISOString(),
    proposal_data: {
      type: 'park',
      name: 'Test Park Proposal',
      parcels: ['HR-335754-1236'],
      ...overrides.proposal_data,
    },
    ...overrides,
  };
}

export function makeBuildingProposal(overrides: Record<string, any> = {}) {
  return {
    id: nextServerId++,
    proposal_id: `local-building-${Date.now()}`,
    name: 'Test Building Proposal',
    type: 'building',
    status: 'draft',
    created_at: new Date().toISOString(),
    proposal_data: {
      type: 'building',
      name: 'Test Building Proposal',
      parcels: ['HR-335754-1237'],
      ...overrides.proposal_data,
    },
    ...overrides,
  };
}

export function makeReparcelizationProposal(overrides: Record<string, any> = {}) {
  return {
    id: nextServerId++,
    proposal_id: `local-reparcel-${Date.now()}`,
    name: 'Test Reparcelization',
    type: 'reparcelization',
    status: 'draft',
    created_at: new Date().toISOString(),
    proposal_data: {
      type: 'reparcelization',
      name: 'Test Reparcelization',
      parcels: ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236'],
      ...overrides.proposal_data,
    },
    ...overrides,
  };
}

export const sampleProposalsList = [
  makeRoadProposal({ id: 1, proposal_id: 'server-1' }),
  makeParkProposal({ id: 2, proposal_id: 'server-2' }),
];
