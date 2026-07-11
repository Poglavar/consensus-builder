// SPDX-License-Identifier: MIT
// ENS L1 hybrid resolver (ERC-3668 CCIP-Read + ENSIP-10 wildcard) for
// parcels.urbangametheory.eth / proposals.urbangametheory.eth.
//
// resolve() first checks for an on-chain record for the queried node (used for
// the apex names — the namespace roots double as the NFT contract names); if
// none is set it reverts OffchainLookup to our HTTP gateway (all the wildcard
// children). Pair with backend/ens/gateway.js (matching signature format).
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

    // On-chain records, keyed by node. Set only for apex names; children have
    // none and fall through to the gateway.
    mapping(bytes32 => mapping(uint256 => bytes)) private _addresses; // node => coinType => addr bytes
    mapping(bytes32 => mapping(string => string)) private _texts;     // node => key => value

    uint256 private constant COIN_TYPE_ETH = 60;
    bytes4 private constant SEL_ADDR = 0x3b3b57de;      // addr(bytes32)
    bytes4 private constant SEL_ADDR_COIN = 0xf1cb7e06; // addr(bytes32,uint256)
    bytes4 private constant SEL_TEXT = 0x59d1d43c;      // text(bytes32,string)

    event NewSigners(address[] signers);
    event NewUrl(string url);
    event AddrChanged(bytes32 indexed node, address a);
    event TextChanged(bytes32 indexed node, string key, string value);
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

    function setUrl(string calldata _url) external onlyOwner {
        url = _url;
        emit NewUrl(_url);
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        signers[signer] = allowed;
        address[] memory s = new address[](1);
        s[0] = signer;
        emit NewSigners(s);
    }

    // --- On-chain record setters (owner; for apex names) ---
    function setAddr(bytes32 node, address a) external onlyOwner {
        _addresses[node][COIN_TYPE_ETH] = abi.encodePacked(a);
        emit AddrChanged(node, a);
    }

    function setAddr(bytes32 node, uint256 coinType, bytes calldata a) external onlyOwner {
        _addresses[node][coinType] = a;
    }

    function setText(bytes32 node, string calldata key, string calldata value) external onlyOwner {
        _texts[node][key] = value;
        emit TextChanged(node, key, value);
    }

    // --- On-chain record getters (direct calls, e.g. for the apex) ---
    function addr(bytes32 node) public view returns (address payable) {
        bytes memory a = _addresses[node][COIN_TYPE_ETH];
        if (a.length < 20) return payable(address(0));
        return payable(address(bytes20(a)));
    }

    function addr(bytes32 node, uint256 coinType) public view returns (bytes memory) {
        return _addresses[node][coinType];
    }

    function text(bytes32 node, string calldata key) public view returns (string memory) {
        return _texts[node][key];
    }

    // --- ENSIP-10 entrypoint: on-chain short-circuit, else offchain ---
    function resolve(bytes calldata name, bytes calldata data) external view override returns (bytes memory) {
        bytes memory onchain = _resolveOnchain(data);
        if (onchain.length > 0) {
            return onchain;
        }
        bytes memory callData = abi.encodeWithSelector(IResolverService.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(address(this), urls, callData, OffchainResolver.resolveWithProof.selector, callData);
    }

    // ABI-encoded record if set on-chain for this node, else empty bytes.
    function _resolveOnchain(bytes calldata data) internal view returns (bytes memory) {
        if (data.length < 36) return "";
        bytes4 selector = bytes4(data[0:4]);
        if (selector == SEL_ADDR) {
            bytes32 node = abi.decode(data[4:], (bytes32));
            address a = addr(node);
            if (a != address(0)) return abi.encode(a);
        } else if (selector == SEL_ADDR_COIN) {
            (bytes32 node, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            bytes memory a = _addresses[node][coinType];
            if (a.length > 0) return abi.encode(a);
        } else if (selector == SEL_TEXT) {
            (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
            string memory v = _texts[node][key];
            if (bytes(v).length > 0) return abi.encode(v);
        }
        return "";
    }

    // CCIP-Read callback. Verifies the gateway signature and returns the record.
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "OffchainResolver: invalid signature");
        return result;
    }

    function supportsInterface(bytes4 interfaceID) public view override returns (bool) {
        return interfaceID == type(IExtendedResolver).interfaceId
            || interfaceID == SEL_ADDR
            || interfaceID == SEL_ADDR_COIN
            || interfaceID == SEL_TEXT
            || super.supportsInterface(interfaceID);
    }
}
