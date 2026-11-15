// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqTestBase} from "qore-pq-kit-test/PqTestBase.sol";
import {Shamir} from "qore-pq-kit/threshold/Shamir.sol";
import {SealedSlot} from "qore-pq-kit/threshold/SealedSlot.sol";

import {CommitteeRegistry} from "../../src/CommitteeRegistry.sol";
import {SealedAuction} from "../../src/SealedAuction.sol";
import {SealedAuctionFactory} from "../../src/SealedAuctionFactory.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// Shared fixture: a 2-of-3 committee with mock ML-DSA keys, a PEAL-T-like sale
/// token (18 dp), an fUSD-like quote token (6 dp), and helpers that seal bids the
/// way the browser does (SealedSlot hashes, Shamir shares over F_P).
abstract contract AuctionBase is PqTestBase {
    uint256 internal constant P = Shamir.P;
    uint256 internal constant E18 = 1e18;
    uint256 internal constant BOND = 5e6; // 5 fUSD

    CommitteeRegistry internal registry;
    SealedAuctionFactory internal factory;
    SealedAuction internal impl;
    MockERC20 internal sale;
    MockERC20 internal quote;

    address internal issuer = makeAddr("issuer");
    address internal feeTo = makeAddr("feeTo");
    address[3] internal memberAddr;
    bytes32[3] internal memberSecret;
    bytes32 internal setId;

    /// Dealt shares kept by the test, as each member would recover them from its envelope.
    mapping(address auction => mapping(uint256 bidId => uint256[3])) internal dealt;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        installPqcMocks();
        for (uint256 i; i < 3; ++i) {
            memberAddr[i] = makeAddr(string.concat("member", vm.toString(i + 1)));
            memberSecret[i] = keccak256(abi.encode("member-secret", i));
            registerPqKey(memberAddr[i], memberSecret[i]);
        }
        registry = new CommitteeRegistry();
        setId = _registerCommittee(2);

        impl = new SealedAuction();
        factory = new SealedAuctionFactory(address(impl), registry);
        sale = new MockERC20("Peal Test Token", "PEAL-T", 18);
        quote = new MockERC20("FestUSD", "fUSD", 6);
    }

    // ------------------------------------------------------------ committee

    function _joins(uint8 t, uint256 deadline) internal view returns (CommitteeRegistry.Join[] memory joins) {
        joins = new CommitteeRegistry.Join[](3);
        CommitteeRegistry.Member[] memory ms = new CommitteeRegistry.Member[](3);
        for (uint256 i; i < 3; ++i) {
            joins[i].account = memberAddr[i];
            joins[i].kemKeySha3 = keccak256(abi.encode("kem", i));
            joins[i].card = abi.encode("card", i);
            joins[i].cardHash = keccak256(joins[i].card);
            ms[i] = CommitteeRegistry.Member(memberAddr[i], joins[i].kemKeySha3, joins[i].cardHash);
        }
        bytes32 id = registry.computeSetId(t, ms);
        for (uint256 i; i < 3; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 index = uint8(i + 1);
            bytes memory m = registry.joinMessage(id, index, memberAddr[i], ms[i].kemKeySha3, ms[i].cardHash, deadline);
            joins[i].signature = pqSign(memberSecret[i], m);
        }
    }

    function _registerCommittee(uint8 t) internal returns (bytes32) {
        uint256 deadline = block.timestamp + 1 days;
        return registry.registerSet(t, _joins(t, deadline), deadline);
    }

    // ------------------------------------------------------------ auctions

    function _config() internal view returns (SealedAuction.Config memory c) {
        c.issuer = issuer;
        c.saleToken = address(sale);
        c.quoteToken = address(quote);
        c.totalSupply = 100 * E18;
        c.saleDecimals = 18;
        c.reservePrice = 1_000_000; // 1.00 fUSD
        c.tickSize = 500_000; // 0.50 fUSD
        c.numTicks = 8;
        c.startTime = uint64(block.timestamp);
        c.endTime = uint64(block.timestamp + 1 hours);
        c.releaseDeadline = uint64(block.timestamp + 2 hours);
        c.minBidQuantity = 1;
        c.maxQuantityPerAddress = 0;
        c.maxBids = 64;
        c.bidBond = BOND;
        c.protocolFeeBps = 100; // 1%
        c.feeRecipient = feeTo;
        c.committeeSetId = setId;
        c.metadataHash = factory.metadataHash("Buyback", "PEAL-T for fUSD");
    }

    function _create(SealedAuction.Config memory c) internal returns (SealedAuction a) {
        sale.mint(issuer, c.totalSupply);
        vm.startPrank(issuer);
        sale.approve(address(factory), c.totalSupply);
        a = SealedAuction(factory.createAuction(c, "Buyback", "PEAL-T for fUSD"));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ sealing

    struct Sealed {
        bytes32 ct;
        bytes32 keyHash;
        bytes32[] shareHashes;
        bytes[] envelopes;
        uint256[3] shares;
    }

    function _plaintext(uint128 qty, uint16 tick) internal pure returns (bytes32) {
        return bytes32((uint256(qty) << 128) | (uint256(tick) << 112));
    }

    /// Deal K t-of-3: f(x) = K + a1 x + ... + a_{t-1} x^{t-1} mod P.
    function _deal(uint256 key, uint256 t, uint256 seed) internal pure returns (uint256[3] memory s) {
        for (uint256 x = 1; x <= 3; ++x) {
            uint256 y = key;
            uint256 xp = 1;
            for (uint256 k = 1; k < t; ++k) {
                xp = mulmod(xp, x, P);
                uint256 coeff = uint256(keccak256(abi.encode(seed, k))) % P;
                y = addmod(y, mulmod(coeff, xp, P), P);
            }
            s[x - 1] = y;
        }
    }

    function _seal(address auction, address bidder, uint32 seq, bytes32 pt, uint256 t, uint256 seed)
        internal
        view
        returns (Sealed memory z)
    {
        uint256 key = uint256(keccak256(abi.encode("K", seed))) % P;
        z.shares = _deal(key, t, seed);
        z.ct = SealedSlot.open(auction, bidder, seq, key, pt);
        z.keyHash = SealedSlot.keyHash(auction, bidder, seq, key);
        z.shareHashes = new bytes32[](3);
        z.envelopes = new bytes[](3);
        for (uint256 j; j < 3; ++j) {
            z.shareHashes[j] = SealedSlot.shareHash(auction, bidder, seq, j + 1, z.shares[j]);
            z.envelopes[j] = new bytes(1752); // stand-in for the QoreSeal envelope
        }
    }

    function _fundBidder(address bidder, address auction, uint256 amount) internal {
        quote.mint(bidder, amount);
        vm.prank(bidder);
        quote.approve(auction, amount);
    }

    /// Seal and commit an honest bid; escrow covers qty at the bid's own tick.
    function _bid(SealedAuction a, address bidder, uint128 qty, uint16 tick) internal returns (uint256 id) {
        uint256 escrow = qty == 0 ? 1 : a.escrowFor(qty, tick);
        if (escrow == 0) escrow = 1;
        return _bidRaw(a, bidder, _plaintext(qty, tick), escrow, 2);
    }

    function _bidRaw(SealedAuction a, address bidder, bytes32 pt, uint256 escrow, uint256 dealDegree)
        internal
        returns (uint256 id)
    {
        uint32 seq = a.bidCountOf(bidder);
        Sealed memory z = _seal(address(a), bidder, seq, pt, dealDegree, uint256(keccak256(abi.encode(bidder, seq))));
        _fundBidder(bidder, address(a), escrow + BOND);
        vm.prank(bidder);
        id = a.commitBid(seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, escrow);
        dealt[address(a)][id] = z.shares;
    }

    function _close(SealedAuction a) internal {
        vm.warp(a.config().endTime);
        a.closeCommit();
    }

    // ------------------------------------------------------------ releases

    function _releaseShares(SealedAuction a, uint8 index, uint256 invalidBitmap)
        internal
        view
        returns (uint256[] memory shares)
    {
        uint256 n = a.bidCount();
        shares = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            if ((invalidBitmap >> i) & 1 == 0) shares[i] = dealt[address(a)][i][index - 1];
        }
    }

    function _signRelease(SealedAuction a, uint8 index, uint256[] memory shares, uint256 bitmap, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return pqSign(memberSecret[index - 1], a.releaseMessage(index, shares, bitmap, deadline));
    }

    function _release(SealedAuction a, uint8 index) internal {
        _release(a, index, 0);
    }

    function _release(SealedAuction a, uint8 index, uint256 bitmap) internal {
        uint256[] memory shares = _releaseShares(a, index, bitmap);
        uint256 deadline = block.timestamp + 10 minutes;
        a.submitRelease(index, shares, bitmap, deadline, _signRelease(a, index, shares, bitmap, deadline));
    }

    function _openAll(SealedAuction a) internal {
        uint256 n = a.bidCount();
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = i;
        }
        a.openBids(ids);
    }

    function _claimAll(SealedAuction a) internal {
        uint256 n = a.bidCount();
        for (uint256 i; i < n; ++i) {
            a.claim(i);
        }
    }
}
