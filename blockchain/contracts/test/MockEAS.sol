// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MockEAS {
    struct Attestation {
        bytes32 uid;
        bytes32 schema;
        uint64 time;
        uint64 expirationTime;
        uint64 revocationTime;
        bytes32 refUID;
        address recipient;
        address attester;
        bool revocable;
        bytes data;
    }

    mapping(bytes32 => Attestation) private _attestations;

    function setAttestation(Attestation calldata attestation) external {
        _attestations[attestation.uid] = attestation;
    }

    function getAttestation(bytes32 uid) external view returns (Attestation memory) {
        return _attestations[uid];
    }
}