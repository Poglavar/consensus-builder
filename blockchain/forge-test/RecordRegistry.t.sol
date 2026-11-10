// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Forge tests for design and plan records: one soulbound token per CID, first minter wins, readers page.
import "../contracts/RecordRegistry.sol";

interface Vm {
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function warp(uint256) external;
}

contract RecordRegistryTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    RecordRegistry private registry;
    string private constant DESIGN = "bafkreicc2fqzfruw3ddrjef24t6hxytq3pw2k3yi3gp36aj6omhtal5juy";
    string private constant PLAN = "bafkreifdrje7xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

    function setUp() public {
        registry = new RecordRegistry();
    }

    function testMintStoresTheRecordAndTokenToTheMinter() public {
        VM.warp(1700000000);
        uint8 kind = registry.KIND_DESIGN();
        VM.prank(address(0xABCD));
        uint256 tokenId = registry.mint(kind, DESIGN, "ipfs://meta");
        require(tokenId == uint256(sha256(bytes(DESIGN))), "token id is sha256 of the cid");
        require(registry.ownerOf(tokenId) == address(0xABCD), "minted to the minter");
        RecordRegistry.Record memory r = registry.recordOf(DESIGN);
        require(r.kind == 1 && r.minter == address(0xABCD) && r.createdAt == 1700000000, "record fields");
        _assertEqStrings(r.cid, DESIGN, "cid");
        _assertEqStrings(registry.tokenURI(tokenId), "ipfs://meta", "token uri");
        require(registry.exists(DESIGN) && !registry.exists(PLAN), "exists");
        require(registry.count() == 1, "count");
    }

    function testFirstMinterWinsAndKindsAreChecked() public {
        registry.mint(2, PLAN, "a");
        VM.prank(address(0xBEEF));
        VM.expectRevert(abi.encodeWithSelector(RecordRegistry.RecordExists.selector, PLAN));
        registry.mint(2, PLAN, "b");
        VM.expectRevert(abi.encodeWithSelector(RecordRegistry.UnknownKind.selector, uint8(3)));
        registry.mint(3, DESIGN, "c");
        VM.expectRevert(abi.encodeWithSelector(RecordRegistry.EmptyCid.selector));
        registry.mint(1, "", "c");
        VM.expectRevert(abi.encodeWithSelector(RecordRegistry.NoSuchRecord.selector, DESIGN));
        registry.recordOf(DESIGN);
    }

    function testTokensNeverMove() public {
        uint256 tokenId = registry.mint(1, DESIGN, "m");
        VM.expectRevert(abi.encodeWithSelector(RecordRegistry.Soulbound.selector));
        registry.transferFrom(address(this), address(0xBEEF), tokenId);
        registry.approve(address(0xBEEF), tokenId);
        VM.prank(address(0xBEEF));
        VM.expectRevert(abi.encodeWithSelector(RecordRegistry.Soulbound.selector));
        registry.transferFrom(address(this), address(0xBEEF), tokenId);
        require(registry.ownerOf(tokenId) == address(this), "still the minter's");
    }

    function testReadersPageAndFilterByKind() public {
        registry.mint(1, "cid-d1", "");
        registry.mint(2, "cid-p1", "");
        registry.mint(1, "cid-d2", "");
        _assertEqStrings(registry.at(1).cid, "cid-p1", "at(1)");
        RecordRegistry.Record[] memory all = registry.records(0, 10, 0);
        require(all.length == 3, "all three");
        RecordRegistry.Record[] memory designs = registry.records(0, 10, 1);
        require(designs.length == 3, "same slice");
        require(designs[0].createdAt != 0 && designs[1].createdAt == 0 && designs[2].createdAt != 0, "plan left a gap");
        RecordRegistry.Record[] memory tail = registry.records(2, 10, 0);
        require(tail.length == 1, "clipped at the end");
        _assertEqStrings(tail[0].cid, "cid-d2", "tail");
        require(registry.records(7, 2, 0).length == 0, "past the end is empty");
    }

    function _assertEqStrings(string memory a, string memory b, string memory message) private pure {
        require(keccak256(bytes(a)) == keccak256(bytes(b)), message);
    }
}
