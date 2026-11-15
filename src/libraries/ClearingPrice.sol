// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ClearingPrice
/// @notice Uniform-price clearing over a bounded ladder of price ticks.
/// @dev The rule is ported from Peal (`contracts/src/auctionkit/ClearingPrice.sol`,
///      see README "Prior work"); this file is a fresh implementation.
///
///      Demand is bucketed by the highest tick each bidder accepts. Walking the
///      ladder from the top tick down, the clearing tick is the first one at which
///      cumulative demand reaches the supply. Every winner pays the price of that
///      tick. Bids strictly above it fill in full, bids at it share what is left
///      pro rata (rounded down), and bids below it get nothing.
///
///      Two edge cases are kept apart on purpose:
///      - Undersubscribed (demand > 0 but below supply): all demand fills at the
///        reserve (tick 0), never at the lowest tick someone bid, so a dust bid
///        cannot set the price for the whole sale.
///      - No demand: `cleared == false`. The caller fails the auction and refunds.
///
///      The scan is over ticks (at most `MAX_TICKS`), never over bids, so its cost
///      is fixed by the configuration and not by how many bids arrive.
library ClearingPrice {
    uint256 internal constant MAX_TICKS = 256;

    error BadTickCount(uint256 numTicks);
    error ZeroSupply();

    /// @param cleared       false only when there was no demand at all
    /// @param clearingTick  the tick every winner pays
    /// @param supplySold    sale base units allocated before per-bid flooring
    /// @param demandAtTick  total demand bucketed exactly at `clearingTick`
    /// @param supplyAtTick  supply left for `clearingTick` once higher ticks filled
    struct Result {
        bool cleared;
        uint16 clearingTick;
        uint256 supplySold;
        uint256 demandAtTick;
        uint256 supplyAtTick;
    }

    function findClearingTick(uint256[] memory demandByTick, uint256 supply) internal pure returns (Result memory r) {
        uint256 n = demandByTick.length;
        if (n == 0 || n > MAX_TICKS) revert BadTickCount(n);
        if (supply == 0) revert ZeroSupply();

        uint256 above; // demand strictly above the tick being looked at
        for (uint256 tick = n; tick != 0;) {
            unchecked {
                --tick;
            }
            uint256 here = demandByTick[tick];
            if (above + here >= supply) {
                r.cleared = true;
                // tick < n <= 256 fits in uint16.
                // forge-lint: disable-next-line(unsafe-typecast)
                r.clearingTick = uint16(tick);
                r.supplySold = supply;
                r.demandAtTick = here;
                r.supplyAtTick = supply - above;
                return r;
            }
            above += here;
        }

        if (above == 0) return r; // nothing bid: not a sale, a failure

        // Undersubscribed: every bid fills in full at the reserve.
        r.cleared = true;
        r.clearingTick = 0;
        r.supplySold = above;
        r.demandAtTick = demandByTick[0];
        r.supplyAtTick = demandByTick[0];
    }

    /// @notice Sale base units one bid receives under a clearing result.
    /// @dev Depends only on the bid and on totals fixed at finalization, so it is
    ///      the same whatever order bidders claim in. Flooring leaves a few units of
    ///      dust that stay with the issuer as unsold supply.
    function allocationFor(Result memory r, uint256 quantity, uint16 tick) internal pure returns (uint256) {
        if (!r.cleared || tick < r.clearingTick) return 0;
        if (tick > r.clearingTick || r.demandAtTick <= r.supplyAtTick) return quantity;
        return Math.mulDiv(quantity, r.supplyAtTick, r.demandAtTick);
    }
}
