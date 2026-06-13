// SPDX-License-Identifier: MIT
// Verifies the gateway's CCIP-Read responses. The signature hash construction
// here MUST match backend/ens/gateway.js makeSignatureHash():
//   keccak256(0x1900 ‖ resolver ‖ expires ‖ keccak256(request) ‖ keccak256(result))
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library SignatureVerifier {
    /// @notice Hash signed by the offchain gateway.
    /// @param target The resolver contract that emitted the OffchainLookup.
    /// @param expires Unix time after which the response is no longer valid.
    /// @param request The calldata passed to the gateway (resolve(name,data)).
    /// @param result  The gateway's answer to the inner query.
    function makeSignatureHash(
        address target,
        uint64 expires,
        bytes memory request,
        bytes memory result
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    /// @notice Recover the signer and the result from a gateway response.
    /// @param request The original gateway calldata (extraData).
    /// @param response abi.encode(result, expires, signature) returned by the gateway.
    function verify(
        bytes calldata request,
        bytes calldata response
    ) internal view returns (address, bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        address signer = ECDSA.recover(makeSignatureHash(address(this), expires, request, result), sig);
        require(expires >= block.timestamp, "SignatureVerifier: Signature expired");
        return (signer, result);
    }
}
