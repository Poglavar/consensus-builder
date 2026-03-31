// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../../contracts/ProposalNFT.sol";

contract MockEAS is IEAS {
    mapping(bytes32 => Attestation) private _attestations;

    function setAttestation(bytes32 uid, Attestation memory att) external {
        _attestations[uid] = att;
    }

    function getAttestation(bytes32 uid) external view override returns (Attestation memory) {
        return _attestations[uid];
    }

    /// Helper to build and store a claim attestation in one call
    function setClaimAttestation(
        bytes32 uid,
        bytes32 schema,
        address attester,
        address recipient,
        string memory label,
        string memory targetChain,
        string memory targetAddress,
        string memory targetId
    ) external {
        _attestations[uid] = Attestation({
            uid: uid,
            schema: schema,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID: bytes32(0),
            recipient: recipient,
            attester: attester,
            revocable: true,
            data: abi.encode(label, targetChain, targetAddress, targetId)
        });
    }

    /// Helper to build and store an endorsement attestation in one call
    function setEndorsementAttestation(
        bytes32 uid,
        bytes32 schema,
        address attester,
        address recipient,
        bytes32 refUID
    ) external {
        _attestations[uid] = Attestation({
            uid: uid,
            schema: schema,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID: refUID,
            recipient: recipient,
            attester: attester,
            revocable: true,
            data: abi.encode(true)
        });
    }
}
