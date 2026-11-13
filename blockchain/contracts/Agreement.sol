// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IEAS.sol";

/// Agreements on EVM (docs/blockchain-flows.md, R4): the Solana agreement program's lifecycle in
/// Solidity. One entry per sponsor and agreement CID, an escrow in the native token, settled by the
/// agreement's lens attesting an AgreementDecision through EAS. create → fund (the sponsor, any
/// number of times) → attest (once) → execute; or cancel (the sponsor, while no decision is
/// recorded) or expire (anyone, after the deadline). Every terminal state moves the whole escrow
/// exactly once: to `payout` when Executed, back to the sponsor otherwise. The lens never refuses:
/// it attests only a satisfied decision, so an unmet agreement expires or is cancelled.
contract Agreement {
    uint8 public constant STATUS_ACTIVE = 0;
    uint8 public constant STATUS_EXECUTED = 1;
    uint8 public constant STATUS_CANCELLED = 2;
    uint8 public constant STATUS_EXPIRED = 3;
    uint8 public constant DECISION_PENDING = 0;
    uint8 public constant DECISION_SATISFIED = 1;

    struct Record {
        address sponsor;        // created and funds it; the only key that may cancel; receives refunds
        address lens;           // the lens member whose AgreementDecision attestation settles it
        address payable payout; // receives the whole escrow at execution
        uint64 deadline;        // unix seconds; 0 = no deadline (never expires)
        uint64 createdAt;
        uint256 requiredWei;    // escrow execution needs (0: none)
        uint256 escrowWei;      // what fund brought in, not yet paid out or refunded
        uint8 status;
        bool openGround;        // the land includes open ground; recorded for readers, no effect here
        uint8 decision;
        uint64 decisionAttestedAt;
        uint64 decisionObservedAt; // the attestation's sourceObservedAt
        bytes32 decisionAttestation; // the recorded EAS attestation uid
        bytes32 decisionHash;   // keccak256 of that attestation as read
        uint64 executedAt;
        string cid;
    }

    IEAS public immutable eas;
    /// The EAS schema of AgreementDecision-v1: "string agreementCid, address sponsor, string decision,
    /// string evidenceRef, uint64 sourceObservedAt" (backend/oracle/lens-schemas.js).
    bytes32 public immutable decisionSchema;

    mapping(bytes32 => Record) private _agreements; // keyOf(sponsor, cid)
    bytes32[] private _keys;

    event AgreementCreated(bytes32 indexed key, address indexed sponsor, string cid, address lens, address payout, uint64 deadline, uint256 requiredWei, bool openGround, uint64 createdAt);
    event AgreementFunded(bytes32 indexed key, string cid, uint256 wei_, uint256 escrowWei, uint64 fundedAt);
    event AgreementAttested(bytes32 indexed key, string cid, address lens, bytes32 attestation, bytes32 attestationHash, string evidenceRef, uint64 sourceObservedAt, uint64 attestedAt);
    event AgreementExecuted(bytes32 indexed key, string cid, address payout, uint256 wei_, address lens, bytes32 decisionAttestation, uint64 executedAt);
    event AgreementCancelled(bytes32 indexed key, string cid, uint256 refundedWei, uint64 cancelledAt);
    event AgreementExpired(bytes32 indexed key, string cid, uint256 refundedWei, uint64 expiredAt);

    error InvalidCid();
    error InvalidLens();
    error InvalidPayout();
    error InvalidDeadline();
    error AgreementExists();
    error NoSuchAgreement();
    error NotSponsor();
    error NotActive();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error NoDeadline();
    error NothingToFund();
    error DecisionRecorded();
    error DecisionPending();
    error EscrowShort(uint256 escrowWei, uint256 requiredWei);
    error WrongAttester(address attester);
    error WrongSchema(bytes32 schema);
    error AttestationRevoked();
    error AttestationExpired();
    error WrongAgreement(string agreementCid);
    error WrongSponsor(address sponsor);
    error InvalidDecision(string decision);
    error ObservedInFuture(uint64 sourceObservedAt);
    error PayoutFailed();
    error IndexOutOfRange(uint256 index);

    constructor(IEAS eas_, bytes32 decisionSchema_) {
        eas = eas_;
        decisionSchema = decisionSchema_;
    }

    function keyOf(address sponsor, string memory cid) public pure returns (bytes32) {
        return keccak256(abi.encode(sponsor, cid));
    }

    /// Creates the sender's agreement for `cid`, with any value sent as its first escrow.
    function create(string calldata cid, address lens, uint64 deadline, bool openGround, uint256 requiredWei, address payable payout) external payable returns (bytes32 key) {
        if (bytes(cid).length == 0 || bytes(cid).length > 64) revert InvalidCid();
        if (lens == address(0)) revert InvalidLens();
        if (payout == address(0) || payout == address(this)) revert InvalidPayout();
        if (deadline != 0 && deadline <= block.timestamp) revert InvalidDeadline();
        key = keyOf(msg.sender, cid);
        if (_agreements[key].createdAt != 0) revert AgreementExists();
        Record storage a = _agreements[key];
        a.sponsor = msg.sender;
        a.lens = lens;
        a.payout = payout;
        a.deadline = deadline;
        a.createdAt = uint64(block.timestamp);
        a.requiredWei = requiredWei;
        a.openGround = openGround;
        a.cid = cid;
        _keys.push(key);
        emit AgreementCreated(key, msg.sender, cid, lens, payout, deadline, requiredWei, openGround, a.createdAt);
        if (msg.value > 0) _fund(key, a);
    }

    /// The sponsor adds to the escrow while the agreement is active and its deadline has not passed.
    function fund(bytes32 key) external payable {
        Record storage a = _existing(key);
        if (a.sponsor != msg.sender) revert NotSponsor();
        if (a.status != STATUS_ACTIVE) revert NotActive();
        if (a.deadline != 0 && a.deadline <= block.timestamp) revert DeadlinePassed();
        if (msg.value == 0) revert NothingToFund();
        _fund(key, a);
    }

    /// Records the lens's satisfied decision from the EAS attestation `uid`. Permissionless.
    function attest(bytes32 key, bytes32 uid) external {
        Record storage a = _existing(key);
        if (a.status != STATUS_ACTIVE) revert NotActive();
        if (a.decision != DECISION_PENDING) revert DecisionRecorded();
        if (a.deadline != 0 && a.deadline <= block.timestamp) revert DeadlinePassed();
        IEAS.Attestation memory att = eas.getAttestation(uid);
        if (att.attester != a.lens) revert WrongAttester(att.attester);
        if (att.schema != decisionSchema) revert WrongSchema(att.schema);
        if (att.revocationTime != 0) revert AttestationRevoked();
        if (att.expirationTime != 0 && att.expirationTime <= block.timestamp) revert AttestationExpired();
        (string memory agreementCid, address sponsor, string memory decision, string memory evidenceRef, uint64 sourceObservedAt) =
            abi.decode(att.data, (string, address, string, string, uint64));
        if (keccak256(bytes(agreementCid)) != keccak256(bytes(a.cid))) revert WrongAgreement(agreementCid);
        if (sponsor != a.sponsor) revert WrongSponsor(sponsor);
        if (keccak256(bytes(decision)) != keccak256(bytes("satisfied"))) revert InvalidDecision(decision);
        if (sourceObservedAt > block.timestamp) revert ObservedInFuture(sourceObservedAt);
        a.decision = DECISION_SATISFIED;
        a.decisionAttestedAt = uint64(block.timestamp);
        a.decisionObservedAt = sourceObservedAt;
        a.decisionAttestation = uid;
        a.decisionHash = keccak256(abi.encode(att));
        emit AgreementAttested(key, a.cid, a.lens, uid, a.decisionHash, evidenceRef, sourceObservedAt, a.decisionAttestedAt);
    }

    /// Pays the whole escrow to `payout` once the decision is satisfied and the escrow suffices. Permissionless.
    function execute(bytes32 key) external {
        Record storage a = _existing(key);
        if (a.status != STATUS_ACTIVE) revert NotActive();
        if (a.decision != DECISION_SATISFIED) revert DecisionPending();
        if (a.deadline != 0 && a.deadline <= block.timestamp) revert DeadlinePassed();
        if (a.escrowWei < a.requiredWei) revert EscrowShort(a.escrowWei, a.requiredWei);
        uint256 amount = a.escrowWei;
        a.escrowWei = 0;
        a.status = STATUS_EXECUTED;
        a.executedAt = uint64(block.timestamp);
        emit AgreementExecuted(key, a.cid, a.payout, amount, a.lens, a.decisionAttestation, a.executedAt);
        _send(a.payout, amount);
    }

    /// The sponsor takes the escrow back while no decision is recorded.
    function cancel(bytes32 key) external {
        Record storage a = _existing(key);
        if (a.sponsor != msg.sender) revert NotSponsor();
        if (a.status != STATUS_ACTIVE) revert NotActive();
        if (a.decision != DECISION_PENDING) revert DecisionRecorded();
        uint256 amount = a.escrowWei;
        a.escrowWei = 0;
        a.status = STATUS_CANCELLED;
        emit AgreementCancelled(key, a.cid, amount, uint64(block.timestamp));
        _send(payable(a.sponsor), amount);
    }

    /// Anyone closes an agreement whose deadline has passed; the escrow goes back to the sponsor.
    function expire(bytes32 key) external {
        Record storage a = _existing(key);
        if (a.status != STATUS_ACTIVE) revert NotActive();
        if (a.deadline == 0) revert NoDeadline();
        if (a.deadline > block.timestamp) revert DeadlineNotPassed();
        uint256 amount = a.escrowWei;
        a.escrowWei = 0;
        a.status = STATUS_EXPIRED;
        emit AgreementExpired(key, a.cid, amount, uint64(block.timestamp));
        _send(payable(a.sponsor), amount);
    }

    function exists(bytes32 key) external view returns (bool) {
        return _agreements[key].createdAt != 0;
    }

    function get(bytes32 key) external view returns (Record memory) {
        return _existing(key);
    }

    function count() external view returns (uint256) {
        return _keys.length;
    }

    function at(uint256 index) external view returns (bytes32 key, Record memory record) {
        if (index >= _keys.length) revert IndexOutOfRange(index);
        key = _keys[index];
        record = _agreements[key];
    }

    /// `limit` agreements from `offset` in creation order, fewer at the end; one call for a reader.
    function agreements(uint256 offset, uint256 limit) external view returns (bytes32[] memory keys, Record[] memory records) {
        uint256 end = offset + limit;
        if (end > _keys.length) end = _keys.length;
        uint256 size = end > offset ? end - offset : 0;
        keys = new bytes32[](size);
        records = new Record[](size);
        for (uint256 i = 0; i < size; i++) {
            keys[i] = _keys[offset + i];
            records[i] = _agreements[keys[i]];
        }
    }

    function _existing(bytes32 key) private view returns (Record storage a) {
        a = _agreements[key];
        if (a.createdAt == 0) revert NoSuchAgreement();
    }

    function _fund(bytes32 key, Record storage a) private {
        a.escrowWei += msg.value;
        emit AgreementFunded(key, a.cid, msg.value, a.escrowWei, uint64(block.timestamp));
    }

    function _send(address payable to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert PayoutFailed();
    }
}
