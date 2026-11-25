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
    const MEASURE_TEXT = {
        'cast-support':['measureCastSupport','Support among votes cast'],
        'eligible-support':['measureEligibleSupport','Support among all eligible voters'],
        'household-turnout':['measureHouseholdTurnout','Households that voted'],
        'household-support':['measureHouseholdSupport','Voting households with a Support vote']
    };
    // The ballot rule's tests with what each needs, and the result: provisional while voting is open.
    function ruleHtml(summary) {
        const result=summary.rule, rule=root.CommunityBallotRules?.get(result.id,result.version);
        const name=rule?t(`ballotRules.${rule.id}.name`,rule.text.name):result.id;
        const badge=result.final?(result.passed?['passed','success',t('passed','Passed')]:['failed','danger',t('failed','Failed')])
            :(result.passed?['passing','info',t('passing','Passing')]:['not-passing','warning',t('notPassing','Not passing')]);
        return `<section class="voting-rule" data-voting-rule="${esc(badge[0])}" aria-label="${esc(t('rule','Ballot rule'))}">`
            + `<div class="voting-meter-head"><h4>${esc(name)}</h4><span class="cb-badge cb-badge--${badge[1]}" role="status">${esc(badge[2])}</span></div>`
            + `<ul class="voting-tests">${result.tests.map(test=>{
                const [key,fallback]=MEASURE_TEXT[test.measure] || [test.measure,test.measure];
                const share=root.CbFormat.formatPercent(test.numerator/test.denominator,{maxFractionDigits:1});
                const detail=t('testDetail','{{count}} of {{total}} · needs {{needed}} ({{rule}})',{count:root.CbFormat.formatNumber(test.count),
                    total:root.CbFormat.formatNumber(test.total),needed:root.CbFormat.formatNumber(test.needed),
                    rule:test.strict?t('moreThan','more than {{share}}',{share}):t('atLeast','at least {{share}}',{share})});
                return `<li data-voting-test="${esc(test.measure)}" data-met="${test.met}"><span class="voting-test-mark">${test.met?'<i class="fa-solid fa-check" aria-hidden="true"></i>':'<i class="fa-solid fa-xmark" aria-hidden="true"></i>'}</span>`
                    + `<span>${esc(t(key,fallback))}: <strong>${esc(detail)}</strong> <span class="voting-test-state">${esc(test.met?t('met','met'):t('notMet','not met'))}</span></span></li>`;
            }).join('')}</ul>`
            + (rule?`<p class="voting-tally-note">${esc(t(`ballotRules.${rule.id}.source`,rule.text.source))} ${rule.sources.map(source=>`<a class="cb-link" href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.label)}</a>`).join(' · ')}</p>`:'')
            + '</section>';
    }
    // Owner agreements on the same plan: their sign-off is a separate tally in their own panels.
    function ownersHtml(owners) {
        if(!owners)return '';
        const list=owners.rows;
        return `<section class="voting-owners" aria-label="${esc(t('ownerSignOff','Owner sign-off'))}"><h4>${esc(t('ownerSignOff','Owner sign-off'))}</h4>`
            + (owners.error?`<p class="voting-tally-note">${esc(owners.error)}</p>`
                : !list.length?`<p class="voting-tally-note">${esc(t('ownerNone','No owners’ agreement on this plan yet. Owners decide in a separate agreement on the same plan.'))}</p>`
                : `<ul class="voting-owner-list">${list.map(row=>`<li><span>${esc(row.title || t('ownerAgreement','Owners’ agreement'))} <span class="cb-badge cb-badge--neutral">${esc(row.binding?t('ownerDeal','Owner deal'):t('ownerVote','Owner vote'))}</span></span>`
                    + `<button type="button" class="btn btn-sm btn-secondary" data-voting-action="open-owner" data-voting-owner="${esc(row.cid)}">${esc(t('openOwner','Open'))}</button></li>`).join('')}</ul>`)
            + '</section>';
    }
    function tallyHtml(summary) {
        const {votes,eligible,counts}=summary;
        const percent=(value,total)=>root.CbFormat.formatPercent(total?value/total:0,{maxFractionDigits:1});
        const turnout=t('turnoutCount','{{votes}} of {{eligible}} voted · {{percent}}',{
            votes:root.CbFormat.formatNumber(votes),eligible:root.CbFormat.formatNumber(eligible),percent:percent(votes,eligible)});
        return `<section class="voting-tally" aria-label="${esc(t('results','Voting progress'))}">`
            + `<h4>${esc(t('results','Voting progress'))}</h4><div class="voting-meter-head"><span>${esc(t('turnout','Turnout'))}</span><strong>${esc(turnout)}</strong></div>`
            + `<progress class="voting-meter" data-voting-meter="turnout" value="${esc(votes)}" max="${Math.max(1,eligible)}" aria-label="${esc(t('turnout','Turnout'))}" aria-valuetext="${esc(turnout)}"></progress>`
            + `<p class="voting-tally-note">${esc(t('remaining','Not yet voted: {{count}}',{count:root.CbFormat.formatNumber(eligible-votes)}))}</p>`
            + (summary.households?`<p class="voting-tally-note" data-voting-households>${esc(t('householdsVoted','Households voted: {{voted}} of {{eligible}}',{
                voted:root.CbFormat.formatNumber(summary.households.voted),eligible:root.CbFormat.formatNumber(summary.households.eligible)}))}</p>`:'')
            + `<p class="voting-tally-note">${esc(t('castShare','Share of votes cast'))}</p>`
            + V().CHOICES.map(choice=>{
                const detail=`${root.CbFormat.formatNumber(counts[choice])} · ${percent(counts[choice],votes)}`;
                return `<div class="voting-result" data-voting-result="${choice}"><div class="voting-meter-head"><span>${esc(choiceText(choice))}</span><strong>${esc(detail)}</strong></div>`
                    + `<progress class="voting-meter" data-voting-meter="${choice}" value="${esc(counts[choice])}" max="${Math.max(1,votes)}" aria-label="${esc(choiceText(choice))}" aria-valuetext="${esc(detail)}"></progress></div>`;
            }).join('')
            + (summary.rule?ruleHtml(summary):'')
            + button('results',t('refreshResults','Refresh results'))+'</section>';
    }
    function refusal(code) {
        return ({
            'invalid-code':t('invalidCode','That code was not recognised. Check the letters and try again.'),
            'try-later':t('tryLater','Please wait before trying again.'),
            'vote-changed':t('voteChanged','Your vote changed elsewhere. Check its history before submitting again.'),
            'voting-closed':t('closed','Voting has closed. You can still check your vote and its history.')
        })[code] || t('requestFailed','The request failed.');
    }
    function createView(win, cid, planCid) {
        let slot=null;
        const state={cid,planCid,summary:null,owners:null,code:null,ballot:null,busy:false};
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
        // Published owners' agreements on this plan, read from the public index.
        async function owners() {
            if(!state.planCid)return;
            try {
                const base=String(win.resolveBackendBaseUrl() || '').replace(/\/$/,'');
                const response=await win.fetch(`${base}/agreements?plan=${encodeURIComponent(state.planCid)}&limit=50`,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(45000)});
                if(!response.ok)throw new Error(`HTTP ${response.status}`);
                const rows=(await response.json()).agreements || [];
                state.owners={rows:rows.filter(row=>row.content?.rule?.electorate==='owners' && row.planCid===state.planCid)
                    .map(row=>({cid:row.cid,title:row.title || row.content.title || null,binding:row.content.rule.binding===true}))};
            } catch(error) {
                console.warn(`[${new Date().toISOString()}] [CommunityVoting] owners' agreements on ${state.planCid} could not be read`,error);
                state.owners={rows:[],error:t('ownerUnavailable','Owners’ agreements on this plan could not be read.')};
            }
        }
        async function openOwner(id) {
            const local=win.AgreementStore?.get?.(id);
            const resolved=local?{agreement:local,readOnly:false,designs:[]}:await win.AgreementSync.resolveDetails(id);
            await win.ClickStack.showAgreement(resolved.agreement,{readOnly:resolved.readOnly,designs:resolved.designs});
        }
        async function refresh() {
            await owners();
            state.summary=await request('');
            if(state.code) {state.ballot=await request('/access',{code:state.code});state.summary=state.ballot;}
        }
        function draw() {
            const s=state, summary=s.summary, entry=s.ballot?.entry;
            const closed=summary?.closed;
            const history=entry?.history || [];
            slot.innerHTML=`<h3>${esc(t('title','Vote with a code'))}</h3>`
                + (summary?tallyHtml(summary):'')
                + ownersHtml(s.owners)
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
                        state.ballot=await request('/access',{code});state.summary=state.ballot;state.code=code;state.selected=state.ballot.entry.choice;
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
                    if(action==='results') {await owners();state.summary=await request('');}
                    if(action==='open-owner') await openOwner(control.dataset.votingOwner);
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
                if(!views.has(cid))views.set(cid,createView(win,cid,agreement.plan?.cid || null));
                views.get(cid).render(slot);
            },
            reset(){for(const view of views.values())view.reset();}
        };
    }
    root.CommunityVotingUI={createController};
})(typeof window !== 'undefined' ? window : globalThis);
