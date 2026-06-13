// SPDX-License-Identifier: MIT
// ENS L1 offchain resolver (ERC-3668 CCIP-Read + ENSIP-10 wildcard) for
// parcels.urbangametheory.eth. resolve() reverts OffchainLookup pointing at our
// HTTP gateway; resolveWithProof() verifies the gateway's signed response.
// Pair with backend/ens/gateway.js (which signs in the matching format).
pragma solidity ^0.8.20;

import {IExtendedResolver} from "./IExtendedResolver.sol";
import {SignatureVerifier} from "./SignatureVerifier.sol";
import {SupportsInterface} from "./SupportsInterface.sol";

interface IResolverService {
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view returns (bytes memory result, uint64 expires, bytes memory sig);
}

contract OffchainResolver is IExtendedResolver, SupportsInterface {
    string public url;
    mapping(address => bool) public signers;
    address public owner;

    event NewSigners(address[] signers);
    event NewUrl(string url);
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);

    modifier onlyOwner() {
        require(msg.sender == owner, "OffchainResolver: not owner");
        _;
    }

    constructor(string memory _url, address[] memory _signers) {
        owner = msg.sender;
        url = _url;
        for (uint256 i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
        }
        emit NewSigners(_signers);
        emit NewUrl(_url);
    }

    /// @notice Update the gateway URL (e.g. when the API host changes).
    function setUrl(string calldata _url) external onlyOwner {
        url = _url;
        emit NewUrl(_url);
    }

    /// @notice Add/remove trusted gateway signers.
    function setSigner(address signer, bool allowed) external onlyOwner {
        signers[signer] = allowed;
        address[] memory s = new address[](1);
        s[0] = signer;
        emit NewSigners(s);
    }

    /// @dev ENSIP-10 entrypoint. Always defers to the offchain gateway.
    function resolve(bytes calldata name, bytes calldata data) external view override returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(IResolverService.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(address(this), urls, callData, OffchainResolver.resolveWithProof.selector, callData);
    }

    /// @dev CCIP-Read callback. Verifies the gateway signature and returns the record.
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "OffchainResolver: invalid signature");
        return result;
    }

    function supportsInterface(bytes4 interfaceID) public view override returns (bool) {
        return interfaceID == type(IExtendedResolver).interfaceId || super.supportsInterface(interfaceID);
    }
}
