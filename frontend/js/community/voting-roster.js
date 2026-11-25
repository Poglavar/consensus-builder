// Browser-only voter assignment editor. Its parent receives only the immutable verifier configuration.
(function (root) {
    'use strict';
    const V=()=>root.CommunityVoting;
    const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    function t(key,fallback,params={}) {
        const value=root.i18n?.t?.(`voting.${key}`,params);
        return String(value && value!==`voting.${key}`?value:fallback).replace(/\{\{(\w+)\}\}/g,(_,name)=>params[name]??'');
    }
    function mount(slot,{value=null,changed}) {
        if(!slot)return {busy:()=>false,destroy(){}};
        const local={id:value?.id || root.crypto.randomUUID(),entries:[],value,busy:false,labels:'',household:'',count:10,saved:true,error:null,
            rule:value?.rule?`${value.rule.id}@${value.rule.version}`:''};
        let alive=true;
        const download=(name,content,type)=>root.FileDownload.save(root,content,name,type);
        const notify=()=>changed(local.value,local.busy || !local.saved);
        const Rules=()=>root.CommunityBallotRules;
        const ruleOf=key=>key?Rules().get(...key.split('@')):null;
        const ruleText=(rule,field)=>t(`ballotRules.${rule.id}.${field}`,rule.text[field]);
        // The published voting record: every code, its households (from the local entries, or kept from
        // a reopened draft whose voter list is not open) and the chosen ballot rule.
        function configure(codeHashes) {
            const rule=ruleOf(local.rule);
            return V().configuration({schema:V().SCHEMA,id:local.id,codeHashes,
                ...(local.entries.length?{households:V().householdsOf(local.entries)}:local.value?.households?{households:local.value.households}:{}),
                ...(rule?{rule:{id:rule.id,version:rule.version}}:{})});
        }
        async function generate(rows) {
            if(local.value && !local.entries.length)throw new Error(t('restoreFirst','Open your saved voter list before adding codes to this draft.'));
            if(local.entries.length+rows.length>V().MAX_ENTRIES)throw new Error(t('tooMany','A consultation supports up to 10,000 codes.'));
            const added=[];
            for(let start=0;start<rows.length;start+=V().MAX_BATCH)
                added.push(...await V().generateEntries(local.id,rows.slice(start,start+V().MAX_BATCH),root.crypto,done=>progress(start+done,rows.length)));
            local.entries=local.entries.concat(added);
            local.value=configure(local.entries.map(row=>row.codeHash));
            local.saved=false;
        }
        function render() {
            if(!alive)return;
            slot.innerHTML=`<h4>${esc(t('prepare','Voting codes'))}</h4><p class="agreement-hint">${esc(t('immutable','Prepare the complete voter list before publishing. Changing eligible codes requires a new agreement with its own votes.'))}</p>`
                + `<p class="agreement-hint">${esc(t('localOnly','Names and contact details stay in this browser and your downloaded voter list. Only code hashes enter the agreement.'))}</p>`
                + `<p>${esc(t('prepared','{{count}} eligible codes prepared',{count:local.value?.codeHashes.length || 0}))}</p>`
                + (local.error?`<p role="alert">${esc(local.error)}</p>`:'')
                + ruleHtml()
                + `<label class="proposal-editor-field"><span>${esc(t('labels','People or contact details — one person per line (optional)'))}</span><textarea data-roster-labels rows="3" autocomplete="off" spellcheck="false">${esc(local.labels)}</textarea></label>`
                + `<label class="proposal-editor-field"><span>${esc(t('householdBatch','Household for these people (optional)'))}</span><input type="text" data-roster-household-batch value="${esc(local.household)}" autocomplete="off" spellcheck="false"></label>`
                + `<p class="agreement-hint">${esc(t('householdHint','People who live together share a household label. A code without one counts as a household of its own. Household labels stay local; the agreement records only which codes share a household.'))}</p>`
                + `<label class="proposal-editor-field"><span>${esc(t('count','Or number of unassigned codes'))}</span><input type="number" data-roster-count min="1" max="100" value="${local.count}"></label>`
                + `<div class="cb-actions"><button type="button" class="btn btn-secondary" data-roster-action="generate">${esc(t('generate','Generate codes locally'))}</button><button type="button" class="btn btn-secondary" data-roster-action="save"${local.entries.length?'':' disabled'}>${esc(t('export','Save voter list'))}</button><button type="button" class="btn btn-secondary" data-roster-action="csv"${local.entries.length?'':' disabled'}>${esc(t('csv','Export for distribution'))}</button><button type="button" class="btn btn-secondary" data-roster-pick="json"><i class="fa-solid fa-folder-open" aria-hidden="true"></i> ${esc(t('import','Open a saved voter list'))}</button><input type="file" accept="application/json,.json" data-roster-import hidden><button type="button" class="btn btn-secondary" data-roster-pick="csv"><i class="fa-solid fa-file-csv" aria-hidden="true"></i> ${esc(t('importCsv','Generate codes from a resident CSV'))}</button><input type="file" accept="text/csv,.csv,text/plain" data-roster-import-csv hidden></div>`
                + `<p class="agreement-hint">${esc(t('csvHint','The CSV needs Person and Household columns, one resident per row.'))}</p>`
                + `<p role="status" data-roster-progress>${!local.saved?esc(t('saveFirst','Save your voter-list file before saving this agreement. Keep the file to distribute codes and resume later.')):''}</p>`
                + (local.value?`<button type="button" class="btn btn-quiet" data-roster-action="remove">${esc(t('remove','Remove code voting from this draft'))}</button>`:'')
                + (local.entries.length?`<details><summary>${esc(t('showCodes','Show local code assignments'))}</summary><div class="voting-table-wrap"><table class="voting-table"><thead><tr><th>${esc(t('person','Person (local only)'))}</th><th>${esc(t('household','Household (local only)'))}</th><th>${esc(t('code','Voting code'))}</th></tr></thead><tbody>${local.entries.map((row,index)=>`<tr><td>${esc(row.label)}</td><td><input type="text" data-roster-household="${index}" value="${esc(row.household || '')}" aria-label="${esc(t('householdOf','Household of {{person}}',{person:row.label || row.code}))}" autocomplete="off" spellcheck="false"></td><td class="voting-code">${esc(row.code)}</td></tr>`).join('')}</tbody></table></div></details>`:'');
        }
        function ruleHtml() {
            const rule=ruleOf(local.rule);
            return `<label class="proposal-editor-field"><span>${esc(t('rule','Ballot rule'))}</span><select data-roster-rule>`
                + `<option value="">${esc(t('ruleNone','None — show the totals only'))}</option>`
                + Rules().list().concat(rule && !Rules().list().includes(rule)?[rule]:[]).map(row=>`<option value="${esc(`${row.id}@${row.version}`)}"${`${row.id}@${row.version}`===local.rule?' selected':''}>${esc(ruleText(row,'name'))}</option>`).join('')
                + '</select></label>'
                + (rule?`<p class="agreement-hint" data-roster-rule-source>${esc(ruleText(rule,'source'))} ${rule.sources.map(source=>`<a class="cb-link" href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.label)}</a>`).join(' · ')}</p>`:'');
        }
        function progress(done,total) {const node=slot.querySelector('[data-roster-progress]');if(node)node.textContent=t('progress','Preparing codes: {{done}} / {{total}}',{done,total});}
        async function run(control,work) {
            if(local.busy)return;
            local.busy=true;local.error=null;notify();
            try{await root.BusyControl.track(control,work);}catch(e){local.error=e.message;}
            finally{local.busy=false;notify();render();}
        }
        slot.oninput=event=>{
            if(event.target.matches('[data-roster-labels]'))local.labels=event.target.value;
            if(event.target.matches('[data-roster-count]'))local.count=Number(event.target.value);
            if(event.target.matches('[data-roster-household-batch]'))local.household=event.target.value;
        };
        slot.onchange=event=>{
            if(event.target.matches('[data-roster-rule]')) {
                local.rule=event.target.value;
                // The rule is part of the record; a reopened draft keeps its codes and households.
                if(local.value)local.value=configure(local.value.codeHashes);
                notify();render();slot.querySelector('[data-roster-rule]')?.focus();
                return;
            }
            if(event.target.matches('[data-roster-household]')) {
                const row=local.entries[Number(event.target.dataset.rosterHousehold)];if(!row)return;
                row.household=event.target.value.trim().slice(0,500);
                local.value=configure(local.value.codeHashes);local.saved=false;notify();
                const node=slot.querySelector('[data-roster-progress]');
                if(node)node.textContent=t('saveFirst','Save your voter-list file before saving this agreement. Keep the file to distribute codes and resume later.');
                return;
            }
            if(event.target.matches('[data-roster-import-csv]') && event.target.files[0]) {
                const file=event.target.files[0];
                run(slot.querySelector('[data-roster-pick="csv"]') || event.target,async()=>{
                    if(file.size>8*1024*1024)throw new Error(t('fileLarge','The voter-list file is too large.'));
                    await generate(V().residentsCsv(await file.text()));
                });
                return;
            }
            if(!event.target.matches('[data-roster-import]') || !event.target.files[0])return;
            const file=event.target.files[0];
            run(slot.querySelector('[data-roster-pick="json"]') || event.target,async()=>{
                if(file.size>8*1024*1024)throw new Error(t('fileLarge','The voter-list file is too large.'));
                const imported=await V().importLocalFile(JSON.parse(await file.text()),progress);
                if(local.value && !root.confirm(t('replaceLocal','Replace this draft’s voter list with the selected file?')))return;
                local.id=imported.votingId;local.entries=imported.entries;local.saved=true;
                local.value=configure(local.entries.map(row=>row.codeHash));
            });
        };
        slot.onclick=event=>{
            // Native buttons open the hidden file pickers, so both imports work from the keyboard.
            const pick=event.target.closest('[data-roster-pick]');
            if(pick){if(!pick.disabled && !local.busy)slot.querySelector(pick.dataset.rosterPick==='csv'?'[data-roster-import-csv]':'[data-roster-import]')?.click();return;}
            const button=event.target.closest('[data-roster-action]');if(!button || button.disabled)return;
            run(button,async()=>{
                const action=button.dataset.rosterAction;
                if(action==='generate') {
                    const lines=local.labels.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
                    const labels=lines.length?lines:Array.from({length:Math.max(0,Math.min(101,local.count || 0))},()=> '');
                    if(!labels.length || labels.length>V().MAX_BATCH)throw new Error(t('batch','Generate between 1 and 100 codes at a time.'));
                    const household=local.household.trim().slice(0,500);
                    await generate(labels.map(label=>({label,household})));
                    local.labels='';local.household='';
                }
                if(action==='save'){download('voter-list.json',JSON.stringify(V().localFile(local.id,local.entries),null,2),'application/json');local.saved=true;}
                if(action==='csv')download('voting-codes.csv',V().distributionCsv(local.entries),'text/csv;charset=utf-8');
                if(action==='remove' && root.confirm(t('removeConfirm','Remove code voting from this draft? Save your voter list first if you need it.'))) {
                    local.value=null;local.entries=[];local.id=root.crypto.randomUUID();local.saved=true;
                }
            });
        };
        render();
        return {busy:()=>local.busy || !local.saved,destroy(){alive=false;slot.oninput=null;slot.onchange=null;slot.onclick=null;}};
    }
    root.CommunityVotingRoster={mount};
})(typeof window!=='undefined'?window:globalThis);
