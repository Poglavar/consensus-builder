// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "../contracts/ParcelNFT.sol";
import "../contracts/ProposalNFT.sol";
import "../contracts/CityMemeToken.sol";

interface Vm {
    function expectRevert(bytes calldata) external;
}

contract ProposalNFTTest is ERC721Holder {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ParcelNFT private parcelNFT;
    CityMemeToken private cityToken;
    ProposalNFT private proposalNFT;

    function setUp() public {
        parcelNFT = new ParcelNFT();
        cityToken = new CityMemeToken();
        proposalNFT = new ProposalNFT(
            address(parcelNFT), address(cityToken), address(0), bytes32("own"), bytes32("endorse"), bytes32("ownerlist")
        );
    }

    function testMintAndFundRequiresParcelIds() public {
        string[] memory parcels = new string[](0);
        address[] memory lens = new address[](1);
        lens[0] = address(this);

        vm.expectRevert(bytes("ProposalNFT: Must include at least one parcel"));
        proposalNFT.mintAndFund(address(this), parcels, false, "", 0, 0, lens);
    }

    function testMintAndFundRequiresLens() public {
        string[] memory parcels = new string[](1);
        parcels[0] = "HR-1";
        address[] memory lens = new address[](0);

        vm.expectRevert(bytes("ProposalNFT: Must include at least one lens address"));
        proposalNFT.mintAndFund(address(this), parcels, false, "", 0, 0, lens);
    }

    function testMintAndFundEthMismatchReverts() public {
        string[] memory parcels = _singleParcel("HR-eth");
        address[] memory lens = _singleLens();

        vm.expectRevert(bytes("ProposalNFT: ETH amount mismatch"));
        proposalNFT.mintAndFund{value: 0}(address(this), parcels, false, "ipfs://img", 1 ether, 0, lens);
    }

    function testMintAndFundTokenAllowanceReverts() public {
        string[] memory parcels = _singleParcel("HR-token");
        address[] memory lens = _singleLens();

        vm.expectRevert(bytes("ProposalNFT: Token allowance insufficient"));
        proposalNFT.mintAndFund(address(this), parcels, false, "ipfs://img", 0, 1 ether, lens);
    }

    function testMintAndFundSuccessStoresState() public {
        string[] memory parcels = new string[](2);
        parcels[0] = "HR-p1";
        parcels[1] = "HR-p2";
        address[] memory lens = _singleLens();

        uint256 tokenAmount = 5 ether;
        cityToken.mint(address(this), tokenAmount);
        cityToken.approve(address(proposalNFT), tokenAmount);

        uint256 ethAmount = 1 ether;
        string memory imageURI = "ipfs://proposal-image";

        uint256 proposalId = proposalNFT.mintAndFund{value: ethAmount}(
            address(this), parcels, false, imageURI, ethAmount, tokenAmount, lens
        );

        _assertEq(proposalNFT.ownerOf(proposalId), address(this), "owner set");

        (
            string[] memory storedParcels,
            bool isConditional,
            string memory storedImage,
            bool acceptancePossible,
            ProposalNFT.ProposalStatus status,
            uint256 ethBalance,
            uint256 tokenBalance,
            uint256 acceptanceCount,
            uint256 expiryTimestamp,
            uint256 expiringPercentage
        ) = proposalNFT.getProposal(proposalId);

        _assertEq(storedParcels.length, 2, "parcel count");
        _assertEqStrings(storedParcels[0], parcels[0], "parcel[0]");
        _assertEqStrings(storedParcels[1], parcels[1], "parcel[1]");
        _assertEq(isConditional ? 1 : 0, 0, "isConditional false");
        _assertEqStrings(storedImage, imageURI, "imageURI stored");
        _assertEq(acceptancePossible ? 1 : 0, 1, "acceptance possible");
        _assertEq(uint256(status), uint256(ProposalNFT.ProposalStatus.Active), "status active");
        _assertEq(ethBalance, ethAmount, "eth balance");
        _assertEq(tokenBalance, tokenAmount, "token balance");
        _assertEq(acceptanceCount, 0, "acceptance count");
        _assertEq(expiryTimestamp, 0, "expiry default");
        _assertEq(expiringPercentage, 0, "expiring percentage");

        uint256[] memory proposalsForParcel = proposalNFT.getProposalsForParcel(parcels[0]);
        _assertEq(proposalsForParcel.length, 1, "reverse mapping length");
        _assertEq(proposalsForParcel[0], proposalId, "reverse mapping id");

        address[] memory storedLens = proposalNFT.getLens(proposalId);
        _assertEq(storedLens.length, 1, "lens length");
        _assertEq(storedLens[0], address(this), "lens member");

        _assertEqStrings(proposalNFT.tokenURI(proposalId), imageURI, "tokenURI");

        uint256[] memory owned = proposalNFT.getTokensByOwner(address(this));
        _assertEq(owned.length, 1, "owned length");
        _assertEq(owned[0], proposalId, "owned id");
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

    function _assertEq(address a, address b, string memory message) private pure {
        require(a == b, message);
    }

    function _assertEqStrings(string memory a, string memory b, string memory message) private pure {
        require(keccak256(bytes(a)) == keccak256(bytes(b)), message);
    }
}
