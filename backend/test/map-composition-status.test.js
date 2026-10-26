// Map sharing is green only when the address names the exact published revisions applied here.
// These cases cover ordinary routes, named plans, agreements, and local changes that make a link stale.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MapShare = require('../../frontend/js/map-share.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const Cid = require('../../frontend/js/cid.js');

const cidA = Cid.cidOfObject({ design: 'a' });
const cidB = Cid.cidOfObject({ design: 'b' });
const cidC = Cid.cidOfObject({ design: 'c' });

function harness({ records = [], path = '/', status = 'ready', plan = null, agreement = null,
    currentCid = null, search = '' } = {}) {
    const win = {
        proposalStorage: { getAllProposals: () => records },
        isApplied: record => record.applied === true,
        DesignSync: {
            parseDesignsPath: DesignSync.parseDesignsPath,
            publishedCid: record => record.publishedCid || null
        },
        BrowserWorkspace: { status },
        NamedPlans: { current: plan },
        AgreementSync: { localCopyOf: () => agreement },
        location: { href: `https://example.test${path}${search}` }
    };
    // Current plan identity is checked against the actual URL subject, not whichever plan was last opened.
    if (currentCid && plan) plan.cid = currentCid;
    return win;
}

const applied = (...cids) => cids.map((publishedCid, index) => ({ proposalId: `p${index}`, applied: true, publishedCid }));

describe('MapShare.compositionStatus', () => {
    it('shares an empty map at an ordinary URL and ignores saved unapplied drafts', () => {
        expect(MapShare.compositionStatus(harness())).toBe('shared');
        const draft = { proposalId: 'draft', applied: false };
        expect(MapShare.compositionStatus(harness({ records: [draft] }))).toBe('shared');
    });

    it('returns local for an applied unpublished design', () => {
        expect(MapShare.compositionStatus(harness({ records: [{ proposalId: 'local', applied: true }] }))).toBe('local');
    });

    it('compares /designs members as an order-independent exact set', () => {
        expect(MapShare.compositionStatus(harness({ records: applied(cidA, cidB), path: `/designs/${cidB},${cidA}` }))).toBe('shared');
        expect(MapShare.compositionStatus(harness({ records: applied(cidA, cidB), path: `/designs/${cidA}` }))).toBe('local');
        expect(MapShare.compositionStatus(harness({ records: applied(cidA), path: `/designs/${cidA},${cidB}` }))).toBe('local');
    });

    it('uses the current named plan only when its CID matches the route', () => {
        const plan = { cid: cidC, content: { designCids: [cidA, cidB] } };
        expect(MapShare.compositionStatus(harness({ records: applied(cidB, cidA), path: `/plans/${cidC}`, plan }))).toBe('shared');
        expect(MapShare.compositionStatus(harness({ records: applied(cidA), path: `/plans/${cidC}`, plan }))).toBe('local');
        expect(MapShare.compositionStatus(harness({ records: applied(cidA), path: `/plans/${cidB}`, plan }))).toBe('pending');
        expect(MapShare.compositionStatus(harness({ records: applied(cidA), path: `/plans/${cidC}` }))).toBe('pending');
    });

    it('uses the agreement local copy plan membership', () => {
        const agreement = { plan: { content: { designCids: [cidB, cidA] } } };
        expect(MapShare.compositionStatus(harness({ records: applied(cidA, cidB), path: `/agreements/${cidC}`, agreement }))).toBe('shared');
        expect(MapShare.compositionStatus(harness({ records: applied(cidA), path: `/agreements/${cidC}`, agreement }))).toBe('local');
        expect(MapShare.compositionStatus(harness({ records: applied(cidA), path: `/agreements/${cidC}` }))).toBe('pending');
    });

    it('stays local when a published record no longer resolves to its CID at this backend', () => {
        const win = harness({ records: [{ proposalId: 'edited', applied: true, publishedCid: null }], path: `/designs/${cidA}` });
        expect(MapShare.compositionStatus(win)).toBe('local');
    });

    it('does not depend on camera, mode, or other query parameters', () => {
        const records = applied(cidA);
        const plain = harness({ records, path: `/designs/${cidA}` });
        const cameraChanged = harness({ records, path: `/designs/${cidA}`, search: '?at=45.8,15.9,12&camera=45.8,15.9,0,-0.2,50&3d=' });
        expect(MapShare.compositionStatus(plain)).toBe('shared');
        expect(MapShare.compositionStatus(cameraChanged)).toBe('shared');
    });

    it('waits while the browser workspace is loading', () => {
        expect(MapShare.compositionStatus(harness({ status: 'loading' }))).toBe('pending');
    });
});
