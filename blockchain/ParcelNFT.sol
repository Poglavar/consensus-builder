// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ParcelNFT is ERC721Enumerable, Ownable {
    struct Parcel {
        uint256 osmId;
    }

    mapping(uint256 => Parcel) public parcels;

    constructor() ERC721("Urban Game Theory Parcel", "UGTP") Ownable(msg.sender) {}

    function mint(address to, uint256 osmId) public returns (uint256) {
        if (_ownerOf(osmId) != address(0)) {
            revert("ParcelNFT: Token ID already minted");
        }

        _safeMint(to, osmId);
        parcels[osmId] = Parcel(osmId);

        return osmId;
    }

    function mintBatch(address to, uint256[] calldata osmIds) public returns (uint256[] memory) {
        uint256[] memory mintedIds = new uint256[](osmIds.length);

        for (uint256 i = 0; i < osmIds.length; i++) {
            if (_ownerOf(osmIds[i]) != address(0)) {
                revert("ParcelNFT: Token ID already minted");
            }

            _safeMint(to, osmIds[i]);
            parcels[osmIds[i]] = Parcel(osmIds[i]);
            mintedIds[i] = osmIds[i];
        }

        return mintedIds;
    }

    function getParcel(uint256 tokenId) public view returns (Parcel memory) {
        if (_ownerOf(tokenId) == address(0)) {
            revert("ParcelNFT: Parcel does not exist");
        }
        return parcels[tokenId];
    }

    // Override functions to handle ERC721Enumerable
    function _update(address to, uint256 tokenId, address auth)
        internal
        virtual
        override(ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 amount) internal virtual override(ERC721Enumerable) {
        super._increaseBalance(account, amount);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
