// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Agreement.sol";
import "./AgreementOutcomeReporter.sol";
import "./IConditionalMarkets.sol";

/// The canonical prediction market of each EVM agreement (README-agreement-markets.md): a Gnosis LMSR
/// market maker over the agreement's Conditional Tokens condition, whose oracle is the permissionless
/// AgreementOutcomeReporter. Only the agreement's sponsor opens it, once, while the agreement is
/// Active, depositing funding F = ceil(b·ln 2) in the collateral token; Gnosis's LMSR with funding F
/// has liquidity b = F / ln 2, so the seed and the prices are those of the Solana market for the same b.
/// This contract owns every maker it creates, so no one can pause it, change its fee or pull its
/// funding. It is also each maker's whitelist, which admits every trader while the agreement is Active
/// and before its deadline and nobody afterwards, so trading stops exactly when the outcome is
/// decided on chain, as it does on Solana. After resolution the sponsor alone reclaims what the maker
/// holds: its outcome tokens are redeemed and the collateral paid to the sponsor.
contract AgreementMarkets {
    using SafeERC20 for IERC20;

    uint256 private constant ONE = 1e18;
    /// floor(ln 2 · 10^18), the constant of frontend/js/bets/lmsr.js and the Solana program.
    uint256 public constant LN2 = 693147180559945309;
    uint256 public constant OUTCOME_SLOTS = 2;

    Agreement public immutable agreement;
    AgreementOutcomeReporter public immutable reporter;
    IConditionalTokens public immutable conditionalTokens;
    ILMSRMarketMakerFactory public immutable factory;
    IERC20 public immutable collateral;

    mapping(bytes32 => address) public marketOf;   // agreement key → its LMSR market maker
    mapping(address => bytes32) public keyOfMarket; // market maker → agreement key
    mapping(bytes32 => uint256) public liquidityOf; // the b the sponsor opened with
    mapping(bytes32 => bool) public reclaimed;

    event MarketOpened(bytes32 indexed key, address indexed sponsor, address market, bytes32 conditionId, uint256 liquidity, uint256 funding);
    event SeedReclaimed(bytes32 indexed key, address indexed sponsor, address market, uint256 amount);

    error NotSponsor();
    error NotActive();
    error DeadlinePassed();
    error MarketExists();
    error NoMarket();
    error AlreadyReclaimed();
    error InvalidLiquidity();
    error ReporterMismatch();
    error UnexpectedTokens();

    constructor(
        Agreement agreement_,
        AgreementOutcomeReporter reporter_,
        IConditionalTokens conditionalTokens_,
        ILMSRMarketMakerFactory factory_,
        IERC20 collateral_
    ) {
        if (address(reporter_.agreement()) != address(agreement_) || address(reporter_.conditionalTokens()) != address(conditionalTokens_)) {
            revert ReporterMismatch();
        }
        agreement = agreement_;
        reporter = reporter_;
        conditionalTokens = conditionalTokens_;
        factory = factory_;
        collateral = collateral_;
    }

    /// The funding that gives a Gnosis LMSR liquidity `b`: ceil(b · ln 2), in collateral units.
    function fundingFor(uint256 b) public pure returns (uint256) {
        return (b * LN2 + ONE - 1) / ONE;
    }

    function conditionIdOf(bytes32 key) public view returns (bytes32) {
        return reporter.conditionIdOf(key);
    }

    /// Opens the market of the sender's Active agreement `key` with liquidity `b` (collateral units),
    /// taking fundingFor(b) from the sender, who must have approved this contract for it.
    function open(bytes32 key, uint256 b) external returns (address market) {
        Agreement.Record memory a = agreement.get(key);
        if (a.sponsor != msg.sender) revert NotSponsor();
        if (a.status != agreement.STATUS_ACTIVE()) revert NotActive();
        if (a.deadline != 0 && a.deadline <= block.timestamp) revert DeadlinePassed();
        if (marketOf[key] != address(0)) revert MarketExists();
        uint256 funding = fundingFor(b);
        if (funding == 0) revert InvalidLiquidity();

        bytes32 conditionId = conditionIdOf(key);
        if (conditionalTokens.getOutcomeSlotCount(conditionId) == 0) {
            conditionalTokens.prepareCondition(address(reporter), key, OUTCOME_SLOTS);
        }
        collateral.safeTransferFrom(msg.sender, address(this), funding);
        collateral.forceApprove(address(factory), funding);
        bytes32[] memory conditionIds = new bytes32[](1);
        conditionIds[0] = conditionId;
        market = factory.createLMSRMarketMaker(address(conditionalTokens), address(collateral), conditionIds, 0, address(this), funding);
        marketOf[key] = market;
        keyOfMarket[market] = key;
        liquidityOf[key] = b;
        emit MarketOpened(key, msg.sender, market, conditionId, b, funding);
    }

    /// The whitelist hook every maker calls with the trader on each trade (msg.sender is the maker):
    /// anyone may trade while the market's agreement is Active and before its deadline.
    function isWhitelisted(address) external view returns (bool) {
        bytes32 key = keyOfMarket[msg.sender];
        if (key == bytes32(0) || marketOf[key] != msg.sender) return false;
        Agreement.Record memory a = agreement.get(key);
        return a.status == agreement.STATUS_ACTIVE() && (a.deadline == 0 || a.deadline > block.timestamp);
    }

    /// The sponsor takes back what the market maker holds once the outcome is reported (reporting it
    /// first when nobody has): the maker is closed, its outcome tokens are redeemed, and everything
    /// that yields, the leftover of the funding plus what traders paid, goes to the sponsor.
    function reclaim(bytes32 key) external returns (uint256 amount) {
        address market = marketOf[key];
        if (market == address(0)) revert NoMarket();
        if (agreement.get(key).sponsor != msg.sender) revert NotSponsor();
        if (reclaimed[key]) revert AlreadyReclaimed();
        reclaimed[key] = true;
        bytes32 conditionId = conditionIdOf(key);
        if (conditionalTokens.payoutDenominator(conditionId) == 0) reporter.report(key);

        uint256 before = collateral.balanceOf(address(this));
        ILMSRMarketMaker(market).close();
        ILMSRMarketMaker(market).withdrawFees();
        uint256[] memory indexSets = new uint256[](2);
        indexSets[0] = 1;
        indexSets[1] = 2;
        conditionalTokens.redeemPositions(address(collateral), bytes32(0), conditionId, indexSets);
        amount = collateral.balanceOf(address(this)) - before;
        emit SeedReclaimed(key, msg.sender, market, amount);
        collateral.safeTransfer(msg.sender, amount);
    }

    /// Outcome tokens arrive only from our own makers when reclaim closes them; nothing else is accepted.
    function onERC1155Received(address operator, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        _acceptOnlyOwnMakers(operator);
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address operator, address, uint256[] calldata, uint256[] calldata, bytes calldata) external view returns (bytes4) {
        _acceptOnlyOwnMakers(operator);
        return this.onERC1155BatchReceived.selector;
    }

    function _acceptOnlyOwnMakers(address operator) private view {
        if (msg.sender != address(conditionalTokens)) revert UnexpectedTokens();
        bytes32 key = keyOfMarket[operator];
        if (key == bytes32(0) || marketOf[key] != operator) revert UnexpectedTokens();
    }
}
