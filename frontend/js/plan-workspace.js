// Local immutable plan snapshots and publication of their exact member revisions.
(function (win) {
    'use strict';
    const key = cid => `plan:${cid}`;
    const backend = () => win.DesignSync.apiBase();
    const copy = value => structuredClone(value);
    // Cache proof of the exact stored bytes. Each caller still receives its own plan object.
    const verified = new Map();
    function rememberVerified(cid, serialized) {
        verified.set(cid, serialized);
        if (verified.size > 8) verified.delete(verified.keys().next().value);
    }
    function save(row) {
        win.PlanComposition.validate(row);
        const previous = win.PersistentStorage.getItem(key(row.cid));
        const createdAt = previous ? JSON.parse(previous).createdAt : (row.published ? row.createdAt : new Date().toISOString());
        const saved = { ...row, createdAt };
        const serialized = JSON.stringify(saved);
        win.PersistentStorage.setItem(key(row.cid), serialized);
        rememberVerified(row.cid, serialized);
        win.dispatchEvent(new CustomEvent('planschange'));
        return saved;
    }
    function list() { return win.NamedPlans.list(); }
    async function publication(plan) {
        const response = await win.fetch(backend() + '/plans/' + plan.cid, { cache:'no-store', signal:AbortSignal.timeout(30000) });
        if(response.status===404)return null;
        const row=await response.json();
        if(!response.ok)throw new Error(win.i18n.t('planDialog.lookupFailed',{reason:row.error||`HTTP ${response.status}`}));
        const invalid=win.PlanRecord.validate(row.content);
        if(invalid)throw new Error(win.i18n.t('planDialog.planInvalid',{reason:invalid}));
        if(row.cid!==plan.cid||win.Cid.cidOfObject(row.content)!==plan.cid)throw new Error(win.i18n.t('planDialog.revisionChanged'));
        if (Array.isArray(plan.designs)) save({ ...plan, published: true, publishedAt: row.publishedAt });
        return {...row,link:win.NamedPlans.link(row.cid)};
    }
    async function resolve(plan, members = []) {
        const cached = win.PersistentStorage.getItem(key(plan.cid));
        const row = cached ? JSON.parse(cached) : plan;
        if (Array.isArray(row.designs)) {
            if (!cached || verified.get(plan.cid) !== cached) {
                win.PlanComposition.validate(row);
                if (cached) rememberVerified(plan.cid, cached);
            }
            return plan.published && (!row.published || (!row.publishedAt && plan.publishedAt))
                ? save({ ...row, published: true, publishedAt: row.publishedAt || plan.publishedAt }) : row;
        }
        const available = new Map(win.DesignSync.localDesignIndex().byCid);
        for (const record of members) {
            try { available.set(win.DesignRecord.cidOf(record), record); }
            catch (_) { /* Unrelated incomplete drafts are not members of this exact snapshot. */ }
        }
        const missing = plan.content.designCids.filter(cid => !available.has(cid));
        if (missing.length) {
            const fetched = await win.DesignSync.fetchDesigns(missing);
            if (fetched.missing.length) throw new Error(win.i18n.t('planDialog.membersMissing', { count: fetched.missing.length, total: plan.content.designCids.length }));
            for (const [cid, source] of fetched.rows) available.set(cid,
                win.DesignSync.localDesignFromRow(source, { apiBase: backend() }));
        }
        // The stored plan as it is, with these exact members (validate checks its content against its CID).
        const snapshot = win.PlanComposition.bind(plan, plan.content.designCids.map(cid => ({ ...available.get(cid),
            ...(plan.designSources?.[cid] ? { planFileSource: plan.designSources[cid] } : {}) })));
        // A portable import receipt can supply member ids while the canonical cache supplies
        // publication state and other metadata. Binding adds exact member content; it must not
        // replace metadata from that canonical row.
        const bound = { ...row, ...snapshot };
        if (row.published === true || plan.published === true) bound.published = true;
        return save(bound);
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
            if ((!response.ok && response.status !== 409) || answer.cid !== member.cid) throw new Error(win.i18n.t('planDialog.publicationFailed', {
                title: member.content.title || win.i18n.t('planDialog.untitledDesign'),
                reason: answer.error || (response.ok ? win.i18n.t('planDialog.otherCid') : `HTTP ${response.status}`) }));
        }
        const published = await win.NamedPlans.save(row.content);
        // NamedPlans records public metadata; retain the exact carried revisions for local reuse.
        save({ ...copy(row), published:true, publishedAt: published.publishedAt });
        return published;
    }
    // Designs of the plan the map does not hold applied, by title, for a refusal that names them.
    function missingTitles(plan) {
        const { byCid } = win.DesignSync.localDesignIndex();
        return plan.content.designCids.filter(cid => !byCid.has(cid) || !win.isApplied(byCid.get(cid)))
            .map(cid => byCid.get(cid)?.title
                || (plan.designs || []).find(member => member.cid === cid)?.content?.title || win.i18n.t('planDialog.untitledDesign'));
    }
    // The plan's members as applied local designs, or null while it is only previewed here.
    function appliedMembers(plan) {
        const { byCid } = win.DesignSync.localDesignIndex();
        const members = plan.content.designCids.map(cid => byCid.get(cid));
        return members.length && members.every(record => record && win.isApplied(record)) ? members : null;
    }
    // The plan's members standing on the map here, any number of them (PlanComposition.standingMembers).
    function standingMembers(plan) {
        const { records, cids } = win.DesignSync.localDesignIndex();
        return win.PlanComposition.standingMembers(plan.content.designCids, records,
            { cidOf: record => cids.get(record), isApplied: record => win.isApplied(record) });
    }
    // Bind the declared member sources together, then replay through the same ordered
    // mutation as published designs. No map changes take place during binding.
    async function apply(plan, { signal, onProgress } = {}) {
        const members = plan.published ? [] : (plan.designs || []).map(member => ({
            ...member, source: plan.designSources?.[member.cid]
        }));
        const draftRows = members.length ? await win.PlanAnalysis.bindPrivateRows(members, { signal, onProgress }) : new Map();
        signal?.throwIfAborted();
        const result = await win.handleSharedDesignRoute(plan.content.designCids, {
            ...(draftRows.size ? { draftRows } : {}), openDetails: false, enter3D: false, summary: false });
        if (result.blocked) return { blocked: true };
        if (result.failed.length || result.omitted?.length || !appliedMembers(plan)) {
            throw new Error(result.failed.map(item => [item.label, item.reason].filter(Boolean).join(': ')).join('; ')
                || win.i18n.t('planDialog.notOnMap', { titles: missingTitles(plan).map(title => `“${title}”`).join(', ') }));
        }
        return { blocked: false };
    }
    // Applies stored designs in turn exactly as an Apply click on the map does (ProposalManager.
    // applyProposal: a design stands down the rivals on its ground), in formation order (the order
    // the designs were made in, plan-order.js), `last` after all the others (the design just chosen,
    // which takes its ground as the latest Apply does), inside one parcel mutation that is rolled
    // back: nothing on the map or in storage changes. { standing, fallen } are their ids; a fallen
    // design is one a later one took the ground of, or one the apply refused.
    async function trial(ids, { last = null } = {}) {
        const records = ids.map(id => win.proposalStorage.getProposal(id)).filter(Boolean);
        await win.CadastralParcelRepository.ensureIds(records.flatMap(record => win.__claims.cadastreParcelIdsOf(record)));
        let outcome = null;
        await win.ProposalManager.runParcelMutation('plan-trial', null, async transaction => {
            const store = transaction._parcelMutation.proposals;
            const failures = [];
            const lastRecord = records.find(record => String(record.proposalId) === String(last));
            for (const record of [...win.__planOrder.orderFormations(records.filter(record => record !== lastRecord)), ...(lastRecord ? [lastRecord] : [])]) {
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
    win.PlanWorkspace = Object.freeze({ save, list, resolve, publish, publication, appliedMembers, standingMembers, apply, ensureApplied, trial });
})(window);
