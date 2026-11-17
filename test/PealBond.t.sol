// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {QoreChainHybridHolderGuard} from "qorechain-asset-kit/guard/QoreChainHybridHolderGuard.sol";
import {IHolderEligibility} from "qorechain-asset-kit/interfaces/IHolderEligibility.sol";
import {PqAuth} from "qore-pq-kit/PqAuth.sol";

import {SealedAuction} from "../src/SealedAuction.sol";
import {IAuctionVenue, PealBond} from "../src/demo/PealBond.sol";
import {AuctionBase} from "./utils/AuctionBase.sol";

/// PEAL-B: a bond only post-quantum accounts may hold, checked by QoreChain's Asset Kit guard
/// (`QoreChainHybridHolderGuard`, unchanged from the kit), sold by a sealed auction of this venue.
contract PealBondTest is AuctionBase {
    QoreChainHybridHolderGuard internal guard;
    PealBond internal bond;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal classicalOnly = makeAddr("classical-only");

    function setUp() public override {
        super.setUp();
        guard = new QoreChainHybridHolderGuard(address(this));
        // The guard forwards 50k gas to pqcKeyStatus (the real precompile charges a flat 2,500).
        // The kit's mock reads a stored key from storage, which for a 2,592-byte key costs far more
        // when cold, so holders here get short stand-in keys; the guard does not check key length.
        _holder(issuer);
        _holder(alice);
        _holder(bob);
        bond = new PealBond(IHolderEligibility(address(guard)), IAuctionVenue(address(factory)), issuer, 1_000 * E18);
    }

    function _holder(address who) internal {
        pqcKeyStatusMock.set(who, true, PqAuth.ALGORITHM_ML_DSA_87, abi.encodePacked(keccak256(abi.encode(who))), true);
    }

    function test_onlyHybridHoldersReceive() public {
        vm.prank(issuer);
        bond.transfer(alice, 10 * E18);
        assertEq(bond.balanceOf(alice), 10 * E18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PealBond.NotEligible.selector, classicalOnly));
        bond.transfer(classicalOnly, 1);
    }

    function test_keyWithoutPossessionOrOtherAlgorithmIsRefused() public {
        bytes memory pk = abi.encodePacked(keccak256("k"));
        pqcKeyStatusMock.set(classicalOnly, true, PqAuth.ALGORITHM_ML_DSA_87, pk, false);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(PealBond.NotEligible.selector, classicalOnly));
        bond.transfer(classicalOnly, 1);

        pqcKeyStatusMock.set(classicalOnly, true, 2, pk, true);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(PealBond.NotEligible.selector, classicalOnly));
        bond.transfer(classicalOnly, 1);
    }

    function test_failsClosedWhenThePrecompileAnswersNothing() public {
        pqcKeyStatusMock.setEmptyReturn(true);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(PealBond.NotEligible.selector, alice));
        bond.transfer(alice, 1);
    }

    function test_issuerMustHoldAKeyToMint() public {
        vm.expectRevert(abi.encodeWithSelector(PealBond.NotEligible.selector, classicalOnly));
        new PealBond(IHolderEligibility(address(guard)), IAuctionVenue(address(factory)), classicalOnly, 1);
    }

    function test_onlyThisVenuesAuctionsAreExempt() public {
        assertTrue(bond.isVenue(address(factory)));
        assertFalse(bond.isVenue(address(impl)));
        assertFalse(bond.isVenue(classicalOnly));
        assertFalse(bond.eligible(address(this)));
    }

    /// A whole sealed auction of PEAL-B for fUSD: the factory and the clone hold the supply,
    /// allocations reach the post-quantum bidders, the unsold rest returns to the issuer.
    function test_sealedAuctionOfTheBond() public {
        SealedAuction.Config memory c = _config();
        c.saleToken = address(bond);
        c.totalSupply = 100 * E18;
        c.metadataHash = factory.metadataHash("PEAL-B", "a bond for post-quantum holders");
        vm.startPrank(issuer);
        bond.approve(address(factory), c.totalSupply);
        SealedAuction a = SealedAuction(factory.createAuction(c, "PEAL-B", "a bond for post-quantum holders"));
        vm.stopPrank();
        assertTrue(bond.isVenue(address(a)));
        assertEq(bond.balanceOf(address(a)), 100 * E18);

        _bid(a, alice, uint128(60 * E18), 3);
        _bid(a, bob, uint128(30 * E18), 1);
        _close(a);
        _release(a, 1);
        _release(a, 2);
        _openAll(a);
        vm.warp(c.releaseDeadline + 1);
        a.finalize();
        _claimAll(a);
        a.claimUnsold();

        assertEq(bond.balanceOf(alice), 60 * E18);
        assertEq(bond.balanceOf(bob), 30 * E18);
        assertEq(bond.balanceOf(address(a)), 0);
        assertEq(bond.balanceOf(issuer), 910 * E18);
    }
}
