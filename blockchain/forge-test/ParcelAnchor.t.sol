// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Forge tests for the ownerless parcel anchors: create once, batches skip what exists, readers page.
import "../contracts/ParcelAnchor.sol";

interface Vm {
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function warp(uint256) external;
}

contract ParcelAnchorTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ParcelAnchor private anchors;

    function setUp() public {
        anchors = new ParcelAnchor();
    }

    function testAnchorStoresWhoAndWhen() public {
        VM.warp(1700000000);
        bytes32 key = anchors.anchor("HR-1", "https://example.org/parcels/HR-1");
        require(key == keccak256(bytes("HR-1")), "key is keccak of the id");
        ParcelAnchor.Anchor memory a = anchors.anchorOf("HR-1");
        _assertEqStrings(a.parcelId, "HR-1", "parcel id stored");
        _assertEqStrings(a.metadataURI, "https://example.org/parcels/HR-1", "metadata stored");
        require(a.anchoredAt == 1700000000, "chain time stored");
        require(a.anchoredBy == address(this), "creator stored");
        require(anchors.isAnchored("HR-1"), "anchored");
        require(!anchors.isAnchored("HR-2"), "another id is not");
        require(anchors.count() == 1, "count");
    }

    function testAnchorRefusesDuplicateAndEmptyId() public {
        anchors.anchor("HR-dup", "u");
        VM.expectRevert(abi.encodeWithSelector(ParcelAnchor.ParcelAlreadyAnchored.selector, "HR-dup"));
        anchors.anchor("HR-dup", "u2");
        VM.expectRevert(abi.encodeWithSelector(ParcelAnchor.EmptyParcelId.selector));
        anchors.anchor("", "u");
    }

    function testBatchSkipsExistingAndReportsMissing() public {
        anchors.anchor("HR-a", "ua");
        string[] memory ids = new string[](3);
        ids[0] = "HR-a";
        ids[1] = "HR-b";
        ids[2] = "HR-c";
        string[] memory uris = new string[](3);
        uris[0] = "x";
        uris[1] = "ub";
        uris[2] = "uc";

        bool[] memory before = anchors.missing(ids);
        require(!before[0] && before[1] && before[2], "only b and c missing before");

        VM.prank(address(0xBEEF));
        uint256 created = anchors.anchorBatch(ids, uris);
        require(created == 2, "two created");
        require(anchors.count() == 3, "three anchored");
        _assertEqStrings(anchors.anchorOf("HR-a").metadataURI, "ua", "existing anchor untouched");
        require(anchors.anchorOf("HR-b").anchoredBy == address(0xBEEF), "batch creator stored");
        require(anchors.countBy(address(0xBEEF)) == 2 && anchors.countBy(address(this)) == 1, "counted per creator");
        ParcelAnchor.Anchor[] memory mine = anchors.anchoredBy(address(0xBEEF), 1, 5);
        require(mine.length == 1, "creator page clipped");
        _assertEqStrings(mine[0].parcelId, "HR-c", "creator page in creation order");

        bool[] memory after_ = anchors.missing(ids);
        require(!after_[0] && !after_[1] && !after_[2], "none missing after");

        // The resumed batch is a no-op, not a failure.
        require(anchors.anchorBatch(ids, uris) == 0, "resume creates nothing");
    }

    function testBatchLengthMismatchReverts() public {
        string[] memory ids = new string[](1);
        ids[0] = "HR-one";
        string[] memory uris = new string[](2);
        VM.expectRevert(abi.encodeWithSelector(ParcelAnchor.LengthMismatch.selector));
        anchors.anchorBatch(ids, uris);
    }

    function testReadersPageInCreationOrder() public {
        anchors.anchor("HR-1", "u1");
        anchors.anchor("HR-2", "u2");
        anchors.anchor("HR-3", "u3");
        _assertEqStrings(anchors.at(2).parcelId, "HR-3", "at(2)");
        ParcelAnchor.Anchor[] memory page = anchors.anchors(1, 10);
        require(page.length == 2, "page clipped at the end");
        _assertEqStrings(page[0].parcelId, "HR-2", "page[0]");
        _assertEqStrings(page[1].parcelId, "HR-3", "page[1]");
        require(anchors.anchors(5, 10).length == 0, "offset past the end is empty");
        VM.expectRevert(abi.encodeWithSelector(ParcelAnchor.IndexOutOfRange.selector, 3));
        anchors.at(3);
        require(anchors.anchorOf("HR-none").anchoredAt == 0, "unknown parcel reads empty");
    }

    function _assertEqStrings(string memory a, string memory b, string memory message) private pure {
        require(keccak256(bytes(a)) == keccak256(bytes(b)), message);
    }
}
