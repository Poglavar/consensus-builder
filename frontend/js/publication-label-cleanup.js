// One-off, explicit cleanup of concept labels. Publications are recreated under their real CIDs;
// authored geometry and local record identities stay intact. No display aliases or legacy readers.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PublicationLabelCleanup = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const cidApi = () => root.Cid || require('./cid.js');
    const labelKeys = new Set(['title', 'name', 'description', 'author', 'label', 'blockName', 'proposalName', 'buildingName']);
    const hasConcept = value => typeof value === 'string' && /\bconcept\b/i.test(value);

    function cleanText(value) {
        if (!hasConcept(value)) return value;
        return value.replace(/\bconcept\s+only\b\s*[:;.!–—-]?\s*/gi, '')
            .replace(/\bconcept\b/gi, '')
            .replace(/\(\s*\)|\[\s*\]/g, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\s+([,.;!?])/g, '$1')
            .replace(/^\s*[:;,.|–—-]\s*|\s*[:;|–—-]\s*$/g, '').trim();
    }

    function cleanLabels(value) {
        if (Array.isArray(value)) return value.map(cleanLabels);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            const cleaned = labelKeys.has(key) && hasConcept(item) ? cleanText(item) : cleanLabels(item);
            return [key, cleaned === '' && ['author', 'description'].includes(key) ? null : cleaned];
        }));
    }

    function remap(value, mapping, { local = false } = {}, key = '') {
        if (typeof value === 'string') return local && ['id', 'proposalId'].includes(key) ? value : mapping.get(value) || value;
        if (Array.isArray(value)) return value.map(item => remap(item, mapping, { local }, key));
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, remap(item, mapping, { local }, name)]));
    }

    function buildRevisions(snapshot) {
        const cid = cidApi().cidOfObject;
        for (const row of [...snapshot.designs, ...snapshot.plans, ...snapshot.agreements]) {
            if (cid(row.content) !== row.cid) throw new Error(`Invalid source content identifier: ${row.cid}`);
        }
        const mapping = new Map(), contentByCid = new Map();
        // Origin references follow renamed revisions as well. A valid content-addressed ancestry
        // cannot contain a self-referential cycle; a fixed point must be reached within this bound.
        let settled = false;
        for (let pass = 0; pass <= snapshot.designs.length; pass++) {
            let changed = false;
            for (const row of snapshot.designs) {
                const content = remap(cleanLabels(row.content), mapping);
                const next = cid(content);
                contentByCid.set(row.cid, content);
                if (next !== row.cid && mapping.get(row.cid) !== next) { mapping.set(row.cid, next); changed = true; }
            }
            if (!changed) { settled = true; break; }
        }
        if (!settled) throw new Error('Design references did not settle.');
        const designs = snapshot.designs.filter(row => mapping.has(row.cid)).map(row => ({
            kind: 'design', from: row.cid, to: mapping.get(row.cid), content: contentByCid.get(row.cid)
        }));
        const plans = [];
        for (const row of snapshot.plans) {
            const content = remap(cleanLabels(row.content), mapping);
            content.designCids = [...new Set(content.designCids)].sort();
            const to = cid(content);
            if (to !== row.cid) { mapping.set(row.cid, to); plans.push({ kind: 'plan', from: row.cid, to, content }); }
        }
        const agreements = [];
        for (const row of snapshot.agreements) {
            if (row.onchain) throw new Error('A minted agreement cannot be relabeled.');
            // Output producedBy links name design revisions too; allocation hashes and terms stay
            // unchanged because this operation changes no output geometry or economic content.
            const content = remap(row.content, mapping);
            const to = cid(content);
            if (to !== row.cid) { mapping.set(row.cid, to); agreements.push({ kind: 'agreement', from: row.cid, to, content }); }
        }
        if (Object.values(snapshot.references || {}).some(Boolean)) throw new Error('Dependent decisions or market state prevent replacement.');
        return { designs, plans, agreements, mappings: Object.fromEntries(mapping) };
    }

    // Current proposal:/agreement: rows only. In particular, abandoned whole-store blobs are not
    // read, migrated or deleted. Browser-only edits are hashed too, rather than marked published.
    function workspaceChanges(rows, mappings, { DesignRecord, AgreementRecord } = {}) {
        const mapping = new Map(Object.entries(mappings)), drafts = new Map();
        const parsed = rows.filter(row => /^(proposal|agreement):/.test(row.key)).map(row => ({ ...row, record: JSON.parse(row.value) }));
        const designRows = parsed.filter(row => row.key.startsWith('proposal:'));
        let settled = false;
        for (let pass = 0; pass <= designRows.length; pass++) {
            let changed = false;
            for (const row of designRows) {
                const record = remap(cleanLabels(row.record), mapping, { local: true });
                const before = DesignRecord.cidOf(row.record), after = DesignRecord.cidOf(record);
                if (before !== after && mapping.get(before) !== after) { mapping.set(before, after); changed = true; }
                if (record.published && record.published.cid !== after) delete record.published;
                drafts.set(row.key, record);
            }
            if (!changed) { settled = true; break; }
        }
        if (!settled) throw new Error('Local design references did not settle.');
        const changes = [];
        for (const row of parsed) {
            let record = drafts.get(row.key);
            if (row.key.startsWith('agreement:')) {
                record = remap(row.record, mapping, { local: true });
                if (record.plan) {
                    record.plan.content = cleanLabels(record.plan.content);
                    record.plan.content.designCids = [...new Set(record.plan.content.designCids)].sort();
                    const next = cidApi().cidOfObject(record.plan.content);
                    mapping.set(row.record.plan.cid, next); record.plan.cid = next;
                }
                record.designs = cleanLabels(record.designs);
                if (record.published && AgreementRecord.publishedCid(record) !== record.published.cid) delete record.published;
            }
            const value = JSON.stringify(record);
            if (row.record.onchain && value !== row.value) throw new Error('A minted local agreement cannot be relabeled.');
            if (value !== row.value) changes.push({ key: row.key, value });
        }
        return changes;
    }

    return Object.freeze({ cleanText, cleanLabels, remap, buildRevisions, workspaceChanges });
});
