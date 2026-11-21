// Fetch private referenced artifacts with the same import/apply flow as shared designs. Nothing is
// published, and no wallet method is called. Imported records are local drafts the person can edit.
(function (root) {
    'use strict';
    if (!root) return;
    // The shared-designs load overlay (proposals/core.js), when the page has it.
    const overlay = name => (typeof root[name] === 'function' ? root[name] : () => {});
    // Called by the /designs?draft= route (proposals/core.js) only.
    async function open() {
        const t = typeof root.getProposalI18nHelper === 'function' ? root.getProposalI18nHelper() : (_key, fallback) => fallback;
        overlay('showProposalLoadOverlay')(t('proposals.share.route.fetching', 'Fetching the shared designs…'),
            { title: t('proposals.share.route.title', 'Shared designs') });
        const progress = ({ done, total }) => overlay('updateProposalLoadOverlay')({ progress: { done, total } });
        let draft;
        try {
            draft = await fetchAndBind(progress);
        } catch (error) {
            overlay('hideProposalLoadOverlay')();
            throw error;
        }
        if (!draft) { overlay('hideProposalLoadOverlay')(); return; }
        return applyDraft(draft);
    }
    // Fetches the draft's objects, checks them and binds each design to its ground. Nothing is stored.
    async function fetchAndBind(progress) {
        const artifact = await root.DraftLink.load(root.location.href, { onProgress: progress });
        if (!artifact) return null;
        if (artifact.plan) {
            const error = root.PlanRecord.validate(artifact.plan);
            if (error) throw new Error(error);
        }
        if (artifact.agreement && (!artifact.plan || artifact.agreement.planCid !== root.Cid.cidOfObject(artifact.plan)
            || Object.hasOwn(artifact.agreement, 'designs'))) throw new Error('Draft agreement must reference its exact plan.');
        const collection = artifact.agreement || artifact.plan;
        const designs = collection ? artifact.designs : [artifact.design];
        if (!Array.isArray(designs) || !designs.length) throw new Error('Draft preview needs designs');
        if (collection) {
            const carried = designs.map(content => root.Cid.cidOfObject(content));
            const linked = artifact.plan.designCids;
            if (!Array.isArray(linked) || new Set(carried).size !== carried.length || new Set(linked).size !== linked.length
                || carried.length !== linked.length || linked.some(cid => !carried.includes(cid))) throw new Error('Draft preview designs must exactly match the collection’s linked CIDs.');
            // Replay order belongs to the collection, not its transport envelope.
            const byCid = new Map(designs.map(content => [root.Cid.cidOfObject(content), content]));
            designs.splice(0, designs.length, ...linked.map(cid => byCid.get(cid)));
        }
        for (const content of designs) {
            const checked = root.DesignRecord.validate(content);
            if (!checked.valid) throw new Error(checked.errors[0].message);
        }
        const apiBase = root.DesignSync.apiBase();
        progress({ done: 0, total: designs.length });
        const bound = await root.DraftLink.mapLimit(designs, root.DraftLink.CONCURRENCY, async content => {
            const cid = root.Cid.cidOfObject(content);
            const parcelSourceId = artifact.designSources?.[cid] || artifact.parcelSourceId || root.DesignSync.parcelSourceIdOf(content.city);
            const response = await root.fetch(`${apiBase}/designs/binding`, { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: root.__siteBinding.siteOf(content, { turf: root.turf }), city: content.city,
                    toleranceM: content.toleranceM, parcelSourceId }) });
            const binding = await response.json();
            if (!response.ok) throw new Error(binding.error || binding.code || 'Draft ground is unavailable');
            return { cid, content, city: content.city, parcelSourceId, binding: binding.binding };
        }, (done, total) => progress({ done, total }));
        return { artifact, collection, rows: new Map(bound.map(row => [row.cid, row])) };
    }
    // Applies the bound designs as shared designs are applied, then opens the plan or agreement.
    async function applyDraft({ artifact, collection, rows }) {
        const apiBase = root.DesignSync.apiBase();
        const applied = await root.handleSharedDesignRoute([...rows.keys()], { draftRows: rows, enter3D: true, openDetails: !collection });
        if (applied.blocked || applied.omitted?.length) return applied;
        if (applied.failed.length) throw new Error('Some draft designs could not be applied; review the map.');
        // A scheduled plan opens its build-out time control, at ?when= when the link names a month.
        if (artifact.plan && !artifact.agreement) root.BuildoutClock?.arrive({ cid: root.Cid.cidOfObject(artifact.plan), content: artifact.plan });
        if (artifact.agreement) {
            const content = artifact.agreement, cid = root.Cid.cidOfObject(content);
            const records = [...applied.localIds.values()].map(id => root.proposalStorage.getProposal(id));
            const ids = root.AgreementDialog.inputParcelIds(records, root.LiveParcelFabric);
            const originals = await root.CadastralParcelRepository.ensureIds(ids, { retainOnly: true });
            const derived = root.AgreementGround.derive({ designs: records, fabric: root.LiveParcelFabric,
                originals: root.AgreementDialog.originalsById(originals.features, root.LiveParcelFabric.featureId),
                ownerOf: () => [] });
            const record = root.AgreementSync.recordFromPublished({ cid, content, plan: { cid: content.planCid, content: artifact.plan } }, { id: `draft-${cid}`, apiBase,
                localIdOf: designCid => applied.localIds.get(designCid), designOf: id => root.proposalStorage.getProposal(id), derived });
            delete record.published;
            if (derived.outputs.length !== content.outputs.length || derived.outputs.some(o => !content.outputs.some(expected => expected.hash === o.hash))) throw new Error('Draft agreement ground differs here. Review the designs before creating the agreement.');
            const checked = root.AgreementRecord.validate(record);
            if (!checked.valid) throw new Error(checked.errors[0].message);
            root.AgreementStore.save(record);
            await root.AgreementPanel.open(record.id);
        }
        return applied;
    }
    root.DraftPreview = { open };
})(typeof window !== 'undefined' ? window : null);
