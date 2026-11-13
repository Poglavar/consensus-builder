// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Forge tests for agreement prediction markets on the Gnosis Conditional Tokens and LMSR market maker:
// the sponsor opens one market per Active agreement, traders buy and sell through the LMSR while it is
// Active, the permissionless reporter settles Executed as YES and Cancelled or Expired as NO, winners
// redeem, and only the sponsor reclaims what the maker holds. A price-parity test replays trades
// quoted by frontend/js/bets/lmsr.js (forge-test/fixtures/LmsrMarketVectors.sol).
import "../contracts/Agreement.sol";
import "../contracts/AgreementOutcomeReporter.sol";
import "../contracts/AgreementMarkets.sol";
import "../contracts/IConditionalMarkets.sol";
import "./mocks/MockEAS.sol";
import "../contracts/test/TestUSDC.sol";
import "./fixtures/LmsrMarketVectors.sol";

interface MarketVm {
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function readFile(string calldata) external view returns (string memory);
    function parseJsonString(string calldata, string calldata) external pure returns (string memory);
    function parseBytes(string calldata) external pure returns (bytes memory);
    function replace(string calldata, string calldata, string calldata) external pure returns (string memory);
    function toString(address) external pure returns (string memory);
}

contract AgreementMarketsTest {
    MarketVm private constant VM = MarketVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant SCHEMA = keccak256("AgreementDecision-v1");
    string private constant CID = "bafkreicc2fqzfruw3ddrjef24t6hxytq3pw2k3yi3gp36aj6omhtal5juy";
    uint256 private constant USDC = 1e6;
    uint256 private constant B = 5 * USDC;
    uint256 private constant NO = 0;
    uint256 private constant YES = 1;

    MockEAS private eas;
    Agreement private agreement;
    IConditionalTokens private ct;
    ILMSRMarketMakerFactory private factory;
    AgreementOutcomeReporter private reporter;
    AgreementMarkets private markets;
    TestUSDC private usdc;
    address private sponsor = address(0x5000);
    address private lens = address(0x1E45);
    address private payout = address(0x9A70);
    address private alice = address(0xA11CE);
    address private bob = address(0xB0B);

    function setUp() public {
        VM.warp(1700000000);
        eas = new MockEAS();
        agreement = new Agreement(IEAS(address(eas)), SCHEMA);
        ct = IConditionalTokens(_deploy(_bytecode("conditional-tokens-contracts/build/contracts/ConditionalTokens.json")));
        // The factory's LMSRMarketMaker calls Fixed192x64Math as a linked library, as on mainnet.
        address math = _deploy(_bytecode("conditional-tokens-market-makers/build/contracts/Fixed192x64Math.json"));
        string memory factoryHex = VM.replace(_bytecode("conditional-tokens-market-makers/build/contracts/LMSRMarketMakerFactory.json"),
            "__Fixed192x64Math_______________________", VM.replace(VM.toString(math), "0x", ""));
        factory = ILMSRMarketMakerFactory(_deploy(factoryHex));
        reporter = new AgreementOutcomeReporter(agreement, ct);
        usdc = new TestUSDC();
        markets = new AgreementMarkets(agreement, reporter, ct, factory, IERC20(address(usdc)));
        address[3] memory people = [sponsor, alice, bob];
        for (uint256 i = 0; i < people.length; i++) {
            usdc.mint(people[i], 1000 * USDC);
            VM.prank(people[i]);
            usdc.approve(address(markets), type(uint256).max);
        }
        VM.deal(sponsor, 10 ether);
    }

    /// The creation bytecode (hex) of a Gnosis truffle artifact as published in its npm package.
    function _bytecode(string memory artifact) private view returns (string memory) {
        return VM.parseJsonString(VM.readFile(string.concat("solidity-deps/node_modules/@gnosis.pm/", artifact)), ".bytecode");
    }

    function _deploy(string memory creationHex) private returns (address deployed) {
        bytes memory code = VM.parseBytes(creationHex);
        assembly {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), "gnosis contract deploys");
    }

    function _agreement(uint64 deadline) private returns (bytes32) {
        VM.prank(sponsor);
        return agreement.create{ value: 1 ether }(CID, lens, deadline, false, 1 ether, payable(payout));
    }

    function _open(bytes32 key) private returns (ILMSRMarketMaker) {
        VM.prank(sponsor);
        return ILMSRMarketMaker(markets.open(key, B));
    }

    function _amounts(uint256 side, int256 shares) private pure returns (int256[] memory amounts) {
        amounts = new int256[](2);
        amounts[side] = shares;
    }

    /// `who` buys (shares > 0) or sells (shares < 0) one side; returns the collateral paid (or received, negative).
    function _trade(ILMSRMarketMaker market, address who, uint256 side, int256 shares) private returns (int256 netCost) {
        VM.startPrank(who);
        usdc.approve(address(market), type(uint256).max);
        ct.setApprovalForAll(address(market), true);
        netCost = market.trade(_amounts(side, shares), 0);
        VM.stopPrank();
    }

    function _position(bytes32 key, uint256 side) private view returns (uint256) {
        bytes32 collection = ct.getCollectionId(bytes32(0), reporter.conditionIdOf(key), 1 << side);
        return ct.getPositionId(address(usdc), collection);
    }

    function _redeem(bytes32 key, address who) private returns (uint256 paid) {
        uint256[] memory indexSets = new uint256[](2);
        indexSets[0] = 1;
        indexSets[1] = 2;
        bytes32 conditionId = reporter.conditionIdOf(key);
        uint256 before = usdc.balanceOf(who);
        VM.prank(who);
        ct.redeemPositions(address(usdc), bytes32(0), conditionId, indexSets);
        paid = usdc.balanceOf(who) - before;
    }

    function _attestAndExecute(bytes32 key) private {
        bytes32 uid = bytes32(uint256(7));
        eas.setAttestation(uid, IEAS.Attestation({ uid: uid, schema: SCHEMA, time: uint64(block.timestamp), expirationTime: 0, revocationTime: 0,
            refUID: bytes32(0), recipient: address(0), attester: lens, revocable: true, data: abi.encode(CID, sponsor, "satisfied", "sha256:abc", uint64(block.timestamp - 1)) }));
        agreement.attest(key, uid);
        agreement.execute(key);
    }

    function testFullLifecycleExecutedPaysYesAndTheSponsorReclaims() public {
        bytes32 key = _agreement(uint64(block.timestamp + 30 days));
        uint256 sponsorBefore = usdc.balanceOf(sponsor);
        ILMSRMarketMaker market = _open(key);
        uint256 funding = markets.fundingFor(B);
        require(funding == 3465736, "funding is ceil(b ln 2)");
        require(usdc.balanceOf(sponsor) == sponsorBefore - funding, "sponsor paid the funding");
        require(markets.marketOf(key) == address(market) && markets.liquidityOf(key) == B, "market recorded");
        require(market.owner() == address(markets) && market.fee() == 0 && market.funding() == funding, "owned, fee 0, funded");
        require(market.whitelist() == address(markets), "gated by the agreement");
        require(ct.balanceOf(address(market), _position(key, YES)) == funding, "maker holds the split funding");
        require(market.calcMarginalPrice(uint8(YES)) == 2 ** 63, "opens at one half");

        int256 aliceCost = _trade(market, alice, YES, int256(10 * USDC));
        int256 bobCost = _trade(market, bob, NO, int256(4 * USDC));
        require(aliceCost > 0 && bobCost > 0 && uint256(aliceCost) < 10 * USDC, "both paid less than the payout");
        require(ct.balanceOf(alice, _position(key, YES)) == 10 * USDC && ct.balanceOf(bob, _position(key, NO)) == 4 * USDC, "positions held");
        int256 bobBack = _trade(market, bob, NO, -int256(1 * USDC));
        require(bobBack < 0, "a sale pays out");

        VM.expectRevert(abi.encodeWithSelector(AgreementOutcomeReporter.AgreementActive.selector, key));
        reporter.report(key);
        _attestAndExecute(key);
        require(agreement.get(key).status == agreement.STATUS_EXECUTED(), "executed");

        // The outcome is decided: the maker takes no more trades.
        VM.prank(alice);
        VM.expectRevert(bytes("only whitelisted users may call this function"));
        market.trade(_amounts(YES, int256(USDC)), 0);

        VM.prank(alice);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.NotSponsor.selector));
        markets.reclaim(key);

        reporter.report(key);
        bytes32 conditionId = reporter.conditionIdOf(key);
        require(ct.payoutDenominator(conditionId) == 1 && ct.payoutNumerators(conditionId, YES) == 1 && ct.payoutNumerators(conditionId, NO) == 0, "YES reported");
        VM.expectRevert(bytes("payout denominator already set"));
        reporter.report(key);

        require(_redeem(key, alice) == 10 * USDC, "YES pays one unit per share");
        require(_redeem(key, bob) == 0, "NO pays nothing");

        uint256 expected = funding + uint256(aliceCost) + uint256(bobCost) - uint256(-bobBack) - 10 * USDC;
        VM.prank(sponsor);
        uint256 back = markets.reclaim(key);
        require(back == expected, "sponsor gets the funding plus net takings minus the YES payout");
        require(usdc.balanceOf(address(ct)) == 0 && usdc.balanceOf(address(market)) == 0 && usdc.balanceOf(address(markets)) == 0, "nothing left behind");
        require(market.stage() == 2, "maker closed");
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.AlreadyReclaimed.selector));
        markets.reclaim(key);
    }

    function testCancelledResolvesNoAndReclaimReportsItFirst() public {
        bytes32 key = _agreement(0);
        ILMSRMarketMaker market = _open(key);
        int256 aliceCost = _trade(market, alice, YES, int256(3 * USDC));
        int256 bobCost = _trade(market, bob, NO, int256(2 * USDC));
        VM.prank(sponsor);
        agreement.cancel(key);
        VM.prank(bob);
        VM.expectRevert(bytes("only whitelisted users may call this function"));
        market.trade(_amounts(NO, int256(USDC)), 0);

        // The sponsor's reclaim reports the outcome when nobody has yet.
        VM.prank(sponsor);
        uint256 back = markets.reclaim(key);
        bytes32 conditionId = reporter.conditionIdOf(key);
        require(ct.payoutNumerators(conditionId, NO) == 1 && ct.payoutNumerators(conditionId, YES) == 0, "NO reported");
        require(back == markets.fundingFor(B) + uint256(aliceCost) + uint256(bobCost) - 2 * USDC, "sponsor keeps all but the NO payout");
        require(_redeem(key, bob) == 2 * USDC && _redeem(key, alice) == 0, "NO wins");
        require(usdc.balanceOf(address(ct)) == 0, "fully paid out");
    }

    function testExpiredResolvesNoAndTradingStopsAtTheDeadline() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 key = _agreement(deadline);
        ILMSRMarketMaker market = _open(key);
        _trade(market, alice, YES, int256(2 * USDC));
        _trade(market, bob, NO, int256(1 * USDC));
        VM.warp(deadline);
        // Still Active on chain, but past its deadline it can only expire: no more trades.
        VM.prank(alice);
        VM.expectRevert(bytes("only whitelisted users may call this function"));
        market.trade(_amounts(YES, int256(USDC)), 0);
        VM.expectRevert(abi.encodeWithSelector(AgreementOutcomeReporter.AgreementActive.selector, key));
        reporter.report(key);
        agreement.expire(key);
        reporter.report(key);
        require(_redeem(key, bob) == 1 * USDC && _redeem(key, alice) == 0, "NO wins");
        VM.prank(sponsor);
        markets.reclaim(key);
        require(usdc.balanceOf(address(ct)) == 0, "fully paid out");
    }

    function testReportRevertsWhileActiveAndForUnknownAgreements() public {
        bytes32 key = _agreement(0);
        _open(key);
        VM.expectRevert(abi.encodeWithSelector(AgreementOutcomeReporter.AgreementActive.selector, key));
        reporter.report(key);
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(AgreementOutcomeReporter.AgreementActive.selector, key));
        markets.reclaim(key);
        VM.expectRevert(abi.encodeWithSelector(Agreement.NoSuchAgreement.selector));
        reporter.report(keccak256("no such agreement"));
    }

    function testOnlyTheSponsorOpensOnceWhileActive() public {
        bytes32 key = _agreement(uint64(block.timestamp + 1 days));
        VM.prank(alice);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.NotSponsor.selector));
        markets.open(key, B);
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.InvalidLiquidity.selector));
        markets.open(key, 0);
        _open(key);
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.MarketExists.selector));
        markets.open(key, B);

        VM.prank(sponsor);
        bytes32 cancelled = agreement.create("bafycancelled", lens, 0, false, 0, payable(payout));
        VM.prank(sponsor);
        agreement.cancel(cancelled);
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.NotActive.selector));
        markets.open(cancelled, B);

        VM.prank(sponsor);
        bytes32 lapsing = agreement.create("bafylapsing", lens, uint64(block.timestamp + 10), false, 0, payable(payout));
        VM.warp(block.timestamp + 10);
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.DeadlinePassed.selector));
        markets.open(lapsing, B);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.NoMarket.selector));
        markets.reclaim(lapsing);
    }

    function testStrayOutcomeTokensAreRefused() public {
        bytes32 key = _agreement(0);
        ILMSRMarketMaker market = _open(key);
        _trade(market, alice, YES, int256(USDC));
        uint256 position = _position(key, YES);
        VM.prank(alice);
        VM.expectRevert(abi.encodeWithSelector(AgreementMarkets.UnexpectedTokens.selector));
        IERC1155Like(address(ct)).safeTransferFrom(alice, address(markets), position, 1, "");
    }

    error ParityMiss(uint256 index, int256 gnosis, uint256 lmsrJs);
    event log_named_uint(string key, uint256 val);

    /// Replays the lmsr.js-quoted sequence on a real maker: each buy costs and each sale returns what
    /// lmsr.js quotes for b = 5 USDC, within one atomic unit (Gnosis rounds its 64.64 fixed
    /// point in the maker's favour, lmsr.js its 18-decimal one; funding ceil(b ln 2) makes Gnosis's
    /// own b 0.13 units above 5 USDC).
    function testBuyAndSellPricesMatchLmsrJs() public {
        uint256 tolerance = 1;
        uint256 maxDiff;
        require(LmsrMarketVectors.B == B, "vectors use the market's b");
        bytes32 key = _agreement(0);
        ILMSRMarketMaker market = _open(key);
        LmsrMarketVectors.Trade[] memory trades = LmsrMarketVectors.trades();
        for (uint256 i = 0; i < trades.length; i++) {
            LmsrMarketVectors.Trade memory t = trades[i];
            require(ct.balanceOf(alice, _position(key, YES)) == t.qYes && ct.balanceOf(alice, _position(key, NO)) == t.qNo, "same state as the vector");
            int256 shares = t.buy ? int256(t.shares) : -int256(t.shares);
            int256 quoted = market.calcNetCost(_amounts(t.side, shares));
            int256 netCost = _trade(market, alice, t.side, shares);
            require(netCost == quoted, "calcNetCost quotes the trade");
            uint256 amount = t.buy ? uint256(netCost) : uint256(-netCost);
            uint256 diff = amount > t.amount ? amount - t.amount : t.amount - amount;
            if (diff > tolerance) revert ParityMiss(i, netCost, t.amount);
            if (diff > maxDiff) maxDiff = diff;
        }
        emit log_named_uint("largest difference from lmsr.js, atomic units", maxDiff);
    }
}

interface IERC1155Like {
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external;
}
