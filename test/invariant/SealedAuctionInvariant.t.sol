// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SealedAuction} from "../../src/SealedAuction.sol";
import {AuctionMath} from "../../src/libraries/AuctionMath.sol";
import {AuctionBase} from "../utils/AuctionBase.sol";

/// Random actors drive one auction through its whole life: honest and junk bids,
/// releases from any member (sometimes withholding chosen bids), openings,
/// finalize, claims and time jumps.
contract Handler is AuctionBase {
    SealedAuction public auction;
    address[4] internal bidders;
    uint256 public calls;

    function init() external {
        setUp();
        auction = _create(_config());
        for (uint256 i; i < 4; ++i) {
            bidders[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }
    }

    function commit(uint256 who, uint128 qtyRaw, uint16 tickRaw, uint8 kind) external {
        ++calls;
        if (auction.state() != SealedAuction.State.CommitOpen || auction.bidCount() >= 24) return;
        if (block.timestamp >= auction.config().endTime) return;
        address bidder = bidders[who % 4];
        uint128 qty = uint128(uint256(qtyRaw) % (60 * E18) + 1);
        uint16 tick = uint16(tickRaw % 8);
        uint256 escrow = auction.escrowFor(qty, tick);
        if (escrow == 0) escrow = 1;
        uint256 k = kind % 8;
        if (k == 0) {
            // junk plaintext: padding set
            _bidRaw(auction, bidder, bytes32(uint256(_plaintext(qty, tick)) | 1), escrow, 2);
        } else if (k == 1) {
            // under-escrowed
            _bidRaw(auction, bidder, _plaintext(qty, tick), escrow / 2 + 1, 2);
        } else if (k == 2) {
            // dealt with a degree too high: two shares do not rebuild K
            _bidRaw(auction, bidder, _plaintext(qty, tick), escrow, 3);
        } else {
            _bidRaw(auction, bidder, _plaintext(qty, tick), escrow, 2);
        }
    }

    function close() external {
        ++calls;
        if (auction.state() != SealedAuction.State.CommitOpen) return;
        vm.warp(auction.config().endTime);
        auction.closeCommit();
    }

    function release(uint8 memberRaw, uint256 withhold) external {
        ++calls;
        if (auction.state() != SealedAuction.State.Closed) return;
        if (block.timestamp > auction.config().releaseDeadline) return;
        uint8 index = uint8(memberRaw % 3) + 1;
        if (auction.releaseMask() & (1 << (index - 1)) != 0) return;
        uint256 count = auction.bidCount();
        uint256 bitmap = count >= 256 ? withhold : withhold & ((1 << count) - 1);
        bitmap &= withhold >> 128; // withhold rarely
        _release(auction, index, bitmap);
    }

    function open(uint256 from, uint256 len) external {
        ++calls;
        if (auction.state() != SealedAuction.State.Closed) return;
        uint256 n = auction.bidCount();
        from = from % n;
        len = len % (n - from) + 1;
        uint256[] memory ids = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            ids[i] = from + i;
        }
        auction.openBids(ids);
    }

    function finalize() external {
        ++calls;
        if (auction.state() != SealedAuction.State.Closed) return;
        if (!auction.releaseWindowOver()) return;
        _openAll(auction);
        auction.finalize();
    }

    function claim(uint256 id) external {
        ++calls;
        SealedAuction.State s = auction.state();
        if (s != SealedAuction.State.Settled && s != SealedAuction.State.Failed) return;
        uint256 n = auction.bidCount();
        if (n == 0) return;
        id = id % n;
        if (auction.getBid(id).claimed) return;
        auction.claim(id);
    }

    function claimIssuer(bool proceeds) external {
        ++calls;
        SealedAuction.State s = auction.state();
        if (proceeds && s == SealedAuction.State.Settled && !auction.proceedsClaimed()) auction.claimProceeds();
        if (!proceeds && (s == SealedAuction.State.Settled || s == SealedAuction.State.Failed)) {
            if (!auction.unsoldClaimed()) auction.claimUnsold();
        }
    }

    function warp(uint32 secs) external {
        ++calls;
        vm.warp(block.timestamp + secs % 2 hours);
    }

    // ------------------------------------------------------------ ghost views

    function saleBalanceOfAuction() external view returns (uint256) {
        return sale.balanceOf(address(auction));
    }

    function quoteBalanceOfAuction() external view returns (uint256) {
        return quote.balanceOf(address(auction));
    }

    /// Quote the auction still owes: unclaimed refunds plus unclaimed proceeds.
    function quoteOwed() external view returns (uint256 owed) {
        SealedAuction a = auction;
        SealedAuction.State s = a.state();
        uint256 n = a.bidCount();
        for (uint256 i; i < n; ++i) {
            SealedAuction.Bid memory b = a.getBid(i);
            if (b.claimed) continue;
            owed += b.escrow + (b.bondBurned ? 0 : BOND);
            if (s == SealedAuction.State.Settled && b.status == SealedAuction.BidStatus.Opened) {
                owed -= AuctionMath.costFloor(a.allocationOf(i), a.clearingPrice(), 18);
            }
        }
        if (s == SealedAuction.State.Settled && !a.proceedsClaimed()) owed += a.grossProceeds();
    }

    /// Sale tokens the auction still owes: unclaimed allocations plus unclaimed unsold supply.
    function saleOwed() external view returns (uint256 owed) {
        SealedAuction a = auction;
        SealedAuction.State s = a.state();
        uint256 supply = a.config().totalSupply;
        if (s != SealedAuction.State.Settled) {
            return (s == SealedAuction.State.Cancelled || a.unsoldClaimed()) ? 0 : supply;
        }
        uint256 n = a.bidCount();
        for (uint256 i; i < n; ++i) {
            if (!a.getBid(i).claimed) owed += a.allocationOf(i);
        }
        if (!a.unsoldClaimed()) owed += supply - a.totalSold();
    }

    function sumAllocations() external view returns (uint256 s) {
        uint256 n = auction.bidCount();
        for (uint256 i; i < n; ++i) {
            s += auction.allocationOf(i);
        }
    }
}

contract SealedAuctionInvariantTest is Test {
    Handler internal h;

    function setUp() public {
        h = new Handler();
        h.init();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = Handler.commit.selector;
        sel[1] = Handler.commit.selector;
        sel[2] = Handler.close.selector;
        sel[3] = Handler.release.selector;
        sel[4] = Handler.open.selector;
        sel[5] = Handler.finalize.selector;
        sel[6] = Handler.claim.selector;
        sel[7] = Handler.claimIssuer.selector;
        sel[8] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_quoteSolvent() public view {
        assertGe(h.quoteBalanceOfAuction(), h.quoteOwed(), "auction cannot pay what it owes in quote");
    }

    function invariant_saleSolvent() public view {
        assertGe(h.saleBalanceOfAuction(), h.saleOwed(), "auction cannot pay what it owes in sale tokens");
    }

    function invariant_allocationsWithinSupply() public view {
        SealedAuction a = h.auction();
        uint256 supply = a.config().totalSupply;
        assertLe(a.totalSold(), supply);
        assertLe(h.sumAllocations(), a.totalSold());
    }

    function invariant_noBidOpensBelowThreshold() public view {
        SealedAuction a = h.auction();
        uint256 n = a.bidCount();
        uint256 t = a.threshold();
        for (uint256 i; i < n; ++i) {
            SealedAuction.Bid memory b = a.getBid(i);
            bool opened = b.status == SealedAuction.BidStatus.Opened || b.status == SealedAuction.BidStatus.Excluded;
            if (!opened) continue;
            uint256 c;
            for (uint8 m = b.shareMask; m != 0; m &= m - 1) {
                ++c;
            }
            assertGe(c, t, "a bid opened with fewer than t shares");
        }
    }

    function invariant_decidedNeverExceedsBids() public view {
        SealedAuction a = h.auction();
        assertLe(a.decidedCount(), a.bidCount());
    }
}
