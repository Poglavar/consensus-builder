// Accessible voting and private ballot history for an immutable code list.
(function (root) {
    'use strict';
    const V = () => root.CommunityVoting;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    function t(key, fallback, params = {}) {
        const translated = root.i18n?.t?.(`voting.${key}`,params);
        return String(translated && translated !== `voting.${key}` ? translated : fallback).replace(/\{\{(\w+)\}\}/g,(_,name)=>params[name] ?? '');
    }
    const choiceText = choice => ({support:t('support','Support'),oppose:t('oppose','Oppose'),abstain:t('abstain','Abstain')})[choice] || t('noVote','No vote yet');
    const button = (action,label,disabled=false) => `<button type="button" class="btn btn-sm btn-secondary" data-voting-action="${action}"${disabled?' disabled':''}>${esc(label)}</button>`;
    function refusal(code) {
        return ({
            'invalid-code':t('invalidCode','That code was not recognised. Check the letters and try again.'),
            'try-later':t('tryLater','Please wait before trying again.'),
            'vote-changed':t('voteChanged','Your vote changed elsewhere. Check its history before submitting again.'),
            'voting-closed':t('closed','Voting has closed. You can still check your vote and its history.')
        })[code] || t('requestFailed','The request failed.');
    }
    function createView(win, cid) {
        let slot=null;
        const state={cid,summary:null,code:null,ballot:null,busy:false};
        function redraw() { if (slot?.isConnected && state) draw(); }
        async function request(suffix,body) {
            const base=String(win.resolveBackendBaseUrl() || '').replace(/\/$/,'');
            const response=await win.fetch(`${base}/agreements/${encodeURIComponent(state.cid)}/voting${suffix}`,{
                method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
                cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(45000),...(body?{body:JSON.stringify(body)}:{})
            });
            const result=await response.json();
            if (!response.ok) throw Object.assign(new Error(refusal(result.code)),{code:result.code,retryAfter:result.retryAfter || Number(response.headers.get('Retry-After')) || 0});
            if(result.agreementCid!==state.cid) throw new Error(t('wrongResponse','The server returned a different consultation.'));
            return result;
        }
        async function refresh() {
            state.summary=await request('');
            if(state.code) state.ballot=await request('/access',{code:state.code});
        }
        function draw() {
            const s=state, summary=s.summary, entry=s.ballot?.entry;
            const closed=summary?.closed;
            const history=entry?.history || [];
            slot.innerHTML=`<h3>${esc(t('title','Vote with a code'))}</h3>`
                + (summary?`<p class="agreement-panel-meta">${esc(t('totals','{{votes}} votes · {{eligible}} eligible codes',{votes:summary.votes,eligible:summary.eligible}))}</p>`
                    + `<p class="agreement-panel-meta">${V().CHOICES.map(choice=>`${esc(choiceText(choice))}: ${summary.counts[choice]}`).join(' · ')}</p>`:'')
                + (closed?`<p class="cb-notice">${esc(t('closed','Voting has closed. You can still check your vote and its history.'))}</p>`:'')
                + (s.error?`<p role="alert" class="agreement-panel-note agreement-panel-note--danger">${esc(s.error)}</p>`:'')
                + (s.success?`<p role="status" class="agreement-panel-meta">${esc(s.success)}</p>`:'')
                + (!entry?`<form data-voting-access><label class="proposal-editor-field"><span>${esc(t('code','Your voting code'))}</span><input type="text" data-voting-code class="voting-code" value="${esc(s.inputCode || '')}" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" maxlength="100" placeholder="KRM-TAV-DBN-WEX-HPS" required></label><p class="agreement-panel-hint">${esc(t('codeHint','Enter the code from your organiser. Spaces, dashes and lowercase letters are accepted.'))}</p><button class="btn btn-primary" type="submit">${esc(t('check','Check my vote'))}</button></form>`
                    : `<p class="voting-current">${esc(t('current','Your current vote'))}: <strong>${esc(choiceText(entry.choice))}</strong></p>`
                    + `<form data-voting-ballot><fieldset class="voting-choices"${closed?' disabled':''}><legend>${esc(t('choose','Choose your vote'))}</legend>${V().CHOICES.map(choice=>`<label><input type="radio" name="community-vote" value="${choice}"${choice===(s.selected || entry.choice)?' checked':''} required> ${esc(choiceText(choice))}</label>`).join('')}<button class="btn btn-primary" type="submit">${esc(t('saveVote','Save my vote'))}</button></fieldset></form>`
                    + `<div class="cb-actions">${button('refresh',t('refresh','Refresh history'))}${button('leave',t('leave','Use another code'))}</div>`
                    + `<h4>${esc(t('history','Your vote history'))}</h4><p class="agreement-panel-hint">${esc(t('historyHint','Every change made with your code appears here. Contact the organiser if you do not recognise a change.'))}</p>`
                    + `<div class="voting-table-wrap"><table class="voting-table"><thead><tr><th>${esc(t('when','When'))}</th><th>${esc(t('action','Action'))}</th><th>${esc(t('choice','Vote'))}</th></tr></thead><tbody>${history.map(event=>`<tr><td><time datetime="${esc(event.occurredAt)}">${esc(win.CbFormat?.formatDateTime?.(event.occurredAt) || new Date(event.occurredAt).toLocaleString())}</time></td><td>${esc(t('voteRecorded','Vote recorded'))}</td><td>${esc(choiceText(event.choice))}</td></tr>`).join('')}</tbody></table></div>`)
                ;
        }
        async function run(control, work) {
            if(state.busy || win.BusyControl.isBusy(control)) return;
            const current=state; current.busy=true; current.error=null; current.success=null;
            try { await win.BusyControl.track(control,work); }
            catch(e) {
                current.error=e.message+(e.retryAfter?t('wait',' Try again in {{seconds}} seconds.',{seconds:e.retryAfter}):'');
                if(e.code==='vote-changed') { current.ballot=null; current.inputCode=current.code; }
            } finally { current.busy=false; if(current===state) redraw(); }
        }
        function wire() {
            slot.oninput=event=>{
                if(event.target.matches('[data-voting-code]')) state.inputCode=event.target.value;
                if(event.target.matches('[name="community-vote"]')) state.selected=event.target.value;
            };
            slot.onsubmit=event=>{
                event.preventDefault();event.stopPropagation();
                const control=event.submitter || event.target.querySelector('[type="submit"]');
                run(control,async()=>{
                    if(event.target.matches('[data-voting-access]')) {
                        const code=state.inputCode || ''; 
                        state.ballot=await request('/access',{code});state.code=code;state.selected=state.ballot.entry.choice;
                    } else {
                        await request('/ballot',{code:state.code,choice:state.selected || state.ballot.entry.choice,expectedVersion:state.ballot.entry.version,requestId:win.crypto.randomUUID()});
                        state.ballot=await request('/access',{code:state.code});state.summary=state.ballot;
                        state.success=t('saved','Your vote was saved and read back.');
                    }
                });
            };
            slot.onclick=event=>{
                const control=event.target.closest('[data-voting-action]');
                if(!control || control.disabled) return;
                const action=control.dataset.votingAction;
                run(control,async()=>{
                    if(action==='refresh') await refresh();
                    if(action==='leave') {state.code=null;state.inputCode='';state.ballot=null;state.selected=null;}
                });
            };
        }
        function render(nextSlot) {
            slot=nextSlot;
            if(!slot)return;
            draw();wire();
            if(!state.loaded) {state.loaded=true;run(slot.querySelector('[type="submit"]'),refresh);}
        }
        return {render,reset(){slot=null;}};
    }
    function createController(win) {
        const views=new Map();
        return {
            render(slot,agreement) {
                const cid=agreement?.published?.cid;
                if(!slot || !cid || !agreement.consultation?.voting)return;
                if(!views.has(cid))views.set(cid,createView(win,cid));
                views.get(cid).render(slot);
            },
            reset(){for(const view of views.values())view.reset();}
        };
    }
    root.CommunityVotingUI={createController};
})(typeof window !== 'undefined' ? window : globalThis);
