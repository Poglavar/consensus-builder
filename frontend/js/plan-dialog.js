// Separate creation, inspection and sharing surfaces for immutable named plans.
(function (win) {
    'use strict';
    const t = (key, params) => win.i18n.t(`planDialog.${key}`, params || {});
    const node = (tag, className, text) => {
        const el = document.createElement(tag); el.className = className || '';
        if (text !== undefined) el.textContent = text;
        return el;
    };
    const button = (label, run, primary = false) => {
        const el = node('button', `btn${primary ? ' btn-primary' : ''}`, label); el.type = 'button';
        el.addEventListener('click', async () => {
            if (win.BusyControl.isBusy(el)) return;
            try { await win.BusyControl.track(el, async()=>{
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                return run();
            }); }
            catch (error) { win.showStyledAlert(error.message); }
        });
        return el;
    };
    const records = () => win.proposalStorage.getAllProposals().filter(record => {
        try { return win.DesignRecord.validate(win.DesignRecord.published(record)).valid; } catch (_) { return false; }
    });
    function closeContexts() { win.ClickStack?.close(); win.ThreeClickStack?.close(); }
    function openDialog(title, body, actions = [], size = 'sm') {
        return win.CbDialog.open({ title, size, className:'plan-dialog', body, actions, autoCloseActions:false });
    }
    function memberList(row) {
        const list = node('ul', 'plan-dialog__members');
        row.designs.forEach(member => list.append(node('li', '', member.content.title || t('untitledDesign'))));
        return list;
    }
    async function create({ members = [], base = null, add = null } = {}) {
        closeContexts();
        const baseRow = base ? await win.PlanWorkspace.resolve(base) : null;
        const sources = new Map(records().map(record => [win.DesignRecord.cidOf(record), record]));
        const selected = new Set();
        if (baseRow) for (const record of win.PlanComposition.localRecords(baseRow, { apiBase:win.DesignSync.apiBase() })) {
            const cid = win.DesignRecord.cidOf(record); sources.set(cid, record); selected.add(cid);
        }
        for (const record of members) { const cid=win.DesignRecord.cidOf(record); sources.set(cid,record); selected.add(cid); }
        if (add) { const cid=win.DesignRecord.cidOf(add); sources.set(cid,add); selected.add(cid); }
        const body = node('form', 'plan-composer');
        const view = structuredClone(baseRow?.content.view || win.MapShare.capture(win));
        const nameLabel = node('label', 'plan-dialog__field', t('name'));
        const name = node('input'); name.type='text'; name.required=true; name.maxLength=win.PlanRecord.MAX_TITLE;
        name.value=baseRow?.content.title || ''; nameLabel.append(name); body.append(nameLabel);
        if (baseRow) body.append(node('p','sheet-note',t('revisionHint')));
        const searchLabel=node('label','plan-dialog__field',t('addDesigns'));
        const search=node('input'); search.type='search'; search.placeholder=t('search'); searchLabel.append(search); body.append(searchLabel);
        const count=node('p','plan-dialog__count'); body.append(count);
        const list=node('div','plan-dialog__choices'); body.append(list);
        if(view.mode !== '2d') {
            const options=node('div','plan-dialog__view');
            const option=(key, title, checked)=>{
                const label=node('label'), input=node('input');input.type='checkbox';input.checked=checked;
                input.dataset.planView=key;label.append(input,document.createTextNode(title));options.append(label);return input;
            };
            const camera=view.camera;
            if(camera)option('camera',win.i18n.t('proposals.share.view.camera'),true).addEventListener('change',event=>{view.camera=event.target.checked?camera:null;});
            option('rotate',win.i18n.t('proposals.share.view.rotate'),view.rotate===true).addEventListener('change',event=>{view.rotate=event.target.checked;});
            options.append(node('small','sheet-note',win.i18n.t('proposals.share.view.rotateHint')));body.append(options);
        }
        const status=node('p','plan-dialog__status'); status.setAttribute('role','status'); body.append(status);
        const footer=node('div','cb-actions plan-dialog__footer');
        let dialog;
        const save=button(t(baseRow ? 'saveRevision' : 'createPlan'), async () => {
            const row=win.PlanComposition.create(name.value,[...selected].map(cid=>sources.get(cid)),view);
            win.PlanWorkspace.save(row); dialog.close();
            await win.ClickStack.showPlan(row, { designs: win.PlanComposition.localRecords(row, { apiBase: win.DesignSync.apiBase() }), draft: !row.published });
        },true);
        const cancel=button(t('cancel'),()=>dialog.close()); footer.append(cancel,save); body.append(footer);
        const update=()=>{count.textContent=t('selected',{count:selected.size});save.disabled=!name.value.trim()||!selected.size;};
        const render=()=>{
            const query=search.value.trim().toLocaleLowerCase(); list.replaceChildren();
            for (const [cid,record] of sources) {
                if (query && ![record.title,record.author,record.goal].join(' ').toLocaleLowerCase().includes(query)) continue;
                const label=node('label','plan-dialog__choice'); const check=node('input'); check.type='checkbox';check.checked=selected.has(cid);
                check.addEventListener('change',()=>{if(check.checked)selected.add(cid);else selected.delete(cid);update();});
                const text=node('span','',record.title||t('untitledDesign'));
                const kind=node('small','',win.getProposalGoalLabel?.(record.goal)||record.goal);text.append(kind);label.append(check,text);list.append(label);
            }
            if(!sources.size)list.append(node('p','sheet-note',t('noDesigns')));update();
        };
        name.addEventListener('input',update);search.addEventListener('input',render);
        body.addEventListener('submit',event=>{event.preventDefault();if(!save.disabled)save.click();});
        dialog=openDialog(t(baseRow?'editPlan':'createPlan'),body,[],'md');render();name.focus();return dialog;
    }
    async function addDesign(id) {
        const record=win.proposalStorage.getProposal(id);if(!record)throw new Error(t('designMissing'));
        const plans=win.PlanWorkspace.list();
        if(!plans.length)return create({add:record});
        const chosen=await win.CbDialog.choice(t('choosePlan'),[
            {value:'new',label:t('newPlan'),primary:true},...plans.map(plan=>({value:plan.cid,label:plan.content.title})),
            {value:'cancel',label:t('cancel')}
        ],{title:t('addToPlan')});
        if(!chosen||chosen==='cancel')return null;
        return create({base:chosen==='new'?null:plans.find(plan=>plan.cid===chosen),add:record});
    }
    async function share(plan, members=[]) {
        const row=await win.PlanWorkspace.resolve(plan,members);closeContexts();
        const published=await win.PlanWorkspace.publication(row);
        const body=node('div','plan-share');body.append(node('h3','',row.content.title),memberList(row));
        body.append(node('p','sheet-note',t('shareFixed')));
        const link=node('input','design-link__input');link.type='text';link.readOnly=true;link.setAttribute('aria-label',t('planLink'));link.hidden=!published;link.value=published?.link||'';
        const status=node('p','plan-dialog__status');status.setAttribute('role','status');
        const publish=button(t(published?'copyLink':'publishAndCopy'),async()=>{
            status.textContent=link.value?'':t('publishing');
            try {
                if(!link.value){const result=await win.PlanWorkspace.publish(row);link.value=result.link;link.hidden=false;}
                status.textContent=await win.DesignSync.copyLink(link.value)?t('copied'):t('copyLinkManually');
                publish.textContent=t('copyLink');
            }catch(error){status.textContent=error.message;}
        },true);
        body.append(link,status,publish);return openDialog(t('sharePlan'),body);
    }
    async function details(plan) {
        const row=await win.PlanWorkspace.resolve(plan);const body=node('div','plan-details');
        body.append(node('h3','',row.content.title),memberList(row));
        const actions=node('div','cb-actions');let dialog;
        actions.append(button(t('sharePlan'),async()=>{dialog.close();await share(row);},true));
        actions.append(button(t('editPlan'),async()=>{dialog.close();await create({base:row});}));
        actions.append(button(t('createAgreement'),async()=>{dialog.close();await win.AgreementDialog.open({plan:row});}));
        body.append(actions,win.PlanFileUI.controls({ getRecords:()=>win.PlanComposition.localRecords(row,{apiBase:win.DesignSync.apiBase()}),
            getView:()=>row.content.view,getTitle:()=>row.content.title,getSources:()=>row.designSources||{},importAllowed:false }));
        dialog=openDialog(t('plan'),body);return dialog;
    }
    win.PlanDialog=Object.freeze({create,addDesign,share,details});
})(window);
