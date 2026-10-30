// File actions use the share panel's explicit membership. Import parks drafts in one atomic
// mutation, including their local plan membership; no source request or publication is needed.
// Lists (lists-panel.js) offers Import and Imported on each tab through importFile and imported.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanFileUI = api.browser(root);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const PREFIX = 'ugt-imported-plan:';
    // An agreement read from a file is marked here by its local id, so Imported agreements lists it.
    const AGREEMENT_PREFIX = 'ugt-imported-agreement:';
    // A design read from a file is stored under a `file-` id (PlanFile.importInto).
    const IMPORTED_DESIGN = /^file-/;
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
        // `designsOnly`: a design file (or a plan file read on the Designs tab) adds its designs and
        // keeps no imported plan.
        function review(file, { designsOnly = false } = {}) {
            return new Promise(resolve => {
                const body = doc.createElement('div');
                const summary = doc.createElement('p');
                summary.textContent = designsOnly
                    ? t('designPreview', '“{{title}}”: {{count}} designs. Import adds them as local, unapplied drafts. Existing work stays in place. No agreement, ownership or signature is imported.', { title: file.plan.title, count: file.designs.length })
                    : t('preview', '“{{title}}”: {{count}} designs. Import adds local, unapplied drafts and saves this plan’s membership and view. Existing work stays in place. No agreement, ownership or signature is imported.', { title: file.plan.title, count: file.designs.length });
                const list = doc.createElement('ul');
                file.designs.forEach(({ content }) => {
                    const item = doc.createElement('li'); item.textContent = content.title || content.goal; list.appendChild(item);
                });
                const location = doc.createElement('p');
                location.textContent = t('location', 'Saved location (latitude, longitude, zoom): {{at}}', { at: file.plan.view.at });
                body.append(summary, location, list);
                const modal = win.showSimpleShareModal({ title: designsOnly ? t('reviewDesigns', 'Review design file') : t('review', 'Review plan file'), body,
                    autoCloseActions: false, onClose: () => resolve(false), actions: [
                        { id: 'cancel', label: t('cancel', 'Cancel'), onClick: m => { resolve(false); m.close(); } },
                        { id: 'import', label: t('importDrafts', 'Import as drafts'), primary: true, onClick: m => { resolve(true); m.close(); } }
                    ] });
                if (!modal) resolve(false);
            });
        }
        async function commitImport(file, { keepPlan = true } = {}) {
            win.PlanFile.validate(file);
            return observe('import', { entity: 'plan', planKey: win.Cid.cidOfObject(file.plan), code: 'plan-import-failed' }, () => win.ProposalManager.runParcelMutation('import-plan-file', null, options => {
                const context = options._parcelMutation;
                const plan = win.PlanFile.importInto(file, context.proposals);
                if (keepPlan) context.storage.setItem(PREFIX + plan.cid, JSON.stringify(plan));
                return plan;
            }, { _mapMutation: false }));
        }
        async function openPlan(plan) {
            const members = plan.memberIds.map(id => win.proposalStorage.getProposal(id)).filter(Boolean);
            if (members.length !== plan.memberIds.length) throw new Error(t('missingMembers', 'Some imported designs were removed from this device. Import the file again to restore them.'));
            const snapshot = await win.PlanWorkspace.resolve(plan, members);
            return win.PlanDialog.details(snapshot);
        }
        // What was read from files on this device, per Lists tab: [{ title, open }].
        function importedRows(kind) {
            if (kind === 'designs') return win.proposalStorage.getAllProposals().filter(record => IMPORTED_DESIGN.test(String(record.proposalId)))
                .map(record => ({ title: record.title || record.name || win.i18n.t('planDialog.untitledDesign'), open: () => {
                    win.MapShell?.closeSheets(); return win.openListedProposal(record, record.proposalId, 'details');
                } }));
            const rows = [];
            win.PersistentStorage.forEach((raw, key) => {
                key = String(key);
                if (kind === 'plans' && key.startsWith(PREFIX)) {
                    try {
                        const plan = JSON.parse(raw);
                        if (!win.PlanRecord.validate(plan.content) && Array.isArray(plan.memberIds)) rows.push({ title: plan.content.title, open: () => openPlan(plan) });
                    } catch (_) { /* leave an invalid local entry untouched */ }
                }
                if (kind === 'agreements' && key.startsWith(AGREEMENT_PREFIX)) {
                    const agreement = win.AgreementStore.get(key.slice(AGREEMENT_PREFIX.length));
                    if (agreement) rows.push({ title: agreement.title || win.i18n.t('agreement.panel.untitled'), open: () => {
                        win.MapShell?.closeSheets(); return win.AgreementPanel.open(agreement.id);
                    } });
                }
            });
            return rows;
        }
        const IMPORTED_TEXT = {
            designs: [['importedDesigns', 'Imported designs'], ['noImportedDesigns', 'No designs have been imported on this device.']],
            plans: [['importedPlans', 'Imported plans'], ['noImports', 'No plans have been imported on this device.']],
            agreements: [['importedAgreements', 'Imported agreements'], ['noImportedAgreements', 'No agreements have been imported on this device.']]
        };
        function imported(kind) {
            const rows = importedRows(kind), [title, empty] = IMPORTED_TEXT[kind];
            const body = doc.createElement('div'); body.className = 'plan-file-imported';
            if (!rows.length) body.textContent = t(...empty);
            const modal = win.showSimpleShareModal({ title: t(...title), body, actions: [] });
            for (const row of rows) {
                const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn';
                button.textContent = row.title;
                button.addEventListener('click', () => { modal.close(); Promise.resolve().then(row.open).catch(e => error(e)); });
                body.appendChild(button);
            }
        }
        function actionIcon(button, name) {
            const icon = doc.createElement('i'); icon.className = `fas fa-${name}`;
            icon.setAttribute('aria-hidden', 'true'); button.prepend(icon);
        }
        // `extras`: further downloads, [{ label, hook, make: () => ({ text, name, type }) }].
        function controls({ getRecords = null, getView = () => win.MapShare.capture(win), getTitle = () => 'My plan', getSources = () => ({}), getSchedule = () => null, extras = [] } = {}) {
            const group = doc.createElement('div'); group.className = 'plan-file-controls';
            let busy = false;
            const buttons = [];
            const button = (label, action, hook) => {
                const b = doc.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = label;
                b.dataset.planFileAction = hook;
                actionIcon(b, 'download');
                b.addEventListener('click', async () => {
                    if (busy) return;
                    busy = true; buttons.forEach(c => { c.disabled = true; });
                    try { await win.BusyControl.track(b, async () => {
                        await new Promise(win.requestAnimationFrame);
                        return observe('export', { entity: 'file', code: 'plan-export-failed', context: { format: hook } }, action);
                    }); } catch (e) { error(e, 'plan-export-failed'); }
                    finally { busy = false; buttons.forEach(c => { c.disabled = false; }); }
                });
                buttons.push(b); group.appendChild(b); return b;
            };
            if (getRecords) {
                const make = () => win.PlanFile.create(structuredClone(getRecords()), { title: getTitle(), view: structuredClone(getView()), schedule: getSchedule(), designSources: getSources(), fetchModel });
                button(t('json', 'Download editable plan'), async () => download(win.PlanFile.stringify(await make()), `${fileStem(getTitle())}.ugt.json`, 'application/json'), 'json');
                button(t('geojson', 'Download GeoJSON'), () => download(JSON.stringify(win.PlanFile.geojsonRecords(structuredClone(getRecords()), { title: getTitle(), view: structuredClone(getView()) }), null, 2) + '\n', `${fileStem(getTitle())}.geojson`, 'application/geo+json'), 'geojson');
                // CityJSON beside our own files: buildings, roads and spaces as city objects, the plan file inside (city-json-export.js).
                button(t('cityjson', 'Download CityJSON'), async () => download(JSON.stringify(win.CityJsonExport.fromPlanFile(await make(), { proj4: win.proj4 })) + '\n', `${fileStem(getTitle())}.city.json`, 'application/city+json'), 'cityjson');
            }
            extras.forEach(extra => button(extra.label, () => { const file = extra.make(); download(file.text, file.name, file.type); }, extra.hook));
            return group;
        }
        // Read one chosen file into this device: on the Plans tab a plan file (kept as an imported
        // plan), on the Designs tab a design or plan file (its designs only), on the Agreements tab an
        // agreement file. Resolves once the import is done, cancelled or refused; a refusal is shown.
        async function importFile(kind, file) {
            const format = kind === 'agreements' ? 'agreement' : 'json';
            const note = outcome => win.AppDiagnostics?.event('import', outcome, { entity: 'file', context: { surface: 'plan-file', format } });
            try {
                let parsed;
                try {
                    if (file.size > win.PlanFile.MAX_BYTES) throw new Error(t('tooLarge', 'Plan files are limited to 32 MiB.'));
                    parsed = (kind === 'agreements' ? win.AgreementFile : win.PlanFile).parse(await file.text());
                } catch (e) { note('failure'); throw e; }
                const designsOnly = kind === 'designs';
                if (!await (kind === 'agreements' ? reviewAgreement(parsed) : review(parsed, { designsOnly }))) { note('cancelled'); return; }
                if (kind === 'agreements') {
                    const agreement = await importAgreement(parsed);
                    win.updateShowProposalsButton?.(); win.refreshProposalsLayer?.();
                    win.showSimpleShareModal({ title: t('agreementImported', 'Agreement imported'), body: t('agreementImportedBody', 'The agreement and its plan’s designs are saved here as drafts. Apply the plan’s designs to read its land.'),
                        actions: [{ label: t('openAgreement', 'Open imported agreement'), primary: true, onClick: () => Promise.resolve(win.AgreementPanel.open(agreement.id)).catch(e => error(e)) }] });
                    return;
                }
                const plan = await commitImport(parsed, { keepPlan: !designsOnly });
                win.updateShowProposalsButton?.(); win.refreshProposalsLayer?.();
                if (designsOnly) {
                    win.showEphemeralMessage(t('designsImported', 'Designs imported as local drafts: {{count}}', { count: plan.memberIds.length }), 5000, 'success');
                    return;
                }
                win.showSimpleShareModal({ title: t('imported', 'Plan imported'), body: t('importedBody', 'The designs are saved as local drafts. Open the imported plan to review its members, download it again or publish a link.'),
                    actions: [{ label: t('open', 'Open imported plan'), primary: true, onClick: () => Promise.resolve().then(() => openPlan(plan)).catch(e => error(e)) }] });
            } catch (e) { error(e, 'plan-import-failed'); }
        }
        // The download controls of one resolved plan (PlanWorkspace.resolve): its members as they are
        // in that exact revision, its view, schedule and sources.
        function planControls(row) {
            return controls({ getRecords: () => win.PlanComposition.localRecords(row, { apiBase: win.DesignSync.apiBase() }),
                getView: () => row.content.view, getTitle: () => row.content.title, getSources: () => row.designSources || {},
                getSchedule: () => row.content.schedule || null });
        }
        // Download a plan ({ cid, content }, or a stored row) or a design as a file, from any surface.
        async function plan(record, members = []) {
            const row = await win.PlanWorkspace.resolve(record, members);
            win.showSimpleShareModal({ title: t('plan', 'Download plan'), body: planControls(row), actions: [] });
        }
        // A road also downloads as its OSM document (Road → Import reads it back) and a parcel layout
        // as its plots (the layout editor's Upload GeoJSON reads them back).
        const EXTRA_LABELS = { 'road-osm': ['roadOsm', 'Download road for import (OSM)'], 'layout-plots': ['layoutPlots', 'Download plots (GeoJSON)'] };
        function design(record) {
            const title = () => record.title || 'My design';
            const extras = win.DesignFileExports.downloadsFor(record).map(file => ({ label: t(...EXTRA_LABELS[file.id]), hook: file.id,
                make: () => ({ text: file.text, name: fileStem(title()) + file.suffix, type: file.type }) }));
            win.showSimpleShareModal({ title: t('design', 'Download design'), body: controls({ getRecords: () => [record], getTitle: title, extras }), actions: [] });
        }
        // ---- agreements: the terms with the plan file of their plan (agreement-file.js) ----------
        // Download one agreement, stored or published (`designs`: a published one's fetched designs).
        async function downloadAgreement(record, designs = []) {
            if (!record?.plan) throw new Error(t('agreementNoPlan', 'This agreement has no plan yet, so it cannot be downloaded.'));
            return observe('export', { entity: 'file', code: 'plan-export-failed', context: { format: 'agreement' } }, async () => {
                const row = await win.PlanWorkspace.resolve(record.plan, designs);
                const cidMap = {};
                const planFile = await win.PlanFile.create(structuredClone(win.PlanComposition.localRecords(row, { apiBase: win.DesignSync.apiBase() })), {
                    title: row.content.title, view: structuredClone(row.content.view), schedule: row.content.schedule || null,
                    designSources: row.designSources || {}, fetchModel, cidMap });
                const file = win.AgreementFile.create(record, planFile, cidMap);
                return download(win.AgreementFile.stringify(file), `${win.FileDownload.fileStem(record.title || row.content.title, 'agreement')}.ugt-agreement.json`, 'application/json');
            });
        }
        function reviewAgreement(file) {
            return new Promise(resolve => {
                const body = doc.createElement('p');
                body.textContent = t('agreementPreview', '“{{title}}”: an agreement over the plan “{{plan}}” with {{count}} designs. Import adds the designs as local, unapplied drafts and the agreement as a local draft. It is not proposed or published, and no vote or signature is imported.',
                    { title: file.agreement.title || file.planFile.plan.title, plan: file.planFile.plan.title, count: file.planFile.designs.length });
                const modal = win.showSimpleShareModal({ title: t('reviewAgreement', 'Review agreement file'), body,
                    autoCloseActions: false, onClose: () => resolve(false), actions: [
                        { id: 'cancel', label: t('cancel', 'Cancel'), onClick: m => { resolve(false); m.close(); } },
                        { id: 'import', label: t('importDrafts', 'Import as drafts'), primary: true, onClick: m => { resolve(true); m.close(); } }
                    ] });
                if (!modal) resolve(false);
            });
        }
        // The plan's designs arrive as drafts (one mutation, as a plan file import), then the agreement
        // is stored under a new id over them.
        async function importAgreement(file) {
            const checked = win.AgreementFile.validate(file);
            const plan = await commitImport(checked.planFile);
            const agreement = win.AgreementStore.save(win.AgreementFile.localAgreement(checked, plan, { id: win.AgreementRecord.newId() }));
            win.PersistentStorage.setItem(AGREEMENT_PREFIX + agreement.id, '1');
            return agreement;
        }
        return { controls, planControls, plan, design, review, commitImport, openPlan, downloadAgreement, importAgreement, importFile, imported, importedRows };
    }
    return { PREFIX, browser };
});
