// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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

/// @title Proposal flow tests: acceptance, withdrawal, contribution, distribution
contract ProposalFlowsTest is ERC721Holder {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ParcelNFT private parcelNFT;
    CityMemeToken private cityToken;
    ProposalNFT private proposalNFT;
    MockEAS private mockEAS;

    bytes32 private constant OWN_SCHEMA = bytes32("own");
    bytes32 private constant ENDORSE_SCHEMA = bytes32("endorse");
    bytes32 private constant OWNER_LIST_SCHEMA = bytes32("ownerlist");

    // Fixed UIDs for test attestations
    bytes32 private constant CLAIM_UID = bytes32("claim-1");
    bytes32 private constant ENDORSEMENT_UID = bytes32("endorse-1");
    bytes32 private constant CLAIM_UID_2 = bytes32("claim-2");
    bytes32 private constant ENDORSEMENT_UID_2 = bytes32("endorse-2");

    address private constant ACCEPTER = address(0xBEEF);

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
    // Acceptance tests
    // ========================

    function testAcceptProposalSingleOwner() public {
        (uint256 proposalId, string memory parcelId) = _createProposalWithParcel("HR-acc-1", false);

        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcelId, ACCEPTER);

        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(proposalId, parcelId, bytes32(0), CLAIM_UID, ENDORSEMENT_UID);

        _assertTrue(proposalNFT.hasAccepted(proposalId, parcelId), "parcel should be accepted");

        (, , , , , , , uint256 acceptanceCount, ,) = proposalNFT.getProposal(proposalId);
        _assertEq(acceptanceCount, 1, "acceptance count should be 1");
    }

    function testAcceptAllParcelsExecutes() public {
        string[] memory parcels = new string[](2);
        parcels[0] = "HR-exec-1";
        parcels[1] = "HR-exec-2";

        uint256 proposalId = _createProposalWithParcels(parcels, false, 1 ether, 0);

        // Accept parcel 1
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcels[0], ACCEPTER);
        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(proposalId, parcels[0], bytes32(0), CLAIM_UID, ENDORSEMENT_UID);

        // Accept parcel 2
        _setupAttestations(CLAIM_UID_2, ENDORSEMENT_UID_2, parcels[1], ACCEPTER);
        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(proposalId, parcels[1], bytes32(0), CLAIM_UID_2, ENDORSEMENT_UID_2);

        (, , , , ProposalNFT.ProposalStatus status, , , uint256 acceptanceCount, ,) = proposalNFT.getProposal(proposalId);
        _assertEq(acceptanceCount, 2, "all parcels accepted");
        _assertEq(uint256(status), uint256(ProposalNFT.ProposalStatus.Executed), "status should be Executed");
    }

    function testAcceptRevertsInvalidParcel() public {
        _createProposalWithParcel("HR-valid", false);
        // Mint a different parcel that is NOT in the proposal
        parcelNFT.mintParcel(ACCEPTER, "HR-invalid", "ipfs://meta");

        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, "HR-invalid", ACCEPTER);

        vm.expectRevert(bytes("ProposalNFT: Parcel not part of proposal"));
        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(0, "HR-invalid", bytes32(0), CLAIM_UID, ENDORSEMENT_UID);
    }

    function testAcceptRevertsAlreadyAccepted() public {
        string[] memory parcels = new string[](2);
        parcels[0] = "HR-dbl-1";
        parcels[1] = "HR-dbl-2";
        uint256 proposalId = _createProposalWithParcels(parcels, false, 0, 0);

        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcels[0], ACCEPTER);

        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(proposalId, parcels[0], bytes32(0), CLAIM_UID, ENDORSEMENT_UID);

        // Second accept of same parcel should revert
        vm.expectRevert(bytes("ProposalNFT: Parcel already accepted"));
        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(proposalId, parcels[0], bytes32(0), CLAIM_UID, ENDORSEMENT_UID);
    }

    // ========================
    // Withdrawal tests
    // ========================

    function testWithdrawConditional() public {
        string[] memory parcels = new string[](2);
        parcels[0] = "HR-wd-1";
        parcels[1] = "HR-wd-2";
        uint256 proposalId = _createProposalWithParcels(parcels, true, 0, 0);

        // Accept
        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcels[0], ACCEPTER);
        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(proposalId, parcels[0], bytes32(0), CLAIM_UID, ENDORSEMENT_UID);

        _assertTrue(proposalNFT.hasAccepted(proposalId, parcels[0]), "should be accepted");

        // Withdraw
        vm.prank(ACCEPTER);
        proposalNFT.withdrawAcceptance(proposalId, parcels[0], bytes32(0), CLAIM_UID, ENDORSEMENT_UID);

        _assertTrue(!proposalNFT.hasAccepted(proposalId, parcels[0]), "should be withdrawn");

        (, , , , , , , uint256 acceptanceCount, ,) = proposalNFT.getProposal(proposalId);
        _assertEq(acceptanceCount, 0, "acceptance count back to 0");
    }

    function testWithdrawRevertsNonConditional() public {
        string[] memory parcels = new string[](2);
        parcels[0] = "HR-nc-1";
        parcels[1] = "HR-nc-2";
        uint256 proposalId = _createProposalWithParcels(parcels, false, 0, 0);

        _setupAttestations(CLAIM_UID, ENDORSEMENT_UID, parcels[0], ACCEPTER);
        vm.prank(ACCEPTER);
        proposalNFT.acceptProposal(proposalId, parcels[0], bytes32(0), CLAIM_UID, ENDORSEMENT_UID);

        vm.expectRevert(bytes("ProposalNFT: Cannot withdraw acceptance from non-conditional proposal"));
        vm.prank(ACCEPTER);
        proposalNFT.withdrawAcceptance(proposalId, parcels[0], bytes32(0), CLAIM_UID, ENDORSEMENT_UID);
    }

    // ========================
    // Contribution tests
    // ========================

    function testContributeFundsETH() public {
        (uint256 proposalId,) = _createProposalWithParcel("HR-cf-1", false);

        vm.deal(address(0xCAFE), 5 ether);
        vm.prank(address(0xCAFE));
        proposalNFT.contributeFunds{value: 2 ether}(proposalId, address(0), 2 ether);

        (, , , , , uint256 ethBalance, , , ,) = proposalNFT.getProposal(proposalId);
        _assertEq(ethBalance, 2 ether, "eth balance should increase");
    }

    function testContributeFundsERC20() public {
        (uint256 proposalId,) = _createProposalWithParcel("HR-cf-2", false);

        uint256 amount = 10 ether;
        cityToken.mint(address(0xCAFE), amount);

        vm.startPrank(address(0xCAFE));
        cityToken.approve(address(proposalNFT), amount);
        proposalNFT.contributeFunds(proposalId, address(cityToken), amount);
        vm.stopPrank();

        (, , , , , , uint256 tokenBalance, , ,) = proposalNFT.getProposal(proposalId);
        _assertEq(tokenBalance, amount, "token balance should increase");
    }

    function testContributeFundsRevertsZero() public {
        (uint256 proposalId,) = _createProposalWithParcel("HR-cf-0", false);

        vm.expectRevert(bytes("ProposalNFT: Contribution must be greater than zero"));
        proposalNFT.contributeFunds(proposalId, address(0), 0);
    }

    // ========================
    // Distribution tests
    // ========================

    function testDistributeFundsCancellation() public {
        (uint256 proposalId,) = _createProposalWithParcel("HR-cancel", false);

        // Fund with ETH
        uint256 fundAmount = 3 ether;
        vm.deal(address(this), fundAmount + 1 ether);
        proposalNFT.contributeFunds{value: fundAmount}(proposalId, address(0), fundAmount);

        uint256 balanceBefore = address(this).balance;

        // Owner cancels (this contract is the owner)
        proposalNFT.distributeFunds(proposalId);

        (, , , , ProposalNFT.ProposalStatus status, , , , ,) = proposalNFT.getProposal(proposalId);
        _assertEq(uint256(status), uint256(ProposalNFT.ProposalStatus.Cancelled), "should be cancelled");

        uint256 balanceAfter = address(this).balance;
        _assertEq(balanceAfter - balanceBefore, fundAmount, "ETH should be returned to owner");
    }

    function testDistributeFundsExpired() public {
        // Create proposal with non-zero ethAmount for this test
        string memory parcelId = "HR-expire";
        parcelNFT.mintParcel(address(this), parcelId, "ipfs://meta");

        string[] memory parcels = _singleParcel(parcelId);
        address[] memory lens = _singleLens();

        uint256 fundAmount = 2 ether;
        vm.deal(address(this), fundAmount + 1 ether);

        proposalNFT.mintAndFund{value: fundAmount}(
            address(this), parcels, false, "ipfs://img", fundAmount, 0, lens
        );

        // expiryTimestamp is 0 by default and not settable via mintAndFund's public API,
        // so we can't test the expiry-triggered distribution path without a contract change.
        // This test verifies the setup completes without error.
    }

    // ========================
    // Helpers
    // ========================

    function _createProposalWithParcel(string memory parcelId, bool isConditional)
        private
        returns (uint256 proposalId, string memory)
    {
        parcelNFT.mintParcel(address(this), parcelId, "ipfs://meta");

        string[] memory parcels = _singleParcel(parcelId);
        address[] memory lens = _singleLens();

        proposalId = proposalNFT.mintAndFund(address(this), parcels, isConditional, "ipfs://img", 0, 0, lens);
        return (proposalId, parcelId);
    }

    function _createProposalWithParcels(string[] memory parcelIds, bool isConditional, uint256 ethAmount, uint256 tokenAmount)
        private
        returns (uint256 proposalId)
    {
        for (uint256 i = 0; i < parcelIds.length; i++) {
            parcelNFT.mintParcel(address(this), parcelIds[i], "ipfs://meta");
        }

        address[] memory lens = _singleLens();

        if (tokenAmount > 0) {
            cityToken.mint(address(this), tokenAmount);
            cityToken.approve(address(proposalNFT), tokenAmount);
        }

        vm.deal(address(this), ethAmount + 1 ether);
        proposalId = proposalNFT.mintAndFund{value: ethAmount}(
            address(this), parcelIds, isConditional, "ipfs://img", ethAmount, tokenAmount, lens
        );
    }

    function _setupAttestations(
        bytes32 claimUid,
        bytes32 endorsementUid,
        string memory parcelId,
        address owner
    ) private {
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

        // Endorsement: the test contract (lens member) endorses the claim
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

    // Required to receive ETH from distributeFunds
    receive() external payable {}
}
