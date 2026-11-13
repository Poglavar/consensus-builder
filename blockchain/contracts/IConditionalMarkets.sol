// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// The parts of the Gnosis Conditional Tokens (npm @gnosis.pm/conditional-tokens-contracts 1.0.3) and
// LMSR market maker (@gnosis.pm/conditional-tokens-market-makers 1.8.1) that the agreement markets
// call. Those contracts are solc 0.5 and cannot be imported into 0.8 code, so they are reached
// through these interfaces; see README-agreement-markets.md.

interface IConditionalTokens {
    function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external;
    function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external;
    function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external;
    function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external pure returns (bytes32);
    function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256);
    function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32);
    function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256);
    function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256);
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function setApprovalForAll(address operator, bool approved) external;
}

interface ILMSRMarketMaker {
    /// Positive amounts buy outcome tokens from the maker, negative ones sell to it; index 0 is NO and
    /// index 1 YES for an agreement market. Returns the collateral paid (positive) or received.
    function trade(int256[] calldata outcomeTokenAmounts, int256 collateralLimit) external returns (int256 netCost);
    function calcNetCost(int256[] calldata outcomeTokenAmounts) external view returns (int256 netCost);
    function calcMarginalPrice(uint8 outcomeTokenIndex) external view returns (uint256 price);
    function close() external;
    function withdrawFees() external returns (uint256 fees);
    function funding() external view returns (uint256);
    function fee() external view returns (uint64);
    function stage() external view returns (uint8);
    function owner() external view returns (address);
    function whitelist() external view returns (address);
}

interface ILMSRMarketMakerFactory {
    function createLMSRMarketMaker(
        address pmSystem,
        address collateralToken,
        bytes32[] calldata conditionIds,
        uint64 fee,
        address whitelist,
        uint256 funding
    ) external returns (address lmsrMarketMaker);
}
