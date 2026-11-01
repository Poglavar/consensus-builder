// Pure adapters that shape map state, plan revisions and selection for chat requests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__chatContext = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const safeCid = (record, cidOf) => { try { return String(cidOf(record)); } catch (_) { return null; } };
    function appliedMembers(records, { cidOf, isApplied }) {
        const list = Array.isArray(records) ? records : [];
        const byCid = new Map();
        list.forEach(record => {
            const cid = safeCid(record, cidOf);
            if (cid && isApplied(record) && !byCid.has(cid)) byCid.set(cid, record);
        });
        return [...byCid.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, record]) => record);
    }
    function currentPlanRow({ records, lastSynced, view, title, cidOf, isApplied, compose }) {
        const members = appliedMembers(records, { cidOf, isApplied });
        if (!members.length) return null;
        const wanted = members.map(record => safeCid(record, cidOf)).sort();
        const previous = (lastSynced?.content?.designCids || []).map(String).sort();
        if (lastSynced && wanted.length === previous.length && wanted.every((cid, i) => cid === previous[i])) return lastSynced;
        return compose(lastSynced?.content?.title ?? title, members,
            lastSynced?.content?.view ?? view, lastSynced?.content?.schedule ?? null);
    }
    function planPayload({ row, lastSynced, artifactOf }) {
        if (!row?.cid) return { planCid: null };
        if (lastSynced && row.cid === lastSynced.cid) return { planCid: lastSynced.cid };
        const artifact = artifactOf(row);
        return { planCid: row.cid, planArtifact: { ...artifact, cid: row.cid } };
    }
    function selectionOf({ selected, cidOf, stack, stackModel, selectedParcels, selectedBuildingIndex }) {
        const ids = [...(selectedParcels || [])].map(String);
        let record = selected || null;
        if (!record && stack && stackModel?.selectedInstance) {
            const instance = stackModel.selectedInstance(stack, stack.selectedKind);
            record = instance?.record || instance?.localRecord || instance || null;
        }
        let selectedCid = record ? safeCid(record, cidOf) : null;
        const rawBuildingIndex = selectedBuildingIndex ?? record?.selectedBuildingIndex ?? record?.buildingIndex
            ?? record?.properties?.buildingIndex;
        const parsedBuildingIndex = rawBuildingIndex == null || rawBuildingIndex === '' ? null : Number(rawBuildingIndex);
        const buildingIndex = Number.isInteger(parsedBuildingIndex) && parsedBuildingIndex >= 0 ? parsedBuildingIndex : null;
        return { ...(selectedCid ? { designCid: selectedCid } : {}), ...(buildingIndex != null ? { buildingIndex } : {}), parcelIds: ids };
    }
    function buildContext({ city, parcelSourceId, view, records, lastSynced, selected, selectedBuildingIndex, title = 'Working plan', cidOf, isApplied,
        compose, artifactOf, stack, stackModel, selectedParcels }) {
        const row = currentPlanRow({ records, lastSynced, view, title, cidOf, isApplied, compose });
        return { city, parcelSourceId, view, selection: selectionOf({ selected, selectedBuildingIndex, cidOf, stack, stackModel, selectedParcels }),
            ...planPayload({ row, lastSynced, artifactOf }) };
    }
    function artifactFromDraft(loaded, { cidOf, cid = null }) {
        const plan = loaded?.plan;
        if (!plan || !Array.isArray(loaded.designs)) throw Object.assign(new Error('The plan draft is incomplete.'), { code: 'invalid-plan' });
        const designs = loaded.designs.map(record => {
            const content = record.content || record;
            const cid = record.cid || safeCid(content, cidOf);
            if (!cid) throw Object.assign(new Error('A plan design has no CID.'), { code: 'invalid-plan' });
            const declared = record.parcelSourceId || loaded.designSources?.[cid] || loaded.parcelSourceId;
            const parcelSourceId = typeof declared === 'string' ? declared : declared?.sourceId;
            return { cid, content, ...(parcelSourceId ? { parcelSourceId } : {}) };
        });
        return { plan, designs, ...(cid ? { cid } : {}), ...(loaded.parcelSourceId ? { parcelSourceId: loaded.parcelSourceId } : {}) };
    }
    function nextRowFromDraft(artifact, previous, { rowOf }) {
        const memberIds = {};
        (artifact.plan.designCids || []).forEach((cid, index) => {
            const idx = previous?.designs?.findIndex(member => member.cid === cid) ?? -1;
            if (idx >= 0 && previous.memberIds?.[idx]) memberIds[cid] = previous.memberIds[idx];
            else memberIds[cid] = `chat-${cid}`;
        });
        const row = rowOf(artifact, memberIds);
        if (artifact.cid && artifact.cid !== row.cid) throw Object.assign(new Error('The private plan reference does not match its content.'), { code: 'plan-cid-mismatch' });
        return row;
    }
    function lastChangeOf(previous, next, changes, kind = 'edit') {
        const fromCid = previous?.cid || null, toCid = next?.cid || null;
        const members = (changes || []).map(change => ({ beforeCid: change.beforeCid ?? change.fromCid ?? null,
            afterCid: change.afterCid ?? change.toCid ?? null })).filter(change => change.beforeCid || change.afterCid);
        if (!members.length) {
            const before = new Set(previous?.content?.designCids || []), after = new Set(next?.content?.designCids || []);
            [...new Set([...before, ...after])].forEach(cid => {
                if (before.has(cid) !== after.has(cid)) members.push({ beforeCid: before.has(cid) ? cid : null, afterCid: after.has(cid) ? cid : null });
            });
        }
        return { fromCid, toCid, members, kind };
    }
    function parseRef(ref) {
        if (typeof ref !== 'string') return null;
        const match = ref.match(/^(?:design:([a-z2-7]{20,})|building:([a-z2-7]{20,}):(\d+))$/i);
        if (match) return match[1]
            ? { designCid: match[1] }
            : { designCid: match[2], buildingIndex: Number(match[3]) };
        return null;
    }
    return { appliedMembers, currentPlanRow, planPayload, selectionOf, buildContext, artifactFromDraft,
        nextRowFromDraft, lastChangeOf, parseRef };
});
