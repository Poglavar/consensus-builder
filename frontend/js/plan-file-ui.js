// File actions use the share panel's explicit membership. Import parks drafts in one atomic
// mutation, including their local plan membership; no source request or publication is needed.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.PlanFileUI = api.browser(root);
        const host = root.document.getElementById('plan-file-actions');
        if (host) host.appendChild(root.PlanFileUI.controls());
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const PREFIX = 'ugt-imported-plan:';
    function browser(win) {
        const doc = win.document;
        const t = (key, fallback, params) => win.getProposalI18nHelper()(`planFile.${key}`, fallback, params);
        const error = (e, code = 'plan-open-failed') => {
            const diagnostic = win.AppDiagnostics?.report(e, { code, context: { surface: 'plan-file' } });
            win.showStyledAlert(diagnostic?.message || 'The plan action could not finish. Please retry.');
        };
        const observe = (operation, options, action) => win.AppDiagnostics
            ? win.AppDiagnostics.run(operation, { ...options, context: { surface: 'plan-file', ...options.context } }, action) : action();
        // A download is named after its plan or design: "Riverside blocks" -> riverside-blocks.ugt.json.
        const fileStem = title => win.FileDownload.fileStem(title, 'plan');
        const download = (text, name, type) => win.FileDownload.save(win, text, name, type);
        async function fetchModel(raw) {
            const url = new URL(win.resolveBackendAssetUrl(raw), win.location.href);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(t('modelUrl', 'The model URL cannot be downloaded safely.'));
            const response = await win.fetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(t('modelFailed', 'A model could not be downloaded. The plan file was not created.'));
            if (Number(response.headers.get('content-length')) > win.PlanFile.MAX_BYTES / 2) throw new Error(t('modelLarge', 'The model is too large for a portable plan file.'));
            const reader = response.body.getReader(), chunks = [];
            let size = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > win.PlanFile.MAX_BYTES / 2) throw new Error(t('modelLarge', 'The model is too large for a portable plan file.'));
                    chunks.push(value);
                }
            } finally { await reader.cancel(); }
            const data = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
            let binary = '';
            for (let i = 0; i < size; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
            return 'data:model/gltf-binary;base64,' + win.btoa(binary);
        }
        function review(file) {
            return new Promise(resolve => {
                const body = doc.createElement('div');
                const summary = doc.createElement('p');
                summary.textContent = t('preview', '“{{title}}”: {{count}} designs. Import adds local, unapplied drafts and saves this plan’s membership and view. Existing work stays in place. No agreement, ownership or signature is imported.', { title: file.plan.title, count: file.designs.length });
                const list = doc.createElement('ul');
                file.designs.forEach(({ content }) => {
                    const item = doc.createElement('li'); item.textContent = content.title || content.goal; list.appendChild(item);
                });
                const location = doc.createElement('p');
                location.textContent = t('location', 'Saved location (latitude, longitude, zoom): {{at}}', { at: file.plan.view.at });
                body.append(summary, location, list);
                const modal = win.showSimpleShareModal({ title: t('review', 'Review plan file'), body,
                    autoCloseActions: false, onClose: () => resolve(false), actions: [
                        { id: 'cancel', label: t('cancel', 'Cancel'), onClick: m => { resolve(false); m.close(); } },
                        { id: 'import', label: t('importDrafts', 'Import as drafts'), primary: true, onClick: m => { resolve(true); m.close(); } }
                    ] });
                if (!modal) resolve(false);
            });
        }
        async function commitImport(file) {
            win.PlanFile.validate(file);
            return observe('import', { entity: 'plan', planKey: win.Cid.cidOfObject(file.plan), code: 'plan-import-failed' }, () => win.ProposalManager.runParcelMutation('import-plan-file', null, options => {
                const context = options._parcelMutation;
                const plan = win.PlanFile.importInto(file, context.proposals);
                context.storage.setItem(PREFIX + plan.cid, JSON.stringify(plan));
                return plan;
            }, { _mapMutation: false }));
        }
        async function openPlan(plan) {
            const members = plan.memberIds.map(id => win.proposalStorage.getProposal(id)).filter(Boolean);
            if (members.length !== plan.memberIds.length) throw new Error(t('missingMembers', 'Some imported designs were removed from this device. Import the file again to restore them.'));
            const snapshot = await win.PlanWorkspace.resolve(plan, members);
            return win.PlanDialog.details(snapshot);
        }
        function importedPlans() {
            const plans = [];
            win.PersistentStorage.forEach((raw, key) => {
                if (!String(key).startsWith(PREFIX)) return;
                try {
                    const plan = JSON.parse(raw);
                    if (!win.PlanRecord.validate(plan.content) && Array.isArray(plan.memberIds)) plans.push(plan);
                } catch (_) { /* leave an invalid local entry untouched */ }
            });
            const body = doc.createElement('div');
            if (!plans.length) body.textContent = t('noImports', 'No plans have been imported on this device.');
            const modal = win.showSimpleShareModal({ title: t('importedPlans', 'Imported plans'), body, actions: [] });
            for (const plan of plans) {
                const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn';
                button.textContent = plan.content.title;
                button.addEventListener('click', () => { modal.close(); Promise.resolve().then(() => openPlan(plan)).catch(e => error(e)); });
                body.appendChild(button);
            }
        }
        function actionIcon(button, name) {
            const icon = doc.createElement('i'); icon.className = `fas fa-${name}`;
            icon.setAttribute('aria-hidden', 'true'); button.prepend(icon);
        }
        function controls({ getRecords = null, getView = () => win.MapShare.capture(win), getTitle = () => 'My plan', getSources = () => ({}), getSchedule = () => null, importAllowed = true } = {}) {
            const group = doc.createElement('div'); group.className = 'plan-file-controls';
            let busy = false;
            const buttons = [];
            const button = (label, action, hook) => {
                const b = doc.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = label;
                b.dataset.planFileAction = hook;
                actionIcon(b, hook === 'plans' ? 'folder-open' : 'download');
                b.addEventListener('click', async () => {
                    if (busy) return;
                    busy = true; buttons.forEach(c => { c.disabled = true; });
                    try { await win.BusyControl.track(b, async () => {
                        await new Promise(win.requestAnimationFrame);
                        return ['json', 'geojson'].includes(hook)
                            ? observe('export', { entity: 'file', code: 'plan-export-failed', context: { format: hook } }, action) : action();
                    }); } catch (e) { error(e, ['json', 'geojson'].includes(hook) ? 'plan-export-failed' : 'plan-open-failed'); }
                    finally { busy = false; buttons.forEach(c => { c.disabled = false; }); }
                });
                buttons.push(b); group.appendChild(b); return b;
            };
            if (getRecords) {
                const make = () => win.PlanFile.create(structuredClone(getRecords()), { title: getTitle(), view: structuredClone(getView()), schedule: getSchedule(), designSources: getSources(), fetchModel });
                button(t('json', 'Download editable plan'), async () => download(win.PlanFile.stringify(await make()), `${fileStem(getTitle())}.ugt.json`, 'application/json'), 'json');
                button(t('geojson', 'Download GeoJSON'), () => download(JSON.stringify(win.PlanFile.geojsonRecords(structuredClone(getRecords()), { title: getTitle(), view: structuredClone(getView()) }), null, 2) + '\n', `${fileStem(getTitle())}.geojson`, 'application/geo+json'), 'geojson');
            }
            if (!importAllowed) return group;
            const input = doc.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
            input.setAttribute('aria-label', t('import', 'Import plan file'));
            // File-picker cancellation starts no work, and clearing after each choice permits the
            // same file to be chosen again after cancellation or validation failure.
            const choose = doc.createElement('button'); choose.type = 'button'; choose.className = 'btn';
            choose.textContent = t('import', 'Import plan file'); choose.dataset.planFileAction = 'import';
            actionIcon(choose, 'file-import');
            choose.addEventListener('click', () => { if (!busy) input.click(); });
            buttons.push(choose); group.append(choose, input);
            input.addEventListener('change', async () => {
                const file = input.files?.[0]; input.value = '';
                if (!file || busy) return;
                busy = true; buttons.forEach(b => { b.disabled = true; });
                try {
                    await win.BusyControl.track(choose, async () => {
                        let planFile;
                        try {
                            if (file.size > win.PlanFile.MAX_BYTES) throw new Error(t('tooLarge', 'Plan files are limited to 32 MiB.'));
                            planFile = win.PlanFile.parse(await file.text());
                        } catch (e) {
                            win.AppDiagnostics?.event('import', 'failure', { entity: 'file', context: { surface: 'plan-file', format: 'json' } });
                            throw e;
                        }
                        if (!await review(planFile)) {
                            win.AppDiagnostics?.event('import', 'cancelled', { entity: 'file', context: { surface: 'plan-file', format: 'json' } });
                            return;
                        }
                        const plan = await commitImport(planFile);
                        win.updateShowProposalsButton?.(); win.refreshProposalsLayer?.();
                        win.showSimpleShareModal({ title: t('imported', 'Plan imported'), body: t('importedBody', 'The designs are saved as local drafts. Open the imported plan to review its members, download it again or publish a link.'),
                            actions: [{ label: t('open', 'Open imported plan'), primary: true, onClick: () => Promise.resolve().then(() => openPlan(plan)).catch(e => error(e)) }] });
                    });
                } catch (e) { error(e, 'plan-import-failed'); }
                finally { busy = false; buttons.forEach(b => { b.disabled = false; }); }
            });
            button(t('importedPlans', 'Imported plans'), importedPlans, 'plans');
            const help = doc.createElement('a'); help.href = 'plan-files.html'; help.target = '_blank'; help.rel = 'noopener';
            help.textContent = t('help', 'File formats and limits'); group.appendChild(help);
            return group;
        }
        // The download controls of one resolved plan (PlanWorkspace.resolve): its members as they are
        // in that exact revision, its view, schedule and sources.
        function planControls(row, { getRow = () => row } = {}) {
            return controls({ getRecords: () => win.PlanComposition.localRecords(getRow(), { apiBase: win.DesignSync.apiBase() }),
                getView: () => getRow().content.view, getTitle: () => getRow().content.title, getSources: () => getRow().designSources || {},
                getSchedule: () => getRow().content.schedule || null, importAllowed: false });
        }
        // Download a plan ({ cid, content }, or a stored row) or a design as a file, from any surface.
        async function plan(record, members = []) {
            const row = await win.PlanWorkspace.resolve(record, members);
            win.showSimpleShareModal({ title: t('plan', 'Download plan'), body: planControls(row), actions: [] });
        }
        function design(record) {
            win.showSimpleShareModal({ title: t('design', 'Download design'), body: controls({ getRecords: () => [record], getTitle: () => record.title || 'My design', importAllowed: false }), actions: [] });
        }
        return { controls, planControls, plan, design, review, commitImport, openPlan };
    }
    return { PREFIX, browser };
});
