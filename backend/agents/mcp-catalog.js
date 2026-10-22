// Shared advertised tool catalogue, checked against actual MCP registration in protocol tests.
export const MCP_LOCAL_TOOLS = Object.freeze([
    'ugt_capabilities', 'ugt_activity', 'ugt_list_agreements', 'ugt_get_agreement', 'ugt_list_attesters',
    'ugt_support_status', 'ugt_oracle_events', 'ugt_inspect_verified_fact', 'ugt_publish_design', 'ugt_propose_agreement',
    'ugt_chain_agreements', 'ugt_chain_agreement', 'ugt_bet_on_account', 'ugt_mint_agreement', 'ugt_fund_agreement', 'ugt_bet_on_agreement',
    'ugt_buy_verified_fact', 'ugt_request_ownership', 'ugt_pledge', 'ugt_donate', 'ugt_refund_donation', 'ugt_void_pledge',
    'ugt_revoke_pledge', 'ugt_release_donations', 'ugt_fulfill_pledge', 'ugt_resolve_market', 'ugt_claim_market',
    'ugt_resolve_external_market', 'ugt_claim_external_market',
    'ugt_approval_link', 'ugt_find_place', 'ugt_parcel_context', 'ugt_list_designs', 'ugt_get_design', 'ugt_markets', 'ugt_explain',
    'ugt_draft_road', 'ugt_draft_building', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule',
    'ugt_modify_design', 'ugt_compare', 'ugt_draft_agreement'
]);
export const MCP_HOSTED_TOOLS = Object.freeze([...MCP_LOCAL_TOOLS.slice(0, 10), ...MCP_LOCAL_TOOLS.slice(29)]);
