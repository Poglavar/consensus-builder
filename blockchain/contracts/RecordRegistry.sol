// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/// Design and plan records (docs/blockchain-flows.md, "The objects on chain"): a non-transferable
/// ERC-721 per published CID, minted to whoever published it so wallets show it. The record says
/// "this content exists, since this time, minted by this key" and confers nothing. The token id is
/// uint256(sha256(cid)), so one CID has one record and the first minter wins; nothing is ever burnt.
contract RecordRegistry is ERC721Enumerable {
    uint8 public constant KIND_DESIGN = 1;
    uint8 public constant KIND_PLAN = 2;

    struct Record {
        uint8 kind;
        string cid;
        address minter;
        uint64 createdAt;
        string tokenURI;
    }

    mapping(uint256 => Record) private _records;

    event RecordMinted(uint256 indexed tokenId, uint8 indexed kind, string cid, address indexed minter);

    error RecordExists(string cid);
    error UnknownKind(uint8 kind);
    error EmptyCid();
    error Soulbound();
    error NoSuchRecord(string cid);

    constructor() ERC721("Urban Game Theory Record", "UGTREC") {}

    /// Mints the record of `cid` (a design or a plan) to the caller. `tokenURI` is the wallet-facing
    /// metadata object, cosmetic: readers take content from the CID, never from it.
    function mint(uint8 kind, string calldata cid, string calldata uri) external returns (uint256 tokenId) {
        if (kind != KIND_DESIGN && kind != KIND_PLAN) revert UnknownKind(kind);
        tokenId = tokenIdOf(cid);
        if (_records[tokenId].createdAt != 0) revert RecordExists(cid);
        _records[tokenId] = Record(kind, cid, msg.sender, uint64(block.timestamp), uri);
        _mint(msg.sender, tokenId);
        emit RecordMinted(tokenId, kind, cid, msg.sender);
    }

    function tokenIdOf(string calldata cid) public pure returns (uint256) {
        if (bytes(cid).length == 0) revert EmptyCid();
        return uint256(sha256(bytes(cid)));
    }

    function exists(string calldata cid) external view returns (bool) {
        return _records[tokenIdOf(cid)].createdAt != 0;
    }

    function recordOf(string calldata cid) external view returns (Record memory record) {
        record = _records[tokenIdOf(cid)];
        if (record.createdAt == 0) revert NoSuchRecord(cid);
    }

    function recordByToken(uint256 tokenId) external view returns (Record memory) {
        _requireOwned(tokenId);
        return _records[tokenId];
    }

    function count() external view returns (uint256) {
        return totalSupply();
    }

    function at(uint256 index) external view returns (Record memory) {
        return _records[tokenByIndex(index)];
    }

    /// `limit` records from `offset` in mint order, fewer at the end; `kind` 0 takes every kind.
    /// Records of other kinds leave gaps: the page is the same slice whatever the filter, so a reader
    /// pages once through the registry and drops the empty entries (createdAt 0).
    function records(uint256 offset, uint256 limit, uint8 kind) external view returns (Record[] memory page) {
        uint256 total = totalSupply();
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 size = end > offset ? end - offset : 0;
        page = new Record[](size);
        for (uint256 i = 0; i < size; i++) {
            Record storage record = _records[tokenByIndex(offset + i)];
            if (kind == 0 || record.kind == kind) page[i] = record;
        }
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _records[tokenId].tokenURI;
    }

    /// Soulbound and permanent: only minting (from the zero address) passes.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 amount) internal override {
        super._increaseBalance(account, amount);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
