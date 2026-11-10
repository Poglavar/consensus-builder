// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Ownerless parcel anchors (docs/blockchain-flows.md, "The objects on chain"): one entry per
/// cadastral parcel id, created once by anyone, never transferred and never removed. The anchor is
/// the parcel's public address on this chain; ownership of land never reaches it. Replaces the
/// transferable ParcelNFT.
contract ParcelAnchor {
    struct Anchor {
        string parcelId;
        string metadataURI;
        uint64 anchoredAt;
        address anchoredBy;
    }

    /// keccak256(parcelId) => anchor. Keys are kept in order of creation for readers, and per
    /// creator so a wallet can list what it anchored (it holds nothing: the anchor has no owner).
    mapping(bytes32 => Anchor) private _anchors;
    bytes32[] private _keys;
    mapping(address => bytes32[]) private _byCreator;

    event ParcelAnchored(bytes32 indexed key, string parcelId, string metadataURI, address indexed anchoredBy);

    error ParcelAlreadyAnchored(string parcelId);
    error EmptyParcelId();
    error LengthMismatch();
    error IndexOutOfRange(uint256 index);

    /// Anchors one parcel; reverts when it is anchored already.
    function anchor(string calldata parcelId, string calldata metadataURI) external returns (bytes32 key) {
        key = keyOf(parcelId);
        if (_anchors[key].anchoredAt != 0) revert ParcelAlreadyAnchored(parcelId);
        _create(key, parcelId, metadataURI);
    }

    /// Anchors several parcels in one transaction, skipping the ones that exist, so a batch resumed
    /// after a refused signature never fails on its own earlier work. Returns how many were created.
    function anchorBatch(string[] calldata parcelIds, string[] calldata metadataURIs) external returns (uint256 created) {
        if (parcelIds.length != metadataURIs.length) revert LengthMismatch();
        for (uint256 i = 0; i < parcelIds.length; i++) {
            bytes32 key = keyOf(parcelIds[i]);
            if (_anchors[key].anchoredAt != 0) continue;
            _create(key, parcelIds[i], metadataURIs[i]);
            created++;
        }
    }

    function keyOf(string calldata parcelId) public pure returns (bytes32) {
        if (bytes(parcelId).length == 0) revert EmptyParcelId();
        return keccak256(bytes(parcelId));
    }

    function isAnchored(string calldata parcelId) external view returns (bool) {
        return _anchors[keyOf(parcelId)].anchoredAt != 0;
    }

    /// Which of `parcelIds` have no anchor yet, as flags in the same order (one call for a checklist).
    function missing(string[] calldata parcelIds) external view returns (bool[] memory flags) {
        flags = new bool[](parcelIds.length);
        for (uint256 i = 0; i < parcelIds.length; i++) {
            flags[i] = _anchors[keyOf(parcelIds[i])].anchoredAt == 0;
        }
    }

    /// The anchor of a parcel, or an empty one (anchoredAt 0) when it has none.
    function anchorOf(string calldata parcelId) external view returns (Anchor memory) {
        return _anchors[keyOf(parcelId)];
    }

    function anchorByKey(bytes32 key) external view returns (Anchor memory) {
        return _anchors[key];
    }

    function count() external view returns (uint256) {
        return _keys.length;
    }

    function at(uint256 index) external view returns (Anchor memory) {
        if (index >= _keys.length) revert IndexOutOfRange(index);
        return _anchors[_keys[index]];
    }

    /// `limit` anchors from `offset` in creation order, fewer at the end; one call for a reader.
    function anchors(uint256 offset, uint256 limit) external view returns (Anchor[] memory) {
        return _page(_keys, offset, limit);
    }

    function countBy(address creator) external view returns (uint256) {
        return _byCreator[creator].length;
    }

    /// The anchors `creator` paid for, paged like `anchors`.
    function anchoredBy(address creator, uint256 offset, uint256 limit) external view returns (Anchor[] memory) {
        return _page(_byCreator[creator], offset, limit);
    }

    function _page(bytes32[] storage keys, uint256 offset, uint256 limit) private view returns (Anchor[] memory page) {
        uint256 end = offset + limit;
        if (end > keys.length) end = keys.length;
        uint256 size = end > offset ? end - offset : 0;
        page = new Anchor[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = _anchors[keys[offset + i]];
        }
    }

    function _create(bytes32 key, string calldata parcelId, string calldata metadataURI) private {
        _anchors[key] = Anchor(parcelId, metadataURI, uint64(block.timestamp), msg.sender);
        _keys.push(key);
        _byCreator[msg.sender].push(key);
        emit ParcelAnchored(key, parcelId, metadataURI, msg.sender);
    }
}
