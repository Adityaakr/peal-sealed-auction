// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqAuth} from "qore-pq-kit/PqAuth.sol";
import {SealedSlot} from "qore-pq-kit/threshold/SealedSlot.sol";
import {MockPqcVerify} from "qore-pq-kit-test/mocks/MockPqcVerify.sol";

import {SealedAuction} from "../src/SealedAuction.sol";
import {AuctionBase} from "./utils/AuctionBase.sol";
import {FeeOnTransferERC20} from "./mocks/MockERC20.sol";

contract SealedAuctionTest is AuctionBase {
    SealedAuction internal a;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public override {
        super.setUp();
        a = _create(_config());
    }

    // Worked example: supply 100; A 50 @ 2.00, B 70 @ 1.50, C 100 @ 1.00.
    // Ticks: 0 = 1.00, 1 = 1.50, 2 = 2.00. Clears at 1.50.
    function _workedExample() internal {
        _bid(a, alice, uint128(50 * E18), 2);
        _bid(a, bob, uint128(70 * E18), 1);
        _bid(a, carol, uint128(100 * E18), 0);
        _close(a);
    }

    // ------------------------------------------------------------ happy path

    function test_fullLifecycleWithOneMemberOffline() public {
        _workedExample();
        _release(a, 1);
        _release(a, 2); // member 3 stays offline
        assertFalse(a.releaseWindowOver());
        _openAll(a);
        assertEq(a.decidedCount(), 3);

        vm.expectRevert(SealedAuction.ReleaseWindowOpen.selector);
        a.finalize();
        vm.warp(a.config().releaseDeadline + 1);
        a.finalize();

        assertEq(uint8(a.state()), uint8(SealedAuction.State.Settled));
        assertEq(a.clearing().clearingTick, 1);
        assertEq(a.clearingPrice(), 1_500_000);
        assertEq(a.totalSold(), 100 * E18);
        assertEq(a.grossProceeds(), 150_000_000);

        (uint256 tA, uint256 rA) = a.claim(0);
        (uint256 tB, uint256 rB) = a.claim(1);
        (uint256 tC, uint256 rC) = a.claim(2);
        assertEq(tA, 50 * E18);
        assertEq(rA, 100_000_000 - 75_000_000 + BOND, "A pays 1.50, not 2.00");
        assertEq(tB, 50 * E18);
        assertEq(rB, 105_000_000 - 75_000_000 + BOND);
        assertEq(tC, 0);
        assertEq(rC, 100_000_000 + BOND);

        a.claimProceeds();
        a.claimUnsold();
        assertEq(quote.balanceOf(issuer), 150_000_000 - 1_500_000);
        assertEq(quote.balanceOf(feeTo), 1_500_000);
        assertEq(quote.balanceOf(address(a)), 0, "every quote unit accounted for");
        assertEq(sale.balanceOf(address(a)), 0, "every sale unit accounted for");
    }

    function test_allReleasesLetFinalizeRunEarly() public {
        _workedExample();
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        assertTrue(a.releaseWindowOver());
        _openAll(a);
        a.finalize();
        assertEq(uint8(a.state()), uint8(SealedAuction.State.Settled));
    }

    function test_anyTwoMembersOpenTheBids() public {
        _workedExample();
        _release(a, 1);
        _release(a, 3);
        _openAll(a);
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(a.getBid(i).status), uint8(SealedAuction.BidStatus.Opened));
        }
        (, uint256[] memory s) = a.sharesOf(0);
        assertEq(s[1], 0, "member 2 never released");
    }

    function test_bidsOpenToTheCommittedValues() public {
        _bid(a, alice, 1234, 5);
        _close(a);
        _release(a, 2);
        _release(a, 3);
        _openAll(a);
        SealedAuction.Bid memory b = a.getBid(0);
        assertEq(b.quantity, 1234);
        assertEq(b.tick, 5);
    }

    function test_undersubscribedFillsAtReserve() public {
        _bid(a, alice, uint128(10 * E18), 3);
        _bid(a, bob, uint128(5 * E18), 2);
        _close(a);
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        _openAll(a);
        a.finalize();
        assertEq(a.clearing().clearingTick, 0);
        assertEq(a.clearingPrice(), 1_000_000);
        assertEq(a.totalSold(), 15 * E18);
        a.claimUnsold();
        assertEq(sale.balanceOf(issuer), 85 * E18);
    }

    function test_twoBidsFromOneBidder() public {
        _bid(a, alice, uint128(10 * E18), 1);
        _bid(a, alice, uint128(20 * E18), 4);
        assertEq(a.bidCountOf(alice), 2);
        _close(a);
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        _openAll(a);
        assertEq(a.openedQuantityOf(alice), 30 * E18);
    }

    // ------------------------------------------------------------ commit rules

    function test_commitRejectsWrongSeq() public {
        Sealed memory z = _seal(address(a), alice, 1, _plaintext(1, 1), 2, 1);
        _fundBidder(alice, address(a), 1e9);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadSeq.selector, 0));
        a.commitBid(1, z.ct, z.keyHash, z.shareHashes, z.envelopes, 1e6);
    }

    function test_commitRejectsBadShape() public {
        Sealed memory z = _seal(address(a), alice, 0, _plaintext(1, 1), 2, 1);
        _fundBidder(alice, address(a), 1e9);
        bytes32[] memory two = new bytes32[](2);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadBid.selector, "share count"));
        a.commitBid(0, z.ct, z.keyHash, two, z.envelopes, 1e6);
        z.envelopes[1] = new bytes(4097);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadBid.selector, "envelope"));
        a.commitBid(0, z.ct, z.keyHash, z.shareHashes, z.envelopes, 1e6);
        z.envelopes[1] = new bytes(1752);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadBid.selector, "escrow"));
        a.commitBid(0, z.ct, z.keyHash, z.shareHashes, z.envelopes, 0);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadBid.selector, "keyHash"));
        a.commitBid(0, z.ct, bytes32(0), z.shareHashes, z.envelopes, 1e6);
        vm.stopPrank();
    }

    function test_commitWindow() public {
        vm.warp(a.config().endTime);
        Sealed memory z = _seal(address(a), alice, 0, _plaintext(1, 1), 2, 1);
        _fundBidder(alice, address(a), 1e9);
        vm.prank(alice);
        vm.expectRevert(SealedAuction.TooLate.selector);
        a.commitBid(0, z.ct, z.keyHash, z.shareHashes, z.envelopes, 1e6);
    }

    function test_commitPullsEscrowPlusBond() public {
        uint256 before = quote.balanceOf(address(a));
        _bid(a, alice, uint128(E18), 2);
        assertEq(quote.balanceOf(address(a)) - before, 2_000_000 + BOND);
    }

    function test_maxBids() public {
        SealedAuction.Config memory c = _config();
        c.maxBids = 1;
        SealedAuction small = _create(c);
        _bid(small, alice, 1, 0);
        Sealed memory z = _seal(address(small), bob, 0, _plaintext(1, 1), 2, 1);
        _fundBidder(bob, address(small), 1e9);
        vm.prank(bob);
        vm.expectRevert(SealedAuction.TooManyBids.selector);
        small.commitBid(0, z.ct, z.keyHash, z.shareHashes, z.envelopes, 1e6);
    }

    function test_noBidsFailsAndReturnsSupply() public {
        _close(a);
        assertEq(uint8(a.state()), uint8(SealedAuction.State.Failed));
        a.claimUnsold();
        assertEq(sale.balanceOf(issuer), 100 * E18);
    }

    // ------------------------------------------------------------ releases

    function test_releaseBeforeCloseRefused() public {
        _bid(a, alice, 1, 0);
        uint256[] memory shares = _releaseShares(a, 1, 0);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 0, d);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadState.selector, SealedAuction.State.CommitOpen));
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_releaseSignedByNonMemberRefused() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0);
        uint256 d = block.timestamp + 60;
        bytes32 outsider = keccak256("outsider");
        bytes memory sig = pqSign(outsider, a.releaseMessage(1, shares, 0, d));
        vm.expectRevert(SealedAuction.ReleaseSignatureInvalid.selector);
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_releaseSignedByAnotherMemberRefused() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0);
        uint256 d = block.timestamp + 60;
        bytes memory sig = pqSign(memberSecret[1], a.releaseMessage(1, shares, 0, d));
        vm.expectRevert(SealedAuction.ReleaseSignatureInvalid.selector);
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_releaseForAnotherAuctionRefused() public {
        _workedExample();
        SealedAuction other = _create(_config());
        _bid(other, alice, uint128(50 * E18), 2);
        _bid(other, bob, uint128(70 * E18), 1);
        _bid(other, carol, uint128(100 * E18), 0);
        _close(other);
        uint256[] memory shares = _releaseShares(other, 1, 0);
        uint256 d = block.timestamp + 60;
        bytes memory sigForOther = _signRelease(other, 1, shares, 0, d);
        // Same member, same bid count, but signed for `other`: refused here.
        vm.expectRevert(SealedAuction.ReleaseSignatureInvalid.selector);
        a.submitRelease(1, shares, 0, d, sigForOther);
    }

    function test_releaseReplayRefused() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 0, d);
        a.submitRelease(1, shares, 0, d, sig);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.AlreadyReleased.selector, 1));
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_releaseAfterDeadlineRefused() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0);
        vm.warp(a.config().releaseDeadline + 1);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 0, d);
        vm.expectRevert(SealedAuction.TooLate.selector);
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_expiredReleaseSignatureRefused() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 0, d);
        vm.warp(d + 1);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.ReleaseExpired.selector, d));
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_releaseWithWrongShareRevertsWhole() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 2, 0);
        shares[1] = addmod(shares[1], 1, P);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 2, shares, 0, d);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.WrongShare.selector, 1));
        a.submitRelease(2, shares, 0, d, sig);
    }

    function test_releaseWithAnotherMembersShareReverts() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0); // member 1's shares...
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 2, shares, 0, d); // ...posted as member 2's
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.WrongShare.selector, 0));
        a.submitRelease(2, shares, 0, d, sig);
    }

    function test_bitmapThatDisagreesWithSharesReverts() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0); // bit 0 set but share present
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 1, d);
        vm.expectRevert(SealedAuction.BadBitmap.selector);
        a.submitRelease(1, shares, 1, d, sig);

        uint256 high = 1 << 3; // only 3 bids
        uint256[] memory s2 = _releaseShares(a, 1, high);
        bytes memory sig2 = _signRelease(a, 1, s2, high, d);
        vm.expectRevert(SealedAuction.BadBitmap.selector);
        a.submitRelease(1, s2, high, d, sig2);
    }

    function test_releaseLengthMustMatchFrozenSet() public {
        _workedExample();
        uint256[] memory shares = new uint256[](2);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 0, d);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.ReleaseLength.selector, 2, 3));
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_badMemberIndex() public {
        _workedExample();
        uint256[] memory shares = new uint256[](3);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadMemberIndex.selector, 4));
        a.submitRelease(4, shares, 0, block.timestamp + 60, "");
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadMemberIndex.selector, 0));
        a.submitRelease(0, shares, 0, block.timestamp + 60, "");
    }

    function test_releaseFailsClosedOnEmptyPrecompile() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 1, 0);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 0, d);
        pqcVerifyMock.setMode(MockPqcVerify.Mode.EmptyReturn);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PqPrecompileUnavailable.selector, PqAuth.PQC_VERIFY));
        a.submitRelease(1, shares, 0, d, sig);
    }

    function test_releaseRelayedByAnyone() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 3, 0);
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 3, shares, 0, d);
        vm.prank(makeAddr("relayer"));
        a.submitRelease(3, shares, 0, d, sig);
        assertEq(a.releaseCount(), 1);
    }

    function test_releaseRefusesShareOutsideField() public {
        // A bidder commits a share hash of a value >= P. The member must flag it;
        // posting it reverts, so it can never reach Shamir and block opening.
        uint32 seq = 0;
        Sealed memory z = _seal(address(a), alice, seq, _plaintext(uint128(E18), 1), 2, 7);
        z.shareHashes[0] = SealedSlot.shareHash(address(a), alice, seq, 1, P + 5);
        _fundBidder(alice, address(a), 1e9);
        vm.prank(alice);
        a.commitBid(seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, 2_000_000);
        _close(a);

        uint256[] memory shares = new uint256[](1);
        shares[0] = P + 5;
        uint256 d = block.timestamp + 60;
        bytes memory sig = _signRelease(a, 1, shares, 0, d);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.WrongShare.selector, 0));
        a.submitRelease(1, shares, 0, d, sig);

        // Flagged instead: accepted.
        shares[0] = 0;
        sig = _signRelease(a, 1, shares, 1, d);
        a.submitRelease(1, shares, 1, d, sig);
        (uint8 mask,) = a.sharesOf(0);
        assertEq(mask, 0);
    }

    // ------------------------------------------------------------ opening

    function test_fewerThanThresholdSharesCannotOpen() public {
        _workedExample();
        _release(a, 1);
        _openAll(a);
        assertEq(a.decidedCount(), 0, "one share opens nothing while releases can still arrive");
        vm.warp(a.config().releaseDeadline + 1);
        _openAll(a);
        for (uint256 i; i < 3; ++i) {
            SealedAuction.Bid memory b = a.getBid(i);
            assertEq(uint8(b.status), uint8(SealedAuction.BidStatus.Unopenable));
            assertFalse(b.bondBurned, "members stayed away: the bidder keeps its bond");
        }
        a.finalize();
        assertEq(uint8(a.state()), uint8(SealedAuction.State.Failed));
        _claimAll(a);
        assertEq(quote.balanceOf(alice), 100_000_000 + BOND);
        assertEq(quote.balanceOf(address(a)), 0);
    }

    function test_inconsistentDealerIsExcludedNotFatal() public {
        _bid(a, alice, uint128(60 * E18), 2);
        // Bob deals a fresh polynomial per share: no two shares agree on K.
        uint32 seq = 0;
        Sealed memory z = _seal(address(a), bob, seq, _plaintext(uint128(60 * E18), 3), 2, 99);
        Sealed memory w = _seal(address(a), bob, seq, _plaintext(uint128(60 * E18), 3), 2, 100);
        z.shares[1] = w.shares[1];
        z.shareHashes[1] = w.shareHashes[1];
        _fundBidder(bob, address(a), 1e12);
        vm.prank(bob);
        a.commitBid(seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, 200_000_000);
        dealt[address(a)][1] = z.shares;
        _close(a);

        _release(a, 1);
        _release(a, 2);
        _openAll(a);
        assertEq(uint8(a.getBid(0).status), uint8(SealedAuction.BidStatus.Opened));
        assertEq(uint8(a.getBid(1).status), uint8(SealedAuction.BidStatus.Pending), "member 3 may still release");

        _release(a, 3); // all three released: shares 1 and 3 still agree on K
        _openAll(a);
        assertEq(uint8(a.getBid(1).status), uint8(SealedAuction.BidStatus.Opened), "a consistent pair opens it");
    }

    function test_unopenableAfterAllReleasesBurnsBond() public {
        _bid(a, alice, uint128(60 * E18), 2);
        uint32 seq = 0;
        Sealed memory z = _seal(address(a), bob, seq, _plaintext(uint128(60 * E18), 3), 2, 1);
        z.keyHash = keccak256("not the key"); // no subset can ever match
        _fundBidder(bob, address(a), 1e12);
        vm.prank(bob);
        a.commitBid(seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, 200_000_000);
        dealt[address(a)][1] = z.shares;
        _close(a);
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        uint256 burnBefore = quote.balanceOf(a.BURN());
        _openAll(a);
        SealedAuction.Bid memory b = a.getBid(1);
        assertEq(uint8(b.status), uint8(SealedAuction.BidStatus.Unopenable));
        assertEq(uint8(b.exclusion), uint8(SealedAuction.Exclusion.NoKeyAfterAllReleases));
        assertTrue(b.bondBurned);
        assertEq(quote.balanceOf(a.BURN()) - burnBefore, BOND);

        a.finalize();
        assertEq(uint8(a.state()), uint8(SealedAuction.State.Settled), "the junk bid never fails the auction");
        (, uint256 refund) = a.claim(1);
        assertEq(refund, 200_000_000, "escrow back, bond gone");
    }

    function test_unopenableWithMissingReleaseKeepsBond() public {
        uint32 seq = 0;
        Sealed memory z = _seal(address(a), bob, seq, _plaintext(uint128(60 * E18), 3), 2, 1);
        z.keyHash = keccak256("not the key");
        _fundBidder(bob, address(a), 1e12);
        vm.prank(bob);
        a.commitBid(seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, 200_000_000);
        dealt[address(a)][0] = z.shares;
        _close(a);
        _release(a, 1);
        _release(a, 2);
        vm.warp(a.config().releaseDeadline + 1);
        _openAll(a);
        assertFalse(a.getBid(0).bondBurned);
    }

    function test_malformedPlaintextBurnsBond() public {
        bytes32 pt = bytes32(uint256(_plaintext(uint128(E18), 1)) | 1); // padding not zero
        _bidRaw(a, alice, pt, 2_000_000, 2);
        _bidRaw(a, bob, _plaintext(uint128(E18), 200), 1e9, 2); // tick out of range (8 ticks)
        _bidRaw(a, carol, _plaintext(0, 1), 1e6, 2); // zero quantity
        _close(a);
        _release(a, 1);
        _release(a, 2);
        _openAll(a);
        for (uint256 i; i < 3; ++i) {
            SealedAuction.Bid memory b = a.getBid(i);
            assertEq(uint8(b.status), uint8(SealedAuction.BidStatus.Excluded));
            assertEq(uint8(b.exclusion), uint8(SealedAuction.Exclusion.Malformed));
            assertTrue(b.bondBurned);
        }
    }

    function test_ineligibleBidsAreRefundedWithBond() public {
        SealedAuction.Config memory c = _config();
        c.minBidQuantity = E18;
        c.maxQuantityPerAddress = 10 * E18;
        SealedAuction x = _create(c);
        _bid(x, alice, uint128(E18 / 2), 1); // below minimum
        _bidRaw(x, bob, _plaintext(uint128(10 * E18), 2), 1, 2); // escrow far too small
        _bid(x, carol, uint128(8 * E18), 1);
        _bid(x, carol, uint128(8 * E18), 1); // pushes carol over the cap
        _close(x);
        _release(x, 1);
        _release(x, 2);
        _openAll(x);
        assertEq(uint8(x.getBid(0).exclusion), uint8(SealedAuction.Exclusion.BelowMinimum));
        assertEq(uint8(x.getBid(1).exclusion), uint8(SealedAuction.Exclusion.EscrowShort));
        assertEq(uint8(x.getBid(2).status), uint8(SealedAuction.BidStatus.Opened));
        assertEq(uint8(x.getBid(3).exclusion), uint8(SealedAuction.Exclusion.OverAddressCap));
        for (uint256 i; i < 4; ++i) {
            assertFalse(x.getBid(i).bondBurned);
        }
        vm.warp(c.releaseDeadline + 1);
        x.finalize();
        (, uint256 r) = x.claim(1);
        assertEq(r, 1 + BOND);
    }

    function test_bidsOfOneBidderAreDecidedInSeqOrder() public {
        _bid(a, alice, uint128(E18), 1);
        _bid(a, alice, uint128(E18), 1);
        _close(a);
        _release(a, 1);
        _release(a, 2);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        a.openBids(ids); // seq 1 waits for seq 0
        assertEq(uint8(a.getBid(1).status), uint8(SealedAuction.BidStatus.Pending));
        _openAll(a);
        assertEq(a.decidedCount(), 2);
    }

    function test_openUnknownBidReverts() public {
        _workedExample();
        uint256[] memory ids = new uint256[](1);
        ids[0] = 3;
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.UnknownBid.selector, 3));
        a.openBids(ids);
    }

    function test_earlyFinalizeWithOpenableBidsRefused() public {
        _workedExample();
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        a.openBids(ids);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.UndecidedBids.selector, 1, 3));
        a.finalize();
    }

    // ------------------------------------------------------------ timeouts, cancel

    function test_noReleasesAtAllRefundsEveryoneBondsIncluded() public {
        _workedExample();
        vm.warp(a.config().releaseDeadline + 1);
        _openAll(a);
        a.finalize();
        assertEq(uint8(a.state()), uint8(SealedAuction.State.Failed));
        _claimAll(a);
        a.claimUnsold();
        assertEq(quote.balanceOf(bob), 105_000_000 + BOND);
        assertEq(quote.balanceOf(address(a)), 0);
        assertEq(sale.balanceOf(issuer), 100 * E18);
    }

    function test_failOnTimeout() public {
        _workedExample();
        vm.warp(uint256(a.config().releaseDeadline) + a.FINALIZE_GRACE());
        vm.expectRevert(SealedAuction.TooEarly.selector);
        a.failOnTimeout();
        vm.warp(block.timestamp + 1);
        a.failOnTimeout();
        _claimAll(a);
        assertEq(quote.balanceOf(address(a)), 0);
    }

    function test_cancelRules() public {
        vm.prank(alice);
        vm.expectRevert(SealedAuction.NotIssuer.selector);
        a.cancel();

        vm.prank(issuer);
        a.cancel(); // open with no bids
        assertEq(sale.balanceOf(issuer), 100 * E18);

        SealedAuction b = _create(_config());
        _bid(b, alice, 1, 0);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadState.selector, SealedAuction.State.CommitOpen));
        b.cancel();
    }

    function test_cancelledAuctionPaysNoTokens() public {
        SealedAuction.Config memory c = _config();
        c.startTime = uint64(block.timestamp + 1 days);
        c.endTime = uint64(block.timestamp + 2 days);
        c.releaseDeadline = uint64(block.timestamp + 3 days);
        SealedAuction x = _create(c);
        assertEq(uint8(x.state()), uint8(SealedAuction.State.Funded), "not opened before start");
        vm.expectRevert(SealedAuction.TooEarly.selector);
        x.openCommit();
        vm.prank(issuer);
        x.cancel();
        assertEq(uint8(x.state()), uint8(SealedAuction.State.Cancelled));
    }

    // ------------------------------------------------------------ claims

    function test_noDoubleClaim() public {
        _workedExample();
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        _openAll(a);
        a.finalize();
        a.claim(0);
        vm.expectRevert(SealedAuction.AlreadyClaimed.selector);
        a.claim(0);
        a.claimProceeds();
        vm.expectRevert(SealedAuction.AlreadyClaimed.selector);
        a.claimProceeds();
        a.claimUnsold();
        vm.expectRevert(SealedAuction.AlreadyClaimed.selector);
        a.claimUnsold();
    }

    function test_claimBeforeSettlementRefused() public {
        _workedExample();
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadState.selector, SealedAuction.State.Closed));
        a.claim(0);
    }

    function test_claimPaysTheBidderWhoeverCalls() public {
        _workedExample();
        _release(a, 1);
        _release(a, 2);
        _release(a, 3);
        _openAll(a);
        a.finalize();
        vm.prank(makeAddr("anyone"));
        a.claim(0);
        assertEq(sale.balanceOf(alice), 50 * E18);
    }

    // ------------------------------------------------------------ tokens and config

    function test_feeOnTransferQuoteRefused() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(6);
        SealedAuction.Config memory c = _config();
        c.quoteToken = address(fot);
        SealedAuction x = _create(c);
        Sealed memory z = _seal(address(x), alice, 0, _plaintext(1, 1), 2, 1);
        fot.mint(alice, 1e9);
        vm.startPrank(alice);
        fot.approve(address(x), 1e9);
        vm.expectRevert(SealedAuction.FeeOnTransferToken.selector);
        x.commitBid(0, z.ct, z.keyHash, z.shareHashes, z.envelopes, 1e6);
        vm.stopPrank();
    }

    function test_configValidation() public {
        SealedAuction.Config memory c = _config();
        c.releaseDeadline = c.endTime;
        _expectBadConfig(c, "schedule");
        c = _config();
        c.numTicks = 257;
        _expectBadConfig(c, "ticks");
        c = _config();
        c.maxBids = 257;
        _expectBadConfig(c, "maxBids");
        c = _config();
        c.protocolFeeBps = 1001;
        _expectBadConfig(c, "fee");
        c = _config();
        c.saleDecimals = 6;
        _expectBadConfig(c, "saleDecimals");
        c = _config();
        c.quoteToken = c.saleToken;
        _expectBadConfig(c, "tokens");
    }

    function _expectBadConfig(SealedAuction.Config memory c, string memory what) internal {
        sale.mint(issuer, c.totalSupply);
        vm.startPrank(issuer);
        sale.approve(address(factory), c.totalSupply);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadConfig.selector, what));
        factory.createAuction(c, "Buyback", "PEAL-T for fUSD");
        vm.stopPrank();
    }

    function test_implementationCannotBeInitialized() public {
        SealedAuction.Config memory c = _config();
        vm.expectRevert();
        impl.initialize(c, registry);
    }

    function test_releaseMessageMatchesPqAuthFormat() public {
        _workedExample();
        uint256[] memory shares = _releaseShares(a, 2, 0);
        bytes memory expected = pqMessage(
            address(a),
            memberAddr[1],
            keccak256("SealedAuction.release"),
            0,
            123,
            keccak256(abi.encode(uint256(3), shares, uint256(0)))
        );
        assertEq(a.releaseMessage(2, shares, 0, 123), expected);
        assertEq(expected.length, 256);
    }
}
