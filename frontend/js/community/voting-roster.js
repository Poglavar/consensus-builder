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
        const local={id:value?.id || root.crypto.randomUUID(),entries:[],value,busy:false,labels:'',count:10,saved:true,error:null};
        let alive=true;
        const download=(name,content,type)=>{
            const url=URL.createObjectURL(new Blob([content],{type}));
            const link=root.document.createElement('a');link.download=name;link.href=url;link.click();URL.revokeObjectURL(url);
        };
        const notify=()=>changed(local.value,local.busy || !local.saved);
        function render() {
            if(!alive)return;
            slot.innerHTML=`<h4>${esc(t('prepare','Voting codes'))}</h4><p class="agreement-hint">${esc(t('immutable','Prepare the complete voter list before publishing. Changing eligible codes requires a new agreement with its own votes.'))}</p>`
                + `<p class="agreement-hint">${esc(t('localOnly','Names and contact details stay in this browser and your downloaded voter list. Only code hashes enter the agreement.'))}</p>`
                + `<p>${esc(t('prepared','{{count}} eligible codes prepared',{count:local.value?.codeHashes.length || 0}))}</p>`
                + (local.error?`<p role="alert">${esc(local.error)}</p>`:'')
                + `<label class="proposal-editor-field"><span>${esc(t('labels','People or contact details — one person per line (optional)'))}</span><textarea data-roster-labels rows="3" autocomplete="off" spellcheck="false">${esc(local.labels)}</textarea></label>`
                + `<label class="proposal-editor-field"><span>${esc(t('count','Or number of unassigned codes'))}</span><input type="number" data-roster-count min="1" max="100" value="${local.count}"></label>`
                + `<div class="cb-actions"><button type="button" class="btn btn-secondary" data-roster-action="generate">${esc(t('generate','Generate codes locally'))}</button><button type="button" class="btn btn-secondary" data-roster-action="save"${local.entries.length?'':' disabled'}>${esc(t('export','Save voter list'))}</button><button type="button" class="btn btn-secondary" data-roster-action="csv"${local.entries.length?'':' disabled'}>${esc(t('csv','Export for distribution'))}</button><label class="btn btn-secondary" data-roster-open><i class="fa-solid fa-folder-open" aria-hidden="true"></i> ${esc(t('import','Open a saved voter list'))}<input type="file" accept="application/json,.json" data-roster-import hidden></label></div>`
                + `<p role="status" data-roster-progress>${!local.saved?esc(t('saveFirst','Save your voter-list file before saving this agreement. Keep the file to distribute codes and resume later.')):''}</p>`
                + (local.value?`<button type="button" class="btn btn-quiet" data-roster-action="remove">${esc(t('remove','Remove code voting from this draft'))}</button>`:'')
                + (local.entries.length?`<details><summary>${esc(t('showCodes','Show local code assignments'))}</summary><div class="voting-table-wrap"><table class="voting-table"><thead><tr><th>${esc(t('person','Person (local only)'))}</th><th>${esc(t('code','Voting code'))}</th></tr></thead><tbody>${local.entries.map(row=>`<tr><td>${esc(row.label)}</td><td class="voting-code">${esc(row.code)}</td></tr>`).join('')}</tbody></table></div></details>`:'');
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
        };
        slot.onchange=event=>{
            if(!event.target.matches('[data-roster-import]') || !event.target.files[0])return;
            const file=event.target.files[0];
            run(event.target.closest('label') || event.target,async()=>{
                if(file.size>8*1024*1024)throw new Error(t('fileLarge','The voter-list file is too large.'));
                const imported=await V().importLocalFile(JSON.parse(await file.text()),progress);
                if(local.value && !root.confirm(t('replaceLocal','Replace this draft’s voter list with the selected file?')))return;
                local.id=imported.votingId;local.entries=imported.entries;local.saved=true;
                local.value=V().configuration({schema:'community-voting/v1',id:local.id,codeHashes:local.entries.map(row=>row.codeHash)});
            });
        };
        slot.onclick=event=>{
            const button=event.target.closest('[data-roster-action]');if(!button || button.disabled)return;
            run(button,async()=>{
                const action=button.dataset.rosterAction;
                if(action==='generate') {
                    if(local.value && !local.entries.length)throw new Error(t('restoreFirst','Open your saved voter list before adding codes to this draft.'));
                    const lines=local.labels.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
                    const labels=lines.length?lines:Array.from({length:Math.max(0,Math.min(101,local.count || 0))},()=> '');
                    if(local.entries.length+labels.length>V().MAX_ENTRIES)throw new Error(t('tooMany','A consultation supports up to 10,000 codes.'));
                    const added=await V().generateEntries(local.id,labels,root.crypto,progress);
                    const next=local.entries.concat(added);
                    local.value=V().configuration({schema:'community-voting/v1',id:local.id,codeHashes:next.map(row=>row.codeHash)});
                    local.entries=next;local.labels='';local.saved=false;
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
