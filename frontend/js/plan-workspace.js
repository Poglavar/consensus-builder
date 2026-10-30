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
        if (Array.isArray(plan.designs) && !plan.published) save({ ...plan, published: true });
        return {...row,link:win.NamedPlans.link(row.cid)};
    }
    async function resolve(plan, members = []) {
        const cached = win.PersistentStorage.getItem(key(plan.cid));
        const row = cached ? JSON.parse(cached) : plan;
        if (Array.isArray(row.designs)) {
            win.PlanComposition.validate(row);
            return plan.published && !row.published ? save({ ...row, published: true }) : row;
        }
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
        return save({ ...snapshot, ...(plan.published ? { published: true } : {}) });
    }
    async function publish(plan) {
        const row = await resolve(plan);
        const existing=await publication(row);
        if(existing)return existing;
        const known = await win.DesignSync.fetchDesigns(row.content.designCids);
        // Check every dependency before publishing any. The same policy applies to single-design
        // publication.
        const records = win.PlanComposition.localRecords(row, { apiBase: backend() });
        const missing = new Set(known.missing);
        for (const record of records) if (missing.has(win.DesignRecord.cidOf(record))) {
            const refusal = win.ProposalPublishTerms.publishRefusal(record);
            if (refusal) throw new Error(refusal.message);
        }
        const blocked = win.guestPolicyBlocks('publish');
        if (blocked) throw new Error(blocked);
        for (const member of row.designs) if (missing.has(member.cid)) {
            // Refuses a design over the publication limit before anything is sent.
            win.DesignSync.addressObject(member.content);
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
    // The plan's members as applied local designs, or null while it is only previewed here.
    function appliedMembers(plan) {
        return win.PlanComposition.appliedMembers(plan.content.designCids, win.proposalStorage.getAllProposals(),
            { cidOf: record => win.DesignRecord.cidOf(record), isApplied: record => win.isApplied(record) });
    }
    // Applies the plan's exact revisions. A published plan's come from the design index; a private
    // one's from the revisions it carries, which the index does not hold. Returns { blocked: true }
    // when the visitor declined a conflict with designs already applied; throws when a member fails.
    async function apply(plan) {
        const draftRows = new Map();
        for (const member of plan.published ? [] : plan.designs || []) {
            const content = member.content;
            const parcelSourceId = win.DesignSync.parcelSourceIdOf(content.city, content.site);
            const response = await win.fetch(backend() + '/designs/binding', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    city: content.city, site: win.__siteBinding.siteOf(content, { turf: win.turf }),
                    toleranceM: content.toleranceM, parcelSourceId })
            });
            const answer = await response.json();
            if (!response.ok) throw new Error(answer.error || win.i18n.t('planDialog.applyFailed'));
            draftRows.set(member.cid, { cid: member.cid, content, city: content.city, parcelSourceId, binding: answer.binding });
        }
        const result = await win.handleSharedDesignRoute(plan.content.designCids, {
            ...(draftRows.size ? { draftRows } : {}), openDetails: false, enter3D: false, summary: false });
        if (result.blocked) return { blocked: true };
        if (result.failed.length || result.omitted?.length || !appliedMembers(plan)) {
            throw new Error(result.failed.map(item => [item.label, item.reason].filter(Boolean).join(': ')).join('; ') || win.i18n.t('planDialog.applyFailed'));
        }
        return { blocked: false };
    }
    // Applies stored designs in turn exactly as an Apply click on the map does (ProposalManager.
    // applyProposal: a design stands down the rivals on its ground), in formation order (the order
    // the designs were made in, plan-order.js), inside one parcel mutation that is rolled back:
    // nothing on the map or in storage changes. { standing, fallen } are their ids; a fallen design
    // is one a later one took the ground of, or one the apply refused.
    async function trial(ids) {
        const records = ids.map(id => win.proposalStorage.getProposal(id)).filter(Boolean);
        await win.CadastralParcelRepository.ensureIds(records.flatMap(record => win.__claims.cadastreParcelIdsOf(record)));
        let outcome = null;
        await win.ProposalManager.runParcelMutation('plan-trial', null, async transaction => {
            const store = transaction._parcelMutation.proposals;
            const failures = [];
            for (const record of win.__planOrder.orderFormations(records)) {
                const id = String(record.proposalId);
                if (await win.ProposalManager.applyProposal(id, { ...transaction, silent: true })) continue;
                failures.push({ proposalId: id, reason: win.getStoredApplyFailureInfo?.(id)?.message || null });
            }
            const stands = id => win.isApplied(store.getProposal(id));
            outcome = { standing: ids.filter(stands), fallen: ids.filter(id => !stands(id)), failures };
            return false;
        });
        return outcome;
    }
    // A copied address opens a plan as a preview, unapplied. An action that reads the plan's land
    // (an agreement, the rooster) asks once, applies it and goes on; false when the visitor declines.
    async function ensureApplied(plan) {
        if (appliedMembers(plan)) return true;
        const title = plan.content.title;
        const confirmed = await win.CbDialog.confirm(win.i18n.t('planDialog.applyQuestion', { title }), {
            title: win.i18n.t('planDialog.applyTitle', { title }), okText: win.i18n.t('planDialog.applyAndContinue') });
        return confirmed && !(await apply(plan)).blocked;
    }
    win.PlanWorkspace = Object.freeze({ save, list, resolve, publish, publication, appliedMembers, apply, ensureApplied, trial });
})(window);
