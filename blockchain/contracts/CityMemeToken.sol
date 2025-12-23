// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract CityMemeToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10 ** 18; // 1 billion tokens with 18 decimals
    uint256 public totalMinted;

    struct CitizenInfo {
        uint256 registeredAt; // timestamp of registration
        uint256 balanceWithdrawn; // total tokens already withdrawn
    }

    mapping(address => CitizenInfo) public citizens;

    event CitizenRegistered(address indexed account, uint256 registeredAt);
    event Withdrawal(address indexed account, uint256 amount, uint256 balanceWithdrawn);

    constructor() ERC20("Zagreb Meme Token", "ZAGREB") Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        require(totalMinted + amount <= MAX_SUPPLY, "Exceeds max supply");
        totalMinted += amount;
        _mint(to, amount);
    }

    function registerAsCitizen() external {
        require(citizens[msg.sender].registeredAt == 0, "Already registered");
        citizens[msg.sender].registeredAt = block.timestamp;
        emit CitizenRegistered(msg.sender, block.timestamp);
    }

    function availableBalance(address account) public view returns (uint256) {
        CitizenInfo memory info = citizens[account];
        if (info.registeredAt == 0) {
            return 0;
        }

        uint256 hoursElapsed = (block.timestamp - info.registeredAt) / 1 hours;
        uint256 accrued = hoursElapsed * 1 ether; // 1 token per hour
        if (accrued <= info.balanceWithdrawn) {
            return 0;
        }

        return accrued - info.balanceWithdrawn;
    }

    function withdraw(uint256 amount) external {
        CitizenInfo storage info = citizens[msg.sender];
        require(info.registeredAt != 0, "Not registered");

        uint256 available = availableBalance(msg.sender);
        require(amount > 0 && amount <= available, "Insufficient available balance");
        require(totalMinted + amount <= MAX_SUPPLY, "Exceeds max supply");

        info.balanceWithdrawn += amount;
        totalMinted += amount;
        _mint(msg.sender, amount);

        emit Withdrawal(msg.sender, amount, info.balanceWithdrawn);
    }
}
