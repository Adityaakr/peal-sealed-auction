// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {SealedAuction} from "../src/SealedAuction.sol";
import {AuctionBase} from "./utils/AuctionBase.sol";

/// Whole-auction property tests: random bids and a random set of releasing
/// members, run to the end, then everything is claimed.
contract SealedAuctionFuzzTest is AuctionBase {
    function testFuzz_fullAuctionConservesEveryToken(
        uint96[6] memory qtyRaw,
        uint8[6] memory tickRaw,
        uint8 releasers,
        uint96 supplyRaw
    ) public {
        SealedAuction.Config memory c = _config();
        c.totalSupply = uint256(supplyRaw) % (1_000 * E18) + 1;
        SealedAuction a = _create(c);

        uint256 quoteIn;
        for (uint256 i; i < 6; ++i) {
            uint128 qty = uint128(uint256(qtyRaw[i]) % (500 * E18) + 1);
            uint16 tick = uint16(tickRaw[i] % c.numTicks);
            address bidder = makeAddr(string.concat("bidder", vm.toString(i % 4)));
            uint256 escrow = a.escrowFor(qty, tick);
            if (escrow == 0) escrow = 1;
            _bidRaw(a, bidder, _plaintext(qty, tick), escrow, 2);
            quoteIn += escrow + BOND;
        }
        _close(a);

        uint256 released;
        for (uint8 j = 1; j <= 3; ++j) {
            if ((releasers >> (j - 1)) & 1 == 1) {
                _release(a, j);
                ++released;
            }
        }
        if (!a.releaseWindowOver()) vm.warp(c.releaseDeadline + 1);
        _openAll(a);
        a.finalize();

        if (released >= 2) {
            assertEq(uint8(a.state()), uint8(SealedAuction.State.Settled), "t releases settle the auction");
            assertLe(a.totalSold(), c.totalSupply);
        } else {
            assertEq(uint8(a.state()), uint8(SealedAuction.State.Failed), "below t nothing opens");
        }

        _claimAll(a);
        if (a.state() == SealedAuction.State.Settled) a.claimProceeds();
        a.claimUnsold();

        assertEq(quote.balanceOf(address(a)), 0, "quote left behind or overspent");
        assertEq(sale.balanceOf(address(a)), 0, "sale left behind or overspent");
        assertEq(sale.balanceOf(issuer) + _saleHeldByBidders(), c.totalSupply, "sale tokens created or destroyed");
        assertEq(
            quote.balanceOf(issuer) + quote.balanceOf(feeTo) + _quoteHeldByBidders() + quote.balanceOf(a.BURN()),
            quoteIn,
            "quote tokens created or destroyed"
        );
    }

    function _saleHeldByBidders() internal returns (uint256 s) {
        for (uint256 i; i < 4; ++i) {
            s += sale.balanceOf(makeAddr(string.concat("bidder", vm.toString(i))));
        }
    }

    function _quoteHeldByBidders() internal returns (uint256 s) {
        for (uint256 i; i < 4; ++i) {
            s += quote.balanceOf(makeAddr(string.concat("bidder", vm.toString(i))));
        }
    }

    /// The price winners pay never exceeds their own bid, and every winner pays the same price.
    function testFuzz_winnersPayOneUniformPrice(uint96[5] memory qtyRaw, uint8[5] memory tickRaw) public {
        SealedAuction a = _create(_config());
        for (uint256 i; i < 5; ++i) {
            uint128 qty = uint128(uint256(qtyRaw[i]) % (80 * E18) + E18);
            _bid(a, makeAddr(string.concat("b", vm.toString(i))), qty, uint16(tickRaw[i] % 8));
        }
        _close(a);
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        _openAll(a);
        a.finalize();
        uint256 price = a.clearingPrice();
        for (uint256 i; i < 5; ++i) {
            SealedAuction.Bid memory b = a.getBid(i);
            if (a.allocationOf(i) == 0) continue;
            assertGe(uint256(b.tick), uint256(a.clearing().clearingTick), "a bid below the clear won");
            assertLe(price, 1_000_000 + uint256(b.tick) * 500_000, "charged above the bid");
        }
    }
}
