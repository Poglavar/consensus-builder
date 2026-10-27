// MCP uses the same ballot endpoints as the site. Contact assignments never enter these schemas.
export function createMcpVotingTools({read}) {
    return {
        votingStatus({agreementCid,code}) {
            return read.request(`/agreements/${encodeURIComponent(agreementCid)}/voting${code==null?'':'/access'}`,{},code==null?undefined:{code});
        },
        castCommunityVote({agreementCid,code,choice,expectedVersion,requestId,confirm}) {
            if(confirm!==true)throw Object.assign(new Error('Confirm the vote and exact agreement before submitting.'),{code:'confirmation-required'});
            return read.request(`/agreements/${encodeURIComponent(agreementCid)}/voting/ballot`,{},{code,choice,expectedVersion,requestId});
        }
    };
}
