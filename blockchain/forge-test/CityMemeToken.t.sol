// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../contracts/CityMemeToken.sol";

interface Vm {
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
}

contract CityMemeTokenTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CityMemeToken private token;

    function setUp() public {
        token = new CityMemeToken();
    }

    function testRegisterOnce() public {
        token.registerAsCitizen();
        vm.expectRevert(bytes("Already registered"));
        token.registerAsCitizen();
    }

    function testWithdrawAccrualAndMinting() public {
        token.registerAsCitizen();

        vm.warp(block.timestamp + 3 hours);
        _assertEq(token.availableBalance(address(this)), 3 ether, "available after 3h");

        token.withdraw(2 ether);
        _assertEq(token.balanceOf(address(this)), 2 ether, "balance after first withdraw");
        _assertEq(token.availableBalance(address(this)), 1 ether, "available after first withdraw");
        _assertEq(token.totalMinted(), 2 ether, "totalMinted after first withdraw");

        vm.warp(block.timestamp + 2 hours); // now 5 hours total
        _assertEq(token.availableBalance(address(this)), 3 ether, "available after 5h total");

        token.withdraw(3 ether);
        _assertEq(token.balanceOf(address(this)), 5 ether, "balance after second withdraw");
        _assertEq(token.availableBalance(address(this)), 0, "available after full withdraw");
        _assertEq(token.totalMinted(), 5 ether, "totalMinted after second withdraw");
    }

    function testWithdrawWithoutRegistrationReverts() public {
        vm.expectRevert(bytes("Not registered"));
        token.withdraw(1 ether);
    }

    function testWithdrawExceedsAvailableReverts() public {
        token.registerAsCitizen();
        vm.warp(block.timestamp + 1 hours);

        vm.expectRevert(bytes("Insufficient available balance"));
        token.withdraw(2 ether);
    }

    function _assertEq(uint256 a, uint256 b, string memory message) private pure {
        require(a == b, message);
    }
}
