// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "../contracts/ProposalNFT.sol";
import "../contracts/OracleReporter.sol";
import "../contracts/ParcelNFT.sol";
import "../contracts/CityMemeToken.sol";

interface VmOracle {
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
}

contract OracleVoteFlowsTest is ERC721Holder {
    VmOracle private constant vm = VmOracle(address(uint160(uint256(keccak256("hevm cheat code")))));
    ProposalNFT private proposalNFT;
    CityMemeToken private cityToken;
    OracleReporter private ownerOracle;
    OracleReporter private voteOracle;
    address private constant PAYEE = address(0xBEEF);
    bytes32 private constant ALICE = bytes32("alice-opaque");
    bytes32 private constant BOB = bytes32("bob-opaque");

    function setUp() public {
        ParcelNFT parcelNFT = new ParcelNFT();
        cityToken = new CityMemeToken();
        proposalNFT = new ProposalNFT(address(parcelNFT), address(cityToken), address(0), bytes32(0), bytes32(0), bytes32(0));
        ownerOracle = new OracleReporter(address(proposalNFT));
        voteOracle = new OracleReporter(address(proposalNFT));
        ownerOracle.setReporter(address(this), true);
        voteOracle.setReporter(address(this), true);
        vm.deal(address(this), 10 ether);
    }

    function testSelectedOraclesAndMutableVotesSettleOnlyAfterClose() public {
        uint256 proposalId = _mint(2, 2 ether);
        ownerOracle.reportAcceptedOwner(proposalId, ALICE);
        ownerOracle.reportAcceptedOwner(proposalId, BOB);

        voteOracle.reportVote(proposalId, ALICE, 1, bytes32("evidence-1"));
        voteOracle.reportVote(proposalId, BOB, 2, bytes32("evidence-2"));
        _assertCounts(proposalId, 1, 1);
        voteOracle.reportVote(proposalId, BOB, 1, bytes32("evidence-3"));
        _assertCounts(proposalId, 2, 0);

        vm.expectRevert(bytes("ProposalNFT: Voting is open"));
        proposalNFT.finalizeOracleVote(proposalId);
        vm.warp(block.timestamp + 2 days);
        proposalNFT.finalizeOracleVote(proposalId);
        (, , , , ProposalNFT.ProposalStatus status, uint256 escrow, , , ,) = proposalNFT.getProposal(proposalId);
        require(status == ProposalNFT.ProposalStatus.Executed && escrow == 2 ether, "settlement state");

        proposalNFT.withdrawOracleFunds(proposalId);
        require(PAYEE.balance == 2 ether, "recipient paid");
        vm.expectRevert(bytes("ProposalNFT: No funds to withdraw"));
        proposalNFT.withdrawOracleFunds(proposalId);
    }

    function testMissingOwnerOrNoVoteExpiresAndRefunds() public {
        uint256 proposalId = _mint(2, 1 ether);
        ownerOracle.reportAcceptedOwner(proposalId, ALICE);
        voteOracle.reportVote(proposalId, ALICE, 1, bytes32("evidence"));
        vm.warp(block.timestamp + 2 days);
        proposalNFT.finalizeOracleVote(proposalId);
        (, , , , ProposalNFT.ProposalStatus status, , , , ,) = proposalNFT.getProposal(proposalId);
        require(status == ProposalNFT.ProposalStatus.Expired, "incomplete electorate must fail");
        uint256 beforeBalance = address(this).balance;
        proposalNFT.withdrawOracleFunds(proposalId);
        require(address(this).balance == beforeBalance + 1 ether, "funder refunded");
    }

    function testWrongReporterAndLegacyVoteCannotAlterOracleTally() public {
        uint256 proposalId = _mint(1, 0);
        vm.expectRevert(bytes("ProposalNFT: Wrong owner oracle"));
        voteOracle.reportAcceptedOwner(proposalId, ALICE);
        ownerOracle.reportAcceptedOwner(proposalId, ALICE);
        vm.expectRevert(bytes("ProposalNFT: Wrong vote oracle"));
        ownerOracle.reportVote(proposalId, ALICE, 1, bytes32(0));
        vm.expectRevert(bytes("ProposalNFT: Vote oracle required"));
        proposalNFT.castVote(proposalId, "HR-1", bytes32(0), bytes32(0));
        vm.expectRevert(bytes("ProposalNFT: Vote oracle required"));
        proposalNFT.rescindVote(proposalId, "HR-1");
    }

    function testVerifiedWalletCanChangeVoteWithoutReporterTransaction() public {
        uint256 proposalId = _mint(1, 0);
        ownerOracle.reportAcceptedOwner(proposalId, ALICE);
        voteOracle.bindVoterWallet(proposalId, ALICE, PAYEE);
        vm.expectRevert(bytes("OracleReporter: Wallet already bound"));
        voteOracle.bindVoterWallet(proposalId, BOB, PAYEE);
        vm.expectRevert(bytes("OracleReporter: Wrong voter wallet"));
        voteOracle.castMyVote(proposalId, ALICE, 1);
        vm.prank(PAYEE);
        voteOracle.castMyVote(proposalId, ALICE, 1);
        _assertCounts(proposalId, 1, 0);
        vm.prank(PAYEE);
        voteOracle.castMyVote(proposalId, ALICE, 2);
        _assertCounts(proposalId, 0, 1);
        vm.prank(PAYEE);
        voteOracle.castMyVote(proposalId, ALICE, 0);
        _assertCounts(proposalId, 0, 0);
    }

    function testAuthorCannotSetUnapprovedOwnerCount() public {
        string[] memory parcels = new string[](1);
        parcels[0] = "HR-1";
        vm.expectRevert(bytes("ProposalNFT: Electorate not approved"));
        proposalNFT.mintOracleVote(address(this), parcels, "ipfs://proposal", block.timestamp + 1 days,
            address(ownerOracle), address(voteOracle), 1, PAYEE, 0);
    }

    function testNoVoteChangeAfterDeadline() public {
        uint256 proposalId = _mint(1, 0);
        ownerOracle.reportAcceptedOwner(proposalId, ALICE);
        voteOracle.bindVoterWallet(proposalId, ALICE, PAYEE);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(bytes("ProposalNFT: Voting has concluded"));
        vm.prank(PAYEE);
        voteOracle.castMyVote(proposalId, ALICE, 1);
    }

    function testTokenEscrowReleasedToFixedRecipient() public {
        uint256 amount = 3 ether;
        cityToken.mint(address(this), amount);
        cityToken.approve(address(proposalNFT), amount);
        string[] memory parcels = new string[](1);
        parcels[0] = "HR-1";
        uint256 expiry = block.timestamp + 1 days;
        ownerOracle.approveElectorate(proposalNFT.oracleElectorateCommitment(address(this), parcels, 1, expiry));
        uint256 proposalId = proposalNFT.mintOracleVote(address(this), parcels, "ipfs://proposal", expiry,
            address(ownerOracle), address(voteOracle), 1, PAYEE, amount);
        ownerOracle.reportAcceptedOwner(proposalId, ALICE);
        voteOracle.reportVote(proposalId, ALICE, 1, bytes32("evidence"));
        vm.warp(block.timestamp + 2 days);
        proposalNFT.finalizeOracleVote(proposalId);
        proposalNFT.withdrawOracleFunds(proposalId);
        require(cityToken.balanceOf(PAYEE) == amount, "token recipient paid");
    }

    function _mint(uint256 expected, uint256 ethAmount) private returns (uint256) {
        string[] memory parcels = new string[](1);
        parcels[0] = "HR-1";
        uint256 expiry = block.timestamp + 1 days;
        ownerOracle.approveElectorate(proposalNFT.oracleElectorateCommitment(address(this), parcels, expected, expiry));
        return proposalNFT.mintOracleVote{value: ethAmount}(
            address(this), parcels, "ipfs://proposal", expiry,
            address(ownerOracle), address(voteOracle), expected, PAYEE, 0
        );
    }

    function _assertCounts(uint256 proposalId, uint256 yes, uint256 no) private view {
        (, , , , , uint256 yesVotes, uint256 noVotes, ,) = proposalNFT.getOracleVoteInfo(proposalId);
        require(yesVotes == yes && noVotes == no, "wrong vote tally");
    }

    receive() external payable {}
}
