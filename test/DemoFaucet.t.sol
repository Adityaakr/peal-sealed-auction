// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PealT} from "../src/demo/PealT.sol";
import {DemoFaucet} from "../src/demo/DemoFaucet.sol";

contract DemoFaucetTest is Test {
    PealT internal token;
    DemoFaucet internal faucet;
    address internal user = makeAddr("user");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new PealT(address(this), 1_000_000e18);
        faucet = new DemoFaucet(IERC20(address(token)), 1_000e18, 1 days);
        token.transfer(address(faucet), 10_000e18);
    }

    function test_claimAndCooldown() public {
        vm.prank(user);
        faucet.claim(1_000e18);
        assertEq(token.balanceOf(user), 1_000e18);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.CoolingDown.selector, uint64(block.timestamp + 1 days)));
        faucet.claim(1);
        vm.warp(block.timestamp + 1 days);
        vm.prank(user);
        faucet.claim(1);
    }

    function test_limits() public {
        vm.startPrank(user);
        vm.expectRevert(DemoFaucet.ZeroAmount.selector);
        faucet.claim(0);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.AboveMax.selector, 1_001e18, 1_000e18));
        faucet.claim(1_001e18);
        vm.stopPrank();
    }

    function test_empty() public {
        DemoFaucet dry = new DemoFaucet(IERC20(address(token)), 1_000e18, 1 days);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.Empty.selector, 1, 0));
        dry.claim(1);
        (uint256 amount,) = dry.claimableBy(user);
        assertEq(amount, 0);
    }

    function test_tokenMetadata() public view {
        assertEq(token.symbol(), "PEAL-T");
        assertEq(token.decimals(), 18);
    }
}
