// Imports an explicitly requested Affordabot package into the existing local draft editor.
(function attachAffordabotHandoff(root, factory) {
    const api=factory(root);
    if(typeof module==='object'&&module.exports)module.exports=api;
    if(root)root.AffordabotHandoff=api;
})(typeof window!=='undefined'?window:globalThis,function createAffordabotHandoff(root){
    'use strict';
    const key='consensus-builder.affordabot.handoff.v1';
    function importPackage(entry,{store,adapter,cityId='zagreb'}={}){
        const proposal=entry?.proposal;
        if(entry?.version!==1||proposal?.agent?.persona!=='affordabot'||proposal?.affordabilityResearch?.status!=='research-draft'
            ||proposal.city!==cityId||!proposal.geometry?.buildings?.length||!proposal.cadastreParcelIds?.length)throw new Error('Invalid Affordabot handoff');
        if(!store?.createDraft||!adapter?.draftFromProposal)throw new Error('Proposal editor is not ready');
        const input=adapter.draftFromProposal(proposal);
        // This is a NEW design draft. The research package is its starting content, not an existing
        // proposal to replace, and importing it creates no public/server record.
        const draft=store.createDraft({...input,cityId,goal:'single',sourceSnapshot:proposal,sourceProposalId:null,state:'editing'});
        if(!store.getDraft(draft.id))throw new Error('Draft was not saved');
        return draft;
    }
    async function openRequestedDraft(){
        const url=new URL(root.location.href),token=url.searchParams.get('affordabotDraft');
        const navigation=root.document?.getElementById('affordabot-link');
        if(navigation){const target=new URL(navigation.href);target.searchParams.set('lang',root.i18n.getLanguage());
            if(['localhost','127.0.0.1'].includes(root.location.hostname)&&root.getBackendBase)target.searchParams.set('backend',root.getBackendBase());navigation.href=target.href;}
        if(!token)return null;
        try{
            if(root.PersistentStorage?.ready)await root.PersistentStorage.ready;
            const raw=root.localStorage.getItem(key);if(!raw)throw new Error('Research package is missing');
            const entry=JSON.parse(raw);if(entry.token!==token)throw new Error('Research package does not match this request');
            const cityId=root.CityConfigManager?.getCurrentCityId?.();if(cityId!=='zagreb')throw new Error('Open the draft in its original city');
            const draft=importPackage(entry,{store:root.proposalDraftStore,adapter:root.proposalEditorAdapterRegistry?.get('single'),cityId});
            root.openProposalEditorShell(draft.id,{tab:'design'});
            root.localStorage.removeItem(key);url.searchParams.delete('affordabotDraft');root.history.replaceState(null,'',url.href);
            return draft;
        }catch(error){
            console.error(`[Affordabot] ${error.message}`);
            const message=root.i18n.t('affordabot.handoffFailed');
            if(root.showStyledAlert)root.showStyledAlert(message);else root.alert(message);
            return null;
        }
    }
    return Object.freeze({importPackage,openRequestedDraft});
});
