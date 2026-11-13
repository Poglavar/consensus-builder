// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Forge tests for the EVM agreement: create and fund by the sponsor, the lens's EAS decision checked
// field by field, execution paying the escrow once, cancel and expire refunding it, readers paging.
import "../contracts/Agreement.sol";
import "./mocks/MockEAS.sol";

interface Vm {
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
}

contract Payee {
    receive() external payable {}
}

contract Refuser {
    // No receive: a payout here fails.
}

contract AgreementTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant SCHEMA = keccak256("AgreementDecision-v1");
    string private constant CID = "bafkreicc2fqzfruw3ddrjef24t6hxytq3pw2k3yi3gp36aj6omhtal5juy";

    MockEAS private eas;
    Agreement private agreement;
    address private sponsor = address(0x5000);
    address private lens = address(0x1E45);
    Payee private payee;

    function setUp() public {
        eas = new MockEAS();
        agreement = new Agreement(IEAS(address(eas)), SCHEMA);
        payee = new Payee();
        VM.deal(sponsor, 10 ether);
        VM.warp(1700000000);
    }

    function _create(uint64 deadline, uint256 required, uint256 value) private returns (bytes32) {
        VM.prank(sponsor);
        return agreement.create{ value: value }(CID, lens, deadline, false, required, payable(address(payee)));
    }

    function _attestation(bytes32 uid, address attester, string memory cid, address sponsor_, string memory decision, uint64 observedAt, bytes32 schema) private {
        eas.setAttestation(uid, IEAS.Attestation({ uid: uid, schema: schema, time: uint64(block.timestamp), expirationTime: 0, revocationTime: 0,
            refUID: bytes32(0), recipient: address(0), attester: attester, revocable: true, data: abi.encode(cid, sponsor_, decision, "sha256:abc", observedAt) }));
    }

    function testCreateStoresTheAgreementWithItsFirstEscrow() public {
        bytes32 key = _create(uint64(block.timestamp + 1 days), 1 ether, 0.4 ether);
        require(key == agreement.keyOf(sponsor, CID), "key is keccak of sponsor and cid");
        Agreement.Record memory a = agreement.get(key);
        require(a.sponsor == sponsor && a.lens == lens && a.payout == address(payee), "parties stored");
        require(a.requiredWei == 1 ether && a.escrowWei == 0.4 ether && a.status == 0 && a.decision == 0, "escrow and state");
        require(a.createdAt == 1700000000, "chain time");
        require(agreement.count() == 1 && agreement.exists(key), "listed");
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(Agreement.AgreementExists.selector));
        agreement.create(CID, lens, 0, false, 0, payable(address(payee)));
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(Agreement.InvalidDeadline.selector));
        agreement.create("other", lens, uint64(block.timestamp), false, 0, payable(address(payee)));
    }

    function testOnlyTheSponsorFundsWhileActive() public {
        bytes32 key = _create(0, 1 ether, 0);
        VM.deal(address(0xBEEF), 1 ether);
        VM.prank(address(0xBEEF));
        VM.expectRevert(abi.encodeWithSelector(Agreement.NotSponsor.selector));
        agreement.fund{ value: 0.5 ether }(key);
        VM.prank(sponsor);
        agreement.fund{ value: 0.5 ether }(key);
        VM.prank(sponsor);
        agreement.fund{ value: 0.5 ether }(key);
        require(agreement.get(key).escrowWei == 1 ether, "escrow adds up");
        require(address(agreement).balance == 1 ether, "held by the contract");
    }

    function testAttestChecksTheDecisionFieldByField() public {
        bytes32 key = _create(uint64(block.timestamp + 1 days), 0, 0);
        _attestation(bytes32(uint256(1)), address(0xBAD), CID, sponsor, "satisfied", 1699999000, SCHEMA);
        VM.expectRevert(abi.encodeWithSelector(Agreement.WrongAttester.selector, address(0xBAD)));
        agreement.attest(key, bytes32(uint256(1)));
        _attestation(bytes32(uint256(2)), lens, CID, sponsor, "satisfied", 1699999000, keccak256("other schema"));
        VM.expectRevert(abi.encodeWithSelector(Agreement.WrongSchema.selector, keccak256("other schema")));
        agreement.attest(key, bytes32(uint256(2)));
        _attestation(bytes32(uint256(3)), lens, "bafyother", sponsor, "satisfied", 1699999000, SCHEMA);
        VM.expectRevert(abi.encodeWithSelector(Agreement.WrongAgreement.selector, "bafyother"));
        agreement.attest(key, bytes32(uint256(3)));
        _attestation(bytes32(uint256(4)), lens, CID, address(0xBEEF), "satisfied", 1699999000, SCHEMA);
        VM.expectRevert(abi.encodeWithSelector(Agreement.WrongSponsor.selector, address(0xBEEF)));
        agreement.attest(key, bytes32(uint256(4)));
        _attestation(bytes32(uint256(5)), lens, CID, sponsor, "refused", 1699999000, SCHEMA);
        VM.expectRevert(abi.encodeWithSelector(Agreement.InvalidDecision.selector, "refused"));
        agreement.attest(key, bytes32(uint256(5)));
        _attestation(bytes32(uint256(6)), lens, CID, sponsor, "satisfied", uint64(block.timestamp + 1), SCHEMA);
        VM.expectRevert(abi.encodeWithSelector(Agreement.ObservedInFuture.selector, uint64(block.timestamp + 1)));
        agreement.attest(key, bytes32(uint256(6)));

        _attestation(bytes32(uint256(7)), lens, CID, sponsor, "satisfied", 1699999000, SCHEMA);
        agreement.attest(key, bytes32(uint256(7)));
        Agreement.Record memory a = agreement.get(key);
        require(a.decision == 1 && a.decisionAttestation == bytes32(uint256(7)) && a.decisionObservedAt == 1699999000, "decision recorded");
        require(a.decisionAttestedAt == block.timestamp && a.decisionHash != bytes32(0), "times and hash");
        VM.expectRevert(abi.encodeWithSelector(Agreement.DecisionRecorded.selector));
        agreement.attest(key, bytes32(uint256(7)));
    }

    function testExecutePaysTheEscrowOnceWhenItSuffices() public {
        bytes32 key = _create(0, 1 ether, 0.5 ether);
        VM.expectRevert(abi.encodeWithSelector(Agreement.DecisionPending.selector));
        agreement.execute(key);
        _attestation(bytes32(uint256(9)), lens, CID, sponsor, "satisfied", 1699999000, SCHEMA);
        agreement.attest(key, bytes32(uint256(9)));
        VM.expectRevert(abi.encodeWithSelector(Agreement.EscrowShort.selector, 0.5 ether, 1 ether));
        agreement.execute(key);
        VM.prank(sponsor);
        agreement.fund{ value: 0.5 ether }(key);
        agreement.execute(key);
        Agreement.Record memory a = agreement.get(key);
        require(a.status == 1 && a.escrowWei == 0 && a.executedAt == block.timestamp, "executed");
        require(address(payee).balance == 1 ether && address(agreement).balance == 0, "escrow paid once");
        VM.expectRevert(abi.encodeWithSelector(Agreement.NotActive.selector));
        agreement.execute(key);
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(Agreement.NotActive.selector));
        agreement.cancel(key);
    }

    function testCancelRefundsWhileNoDecisionAndExpireAfterTheDeadline() public {
        bytes32 key = _create(0, 0, 1 ether);
        VM.prank(address(0xBEEF));
        VM.expectRevert(abi.encodeWithSelector(Agreement.NotSponsor.selector));
        agreement.cancel(key);
        VM.expectRevert(abi.encodeWithSelector(Agreement.NoDeadline.selector));
        agreement.expire(key);
        uint256 before = sponsor.balance;
        VM.prank(sponsor);
        agreement.cancel(key);
        require(agreement.get(key).status == 2 && sponsor.balance == before + 1 ether, "cancelled and refunded");

        VM.prank(sponsor);
        bytes32 timed = agreement.create{ value: 1 ether }("bafytimed", lens, uint64(block.timestamp + 100), true, 0, payable(address(payee)));
        VM.expectRevert(abi.encodeWithSelector(Agreement.DeadlineNotPassed.selector));
        agreement.expire(timed);
        VM.warp(block.timestamp + 100);
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(Agreement.DeadlinePassed.selector));
        agreement.fund{ value: 1 }(timed);
        before = sponsor.balance;
        VM.prank(address(0xBEEF));
        agreement.expire(timed);
        require(agreement.get(timed).status == 3 && sponsor.balance == before + 1 ether, "expired by anyone, refunded to the sponsor");
        _attestation(bytes32(uint256(11)), lens, "bafytimed", sponsor, "satisfied", 1699999000, SCHEMA);
        VM.expectRevert(abi.encodeWithSelector(Agreement.NotActive.selector));
        agreement.attest(timed, bytes32(uint256(11)));
    }

    function testADecidedAgreementCannotBeCancelledAndAPayoutThatRefusesFails() public {
        bytes32 key = _create(0, 0, 1 ether);
        _attestation(bytes32(uint256(12)), lens, CID, sponsor, "satisfied", 1699999000, SCHEMA);
        agreement.attest(key, bytes32(uint256(12)));
        VM.prank(sponsor);
        VM.expectRevert(abi.encodeWithSelector(Agreement.DecisionRecorded.selector));
        agreement.cancel(key);

        Refuser refuser = new Refuser();
        VM.prank(sponsor);
        bytes32 stuck = agreement.create{ value: 1 ether }("bafystuck", lens, 0, false, 0, payable(address(refuser)));
        _attestation(bytes32(uint256(13)), lens, "bafystuck", sponsor, "satisfied", 1699999000, SCHEMA);
        agreement.attest(stuck, bytes32(uint256(13)));
        VM.expectRevert(abi.encodeWithSelector(Agreement.PayoutFailed.selector));
        agreement.execute(stuck);
        require(agreement.get(stuck).status == 0 && agreement.get(stuck).escrowWei == 1 ether, "nothing moved");
    }

    function testReadersPage() public {
        _create(0, 0, 0);
        VM.prank(sponsor);
        agreement.create("bafysecond", lens, 0, false, 0, payable(address(payee)));
        (bytes32[] memory keys, Agreement.Record[] memory records) = agreement.agreements(1, 10);
        require(keys.length == 1 && keccak256(bytes(records[0].cid)) == keccak256(bytes("bafysecond")), "page clipped at the end");
        (bytes32 key0, Agreement.Record memory first) = agreement.at(0);
        require(key0 == agreement.keyOf(sponsor, CID) && keccak256(bytes(first.cid)) == keccak256(bytes(CID)), "at(0)");
        VM.expectRevert(abi.encodeWithSelector(Agreement.NoSuchAgreement.selector));
        agreement.get(bytes32(uint256(99)));
    }
}
