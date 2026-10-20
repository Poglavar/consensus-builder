// A free-placed building's generated name and description follow the parcels it is finally bound
// to, not the selection it started from (instantCreateProposalFromDraft, proposal-editor-shell.js).
// Freeform buildings are the free-placed buildings: Block, Row and Detached stay on their parcels
// (FREE_PLACEMENT_GOALS, proposal-editor-adapters.js).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/js');
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const site = { type: 'MultiPolygon', coordinates: [[[[15, 45], [15.001, 45], [15.001, 45.001], [15, 45]]]] };

function browser(extra = {}) {
    const context = vm.createContext({ console: quiet, setTimeout, clearTimeout, AbortController, URLSearchParams, Date, ...extra });
    context.window = context;
    return context;
}
const load = (context, file) => vm.runInContext(fs.readFileSync(path.join(FRONTEND, file), 'utf8'), context, { filename: file });

async function saveFreeformBuilding({ boundParcels }) {
    const c = browser({ CbFormat: { formatDateTime: () => 'today' } });
    for (const file of ['proposals/site-draft.js', 'proposals/design-goals.js', 'proposal-editor-adapters.js', 'proposal-drafts.js', 'proposals/create.js', 'proposal-editor-shell.js']) load(c, file);
    const store = c.createProposalDraftStore({
        idFactory: () => 'single-draft',
        adapterRegistry: { get: () => ({ validate: () => ({ valid: true, errors: [], warnings: [] }) }) }
    });
    c.proposalDraftStore = store;
    store.createDraft({
        goal: 'single', adapterKey: 'single', proposalType: 'Freeform building',
        fields: { name: '', description: '', selectedParcelIds: ['HR-339164-2951', 'HR-339164-2972'], site, offer: 0 },
        editorPayload: { placement: { free: true, site, bindingStatus: 'pending' } }
    });
    c.resolveBackendBaseUrl = () => 'https://example.invalid';
    c.fetch = () => {};
    c.__publishBinding = { createFetchBinding: () => async () => ({ coverage: 'complete', source: 'server:test', parcels: boundParcels.map(parcelId => ({ parcelId })) }) };
    c.getProposalI18nHelper = () => (_key, fallback, values = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
    let saved;
    c.generateDefaultProposalDescription = (type, name) => `${type}: ${name}`;
    store.buildProposalFromDraft = id => {
        const d = store.getDraft(id);
        return { title: d.fields.name, description: d.fields.description, offer: d.fields.offer, offerCurrency: 'EUR', site };
    };
    c.proposalStorage = { addProposal: p => { saved = { ...p, proposalId: 'single-saved' }; return 'single-saved'; }, getProposal: () => saved };
    c.ProposalManager = { applyProposal: async () => { saved.applied = true; return true; } };
    c.isProposalApplied = p => p.applied;
    const id = await c.instantCreateProposalFromDraft('single-draft');
    return { id, saved };
}

describe('free-placement naming', () => {
    it('names the saved object after the parcel it was finally bound to', async () => {
        const { id, saved } = await saveFreeformBuilding({ boundParcels: ['HR-339164-2972'] });
        expect(id).toBe('single-saved');
        expect(saved.title).toBe('Freeform building · parcel 2972');
        expect(saved.description).toBe('Freeform building: Freeform building · parcel 2972');
        // No placeholder offer: terms are chosen when the proposal is published (proposal-kinds.md).
        expect(saved.offer).toBe(0);
    });

    it('keeps the generated name when the binding names no parcel', async () => {
        const { saved } = await saveFreeformBuilding({ boundParcels: [] });
        expect(saved.title).toMatch(/^Freeform building · /);
        expect(saved.title).not.toBe('Freeform building · parcel 2972');
    });
});
