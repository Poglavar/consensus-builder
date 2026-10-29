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
            // Members kept from the base revision keep their construction windows.
            const row=win.PlanComposition.create(name.value,[...selected].map(cid=>sources.get(cid)),view,baseRow?.content.schedule);
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
    // The construction windows of a plan's members on one month axis. Each bar opens its row.
    function scheduleStrip(content, { titles = new Map(), onPick = null } = {}) {
        const bars=win.BuildoutSchedule.bars(content.schedule||{},content.designCids);
        const span=win.BuildoutSchedule.range(content.schedule);
        const strip=node('div','plan-schedule__gantt');
        if(!span){strip.append(node('p','sheet-note',t('scheduleEmpty')));return strip;}
        const axis=node('div','plan-schedule__axis');
        axis.append(node('span','',span.start),node('span','',span.end));
        const lanes=node('div','plan-schedule__lanes');
        for(const bar of bars){
            const title=titles.get(bar.cid)||t('untitledDesign');
            const item=node(onPick?'button':'span','plan-schedule__bar');
            if(onPick){item.type='button';item.addEventListener('click',()=>onPick(bar.cid));}
            // Data-dependent geometry only: where on the axis the window sits.
            item.style.setProperty('--plan-schedule-offset',String(bar.offset));
            item.style.setProperty('--plan-schedule-width',String(bar.width));
            item.title=`${title}: ${bar.start} – ${bar.end}`;
            item.setAttribute('aria-label',item.title);
            lanes.append(item);
        }
        strip.append(lanes,axis);
        // Members without dates count as built at every month; they are named, not drawn on the axis.
        const undated=content.designCids.filter(cid=>!content.schedule?.[cid]);
        if(undated.length){
            const row=node('div','plan-schedule__undated');
            row.append(node('span','plan-schedule__undated-label',t('scheduleUndated')));
            for(const cid of undated){
                const item=node(onPick?'button':'span','plan-schedule__undated-item',titles.get(cid)||t('untitledDesign'));
                if(onPick){item.type='button';item.addEventListener('click',()=>onPick(cid));}
                row.append(item);
            }
            strip.append(row);
        }
        return strip;
    }
    // Construction windows of the plan's members (docs/buildout-timeline.md). Saving makes a new
    // immutable plan revision, as any plan edit does; the time control then shows it.
    async function schedule(plan, { focus = null, members = [] } = {}) {
        const row=await win.PlanWorkspace.resolve(plan,members);closeContexts();
        const R=win.PlanRecord;
        const titles=new Map(row.designs.map(member=>[member.cid,member.content.title||t('untitledDesign')]));
        const windows=new Map(Object.entries(row.content.schedule||{}).map(([cid,window])=>[cid,{...window}]));
        const body=node('form','plan-schedule');
        body.append(node('p','sheet-note',t('scheduleHint')));
        const stripHost=node('div','plan-schedule__strip');body.append(stripHost);
        const list=node('ul','plan-schedule__rows');body.append(list);
        const status=node('p','plan-dialog__status');status.setAttribute('role','status');body.append(status);
        const footer=node('div','cb-actions plan-dialog__footer');
        let dialog;
        const current=()=>Object.fromEntries([...windows].filter(([,window])=>window.start||window.end));
        const save=button(t('saveSchedule'),async()=>{
            const next=win.PlanComposition.withSchedule(row,current());
            win.PlanWorkspace.save(next);dialog.close();
            const month=win.BuildoutClock?.month();
            await win.ClickStack.showPlan(next,{designs:win.PlanComposition.localRecords(next,{apiBase:win.DesignSync.apiBase()}),draft:true});
            if(month)win.BuildoutClock.open(month);
            win.showEphemeralMessage?.(t('scheduleSaved'),5000,'success');
        },true);
        // Members without dates can be given a seeded, repeatable scenario on the map; it is never saved.
        const simulate=button(t('simulate'),async()=>{
            dialog.close();
            if(!await win.BuildoutClock.simulate(row))win.showEphemeralMessage?.(t('simulateNothing'),5000,'info');
        });
        simulate.classList.add('plan-schedule__simulate');
        const cancel=button(t('cancel'),()=>dialog.close());footer.append(simulate,cancel,save);body.append(footer);
        const inputs=new Map();
        const update=()=>{
            const draft=current();
            const error=Object.keys(draft).length?R.semanticRules.scheduleError(draft,row.content.designCids):null;
            status.textContent=error?t('scheduleInvalid',{first:R.MONTHS.first,last:R.MONTHS.last}):'';
            const same=JSON.stringify(draft)===JSON.stringify(row.content.schedule||{});
            save.disabled=!!error||same;
            for(const [cid,[start,end]] of inputs){
                const window=windows.get(cid)||{};
                const bad=(window.start||window.end)&&!R.semanticRules.constructionWindow(window);
                start.setAttribute('aria-invalid',String(!!bad));end.setAttribute('aria-invalid',String(!!bad));
            }
            stripHost.replaceChildren(scheduleStrip({designCids:row.content.designCids,schedule:error?{}:draft},{titles,onPick:cid=>inputs.get(cid)?.[0].focus()}));
        };
        const monthInput=(cid,key,label)=>{
            const input=node('input','plan-schedule__month');input.type='month';input.min=R.MONTHS.first;input.max=R.MONTHS.last;
            input.placeholder='YYYY-MM';input.pattern='\\d{4}-\\d{2}';input.value=windows.get(cid)?.[key]||'';input.setAttribute('aria-label',`${titles.get(cid)}: ${label}`);
            input.addEventListener('input',()=>{
                const window={...(windows.get(cid)||{}),[key]:input.value};
                // A start alone gives a one-month window until its end is chosen.
                if(key==='start'&&input.value&&!window.end){window.end=input.value;inputs.get(cid)[1].value=input.value;}
                windows.set(cid,window);update();
            });
            return input;
        };
        for(const cid of row.content.designCids){
            const item=node('li','plan-schedule__row');
            const name=node('span','plan-schedule__name',titles.get(cid));
            const fields=node('div','plan-schedule__fields');
            const start=monthInput(cid,'start',t('scheduleStart')),end=monthInput(cid,'end',t('scheduleEnd'));
            inputs.set(cid,[start,end]);
            const clear=node('button','btn btn-icon plan-schedule__clear');clear.type='button';
            clear.title=t('scheduleClear');clear.setAttribute('aria-label',`${titles.get(cid)}: ${t('scheduleClear')}`);
            const icon=node('i','fas fa-xmark');icon.setAttribute('aria-hidden','true');clear.append(icon);
            clear.addEventListener('click',()=>{windows.delete(cid);start.value='';end.value='';update();});
            const startLabel=node('label','plan-schedule__field',t('scheduleStart'));startLabel.append(start);
            const endLabel=node('label','plan-schedule__field',t('scheduleEnd'));endLabel.append(end);
            fields.append(startLabel,endLabel,clear);item.append(name,fields);list.append(item);
        }
        body.addEventListener('submit',event=>{event.preventDefault();if(!save.disabled)save.click();});
        dialog=openDialog(t('scheduleTitle',{title:row.content.title}),body,[],'md');update();
        (inputs.get(focus)?.[0]||inputs.values().next().value?.[0])?.focus();
        return dialog;
    }
    async function details(plan) {
        const row=await win.PlanWorkspace.resolve(plan);const body=node('div','plan-details');
        body.append(node('h3','',row.content.title),memberList(row));
        const actions=node('div','cb-actions');let dialog;
        actions.append(button(t('sharePlan'),async()=>{dialog.close();await share(row);},true));
        actions.append(button(t('editPlan'),async()=>{dialog.close();await create({base:row});}));
        actions.append(button(t('schedule'),async()=>{dialog.close();await schedule(row);}));
        actions.append(button(t('createAgreement'),async()=>{dialog.close();await win.AgreementDialog.open({plan:row});}));
        body.append(actions,win.PlanFileUI.planControls(row));
        dialog=openDialog(t('plan'),body);return dialog;
    }
    win.PlanDialog=Object.freeze({create,addDesign,share,details,schedule,scheduleStrip});
})(window);
