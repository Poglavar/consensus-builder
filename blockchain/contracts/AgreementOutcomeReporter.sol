// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Agreement.sol";
import "./IConditionalMarkets.sol";

/// The Conditional Tokens oracle of agreement markets (README-agreement-markets.md). The question is
/// the agreement key with two outcome slots, index 0 NO and index 1 YES, and the answer is already on
/// chain: anyone may call `report` once the agreement has left Active, and it reads the Agreement
/// contract and reports Executed as YES, Cancelled or Expired as NO. No admin, no off-chain input.
contract AgreementOutcomeReporter {
    uint256 public constant OUTCOME_SLOTS = 2;
    uint256 public constant NO = 0;
    uint256 public constant YES = 1;

    Agreement public immutable agreement;
    IConditionalTokens public immutable conditionalTokens;

    event OutcomeReported(bytes32 indexed key, bytes32 indexed conditionId, uint8 status, uint256 outcome);

    error AgreementActive(bytes32 key);
    error UnknownStatus(bytes32 key, uint8 status);

    constructor(Agreement agreement_, IConditionalTokens conditionalTokens_) {
        agreement = agreement_;
        conditionalTokens = conditionalTokens_;
    }

    /// The condition of the agreement `key`: keccak256(this reporter, key, 2) in Conditional Tokens.
    function conditionIdOf(bytes32 key) public view returns (bytes32) {
        return conditionalTokens.getConditionId(address(this), key, OUTCOME_SLOTS);
    }

    /// Reports the outcome of a settled agreement. Reverts while it is Active, for an unknown key
    /// (Agreement.NoSuchAgreement), when the condition was never prepared, and on a second report.
    function report(bytes32 key) external {
        uint8 status = agreement.get(key).status;
        uint256 outcome;
        if (status == agreement.STATUS_EXECUTED()) outcome = YES;
        else if (status == agreement.STATUS_CANCELLED() || status == agreement.STATUS_EXPIRED()) outcome = NO;
        else if (status == agreement.STATUS_ACTIVE()) revert AgreementActive(key);
        else revert UnknownStatus(key, status);
        uint256[] memory payouts = new uint256[](OUTCOME_SLOTS);
        payouts[outcome] = 1;
        conditionalTokens.reportPayouts(key, payouts);
        emit OutcomeReported(key, conditionIdOf(key), status, outcome);
    }
}
