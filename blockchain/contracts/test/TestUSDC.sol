// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A 6-decimal stand-in for USDC where there is none: the agreement market tests and the localhost
/// deployment of scripts/deploy-agreement-markets.sh use it as collateral. Anyone may mint.
contract TestUSDC is ERC20 {
    constructor() ERC20("USD Coin (test)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
