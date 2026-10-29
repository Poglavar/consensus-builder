// Pure composition of local designs into a private, immutable named-plan snapshot.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanComposition = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const dependency = (globalName, path) => root[globalName] || (typeof require === 'function' ? require(path) : null);
    const deepCopy = value => JSON.parse(JSON.stringify(value));
    const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    function validate(row) {
        const PlanRecord = dependency('PlanRecord', './plan-record.js');
        const Cid = dependency('Cid', './cid.js');
        const DesignRecord = dependency('DesignRecord', './design-record.js');
        const bad = (message, code='invalid-plan') => Object.assign(new Error(message), { code });
        if (!row || typeof row !== 'object' || !Cid.isCid(row.cid) || !row.content || !Array.isArray(row.designs) || !Array.isArray(row.memberIds)) throw bad('Invalid plan snapshot.');
        const planError = PlanRecord.validate(row.content);
        if (planError) throw bad(planError);
        if (Cid.cidOfObject(row.content) !== row.cid) throw bad('Plan content does not match its CID.', 'cid-mismatch');
        if (row.designs.length !== row.content.designCids.length || row.memberIds.length !== row.designs.length) throw bad('Plan members do not match the plan content.');
        if (row.designSources && (typeof row.designSources !== 'object' || Array.isArray(row.designSources)
            || Object.entries(row.designSources).some(([cid, source]) => !row.content.designCids.includes(cid)
                || !source || typeof source.sourceId !== 'string' || !source.sourceId || source.sourceId.length > 200
                || (source.snapshotId != null && (typeof source.snapshotId !== 'string' || source.snapshotId.length > 200))))) throw bad('Invalid plan member source.');
        const ids = new Set();
        row.designs.forEach((design, i) => {
            if (!design || !Cid.isCid(design.cid) || design.cid !== row.content.designCids[i] || !design.content) throw bad('Invalid carried design member.');
            if (!DesignRecord.validate(design.content).valid || Cid.cidOfObject(design.content) !== design.cid) throw bad('Carried design content does not match its CID.', 'cid-mismatch');
            if (typeof row.memberIds[i] !== 'string' || !row.memberIds[i] || ids.has(row.memberIds[i])) throw bad('Invalid or duplicate source member identity.');
            ids.add(row.memberIds[i]);
        });
        return true;
    }
    // schedule: { [designCid]: { start, end } } (plan-record.js); windows of non-members are dropped.
    function create(title, records, view, schedule = null) {
        const PlanRecord = dependency('PlanRecord', './plan-record.js');
        const DesignRecord = dependency('DesignRecord', './design-record.js');
        const Cid = dependency('Cid', './cid.js');
        if (!Array.isArray(records) || !records.length) throw new Error('Choose at least one design.');
        const byCid = new Map();
        records.forEach(record => {
            const content = DesignRecord.published(record);
            const checked = DesignRecord.validate(content);
            if (!checked.valid) throw Object.assign(new Error(checked.errors[0].message), { code: 'invalid-design' });
            const cid = Cid.cidOfObject(content);
            const source = record.planFileSource || record.binding?.parcelSource;
            if (!byCid.has(cid)) byCid.set(cid, { cid, content: deepCopy(content), memberId: String(record.proposalId || record.id || ''),
                ...(source?.sourceId ? { source: { sourceId: source.sourceId, snapshotId: source.snapshotId ?? null } } : {}) });
        });
        if ([...byCid.values()].some(member => !member.memberId)) throw new Error('Every selected design needs a local proposal identity.');
        const designs = [...byCid.values()].sort((a,b)=>a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0);
        const content = PlanRecord.create(title, designs.map(d=>d.cid), view, schedule);
        const row = { cid: Cid.cidOfObject(content), content: deepCopy(content), designs: designs.map(({cid,content})=>({cid,content})),
            memberIds: designs.map(d=>d.memberId), designSources: Object.fromEntries(designs.filter(d=>d.source).map(d=>[d.cid,d.source])) };
        validate(row);
        return freeze(row);
    }
    // The same members and view with another construction schedule: a new immutable revision.
    function withSchedule(row, schedule) {
        validate(row);
        const PlanRecord = dependency('PlanRecord', './plan-record.js');
        const Cid = dependency('Cid', './cid.js');
        const content = PlanRecord.create(row.content.title, row.content.designCids, row.content.view, schedule);
        const next = { ...deepCopy(row), cid: Cid.cidOfObject(content), content: deepCopy(content) };
        delete next.published;
        validate(next);
        return freeze(next);
    }
    function localRecords(row, { apiBase } = {}) {
        validate(row);
        const DesignSync = dependency('DesignSync', './proposals/design-sync.js');
        return row.designs.map(member => ({ ...DesignSync.localDesignFromRow(member, { apiBase, proposalId: `plan-member-${member.cid}` }),
            ...(row.designSources?.[member.cid] ? { planFileSource: deepCopy(row.designSources[member.cid]) } : {}) }));
    }
    return Object.freeze({ create, validate, withSchedule, localRecords });
});
