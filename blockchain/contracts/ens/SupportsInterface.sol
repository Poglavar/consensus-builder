// SPDX-License-Identifier: MIT
// Minimal ERC-165 base for the resolver.
pragma solidity ^0.8.20;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

abstract contract SupportsInterface is IERC165 {
    function supportsInterface(bytes4 interfaceID) public view virtual override returns (bool) {
        return interfaceID == type(IERC165).interfaceId;
    }
}
