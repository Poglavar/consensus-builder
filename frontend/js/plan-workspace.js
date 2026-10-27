// Local immutable plan snapshots and publication of their exact member revisions.
(function (win) {
    'use strict';
    const key = cid => `plan:${cid}`;
    const backend = () => win.DesignSync.apiBase();
    const copy = value => structuredClone(value);
    function save(row) {
        win.PlanComposition.validate(row);
        win.PersistentStorage.setItem(key(row.cid), JSON.stringify(row));
        win.dispatchEvent(new CustomEvent('planschange'));
        return row;
    }
    function list() { return win.NamedPlans.list(); }
    async function publication(plan) {
        const response = await win.fetch(backend() + '/plans/' + plan.cid, { cache:'no-store', signal:AbortSignal.timeout(30000) });
        if(response.status===404)return null;
        const row=await response.json();
        if(!response.ok)throw new Error(row.error||win.i18n.t('planDialog.publicationFailed'));
        if(win.PlanRecord.validate(row.content)||row.cid!==plan.cid||win.Cid.cidOfObject(row.content)!==plan.cid)throw new Error(win.i18n.t('planDialog.revisionChanged'));
        return {...row,link:win.NamedPlans.link(row.cid)};
    }
    async function resolve(plan, members = []) {
        const cached = win.PersistentStorage.getItem(key(plan.cid));
        const row = cached ? JSON.parse(cached) : plan;
        if (Array.isArray(row.designs)) { win.PlanComposition.validate(row); return row; }
        const available = new Map();
        for (const record of [...win.proposalStorage.getAllProposals(), ...members]) {
            try { available.set(win.DesignRecord.cidOf(record), record); }
            catch (_) { /* Unrelated incomplete drafts are not members of this exact snapshot. */ }
        }
        const missing = plan.content.designCids.filter(cid => !available.has(cid));
        if (missing.length) {
            const fetched = await win.DesignSync.fetchDesigns(missing);
            if (fetched.missing.length) throw new Error(win.i18n.t('planDialog.membersMissing'));
            for (const [cid, source] of fetched.rows) available.set(cid,
                win.DesignSync.localDesignFromRow(source, { apiBase: backend() }));
        }
        const snapshot = win.PlanComposition.create(plan.content.title,
            plan.content.designCids.map(cid => ({ ...available.get(cid),
                ...(plan.designSources?.[cid] ? { planFileSource: plan.designSources[cid] } : {}) })), plan.content.view);
        if (snapshot.cid !== plan.cid) throw new Error(win.i18n.t('planDialog.revisionChanged'));
        return save(snapshot);
    }
    async function publish(plan) {
        const row = await resolve(plan);
        const existing=await publication(row);
        if(existing)return existing;
        const known = await win.DesignSync.fetchDesigns(row.content.designCids);
        // Check every dependency before publishing any. The same policy applies to single-design
        // publication; parcel layouts travel with the agreement which settles their ground.
        const records = win.PlanComposition.localRecords(row, { apiBase: backend() });
        const missing = new Set(known.missing);
        for (const record of records) if (missing.has(win.DesignRecord.cidOf(record))) {
            const refusal = win.ProposalPublishTerms.publishRefusal(record);
            if (refusal) throw new Error(refusal.message);
        }
        const blocked = win.guestPolicyBlocks('publish');
        if (blocked) throw new Error(blocked);
        for (const member of row.designs) if (missing.has(member.cid)) {
            await win.DesignSync.pinObject('design', member.content);
            const source = row.designSources?.[member.cid]?.sourceId;
            const response = await win.fetch(backend() + '/designs', { method:'POST', signal:AbortSignal.timeout(120000), headers:{'Content-Type':'application/json'},
                body:JSON.stringify({ cid:member.cid, content:member.content,
                    parcelSourceId:source === 'hr-cadastre' ? 'oss-wfs' : source || win.DesignSync.parcelSourceIdOf(member.content.city, member.content.site) }) });
            const answer = await response.json();
            if ((!response.ok && response.status !== 409) || answer.cid !== member.cid) throw new Error(answer.error || win.i18n.t('planDialog.publicationFailed'));
        }
        const published = await win.NamedPlans.save(row.content);
        // NamedPlans records public metadata; retain the exact carried revisions for local reuse.
        save({ ...copy(row), published:true });
        return published;
    }
    win.PlanWorkspace = Object.freeze({ save, list, resolve, publish, publication });
})(window);
