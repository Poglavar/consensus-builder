// SPDX-License-Identifier: MIT
// ENSIP-10 wildcard resolution interface — the resolver entrypoint ENS clients
// call with a DNS-encoded name and the inner record query.
pragma solidity ^0.8.20;

interface IExtendedResolver {
    function resolve(bytes memory name, bytes memory data) external view returns (bytes memory);
}
