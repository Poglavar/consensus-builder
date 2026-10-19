// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Tests for the non-binding VOTE proposal flow: mintVote, castVote, rescindVote,
// one-vote-per-owner, expiry conclusion, and strict separation from the accept/execute path.

import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "../contracts/ParcelNFT.sol";
import "../contracts/ProposalNFT.sol";
import "../contracts/CityMemeToken.sol";
import "./mocks/MockEAS.sol";

interface Vm {
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function warp(uint256) external;
}

contract VoteFlowsTest is ERC721Holder {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ParcelNFT private parcelNFT;
    CityMemeToken private cityToken;
    ProposalNFT private proposalNFT;
    MockEAS private mockEAS;

    bytes32 private constant OWN_SCHEMA = bytes32("own");
    bytes32 private constant ENDORSE_SCHEMA = bytes32("endorse");
    bytes32 private constant OWNER_LIST_SCHEMA = bytes32("ownerlist");

    bytes32 private constant CLAIM_UID = bytes32("vclaim-1");
    bytes32 private constant ENDORSEMENT_UID = bytes32("vendorse-1");
    bytes32 private constant CLAIM_UID_2 = bytes32("vclaim-2");
    bytes32 private constant ENDORSEMENT_UID_2 = bytes32("vendorse-2");

    address private constant VOTER = address(0xBEEF);
    address private constant VOTER2 = address(0xF00D);

    uint256 private constant ONE_YEAR = 365 days;

    function setUp() public {
        parcelNFT = new ParcelNFT();
        cityToken = new CityMemeToken();
        mockEAS = new MockEAS();
        proposalNFT = new ProposalNFT(
            address(parcelNFT),
            address(cityToken),
            address(mockEAS),
            OWN_SCHEMA,
            ENDORSE_SCHEMA,
            OWNER_LIST_SCHEMA
        );
    }

    // ========================
    // mint
    // ========================

    function testMintVoteCreatesOpenVote() public {
        (uint256 proposalId,) = _createVoteProposal("HR-vote-1");

        (bool isVote, uint256 voteCount, uint256 expiry, bool concluded) = proposalNFT.getVoteInfo(proposalId);
        _assertTrue(isVote, "should be a vote proposal");
        _assertEq(voteCount, 0, "no votes yet");
        _assertTrue(expiry > block.timestamp, "expiry in the future");
        _assertTrue(!concluded, "not concluded yet");

        (, , , bool acceptancePossible, ProposalNFT.ProposalStatus status, , , , ,) = proposalNFT.getProposal(proposalId);
        _assertTrue(!acceptancePossible, "acceptance must be impossible on a vote proposal");
        _assertEq(uint256(status), uint256(ProposalNFT.ProposalStatus.Active), "vote proposal is Active/open");
    }

    function testMintVoteRevertsNonFutureExpiry() public {
        parcelNFT.mintParcel(address(this), "HR-vote-badexp", "ipfs://meta");
        string[] memory parcels = _singleParcel("HR-vote-badexp");
        address[] memory lens = _singleLens();

        vm.expectRevert(bytes("ProposalNFT: Vote expiry must be in the future"));
        proposalNFT.mintVote(address(this), parcels, "ipfs://img", block.timestamp, lens);
    }

    // ========================
    // cast / rescind
    // ========================

    function testCastVoteSingleOwner() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-2");
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, VOTER);

        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);

        _assertTrue(proposalNFT.hasVoted(proposalId, parcelId, VOTER), "voter recorded");
        (, uint256 voteCount, ,) = proposalNFT.getVoteInfo(proposalId);
        _assertEq(voteCount, 1, "one vote");
    }

    function testRescindVote() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-3");
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, VOTER);

        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);

        vm.prank(VOTER);
        proposalNFT.rescindVote(proposalId, parcelId);

        _assertTrue(!proposalNFT.hasVoted(proposalId, parcelId, VOTER), "vote cleared");
        (, uint256 voteCount, ,) = proposalNFT.getVoteInfo(proposalId);
        _assertEq(voteCount, 0, "tally back to zero");
    }

    function testCastVoteRevertsDoubleVote() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-4");
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, VOTER);

        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);

        vm.expectRevert(bytes("ProposalNFT: Already voted"));
        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);
    }

    function testRescindRevertsWithoutVote() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-5");

        vm.expectRevert(bytes("ProposalNFT: No vote to rescind"));
        vm.prank(VOTER);
        proposalNFT.rescindVote(proposalId, parcelId);
    }

    function testCastVoteRevertsInvalidParcel() public {
        _createVoteProposal("HR-vote-6");
        parcelNFT.mintParcel(VOTER, "HR-vote-outside", "ipfs://meta");
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, "HR-vote-outside", VOTER);

        vm.expectRevert(bytes("ProposalNFT: Parcel not part of proposal"));
        vm.prank(VOTER);
        proposalNFT.castVote(0, "HR-vote-outside", CLAIM_UID, ENDORSEMENT_UID);
    }

    function testCastVoteRevertsUnattestedCaller() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-7");
        // No attestations set up for VOTER -> ownership proof fails.
        vm.expectRevert(bytes("ProposalNFT: Claim not found"));
        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);
    }

    // One meaningful vote per owner: two distinct owners of the same parcel each vote once.
    function testTwoOwnersEachVoteOnce() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-8");

        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, VOTER);
        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);

        _setupAttestations(CLAIM_UID_2, ENDORSEMENT_UID_2, parcelId, VOTER2);
        vm.prank(VOTER2);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID_2, ENDORSEMENT_UID_2);

        (, uint256 voteCount, ,) = proposalNFT.getVoteInfo(proposalId);
        _assertEq(voteCount, 2, "each distinct owner counts once");
    }

    // ========================
    // expiry conclusion
    // ========================

    function testVotingConcludesAtExpiry() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-9");
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, VOTER);

        vm.warp(block.timestamp + ONE_YEAR + 1);

        vm.expectRevert(bytes("ProposalNFT: Voting has concluded"));
        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);

        // getVoteInfo.concluded is derived live from the timestamp (not the stored status),
        // so it reports concluded past the deadline regardless of any reverted state change.
        (, , , bool concluded) = proposalNFT.getVoteInfo(proposalId);
        _assertTrue(concluded, "vote concluded after expiry");
    }

    // ========================
    // strict separation from accept/execute
    // ========================

    function testAcceptRevertsOnVoteProposal() public {
        (uint256 proposalId, string memory parcelId) = _createVoteProposal("HR-vote-10");
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, VOTER);

        vm.expectRevert(bytes("ProposalNFT: Proposal acceptance is not possible"));
        vm.prank(VOTER);
        proposalNFT.acceptProposal(proposalId, parcelId, bytes32(0), CLAIM_UID, ENDORSEMENT_UID);
    }

    function testCastVoteRevertsOnAcceptProposal() public {
        string memory parcelId = "HR-vote-11";
        parcelNFT.mintParcel(address(this), parcelId, "ipfs://meta");
        string[] memory parcels = _singleParcel(parcelId);
        address[] memory lens = _singleLens();
        uint256 proposalId = proposalNFT.mintAndFund(address(this), parcels, false, "ipfs://img", 0, 0, lens);

        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, VOTER);
        vm.expectRevert(bytes("ProposalNFT: Not a vote proposal"));
        vm.prank(VOTER);
        proposalNFT.castVote(proposalId, parcelId, CLAIM_UID, ENDORSEMENT_UID);
    }

    // ========================
    // Helpers
    // ========================

    function _createVoteProposal(string memory parcelId)
        private
        returns (uint256 proposalId, string memory)
    {
        parcelNFT.mintParcel(address(this), parcelId, "ipfs://meta");
        string[] memory parcels = _singleParcel(parcelId);
        address[] memory lens = _singleLens();
        proposalId = proposalNFT.mintVote(address(this), parcels, "ipfs://img", block.timestamp + ONE_YEAR, lens);
        return (proposalId, parcelId);
    }

    function _setupAttestations(bytes32 claimUid, bytes32 endorsementUid, string memory parcelId, address owner)
        private
    {
        uint256 tokenId = parcelNFT.tokenIdForParcelId(parcelId);

        mockEAS.setClaimAttestation(
            claimUid,
            OWN_SCHEMA,
            owner,
            owner,
            "I own this",
            Strings.toString(block.chainid),
            Strings.toHexString(uint160(address(parcelNFT)), 20),
            Strings.toString(tokenId)
        );

        mockEAS.setEndorsementAttestation(
            endorsementUid,
            ENDORSE_SCHEMA,
            address(this), // lens member is the test contract
            owner,
            claimUid
        );
    }

    function _singleParcel(string memory parcelId) private pure returns (string[] memory arr) {
        arr = new string[](1);
        arr[0] = parcelId;
    }

    function _singleLens() private view returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = address(this);
    }

    function _assertEq(uint256 a, uint256 b, string memory message) private pure {
        require(a == b, message);
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    receive() external payable {}
}
