// The one list of the Solana program ids whose address changes with the agreement account layout:
// agreement, and proposal_pledge and proposal_market, which read agreement accounts. Each has the
// current devnet id (what this app writes to and reads) and its retired ids, newest first (deployed
// and still on chain, never written to again; readers such as parcel history may name them). The
// browser clients (agreement-client.js, pledge-client.js, market-client.js, lmsr-client.js) and the
// backend read these; blockchain/solana/Anchor.toml and the programs' declare_id! restate the current
// ids (agreement-client.test.js checks they agree). UMD: window.SolanaProgramIds in the browser,
// module.exports for node; load it before those clients.
(function attachSolanaProgramIds(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaProgramIds = api;
})(typeof window !== 'undefined' ? window : globalThis, function solanaProgramIdsFactory() {
    'use strict';

    const program = (current, retired) => Object.freeze({ current, retired: Object.freeze(retired) });

    const programs = Object.freeze({
        // 612-byte account with the plan CID hash (programs/agreement/README.md).
        agreement: program('6X5ihiKNpsF39eYzWGaw7swgYa6vouZ8gT1LHB5H86Cb', [
            // 580-byte lens-set layout, deployed 2026-11-25.
            'ESJ1w3rpzXtUXcZFgRfzHYRBzcrT7HeCychLNXvdBeYH',
            // 296-byte single-lens layout, deployed 2026-10-23.
            'GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ'
        ]),
        proposal_pledge: program('DY4zKtE1hucUHsQGDhQmBaH3ZdAaeusnmj9HzVtpmYnK', [
            '5RvXB53atCdCkDEydpvgUDz4Ph6uFUVyMgpjdSzNwXAq',
            '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g'
        ]),
        proposal_market: program('79dH9KGrbffN37Hv1mbyUWdbHAVcCt6o2Z1VZ3c745Bn', [
            '9S7jXSkWyDYF1W95E8JYDwjpqR9tfXZiMKc6L3NGgJ71',
            'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB'
        ])
    });

    return Object.freeze({
        programs,
        AGREEMENT_PROGRAM_ID: programs.agreement.current,
        PLEDGE_PROGRAM_ID: programs.proposal_pledge.current,
        MARKET_PROGRAM_ID: programs.proposal_market.current,
        // The current id first, then the retired ones: every program an agreement account may live under.
        AGREEMENT_PROGRAM_IDS: Object.freeze([programs.agreement.current, ...programs.agreement.retired]),
        RETIRED_AGREEMENT_PROGRAM_IDS: programs.agreement.retired
    });
});
