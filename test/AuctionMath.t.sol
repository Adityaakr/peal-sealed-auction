// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionMath} from "../src/libraries/AuctionMath.sol";

contract AuctionMathTest is Test {
    uint8 internal constant DEC = 18;

    function test_priceLadder() public pure {
        assertEq(AuctionMath.priceAt(1_000_000, 250_000, 0), 1_000_000);
        assertEq(AuctionMath.priceAt(1_000_000, 250_000, 4), 2_000_000);
    }

    function test_costRoundsBothWays() public pure {
        // 1 base unit of an 18-dp token at 1.5 (6-dp) costs 1.5e-12: floor 0, ceil 1.
        assertEq(AuctionMath.costFloor(1, 1_500_000, DEC), 0);
        assertEq(AuctionMath.costCeil(1, 1_500_000, DEC), 1);
        assertEq(AuctionMath.costFloor(2e18, 1_500_000, DEC), 3_000_000);
        assertEq(AuctionMath.costCeil(2e18, 1_500_000, DEC), 3_000_000);
    }

    function test_noOverflowOnLargeInputs() public pure {
        // quantity * price is about 1e54: past 2**256 for a naive a*b with bigger values,
        // fine through mulDiv.
        uint256 q = 1e30;
        uint256 p = 1e40;
        assertEq(AuctionMath.costFloor(q, p, DEC), 1e52);
    }

    function test_feeOn() public pure {
        assertEq(AuctionMath.feeOn(1_000_000, 30), 3_000);
        assertEq(AuctionMath.feeOn(333, 1), 0, "fee floors");
        assertEq(AuctionMath.feeOn(1_000, 10_000), 1_000);
    }

    function testFuzz_escrowCoversAnyLowerClear(uint96 q, uint64 reserve, uint64 step, uint8 maxTick) public pure {
        vm.assume(q > 0);
        uint256 escrow = AuctionMath.escrowFor(q, reserve, step, maxTick, DEC);
        for (uint16 t; t <= maxTick; ++t) {
            assertLe(AuctionMath.costFloor(q, AuctionMath.priceAt(reserve, step, t), DEC), escrow);
            if (t == type(uint8).max) break;
        }
    }

    function testFuzz_roundingFavoursBidder(uint96 q, uint64 price) public pure {
        uint256 up = AuctionMath.costCeil(q, price, DEC);
        uint256 down = AuctionMath.costFloor(q, price, DEC);
        assertGe(up, down);
        assertLe(up - down, 1);
    }

    function testFuzz_feeBounded(uint128 proceeds, uint16 bpsRaw) public pure {
        uint16 bps = uint16(bpsRaw % 10_001);
        uint256 fee = AuctionMath.feeOn(proceeds, bps);
        assertLe(fee, proceeds);
        assertLe(fee * 10_000, uint256(proceeds) * bps);
    }

    /// Paying for a partial allocation never costs more than paying for the whole bid.
    function testFuzz_costMonotoneInQuantity(uint96 a, uint96 b, uint64 price) public pure {
        (uint256 lo, uint256 hi) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        assertLe(AuctionMath.costFloor(lo, price, DEC), AuctionMath.costFloor(hi, price, DEC));
        assertLe(AuctionMath.costCeil(lo, price, DEC), AuctionMath.costCeil(hi, price, DEC));
    }
}
