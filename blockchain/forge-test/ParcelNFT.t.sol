// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "../contracts/ParcelNFT.sol";

interface Vm {
    function expectRevert(bytes calldata) external;
    function prank(address) external;
}

contract ParcelNFTTest is ERC721Holder {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ParcelNFT private token;

    function setUp() public {
        token = new ParcelNFT();
    }

    function testMintParcelStoresData() public {
        string memory parcelId = "HR-123";
        string memory uri = "ipfs://meta1";

        uint256 tokenId = token.mintParcel(parcelId, uri);

        // Parcels are soulbound to the registry contract itself.
        _assertEq(token.ownerOf(tokenId), address(token), "owner is registry");
        ParcelNFT.Parcel memory p = token.getParcelByToken(tokenId);
        _assertEqStrings(p.parcelId, parcelId, "parcelId stored");
        _assertEqStrings(p.metadataURI, uri, "metadata stored");
        _assertEqStrings(token.tokenURI(tokenId), uri, "tokenURI matches");
    }

    function testMintParcelRevertsOnDuplicate() public {
        string memory parcelId = "HR-dup";
        token.mintParcel(parcelId, "ipfs://meta2");

        vm.expectRevert(bytes("ParcelNFT: Parcel already minted"));
        token.mintParcel(parcelId, "ipfs://meta3");
    }

    function testMintParcelRequiresMetadata() public {
        vm.expectRevert(bytes("ParcelNFT: metadata URI required"));
        token.mintParcel("HR-no-meta", "");
    }

    function testParcelsAreSoulbound() public {
        uint256 tokenId = token.mintParcel("HR-soulbound", "ipfs://meta");
        // The registry holds the token; moving it reverts with the soulbound guard.
        vm.prank(address(token));
        vm.expectRevert(bytes("ParcelNFT: parcels are soulbound and non-transferable"));
        token.transferFrom(address(token), address(this), tokenId);
    }

    function testTokenIdDerivationAndLookup() public {
        string memory parcelId = "HR-lookup";
        uint256 expectedId = uint256(keccak256(bytes(parcelId)));

        uint256 tokenId = token.mintParcel(parcelId, "ipfs://meta4");
        _assertEq(tokenId, expectedId, "tokenId derived from hash");
        _assertEq(token.tokenIdForParcelId(parcelId), tokenId, "tokenId lookup works");
        _assertEqStrings(token.parcelIdForTokenId(tokenId), parcelId, "parcelId lookup works");
    }

    function testGetParcelByTokenRevertsIfMissing() public {
        vm.expectRevert(bytes("ParcelNFT: Parcel does not exist"));
        token.getParcelByToken(123);
    }

    function testSetParcelMetadataURI() public {
        uint256 tokenId = token.mintParcel("HR-meta", "ipfs://old");

        token.setParcelMetadataURI(tokenId, "ipfs://new");
        ParcelNFT.Parcel memory p = token.getParcelByToken(tokenId);
        _assertEqStrings(p.metadataURI, "ipfs://new", "metadata updated");
        _assertEqStrings(token.tokenURI(tokenId), "ipfs://new", "tokenURI updated");
    }

    function testSetParcelMetadataRevertsIfMissingOrEmpty() public {
        vm.expectRevert(bytes("ParcelNFT: Parcel does not exist"));
        token.setParcelMetadataURI(999, "ipfs://none");

        uint256 tokenId = token.mintParcel("HR-meta-empty", "ipfs://old");
        vm.expectRevert(bytes("ParcelNFT: metadata URI required"));
        token.setParcelMetadataURI(tokenId, "");
    }

    function testMintBatchSuccess() public {
        string[] memory ids = new string[](2);
        ids[0] = "HR-batch-1";
        ids[1] = "HR-batch-2";

        string[] memory uris = new string[](2);
        uris[0] = "ipfs://b1";
        uris[1] = "ipfs://b2";

        uint256[] memory minted = token.mintBatch(ids, uris);
        _assertEq(minted.length, 2, "minted length");
        // Parcels are soulbound to the registry contract itself.
        _assertEq(token.balanceOf(address(token)), 2, "registry balance");

        uint256[] memory owned = token.getTokensByOwner(address(token));
        _assertEq(owned.length, 2, "owned length");
        _assertEq(owned[0], minted[0], "owned[0] matches");
        _assertEq(owned[1], minted[1], "owned[1] matches");

        _assertEqStrings(token.tokenURI(minted[0]), "ipfs://b1", "tokenURI[0]");
        _assertEqStrings(token.tokenURI(minted[1]), "ipfs://b2", "tokenURI[1]");
    }

    function testMintBatchLengthMismatchReverts() public {
        string[] memory ids = new string[](1);
        ids[0] = "HR-one";
        string[] memory uris = new string[](2);
        uris[0] = "ipfs://u1";
        uris[1] = "ipfs://u2";

        vm.expectRevert(bytes("ParcelNFT: parcelIds and metadataURIs length mismatch"));
        token.mintBatch(ids, uris);
    }

    function testTokenURIRevertsForMissing() public {
        vm.expectRevert(bytes("ParcelNFT: URI query for nonexistent token"));
        token.tokenURI(42);
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
