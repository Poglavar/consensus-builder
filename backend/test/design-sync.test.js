// Unit tests for frontend/js/proposals/design-sync.js: when a local design reads as published (its
// exact CID at one API, with the hash memoised per record), share paths of design CIDs, a local record
// rebuilt from an index row, and the browser half on a fake window and a fake courier and index:
// publishing a design, importing one, finding the local copy of a listed design, the parcel source a
// city binds with, and the sentence for each refusal.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const Cid = require('../../frontend/js/cid.js');
const PublishTerms = require('../../frontend/js/proposals/publish-terms.js');
const OpenGround = require('../../frontend/js/proposals/open-ground.js');
let NodeCid;
beforeAll(async () => { NodeCid = await import('../cid.js'); });
afterEach(() => { delete globalThis.DesignRecord; });

const API = 'https://api.example.test';
const square = (x, y, size = 0.001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
const thrown = async fn => { try { await fn(); } catch (error) { return error; } return null; };

function road(extra = {}) {
    return {
        proposalId: 'road-1', goal: 'road', title: 'New lane', author: 'Ana', city: 'zagreb', site: square(15.96, 45.8),
        createdAt: '2026-10-21T10:00:00.000Z', roadProposal: { definition: { widthM: 9 } }, cadastreParcelIds: ['k9'], ...extra
    };
}
// A record published at `apiBase`: marked with the CID it hashes to.
function publishedRoad(apiBase = API, extra = {}) {
    const record = road(extra);
    record.published = { cid: DesignRecord.cidOf(record), publishedAt: '2026-10-21T12:00:00.000Z', apiBase };
    return record;
}
// An index row as GET /designs/:cid and POST /designs/batch answer it (routes/designs.js serializeDesignRow).
function rowOf(record, extra = {}) {
    const content = DesignRecord.published(record);
    return {
        cid: Cid.cidOfObject(content), city: content.city, goal: content.goal, title: content.title, author: content.author,
        content, createdAt: '2026-10-21T12:00:01.000Z',
        binding: { coverage: 'complete', parcels: [{ parcelId: '12' }, { parcelId: '9' }, { parcelId: '12' }, { parcelId: null }] },
        screenshotUrl: 'https://img.example.test/road.png', ...extra
    };
}

describe('publishedCid', () => {
    it('is the CID while the record still hashes to its publication at that API', () => {
        const record = publishedRoad();
        expect(DesignSync.publishedCid(record, API)).toBe(record.published.cid);
        expect(DesignSync.publishedCid(record, `${API}/`)).toBe(record.published.cid);
        // Applying the design writes apply-time state; it is the same design.
        record.roadProposal.applied = true;
        record.applied = true;
        expect(DesignSync.publishedCid(record, API)).toBe(record.published.cid);
    });

    it('is null for another API, an unpublished record, a bad mark or an edit made after publishing', () => {
        expect(DesignSync.publishedCid(publishedRoad(), 'https://other.example.test')).toBeNull();
        expect(DesignSync.publishedCid(publishedRoad(), 'not a url')).toBeNull();
        expect(DesignSync.publishedCid(road(), API)).toBeNull();
        expect(DesignSync.publishedCid({ ...publishedRoad(), published: { cid: 'c2-old', apiBase: API } }, API)).toBeNull();
        const edited = publishedRoad();
        edited.title = 'Wider lane';
        expect(DesignSync.publishedCid(edited, API)).toBeNull();
        // A copy that carried the mark over to other content is not the published design either.
        expect(DesignSync.publishedCid({ ...publishedRoad(), site: square(15.97, 45.8) }, API)).toBeNull();
    });

    it('hashes a record once while its text is unchanged and again after an edit in place', () => {
        let hashed = 0;
        globalThis.DesignRecord = { ...DesignRecord, cidOf: record => { hashed += 1; return DesignRecord.cidOf(record); } };
        const record = publishedRoad();
        expect(DesignSync.publishedCid(record, API)).toBe(record.published.cid);
        expect(DesignSync.publishedCid(record, API)).toBe(record.published.cid);
        expect(hashed).toBe(1);
        record.title = 'Renamed in place';
        expect(DesignSync.publishedCid(record, API)).toBeNull();
        expect(hashed).toBe(2);
        record.title = 'New lane';
        expect(DesignSync.publishedCid(record, API)).toBe(record.published.cid);
        expect(hashed).toBe(3);
    });
});

describe('share paths', () => {
    const a = Cid.cidOfObject({ a: 1 });
    const b = Cid.cidOfObject({ b: 2 });
    const [first, second] = [a, b].sort();

    it('names distinct designs in code-unit order', () => {
        expect(DesignSync.designsPath([second, first, second])).toBe(`/designs/${first},${second}`);
        expect(DesignSync.sortedCids([second, first])).toEqual([first, second]);
        let refusal = null;
        try { DesignSync.designsPath([first, '41']); } catch (error) { refusal = error; }
        expect(refusal && refusal.code).toBe('invalid-cid');
    });

    it('reads the CIDs back from a /designs path, and nothing else', () => {
        expect(DesignSync.parseDesignsPath(`/designs/${second},${first},${second}`)).toEqual([second, first]);
        expect(DesignSync.parseDesignsPath(`/designs/${first}/`)).toEqual([first]);
        expect(DesignSync.parseDesignsPath(`/designs/${first}%2C%20${second}`)).toEqual([first, second]);
        for (const path of ['/designs/', `/designs/${first},41`, '/designs/41', `/proposals/${first}`, `/designs/${first}/edit`, null]) {
            expect(DesignSync.parseDesignsPath(path), String(path)).toBeNull();
        }
    });
});

describe('a local record from an index row', () => {
    it('hashes back to the row\'s CID and carries the binding and the publication', () => {
        const row = rowOf(road());
        const record = DesignSync.localDesignFromRow(row, { apiBase: `${API}/` });
        expect(record).toMatchObject({
            proposalId: `design-${row.cid}`, goal: 'road', title: 'New lane', name: 'New lane', author: 'Ana', city: 'zagreb',
            cadastreParcelIds: ['9', '12'], screenshotUrl: row.screenshotUrl,
            published: { cid: row.cid, publishedAt: row.createdAt, apiBase: API }
        });
        expect(DesignRecord.cidOf(record)).toBe(row.cid);
        expect(DesignSync.publishedCid(record, API)).toBe(row.cid);
        expect(DesignSync.localDesignFromRow(row, { apiBase: API, proposalId: 'kept-id' }).proposalId).toBe('kept-id');
        const fork = rowOf(road({ origin: { cid: row.cid } }));
        expect(DesignSync.localDesignFromRow(fork, { apiBase: API }).origin).toEqual({ cid: row.cid });
    });

    it('preserves the server binding observation for an imported partial site without changing its CID', () => {
        const parcels = Array.from({ length: 118 }, (_, index) => ({ parcelId: `HR-1-${index + 1}`, overlapM2: 20 }));
        const binding = { coverage: 'partial', parcels, touched: [], unsurveyedM2: 76000, outsideM2: null,
            unknownM2: 0, source: 'server', parcelSource: { sourceId: 'gb-hmlr-city-of-london', snapshotId: null } };
        const row = rowOf(road(), { binding });
        const record = DesignSync.localDesignFromRow(row, { apiBase: API });
        expect(record.binding).toEqual(binding);
        expect(OpenGround.hasOpenGround(record)).toBe(true);
        expect(DesignRecord.cidOf(record)).toBe(row.cid);
        expect(DesignSync.designSummary(row).binding).toEqual(binding);
    });

    it('does not synthesize coverage for missing observations or turn unknown into partial', () => {
        const row = rowOf(road());
        const missing = DesignSync.localDesignFromRow({ ...row, binding: undefined }, { apiBase: API });
        const unknown = DesignSync.localDesignFromRow({ ...row, binding: { coverage: 'unknown', parcels: row.binding.parcels } }, { apiBase: API });
        expect(missing).not.toHaveProperty('binding');
        expect(unknown.binding.coverage).toBe('unknown');
        expect(OpenGround.hasOpenGround(unknown)).toBe(false);
    });

    it('takes the creation time from the design object alone, so a design authored without one still hashes to its CID', () => {
        const row = rowOf(road({ createdAt: null }));
        expect(row.content.authoredAt).toBeNull();
        const record = DesignSync.localDesignFromRow(row, { apiBase: API });
        expect(record.createdAt).toBeNull();
        expect(DesignRecord.cidOf(record)).toBe(row.cid);
        expect(DesignSync.publishedCid(record, API)).toBe(row.cid);
    });

    it('refuses a row whose content is not the design it is filed under, or not a design', () => {
        const codeOf = row => { try { DesignSync.localDesignFromRow(row, { apiBase: API }); } catch (error) { return error.code; } return null; };
        const row = rowOf(road());
        expect(codeOf({ ...row, content: { ...row.content, title: 'Tampered' } })).toBe('cid-mismatch');
        expect(codeOf({ ...row, content: { ...row.content, schema: 'proposal/v1' } })).toBe('invalid-design');
        expect(codeOf({ ...row, cid: '41' })).toBe('invalid-design');
        expect(codeOf(null)).toBe('invalid-design');
        expect(() => DesignSync.localDesignFromRow(row, { apiBase: null })).toThrow(/API base/);
    });

    it('lists as a summary that is published by definition', () => {
        const row = rowOf(road());
        expect(DesignSync.designSummary(row)).toMatchObject({ id: row.cid, cid: row.cid, indexed: true, goal: 'road', title: 'New lane',
            cadastreParcelIds: ['9', '12'] });
        expect(DesignSync.designSummary({ cid: 'nope' })).toBeNull();
        expect(DesignSync.bindingParcelIds(null)).toEqual([]);
    });
});

// ---- the browser half ----------------------------------------------------------------------------

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// The browser's real proposal store (proposals/data.js, a classic script) on the globals it reads, as
// proposal-storage-authored-log.test.js boots it. restore() puts the globals back.
function realProposalStorage() {
    const saved = new Map();
    const install = (name, value) => {
        if (!saved.has(name)) saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
        globalThis[name] = value;
    };
    const status = require('../../frontend/js/proposals/status.js');
    const persisted = new Map();
    install('window', globalThis);
    install('__cbSecondaryTab', false);
    install('__formationDepth', require('../../frontend/js/proposals/formation-depth.js'));
    install('__planOrder', require('../../frontend/js/proposals/plan-order.js'));
    install('ProposalOrigin', require('../../frontend/js/proposals/origin.js'));
    install('ProposalAuthoredRecord', require('../../frontend/js/proposals/authored-record.js'));
    install('normalizeParcelIdList', values => Array.from(new Set((values || []).map(String))));
    install('normalizeLensEntries', value => value || []);
    install('normalizeProposalStatusAxes', status.normalizeProposalStatusAxes);
    install('getLifecycleStatus', status.getLifecycleStatus);
    install('parkProposalForImport', status.parkProposalForImport);
    install('normalizeProposalGoalKey', value => String(value || '').trim().toLowerCase());
    install('isLocalProposalId', value => /^local-/.test(String(value || '')));
    install('PersistentStorage', {
        getItem: key => persisted.get(key) || null,
        setItem: (key, value) => persisted.set(key, String(value)),
        removeItem: key => persisted.delete(key),
        forEach: callback => persisted.forEach((value, key) => callback(value, key)),
        atomicWrite: async change => {
            (change.deletes || []).forEach(key => persisted.delete(key));
            (change.puts || new Map()).forEach((value, key) => persisted.set(key, String(value)));
        }
    });
    const storage = (0, eval)(readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8') + '\n;proposalStorage');
    const restore = () => {
        for (const [name, prior] of saved) {
            if (prior.existed) globalThis[name] = prior.value; else delete globalThis[name];
        }
    };
    return { storage, restore };
}

// The courier and the index as the browser sees them: /pins recomputes the CID of the exact bytes it
// receives (with the node twin, as the server does), /designs files the content under it.
function fakeServer({ answerCid = null, refuseDesigns = null } = {}) {
    const calls = [];
    const designs = new Map();
    async function fetch(url, init = {}) {
        const { pathname } = new URL(url);
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method, pathname, body });
        if (init.method === 'POST' && pathname === '/pins') {
            const cid = NodeCid.cidOf(Buffer.from(body.bytes, 'base64'));
            if (cid !== body.cid) return json(409, { code: 'cid-mismatch' });
            return json(200, { cid: answerCid || cid, pinnedAt: '2026-10-21T12:00:00.000Z' });
        }
        if (init.method === 'POST' && pathname === '/designs') {
            if (refuseDesigns) return json(refuseDesigns.status, refuseDesigns.body);
            designs.set(body.cid, body);
            return json(201, { cid: body.cid, content: body.content, createdAt: '2026-10-21T12:00:01.000Z' });
        }
        if (init.method === 'POST' && pathname === '/map-previews') {
            return json(202, { imageUrl: `${API}/map-previews/${body.cids.join(',')}/image.png` });
        }
        return json(404, { code: 'not-found' });
    }
    return { fetch, calls, designs };
}

function fakeWindow({ records = [], server = fakeServer(), blocked = null, configs = {}, proposalStorage = null } = {}) {
    const stored = new Map(records.map(record => [record.proposalId, record]));
    const imports = [];
    let saves = 0;
    const win = {
        fetch: server.fetch,
        btoa: text => Buffer.from(text, 'binary').toString('base64'),
        resolveBackendBaseUrl: () => API,
        resolveFrontendBaseUrl: () => 'https://app.example.test',
        ProposalPublishTerms: PublishTerms,
        guestPolicyBlocks: action => (action === 'publish' ? blocked : null),
        stampCurrentAuthor: record => { record.author = record.author || 'Guest Ana'; return record; },
        isProposalCurrentlyApplied: record => record.applied === true,
        CityConfigManager: {
            getCityConfig: city => configs[city] || null,
            resolveCityId: city => city, getCurrentCityId: () => 'zagreb', getCityCodeForCityId: id => (id === 'zagreb' ? 'zg' : null)
        },
        i18n: { getLanguage: () => 'hr' },
        proposalStorage: {
            getProposal: id => stored.get(id) || null,
            getAllProposals: () => [...stored.values()],
            importProposal: (record, options) => {
                imports.push({ id: record.proposalId, options });
                const copy = JSON.parse(JSON.stringify(record));
                stored.set(copy.proposalId, copy);
                return copy;
            },
            _indexProposal: () => {},
            save: () => { saves += 1; }
        }
    };
    if (proposalStorage) win.proposalStorage = proposalStorage;
    win.ProposalManager = { runParcelMutation: async (_kind, _id, operation) =>
        operation({ _parcelMutation: { proposals: win.proposalStorage } }) };
    const live = DesignSync.browser(win);
    return { win, sync: live.api, stored, imports, server, saves: () => saves };
}

describe('publishDesign', () => {
    it('names the rejected design and maps the server-measured overflow and saved boundary', async () => {
        const record = road();
        const body = { code: 'footprint-outside-site', outsideM2: 89.9, outsideGeometry: square(15.961, 45.8), site: record.site };
        const { sync, win } = fakeWindow({ server: fakeServer({ refuseDesigns: { status: 400, body } }) });
        const overlays = [];
        const group = { addTo: vi.fn(() => group), getBounds: () => 'review-bounds', remove: vi.fn() };
        win.L = { geoJSON: (geometry, options) => { overlays.push({ geometry, options }); return geometry; }, featureGroup: () => group };
        win.map = { getPane: () => true, fitBounds: vi.fn() };
        win.isThreeModeActive = () => true;
        win.exitThreeMode = vi.fn();
        const error = await thrown(() => sync.publishDesign(record));
        expect(error).toMatchObject({ code: body.code, designId: record.proposalId, body });
        expect(error.message).toContain('New lane');
        expect(error.message).toContain('89.9 m²');
        expect(error.message).toContain('Red marks');
        expect(error.message).not.toMatch(/proposal/i);
        expect(overlays.map(item => item.geometry)).toEqual([body.site, body.outsideGeometry]);
        expect(overlays[0].options.style).toMatchObject({ dashArray: '7 5', fill: false });
        expect(overlays[1].options.style).toMatchObject({ color: '#dc2626' });
        expect(win.exitThreeMode).toHaveBeenCalledOnce();
        expect(win.map.fitBounds).toHaveBeenCalledWith('review-bounds', expect.objectContaining({ animate: false }));
        sync.clearPublicationProblem();
        expect(group.remove).toHaveBeenCalledOnce();
        expect(record.published).toBeUndefined();
    });

    it('reuses an already published parcel layout without a publication or author gate; a revision publishes like any design', async () => {
        const record = road({ goal: 'parcel-layout', parcelLayout: { plots: [] } });
        record.published = { cid: DesignRecord.cidOf(record), apiBase: API };
        const { sync, server, win } = fakeWindow({ records: [record], blocked: 'Choose a name' });
        win.stampCurrentAuthor = () => { throw new Error('must not alter published content'); };
        expect(await sync.publishDesign(record)).toEqual({ cid: record.published.cid, row: null, alreadyPublished: true });
        expect(server.calls).toEqual([]);
        record.title = 'Revised layout';
        expect(await thrown(() => sync.publishDesign(record))).toMatchObject({ code: 'name-needed' });
    });

    it('refuses oversized designs locally before pinning or indexing, retaining the draft', async () => {
        const record = { proposalId: 'large-block', goal: 'buildings', buildingProposal: { notes: 'x'.repeat(10 * 1024 * 1024) }, geometry: { buildings: [] } };
        const { sync, server } = fakeWindow();
        expect(await thrown(() => sync.publishDesign(record))).toMatchObject({ code: 'too-large' });
        expect(server.calls).toEqual([]);
        expect(record.published).toBeUndefined();
        expect(record.buildingProposal.notes.length).toBe(10 * 1024 * 1024);
    });

    it.each(['block', 'row', 'parcelBased', 'single', 'park', 'square'])('pins and imports the exact authored %s furniture', async kind => {
        const geometry = square(10, 45);
        const design = { version: 3, trees: [{ coordinate: [10.0001, 45.0001], kind: 'conifer', heightM: 12 }], paths: [[[10.0001, 45.0002], [10.0002, 45.0003]]], benches: [] };
        const structure = ['park', 'square'].includes(kind);
        const record = {
            proposalId: `furniture-${kind}`, title: 'Authored layout', goal: structure ? kind : (kind === 'single' ? 'single' : 'buildings'),
            site: geometry, createdAt: '2026-10-23T10:00:00.000Z', author: 'Test guest', city: 'example',
            ...(structure ? { structureProposal: { kind, geometry, decorationDesign: design, decorations: { trees: [] } } }
                : { buildingProposal: { typologyType: kind }, geometry: { buildings: [], groundSurface: { treatment: 'green', polygon: geometry, decorationDesign: design } } })
        };
        const { sync, server } = fakeWindow({ records: [record] });
        const result = await sync.publishDesign(record);
        const pinned = JSON.parse(Buffer.from(server.calls.find(call => call.pathname === '/pins').body.bytes, 'base64').toString('utf8'));
        expect(structure ? pinned.structureProposal.decorationDesign : pinned.geometry.groundSurface.decorationDesign).toEqual(design);
        const indexRow = server.designs.get(result.cid);
        const receiver = await fakeWindow().sync.importDesign(indexRow);
        expect(structure ? receiver.structureProposal.decorationDesign : receiver.geometry.groundSurface.decorationDesign).toEqual(design);
        expect(DesignRecord.cidOf(receiver)).toBe(result.cid);
    });

    it('pins the exact canonical bytes, indexes them and marks the record published here', async () => {
        const record = road({ author: '' });
        const { sync, server, stored, saves } = fakeWindow({ records: [record], configs: { zagreb: { parcels: { sourceId: 'zagreb-dgu' } } } });
        const result = await sync.publishDesign(record);
        // The author is stamped before the CID is taken: it is content.
        expect(record.author).toBe('Guest Ana');
        const content = DesignRecord.published(record);
        expect(result).toMatchObject({ cid: Cid.cidOfObject(content), alreadyPublished: false });
        expect(server.calls.map(call => `${call.method} ${call.pathname}`)).toEqual(['POST /pins', 'POST /designs']);
        const [pin, index] = server.calls.map(call => call.body);
        expect(pin.kind).toBe('design');
        expect(Buffer.from(pin.bytes, 'base64').toString('utf8')).toBe(new TextDecoder().decode(Cid.canonicalBytes(content)));
        expect(index).toEqual({ cid: result.cid, content, parcelSourceId: 'zagreb-dgu' });
        expect(record.published).toEqual({ cid: result.cid, publishedAt: '2026-10-21T12:00:01.000Z', apiBase: API });
        expect(stored.get('road-1').published).toEqual(record.published);
        expect(saves()).toBe(1);
        expect(sync.publishedCid(record)).toBe(result.cid);

        // Published and unchanged: nothing is sent again.
        expect(await sync.publishDesign(record)).toEqual({ cid: result.cid, row: null, alreadyPublished: true });
        expect(server.calls).toHaveLength(2);
        // Edited in place: it is another design, published under its own CID.
        record.title = 'Wider lane';
        expect(sync.publishedCid(record)).toBeNull();
        const again = await sync.publishDesign(record);
        expect(again.cid).not.toBe(result.cid);
        expect(server.calls).toHaveLength(4);
    });

    it('publishes a parcel layout on its own, and refuses a guest without a name before anything leaves the device', async () => {
        const layout = { proposalId: 'layout-1', goal: 'parcel-layout', site: square(15.96, 45.8), parcelLayout: { algorithm: 'equal', plots: [] } };
        const { sync, server } = fakeWindow({ records: [layout] });
        const published = await sync.publishDesign(layout);
        expect(published).toMatchObject({ alreadyPublished: false });
        expect(layout.published).toMatchObject({ cid: published.cid });
        expect(server.calls.map(call => call.pathname).slice(0, 2)).toEqual(['/pins', '/designs']);
        const guest = fakeWindow({ records: [road()], blocked: 'Choose a name before publishing.' });
        expect(await thrown(() => guest.sync.publishDesign(road()))).toMatchObject({ code: 'name-needed', cancelled: true, message: 'Choose a name before publishing.' });
        expect(guest.server.calls).toEqual([]);
    });

    it('refuses an answer under another CID and reports the index\'s refusal in words', async () => {
        const other = Cid.cidOfObject({ other: true });
        const mismatch = fakeWindow({ records: [road()], server: fakeServer({ answerCid: other }) });
        const record = mismatch.stored.get('road-1');
        expect(await thrown(() => mismatch.sync.publishDesign(record))).toMatchObject({ code: 'cid-mismatch', expected: DesignRecord.cidOf(record), received: other });
        expect(record.published).toBeUndefined();

        const limited = fakeWindow({ records: [road()], server: fakeServer({ refuseDesigns: { status: 429, body: { retryAfterSeconds: 90 } } }) });
        const error = await thrown(() => limited.sync.publishDesign(limited.stored.get('road-1')));
        expect(error).toMatchObject({ code: 'http-429', status: 429 });
        expect(error.message).toBe('“New lane”: Too many publications for now. Try again in about 2 min.');
        expect(limited.stored.get('road-1').published).toBeUndefined();
    });
});

describe('importDesign and the local copy of a listed design', () => {
    it('stores a parked local record that hashes to the row\'s CID, once', async () => {
        const row = rowOf(road());
        const { sync, imports, stored } = fakeWindow();
        const record = await sync.importDesign(row);
        expect(record.proposalId).toBe(`design-${row.cid}`);
        expect(stored.get(record.proposalId)).toBe(record);
        expect(imports).toEqual([{ id: record.proposalId, options: { overwrite: true, deferSave: true } }]);
        expect(DesignRecord.cidOf(record)).toBe(row.cid);
        expect(sync.publishedCid(record)).toBe(row.cid);
        expect(record.applied).toBeUndefined();
        expect(await sync.importDesign(row)).toBe(record);
        expect(await sync.importDesign(row)).toBe(record);
        expect(imports).toHaveLength(1);
        // The copy held here was checked when it came in; a row under the same CID cannot replace it.
        expect(await sync.importDesign({ ...row, content: { ...row.content, title: 'Tampered' } })).toBe(record);
        const fresh = fakeWindow();
        await expect(fresh.sync.importDesign({ ...row, content: { ...row.content, title: 'Tampered' } })).rejects.toThrow(expect.objectContaining({ code: 'cid-mismatch' }));
        expect(fresh.imports).toEqual([]);
    });

    it('finds the copy published at this API, preferring one applied on the map', () => {
        const parked = publishedRoad(API, { proposalId: 'parked' });
        const applied = { ...publishedRoad(API, { proposalId: 'applied' }), applied: true };
        const elsewhere = publishedRoad('https://other.example.test', { proposalId: 'elsewhere', title: 'Elsewhere' });
        const { win } = fakeWindow({ records: [parked, applied, elsewhere] });
        expect(win.findLocalCopyOfServerProposal({ cid: parked.published.cid })).toBe(applied);
        expect(win.isServerProposalDownloaded({ cid: parked.published.cid })).toBe(true);
        expect(win.findLocalCopyOfServerProposal({ cid: elsewhere.published.cid })).toBeNull();
        expect(win.findLocalCopyOfServerProposal({ cid: Cid.cidOfObject({ unknown: 1 }) })).toBeNull();
        expect(win.findLocalCopyOfServerProposal(null)).toBeNull();
        expect(fakeWindow({ records: [parked] }).win.findLocalCopyOfServerProposal({ cid: parked.published.cid })).toBe(parked);
    });

    it('treats an index summary as published by its own CID', () => {
        const row = rowOf(road());
        const { sync } = fakeWindow();
        expect(sync.publishedCid(DesignSync.designSummary(row))).toBe(row.cid);
        expect(sync.publishedCid({ cid: row.cid })).toBeNull();
    });

    // The store's own normaliser (proposals/data.js _normalizeProposal) once filled in what a published
    // design left out (a park's blockName: null, a building's parameters and geometry), so the copy no
    // longer hashed to its CID and read as unpublished here. Imported through the real store, an
    // absent key stays absent.
    it('imports through the real store without filling in keys the published design leaves out', async () => {
        const park = road({ proposalId: 'park-1', goal: 'park', title: 'Pocket park', roadProposal: undefined,
            structureProposal: { kind: 'park', geometry: square(15.96, 45.8) } });
        const building = road({ proposalId: 'block-1', goal: 'buildings', title: 'Block', roadProposal: undefined,
            buildingProposal: { typologyType: 'block' } });
        const { storage, restore } = realProposalStorage();
        try {
            const { sync } = fakeWindow({ proposalStorage: storage });
            for (const design of [park, building]) {
                const row = rowOf(design);
                expect(row.content).not.toHaveProperty('structureProposal.blockName');
                expect(row.content).not.toHaveProperty('buildingProposal.parameters');
                const record = await sync.importDesign(row);
                expect(storage.getProposal(record.proposalId)).toBe(record);
                expect(record.structureProposal || {}).not.toHaveProperty('blockName');
                expect(record.buildingProposal || {}).not.toHaveProperty('parameters');
                expect(record.geometry ?? null).toBeNull();
                expect(DesignRecord.cidOf(record)).toBe(row.cid);
                expect(sync.publishedCid(record)).toBe(row.cid);
            }
        } finally {
            restore();
        }
    });

    it.each(['importDesign', 'importDraft'])('%s survives a background mutation finishing during import', async method => {
        const { storage, restore } = realProposalStorage();
        const { win, sync } = fakeWindow({ proposalStorage: storage });
        const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');
        const run = operation => ParcelMutation.run({ kind: 'import-race-test' }, operation,
            { runtime: win, proposalStore: storage, agentStore: null, storage: globalThis.PersistentStorage, fabric: null });
        win.ProposalManager.runParcelMutation = (_kind, _id, operation) => run(context => operation({ _parcelMutation: context }));
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const begun = new Promise(resolve => { started = resolve; });
        const background = run(async () => { started(); await gate; return true; });
        try {
            await begun;
            const row = rowOf(road({ goal: 'park', roadProposal: undefined,
                structureProposal: { kind: 'park', geometry: square(15.96, 45.8) } }));
            const importing = sync[method](row);
            expect(storage.getAllProposals()).toHaveLength(0);
            release();
            await background;
            const imported = await importing;
            expect(storage.getProposal(imported.proposalId)).toMatchObject({ title: 'New lane', applied: false });
            expect(DesignRecord.cidOf(storage.getProposal(imported.proposalId))).toBe(row.cid);
            // Another ordinary map update must retain the committed import as well.
            await run(async () => true);
            expect(storage.getProposal(imported.proposalId)).toBeTruthy();
        } finally { release(); await background; restore(); }
    });
});

describe('links, parcel sources and refusals', () => {
    it('shares designs at /designs/<cids> in their city, in 3D, in the current language', () => {
        const a = Cid.cidOfObject({ a: 1 });
        const b = Cid.cidOfObject({ b: 1 });
        const { sync } = fakeWindow();
        expect(sync.designLink([b, a], { city: 'zagreb' })).toBe(`https://app.example.test${DesignSync.designsPath([a, b])}?city=zg&3d&lang=hr`);
    });

    it('prepares each published CID set once, independent of order, and retries failures', async () => {
        const a = Cid.cidOfObject({ preview: 'a' });
        const b = Cid.cidOfObject({ preview: 'b' });
        const { sync, server } = fakeWindow();
        const expected = `${API}/map-previews/${[a, b].sort().join(',')}/image.png`;
        const first = await sync.prepareMapPreview([b, a]);
        const second = await sync.prepareMapPreview([a, b, a]);
        expect(first).toBe(expected);
        expect(second).toBe(expected);
        expect(server.calls.filter(call => call.pathname === '/map-previews')).toHaveLength(1);

        let attempts = 0;
        const retrying = fakeServer();
        const fetch = retrying.fetch;
        retrying.fetch = async (url, init) => {
            if (new URL(url).pathname === '/map-previews' && attempts++ === 0) return json(503, { code: 'busy' });
            return fetch(url, init);
        };
        const retrySync = fakeWindow({ server: retrying }).sync;
        await expect(retrySync.prepareMapPreview([a])).rejects.toThrow();
        expect(await retrySync.prepareMapPreview([a])).toContain('/map-previews/');
        expect(attempts).toBe(2);
    });

    it('binds a design with the parcel source where its ground lies, whatever its city says', async () => {
        const FootprintParts = require('../../frontend/js/proposals/footprint-parts.js');
        const sited = road({ city: null });
        const drawn = road({ proposalId: 'road-2', city: null, site: null,
            roadProposal: { definition: { widthM: 9, polygon: square(15.97, 45.81) } } });
        const { sync, server, win } = fakeWindow({ records: [sited, drawn] });
        win.__footprintParts = FootprintParts;
        const asked = [];
        win.CityConfigManager.getDataContext = (geometry, city) => {
            asked.push({ geometry, city });
            return { parcelSourceId: geometry ? 'oss-wfs' : null };
        };
        await sync.publishDesign(sited);
        await sync.publishDesign(drawn);
        expect(server.calls.filter(call => call.pathname === '/designs').map(call => call.body.parcelSourceId)).toEqual(['oss-wfs', 'oss-wfs']);
        expect(asked[0]).toEqual({ geometry: sited.site, city: null });
        expect(asked[1].geometry).toEqual({ type: 'GeometryCollection', geometries: [square(15.97, 45.81)] });
    });

    it('binds a city\'s designs with its catalogue parcel source, else the default', () => {
        const { sync } = fakeWindow({ configs: { zagreb: { parcels: { sourceId: 'zagreb-dgu' } }, split: { parcels: {} } } });
        expect(sync.parcelSourceIdOf('zagreb')).toBe('zagreb-dgu');
        expect(sync.parcelSourceIdOf('split')).toBeNull();
        expect(sync.parcelSourceIdOf('nowhere')).toBeNull();
    });

    it('words each refusal by the server\'s code', () => {
        const { sync, win } = fakeWindow();
        expect(sync.refusalMessage(409, { code: 'cid-mismatch' })).toMatch(/different identity/);
        expect(sync.refusalMessage(503, { code: 'pinning-unconfigured' })).toMatch(/pinning is not configured/);
        expect(sync.refusalMessage(413, { code: 'too-large' })).toMatch(/10 MiB/);
        expect(sync.refusalMessage(429, {})).toBe('Too many publications for now. Wait a few minutes and try again.');
        expect(sync.refusalMessage(429, { retryAfterSeconds: 30 })).toBe('Too many publications for now. Try again in about 1 min.');
        expect(sync.refusalMessage(400, { error: 'site is not a polygon' })).toBe('The server refused this design: site is not a polygon');
        expect(sync.refusalMessage(502, null)).toBe('The server refused this design: HTTP 502');
        const described = [];
        win.ParcelSourceHealth = { describeFailure: problem => { described.push(problem); return `source down: ${problem.code}`; } };
        expect(sync.refusalMessage(503, { code: 'parcel-source-unavailable', error: 'DGU is down' })).toBe('source down: parcel-source-unavailable');
        expect(described[0]).toMatchObject({ status: 503, message: 'DGU is down' });
    });
});
