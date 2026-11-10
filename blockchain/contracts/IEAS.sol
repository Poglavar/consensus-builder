// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// The part of the Ethereum Attestation Service a contract needs to check an attestation: the
/// `Agreement` contract reads the lens's decision through it (docs/blockchain-flows.md, R4).
interface IEAS {
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

    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}
