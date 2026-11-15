// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {SealedAuction} from "../src/SealedAuction.sol";
import {SealedAuctionFactory} from "../src/SealedAuctionFactory.sol";
import {AuctionBase} from "./utils/AuctionBase.sol";

contract SealedAuctionFactoryTest is AuctionBase {
    function test_createFundsAndOpens() public {
        SealedAuction a = _create(_config());
        assertTrue(factory.isAuction(address(a)));
        assertEq(uint8(a.state()), uint8(SealedAuction.State.CommitOpen));
        assertEq(sale.balanceOf(address(a)), 100 * E18);
        assertEq(a.threshold(), 2);
        assertEq(a.members().length, 3);
        assertEq(factory.auctionCount(), 1);
        assertEq(factory.auctionsOf(issuer)[0], address(a));
    }

    function test_issuerMustBeCaller() public {
        SealedAuction.Config memory c = _config();
        sale.mint(address(this), c.totalSupply);
        sale.approve(address(factory), c.totalSupply);
        vm.expectRevert(SealedAuctionFactory.NotIssuer.selector);
        factory.createAuction(c, "Buyback", "PEAL-T for fUSD");
    }

    function test_metadataMustMatch() public {
        SealedAuction.Config memory c = _config();
        sale.mint(issuer, c.totalSupply);
        vm.startPrank(issuer);
        sale.approve(address(factory), c.totalSupply);
        vm.expectRevert(SealedAuctionFactory.MetadataMismatch.selector);
        factory.createAuction(c, "Buyback", "something else");
        vm.stopPrank();
    }

    function test_unknownCommitteeRefused() public {
        SealedAuction.Config memory c = _config();
        c.committeeSetId = keccak256("no such set");
        sale.mint(issuer, c.totalSupply);
        vm.startPrank(issuer);
        sale.approve(address(factory), c.totalSupply);
        vm.expectRevert();
        factory.createAuction(c, "Buyback", "PEAL-T for fUSD");
        vm.stopPrank();
    }

    function test_paging() public {
        for (uint256 i; i < 3; ++i) {
            _create(_config());
        }
        assertEq(factory.auctionsPaged(0, 2).length, 2);
        assertEq(factory.auctionsPaged(2, 10).length, 1);
        assertEq(factory.auctionsPaged(3, 10).length, 0);
        assertEq(factory.auctionsPaged(1, type(uint256).max).length, 2);
    }
}
