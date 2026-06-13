// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ParcelNFT is ERC721Enumerable, Ownable {
    struct Parcel {
        string parcelId;
        string metadataURI;
    }

    mapping(uint256 => Parcel) private _parcels;
    mapping(uint256 => string) private _tokenIdToParcelId;
    mapping(bytes32 => uint256) private _parcelKeyToTokenId;
    mapping(bytes32 => bool) private _parcelKeyExists;

    event ParcelMetadataUpdated(uint256 indexed tokenId, string metadataURI);

    constructor() ERC721("Urban Game Theory Parcel", "UGTP") Ownable(msg.sender) {}

    function mintParcel(address to, string calldata parcelId, string calldata metadataURI) public returns (uint256) {
        bytes32 parcelKey = _parcelKey(parcelId);
        if (_parcelKeyExists[parcelKey]) {
            revert("ParcelNFT: Parcel already minted");
        }

        if (bytes(metadataURI).length == 0) {
            revert("ParcelNFT: metadata URI required");
        }

        uint256 tokenId = _tokenIdFromParcelKey(parcelKey);
        if (_ownerOf(tokenId) != address(0)) {
            revert("ParcelNFT: Token ID already minted");
        }

        _recordParcel(tokenId, parcelKey, parcelId, metadataURI);
        _safeMint(to, tokenId);
        return tokenId;
    }

    function mintBatch(address to, string[] calldata parcelIds, string[] calldata metadataURIs)
        public
        returns (uint256[] memory)
    {
        if (parcelIds.length != metadataURIs.length) {
            revert("ParcelNFT: parcelIds and metadataURIs length mismatch");
        }
        uint256[] memory mintedIds = new uint256[](parcelIds.length);

        for (uint256 i = 0; i < parcelIds.length; i++) {
            bytes32 parcelKey = _parcelKey(parcelIds[i]);
            if (_parcelKeyExists[parcelKey]) {
                revert("ParcelNFT: Parcel already minted");
            }

            if (bytes(metadataURIs[i]).length == 0) {
                revert("ParcelNFT: metadata URI required");
            }

            uint256 tokenId = _tokenIdFromParcelKey(parcelKey);
            if (_ownerOf(tokenId) != address(0)) {
                revert("ParcelNFT: Token ID already minted");
            }

            _recordParcel(tokenId, parcelKey, parcelIds[i], metadataURIs[i]);
            _safeMint(to, tokenId);
            mintedIds[i] = tokenId;
        }

        return mintedIds;
    }

    // // Parcels can only disappear by merging into another parcel.
    // function mergeInto(uint256 fromTokenId, uint256 toTokenId) public {
    //     address owner = ownerOf(fromTokenId);
    //     require(owner == msg.sender, "ParcelNFT: Caller is not the owner of the fromTokenId");
    //     require(ownerOf(toTokenId) == owner, "ParcelNFT: Caller must own both parcels to merge");

    //     // Burn the fromTokenId parcel
    //     _burn(fromTokenId);
    //     delete parcels[fromTokenId];
    // }

    // function splitInto(uint256 originalTokenId, uint256[] memory newTokenIds) public {
    //     address owner = ownerOf(originalTokenId);
    //     require(owner == msg.sender, "ParcelNFT: Caller is not the owner of the originalTokenId");

    //     // Mint the new parcels
    //     for (uint256 i = 0; i < newTokenIds.length; i++) {
    //         uint256 newTokenId = newTokenIds[i];
    //         require(_ownerOf(newTokenId) == address(0), "ParcelNFT: newTokenId already exists");

    //         _safeMint(owner, newTokenId);
    //         parcels[newTokenId] = Parcel(newTokenId);
    //     }
    // }

    function getParcelByToken(uint256 tokenId) public view returns (Parcel memory) {
        if (_ownerOf(tokenId) == address(0)) {
            revert("ParcelNFT: Parcel does not exist");
        }
        return _parcels[tokenId];
    }

    function getParcelById(string calldata parcelId) public view returns (Parcel memory) {
        uint256 tokenId = tokenIdForParcelId(parcelId);
        return _parcels[tokenId];
    }

    function setParcelMetadataURI(uint256 tokenId, string calldata metadataURI) external onlyOwner {
        if (_ownerOf(tokenId) == address(0)) {
            revert("ParcelNFT: Parcel does not exist");
        }
        if (bytes(metadataURI).length == 0) {
            revert("ParcelNFT: metadata URI required");
        }

        _parcels[tokenId].metadataURI = metadataURI;
        emit ParcelMetadataUpdated(tokenId, metadataURI);
    }

    function tokenIdForParcelId(string calldata parcelId) public view returns (uint256) {
        bytes32 parcelKey = _parcelKey(parcelId);
        if (!_parcelKeyExists[parcelKey]) {
            revert("ParcelNFT: Parcel does not exist");
        }
        return _parcelKeyToTokenId[parcelKey];
    }

    function parcelIdForTokenId(uint256 tokenId) public view returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) {
            revert("ParcelNFT: Parcel does not exist");
        }
        return _tokenIdToParcelId[tokenId];
    }

    function ownerOfParcelId(string calldata parcelId) external view returns (address) {
        uint256 tokenId = tokenIdForParcelId(parcelId);
        return ownerOf(tokenId);
    }

    /**
     * @dev Get all token IDs owned by a specific address
     * @param owner The address to query
     * @return An array of token IDs owned by the address
     */
    function getTokensByOwner(address owner) public view returns (uint256[] memory) {
        uint256 balance = balanceOf(owner);
        uint256[] memory tokens = new uint256[](balance);
        for (uint256 i = 0; i < balance; i++) {
            tokens[i] = tokenOfOwnerByIndex(owner, i);
        }
        return tokens;
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) {
            revert("ParcelNFT: URI query for nonexistent token");
        }
        return _parcels[tokenId].metadataURI;
    }

    function _recordParcel(uint256 tokenId, bytes32 parcelKey, string calldata parcelId, string calldata metadataURI)
        private
    {
        _parcels[tokenId] = Parcel(parcelId, metadataURI);
        _tokenIdToParcelId[tokenId] = parcelId;
        _parcelKeyToTokenId[parcelKey] = tokenId;
        _parcelKeyExists[parcelKey] = true;
        emit ParcelMetadataUpdated(tokenId, metadataURI);
    }

    function _parcelKey(string calldata parcelId) private pure returns (bytes32) {
        return keccak256(bytes(parcelId));
    }

    function _tokenIdFromParcelKey(bytes32 parcelKey) private pure returns (uint256) {
        return uint256(parcelKey);
    }

    // Override functions to handle ERC721Enumerable
    function _update(address to, uint256 tokenId, address auth)
        internal
        virtual
        override(ERC721Enumerable)
        returns (address)
    {
        // Soulbound: parcels are non-transferable. Real-world ownership is established off-chain
        // and proven via EAS attestation (see ProposalNFT's claim/endorsement/owner-list schemas),
        // not by holding or transferring this token. Allow minting (from == 0) and burning
        // (to == 0); reject owner-to-owner transfers.
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert("ParcelNFT: soulbound, non-transferable");
        }
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 amount) internal virtual override(ERC721Enumerable) {
        super._increaseBalance(account, amount);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
