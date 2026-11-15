// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingPrice} from "../src/libraries/ClearingPrice.sol";
import {AuctionMath} from "../src/libraries/AuctionMath.sol";

/// External wrapper so `vm.expectRevert` sees a call boundary.
contract ClearingHarness {
    function clear(uint256[] memory d, uint256 supply) external pure returns (ClearingPrice.Result memory) {
        return ClearingPrice.findClearingTick(d, supply);
    }
}

/// Clearing-rule cases ported from Peal's `ClearingPrice.t.sol` (rewritten),
/// plus a differential test against a slow reference model.
contract ClearingPriceTest is Test {
    uint8 internal constant DEC = 18;
    uint256 internal constant E18 = 1e18;

    ClearingHarness internal h;

    function setUp() public {
        h = new ClearingHarness();
    }

    function _ladder(uint256 n) internal pure returns (uint256[] memory) {
        return new uint256[](n);
    }

    function _alloc(ClearingPrice.Result memory r, uint256 q, uint256 t) internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return ClearingPrice.allocationFor(r, q, uint16(t));
    }

    // Worked example. Supply 100. Ticks: 0 = 1.00, 1 = 1.50, 2 = 2.00 (6-dp quote).
    //   A 50 @ tick 2, B 70 @ tick 1, C 100 @ tick 0
    //   -> clears at tick 1 (1.50); A 50, B 50, C 0.
    function test_workedExample() public pure {
        uint256[] memory d = _ladder(3);
        d[2] = 50 * E18;
        d[1] = 70 * E18;
        d[0] = 100 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);

        assertTrue(r.cleared);
        assertEq(r.clearingTick, 1);
        assertEq(r.supplySold, 100 * E18);
        assertEq(_alloc(r, 50 * E18, 2), 50 * E18, "A above the clear fills");
        assertEq(_alloc(r, 70 * E18, 1), 50 * E18, "B at the clear is rationed");
        assertEq(_alloc(r, 100 * E18, 0), 0, "C below the clear gets nothing");

        uint256 price = AuctionMath.priceAt(1_000_000, 500_000, r.clearingTick);
        assertEq(price, 1_500_000);
        assertEq(AuctionMath.costFloor(50 * E18, price, DEC), 75_000_000, "each winner pays 75");
        uint256 escrowA = AuctionMath.escrowFor(50 * E18, 1_000_000, 500_000, 2, DEC);
        assertEq(escrowA, 100_000_000);
        assertEq(escrowA - 75_000_000, 25_000_000, "A gets 25 back");
    }

    function test_undersubscribedClearsAtReserve() public pure {
        uint256[] memory d = _ladder(4);
        d[3] = 10 * E18;
        d[2] = 5 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        assertTrue(r.cleared);
        assertEq(r.clearingTick, 0, "reserve, not the lowest bid");
        assertEq(r.supplySold, 15 * E18);
        assertEq(_alloc(r, 10 * E18, 3), 10 * E18);
        assertEq(_alloc(r, 5 * E18, 2), 5 * E18);
    }

    function test_undersubscribedWithReserveBids() public pure {
        uint256[] memory d = _ladder(3);
        d[0] = 7 * E18;
        d[2] = 3 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        assertEq(r.clearingTick, 0);
        assertEq(r.supplySold, 10 * E18);
        assertEq(_alloc(r, 7 * E18, 0), 7 * E18, "reserve bids fill in full when undersubscribed");
    }

    function test_noDemandIsAFailure() public pure {
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(_ladder(4), 100 * E18);
        assertFalse(r.cleared);
        assertEq(r.supplySold, 0);
        assertEq(_alloc(r, 10 * E18, 3), 0);
    }

    function test_exactFillIsNotRationed() public pure {
        uint256[] memory d = _ladder(3);
        d[2] = 100 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        assertEq(r.clearingTick, 2);
        assertEq(_alloc(r, 100 * E18, 2), 100 * E18);
    }

    function test_exactFillAcrossTwoTicks() public pure {
        uint256[] memory d = _ladder(3);
        d[2] = 40 * E18;
        d[1] = 60 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        assertEq(r.clearingTick, 1);
        assertEq(_alloc(r, 60 * E18, 1), 60 * E18);
    }

    function test_singleTick() public pure {
        uint256[] memory d = _ladder(1);
        d[0] = 250 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        assertTrue(r.cleared);
        assertEq(r.clearingTick, 0);
        assertEq(_alloc(r, 250 * E18, 0), 100 * E18);
    }

    function test_equalBidsShareEqually() public pure {
        uint256[] memory d = _ladder(2);
        d[0] = 200 * E18; // four bids of 50
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        uint256 each = _alloc(r, 50 * E18, 0);
        assertEq(each, 25 * E18);
        assertEq(each * 4, 100 * E18);
    }

    function test_proRataDoesNotDependOnClaimOrder() public pure {
        uint256[] memory d = _ladder(2);
        d[0] = 300 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        uint256 a = _alloc(r, 100 * E18, 0);
        uint256 b = _alloc(r, 200 * E18, 0);
        assertEq(_alloc(r, 200 * E18, 0), b);
        assertEq(_alloc(r, 100 * E18, 0), a);
        assertEq(a, 33_333333333333333333);
        assertEq(b, 66_666666666666666666);
        assertEq(100 * E18 - (a + b), 1, "one unit of dust stays with the issuer");
    }

    function test_losingWhaleDoesNotMoveThePrice() public pure {
        uint256[] memory d = _ladder(4);
        d[3] = 60 * E18;
        d[2] = 60 * E18;
        ClearingPrice.Result memory before = ClearingPrice.findClearingTick(d, 100 * E18);
        d[0] = 10_000 * E18;
        ClearingPrice.Result memory afterWhale = ClearingPrice.findClearingTick(d, 100 * E18);
        assertEq(afterWhale.clearingTick, before.clearingTick);
        assertEq(afterWhale.supplySold, before.supplySold);
        assertEq(_alloc(afterWhale, 60 * E18, 2), _alloc(before, 60 * E18, 2));
    }

    function test_revertsOnZeroSupply() public {
        vm.expectRevert(ClearingPrice.ZeroSupply.selector);
        h.clear(_ladder(2), 0);
    }

    function test_revertsOnBadTickCount() public {
        vm.expectRevert(abi.encodeWithSelector(ClearingPrice.BadTickCount.selector, 0));
        h.clear(_ladder(0), 100);
        uint256 tooMany = ClearingPrice.MAX_TICKS + 1;
        vm.expectRevert(abi.encodeWithSelector(ClearingPrice.BadTickCount.selector, tooMany));
        h.clear(_ladder(tooMany), 100);
    }

    function test_maxTicksWorks() public pure {
        uint256[] memory d = _ladder(ClearingPrice.MAX_TICKS);
        d[ClearingPrice.MAX_TICKS - 1] = 100 * E18;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, 100 * E18);
        assertTrue(r.cleared);
        assertEq(r.clearingTick, ClearingPrice.MAX_TICKS - 1);
    }

    // ------------------------------------------------------------------ fuzz

    function _fill(uint96[8] memory raw) internal pure returns (uint256[] memory d, uint256 total) {
        d = _ladder(8);
        for (uint256 i; i < 8; ++i) {
            d[i] = raw[i];
            total += raw[i];
        }
    }

    function testFuzz_allocationNeverExceedsSupply(uint96[8] memory raw, uint96 s) public pure {
        (uint256[] memory d, uint256 total) = _fill(raw);
        vm.assume(total > 0);
        uint256 supply = uint256(s) + 1;
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, supply);
        uint256 allocated;
        for (uint256 i; i < 8; ++i) {
            allocated += _alloc(r, d[i], i);
        }
        assertLe(allocated, supply);
        assertLe(allocated, r.supplySold);
        assertLe(r.supplySold, supply, "sold more than offered");
    }

    function testFuzz_allocationRespectsBidAndTick(uint96[8] memory raw, uint96 s, uint8 t) public pure {
        (uint256[] memory d, uint256 total) = _fill(raw);
        vm.assume(total > 0);
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, uint256(s) + 1);
        uint256 tick = t % 8;
        uint256 got = _alloc(r, d[tick], tick);
        assertLe(got, d[tick]);
        if (tick < r.clearingTick) assertEq(got, 0);
        if (tick > r.clearingTick) assertEq(got, d[tick]);
    }

    function testFuzz_clearingPriceNeverBelowReserve(uint96[8] memory raw, uint96 s, uint64 reserve, uint64 step)
        public
        pure
    {
        (uint256[] memory d, uint256 total) = _fill(raw);
        vm.assume(total > 0);
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, uint256(s) + 1);
        assertGe(AuctionMath.priceAt(reserve, step, r.clearingTick), reserve);
    }

    /// Splitting one tick's demand across several bids never lets them together
    /// receive more than the tick's share of supply.
    function testFuzz_splitBidsAtClearingTick(uint64[4] memory parts, uint96 above, uint96 s) public pure {
        uint256[] memory d = _ladder(2);
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            sum += parts[i];
        }
        d[0] = sum;
        d[1] = above;
        vm.assume(sum + above > 0);
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, uint256(s) + 1);
        if (r.clearingTick != 0) return;
        uint256 got;
        for (uint256 i; i < 4; ++i) {
            got += _alloc(r, parts[i], 0);
        }
        assertLe(got, r.supplyAtTick);
        assertGe(got + 4, r.supplyAtTick < sum ? r.supplyAtTick : sum, "at most one unit of dust per bid");
    }

    /// Differential test: the tick scan agrees with a direct definition. The
    /// clearing tick is the highest tick t whose demand at or above t covers the
    /// supply; if none does, the reserve (or failure with no demand).
    function testFuzz_matchesReferenceModel(uint96[8] memory raw, uint96 s) public pure {
        (uint256[] memory d, uint256 total) = _fill(raw);
        uint256 supply = uint256(s) + 1;
        if (total == 0) {
            assertFalse(ClearingPrice.findClearingTick(d, supply).cleared);
            return;
        }
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(d, supply);
        int256 expected = -1;
        for (uint256 t = 8; t > 0; --t) {
            uint256 atOrAbove;
            for (uint256 j = t - 1; j < 8; ++j) {
                atOrAbove += d[j];
            }
            if (atOrAbove >= supply) {
                // forge-lint: disable-next-line(unsafe-typecast)
                expected = int256(t - 1);
                break;
            }
        }
        assertTrue(r.cleared);
        if (expected < 0) {
            assertEq(r.clearingTick, 0);
            assertEq(r.supplySold, total);
        } else {
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(uint256(r.clearingTick), uint256(expected));
            assertEq(r.supplySold, supply);
        }
    }
}
