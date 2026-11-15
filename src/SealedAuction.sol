// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {PqAuth} from "qore-pq-kit/PqAuth.sol";
import {Shamir} from "qore-pq-kit/threshold/Shamir.sol";
import {SealedSlot} from "qore-pq-kit/threshold/SealedSlot.sol";

import {ClearingPrice} from "./libraries/ClearingPrice.sol";
import {AuctionMath} from "./libraries/AuctionMath.sol";
import {CommitteeRegistry} from "./CommitteeRegistry.sol";

/// @title SealedAuction
/// @notice One uniform-price sealed-bid auction whose bids no single key holder
///         can open before the close. Deployed as a clone by `SealedAuctionFactory`.
///
/// ## How a bid is sealed (off chain, in the bidder's browser)
///
/// For bid number `seq` of `bidder` (its own counter, `bidCountOf(bidder)`):
///   pt    = uint128 quantity ‖ uint16 tick ‖ 14 zero bytes          (32 bytes)
///   K     random in F_P, P = 2^255 - 19
///   ct    = pt XOR keccak(DEM_DOMAIN, chainid, auction, bidder, seq, K)
///   share j = f(j), f random of degree t-1 with f(0) = K, j = 1..n
///   envelope j = QoreSeal hybrid envelope (ML-KEM-1024 + X25519) of share j to
///                committee member j's registered key
/// The hashes and the key stream are `qore-pq-kit` `SealedSlot`.
///
/// ## Lifecycle
///
/// Created → Funded → CommitOpen → Closed → Settled | Failed | Cancelled
///
/// 1. `commitBid` stores ct, keyHash and the n share hashes, pulls escrow plus a
///    bond, and emits the envelopes. The bid can no longer change.
/// 2. `closeCommit` (anyone, after `endTime`) freezes the set of bids.
/// 3. Each member posts one `submitRelease` covering every bid, signed with
///    ML-DSA-87 and checked on chain by `pqcVerify`. Each share is checked
///    against its hash; one wrong share reverts the whole release.
/// 4. `openBids` (anyone) rebuilds K from any t stored shares, checks it against
///    keyHash, decrypts, checks eligibility and adds the bid to the demand curve.
/// 5. `finalize` (anyone) once the release window is over and every bid is
///    decided, then pull-based claims.
///
/// ## Rules (credited to Peal's plan 017 review)
///
/// - Exclude, never fail: a bid that cannot open is excluded and refunded; it
///   never fails the auction.
/// - One all-or-nothing signed release per member over the frozen set.
/// - Every hash binds chain id, auction, bidder, seq and share index.
/// - Releases are accepted only after the on-chain close.
/// - Junk costs a deposit: the bond is burned when a bid opens to a malformed
///   plaintext (only the bidder can cause that, because K is checked against
///   keyHash), or when all n members released and the bid still cannot open.
///   A bid that fails only because members stayed away keeps its bond.
///
/// Peal's committee reveal root, void and dispute paths do not exist here: the
/// contract rebuilds the key and opens the bids itself.
contract SealedAuction is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    /// @notice Most bids one auction accepts; a release's invalid bitmap is one word.
    uint256 public constant MAX_BIDS = 256;
    /// @notice Largest accepted QoreSeal envelope (a one-recipient hybrid envelope is 1,752 bytes).
    uint256 public constant MAX_ENVELOPE_BYTES = 4096;
    /// @notice Hard cap on the protocol fee: 10%.
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @notice After the release deadline, how long `finalize` has before anyone may fail the auction.
    uint64 public constant FINALIZE_GRACE = 3 days;
    /// @notice Forfeited bonds go here, so nobody profits from blocking a bid.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant RELEASE_ACTION = keccak256("SealedAuction.release");

    uint256 private constant PAD_MASK = (uint256(1) << 112) - 1;

    // ------------------------------------------------------------------ types

    enum State {
        Created,
        Funded,
        CommitOpen,
        Closed,
        Settled,
        Failed,
        Cancelled
    }

    enum BidStatus {
        Pending,
        Opened, // counted in demand
        Excluded, // opened, but not eligible; refunded
        Unopenable // never opened; refunded
    }

    enum Exclusion {
        None,
        Malformed, // padding not zero, zero quantity or tick out of range: bond burned
        BelowMinimum,
        OverAddressCap,
        EscrowShort,
        NoKey, // fewer than t valid shares, or no t of them rebuild keyHash
        NoKeyAfterAllReleases // as NoKey, with all n members released: bond burned
    }

    struct Config {
        address issuer;
        address saleToken;
        address quoteToken;
        uint256 totalSupply;
        uint8 saleDecimals;
        uint256 reservePrice; // quote base units per whole sale token at tick 0
        uint256 tickSize;
        uint16 numTicks;
        uint64 startTime;
        uint64 endTime;
        uint64 releaseDeadline;
        uint256 minBidQuantity;
        uint256 maxQuantityPerAddress; // 0 = no cap
        uint32 maxBids;
        uint256 bidBond; // quote base units, on top of escrow
        uint16 protocolFeeBps;
        address feeRecipient;
        bytes32 committeeSetId;
        bytes32 metadataHash;
    }

    struct Bid {
        address bidder;
        uint32 seq;
        BidStatus status;
        Exclusion exclusion;
        uint8 shareMask; // bit (j-1) set: a checked share from member j is stored
        bool bondBurned;
        bool claimed;
        uint128 quantity;
        uint16 tick;
        uint256 escrow;
        bytes32 ct;
        bytes32 keyHash;
    }

    // ------------------------------------------------------------------ storage

    Config internal _cfg;
    CommitteeRegistry public registry;
    State public state;

    uint8 public threshold;
    address[] internal _members;
    uint8 public releaseMask;
    uint8 public releaseCount;

    uint32 public bidCount;
    uint32 public decidedCount;
    mapping(uint256 bidId => Bid) internal _bids;
    mapping(uint256 bidId => bytes32[]) internal _shareHashes;
    mapping(uint256 bidId => mapping(uint256 index => uint256)) internal _shares;

    mapping(address bidder => uint32) public bidCountOf;
    mapping(address bidder => uint32) public nextSeqToDecide;
    mapping(address bidder => uint256) public openedQuantityOf;
    mapping(uint256 tick => uint256) public demandByTick;

    ClearingPrice.Result internal _clearing;
    uint256 public clearingPrice;
    uint256 public totalSold;
    uint256 public grossProceeds;
    uint256 public protocolFee;
    uint256 public bondsBurned;
    bool public proceedsClaimed;
    bool public unsoldClaimed;

    // ------------------------------------------------------------------ events

    event Initialized(address indexed issuer, bytes32 indexed committeeSetId, uint8 threshold, uint256 members);
    event Funded(uint256 supply);
    event CommitOpened();
    event BidCommitted(
        uint256 indexed bidId,
        address indexed bidder,
        uint32 seq,
        bytes32 ct,
        bytes32 keyHash,
        bytes32[] shareHashes,
        bytes[] envelopes,
        uint256 escrow
    );
    event CommitClosed(uint32 bidCount);
    event ReleaseSubmitted(uint8 indexed memberIndex, address indexed member, uint256 invalidBitmap);
    event BidOpened(uint256 indexed bidId, uint128 quantity, uint16 tick);
    event BidExcluded(uint256 indexed bidId, Exclusion reason, bool bondBurned);
    event Finalized(uint16 clearingTick, uint256 clearingPrice, uint256 sold, uint256 proceeds, uint256 fee);
    event AuctionFailed(string reason);
    event AuctionCancelled();
    event Claimed(uint256 indexed bidId, address indexed bidder, uint256 tokens, uint256 refund);
    event ProceedsClaimed(uint256 net, uint256 fee);
    event UnsoldClaimed(uint256 unsold);

    // ------------------------------------------------------------------ errors

    error BadConfig(string what);
    error BadState(State actual);
    error NotIssuer();
    error TooEarly();
    error TooLate();
    error TooManyBids();
    error BadSeq(uint32 expected);
    error BadBid(string what);
    error FeeOnTransferToken();
    error BadMemberIndex(uint8 index);
    error AlreadyReleased(uint8 index);
    error ReleaseLength(uint256 got, uint256 expected);
    error BadBitmap();
    error WrongShare(uint256 bidId);
    error ReleaseExpired(uint256 deadline);
    error ReleaseSignatureInvalid();
    error ReleaseWindowOpen();
    error UndecidedBids(uint32 decided, uint32 total);
    error AlreadyClaimed();
    error UnknownBid(uint256 bidId);

    // ------------------------------------------------------------------ setup

    constructor() {
        _disableInitializers();
    }

    function initialize(Config calldata cfg, CommitteeRegistry registry_) external initializer {
        if (cfg.issuer == address(0)) revert BadConfig("issuer");
        if (cfg.saleToken == address(0) || cfg.quoteToken == address(0) || cfg.saleToken == cfg.quoteToken) {
            revert BadConfig("tokens");
        }
        if (cfg.totalSupply == 0) revert BadConfig("supply");
        if (cfg.numTicks == 0 || cfg.numTicks > ClearingPrice.MAX_TICKS) revert BadConfig("ticks");
        if (!(cfg.startTime < cfg.endTime && cfg.endTime < cfg.releaseDeadline)) revert BadConfig("schedule");
        if (cfg.maxBids == 0 || cfg.maxBids > MAX_BIDS) revert BadConfig("maxBids");
        if (cfg.protocolFeeBps > MAX_FEE_BPS) revert BadConfig("fee");
        if (cfg.protocolFeeBps != 0 && cfg.feeRecipient == address(0)) revert BadConfig("feeRecipient");
        if (IERC20Metadata(cfg.saleToken).decimals() != cfg.saleDecimals) revert BadConfig("saleDecimals");

        (uint8 t, address[] memory accounts) = registry_.membersOf(cfg.committeeSetId);
        _cfg = cfg;
        registry = registry_;
        threshold = t;
        _members = accounts;
        state = State.Created;
        emit Initialized(cfg.issuer, cfg.committeeSetId, t, accounts.length);
    }

    modifier inState(State s) {
        if (state != s) revert BadState(state);
        _;
    }

    /// @notice Escrow the full sale supply. Anyone may fund; the supply is then
    ///         bound by this auction's rules (`cancel` returns it to the issuer).
    function fund() external inState(State.Created) nonReentrant {
        IERC20 sale = IERC20(_cfg.saleToken);
        uint256 before = sale.balanceOf(address(this));
        sale.safeTransferFrom(msg.sender, address(this), _cfg.totalSupply);
        if (sale.balanceOf(address(this)) - before != _cfg.totalSupply) revert FeeOnTransferToken();
        state = State.Funded;
        emit Funded(_cfg.totalSupply);
    }

    /// @notice Open bidding (anyone, once `startTime` has passed).
    function openCommit() external inState(State.Funded) {
        if (block.timestamp < _cfg.startTime) revert TooEarly();
        state = State.CommitOpen;
        emit CommitOpened();
    }

    /// @notice Issuer only: before bidding opens, or while open with no bids.
    function cancel() external nonReentrant {
        if (msg.sender != _cfg.issuer) revert NotIssuer();
        State s = state;
        if (s == State.Created) {
            state = State.Cancelled;
        } else if (s == State.Funded || (s == State.CommitOpen && bidCount == 0)) {
            state = State.Cancelled;
            IERC20(_cfg.saleToken).safeTransfer(_cfg.issuer, _cfg.totalSupply);
        } else {
            revert BadState(s);
        }
        emit AuctionCancelled();
    }

    // ------------------------------------------------------------------ bidding

    /// @notice Commit a sealed bid. Pulls `escrow + bidBond` of the quote token.
    /// @param seq          must equal `bidCountOf(msg.sender)`; bound into every hash
    /// @param ct           pt XOR keystream(K)
    /// @param keyHash      SealedSlot.keyHash(this, msg.sender, seq, K)
    /// @param shareHashes  SealedSlot.shareHash(this, msg.sender, seq, j, share_j), j = 1..n
    /// @param envelopes    QoreSeal envelope of share j to member j (emitted, not stored)
    /// @param escrow       quote base units; must cover quantity at the bid's own tick
    function commitBid(
        uint32 seq,
        bytes32 ct,
        bytes32 keyHash,
        bytes32[] calldata shareHashes,
        bytes[] calldata envelopes,
        uint256 escrow
    ) external inState(State.CommitOpen) nonReentrant returns (uint256 bidId) {
        if (block.timestamp < _cfg.startTime) revert TooEarly();
        if (block.timestamp >= _cfg.endTime) revert TooLate();
        if (bidCount >= _cfg.maxBids) revert TooManyBids();
        uint32 expected = bidCountOf[msg.sender];
        if (seq != expected) revert BadSeq(expected);
        uint256 n = _members.length;
        if (shareHashes.length != n || envelopes.length != n) revert BadBid("share count");
        if (keyHash == bytes32(0)) revert BadBid("keyHash");
        if (escrow == 0) revert BadBid("escrow");
        for (uint256 j; j < n; ++j) {
            if (shareHashes[j] == bytes32(0)) revert BadBid("shareHash");
            uint256 len = envelopes[j].length;
            if (len == 0 || len > MAX_ENVELOPE_BYTES) revert BadBid("envelope");
        }

        uint256 total = escrow + _cfg.bidBond;
        IERC20 quote = IERC20(_cfg.quoteToken);
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), total);
        if (quote.balanceOf(address(this)) - before != total) revert FeeOnTransferToken();

        bidId = bidCount;
        Bid storage b = _bids[bidId];
        b.bidder = msg.sender;
        b.seq = seq;
        b.escrow = escrow;
        b.ct = ct;
        b.keyHash = keyHash;
        _shareHashes[bidId] = shareHashes;
        // bidId < maxBids <= 256.
        // forge-lint: disable-next-line(unsafe-typecast)
        bidCount = uint32(bidId + 1);
        bidCountOf[msg.sender] = seq + 1;

        emit BidCommitted(bidId, msg.sender, seq, ct, keyHash, shareHashes, envelopes, escrow);
    }

    /// @notice Close bidding (anyone, once `endTime` has passed). No bids: Failed.
    function closeCommit() external inState(State.CommitOpen) {
        if (block.timestamp < _cfg.endTime) revert TooEarly();
        if (bidCount == 0) {
            state = State.Failed;
            emit AuctionFailed("no bids");
        } else {
            state = State.Closed;
            emit CommitClosed(bidCount);
        }
    }

    // ------------------------------------------------------------------ releases

    /// @notice Post member `memberIndex`'s opened shares for every bid, all at once.
    /// @param memberIndex    1-based index of the member in the committee set
    /// @param shares         one entry per bid, in bid id order; 0 where the bitmap is set
    /// @param invalidBitmap  bit i set: the member could not open bid i's envelope, or
    ///                       its share did not match the bid's share hash or was not in F_P
    /// @param deadline       signature expiry (unix seconds)
    /// @param signature      ML-DSA-87 over `releaseMessage(...)`, by the member's registered key
    /// @dev Anyone may relay: the signature is the authority.
    function submitRelease(
        uint8 memberIndex,
        uint256[] calldata shares,
        uint256 invalidBitmap,
        uint256 deadline,
        bytes calldata signature
    ) external inState(State.Closed) {
        if (block.timestamp > _cfg.releaseDeadline) revert TooLate();
        if (block.timestamp > deadline) revert ReleaseExpired(deadline);
        if (memberIndex == 0 || memberIndex > _members.length) revert BadMemberIndex(memberIndex);
        // memberIndex is 1..7, so the bit fits in uint8.
        // forge-lint: disable-next-line(incorrect-shift)
        uint8 bit = uint8(1 << (memberIndex - 1));
        if (releaseMask & bit != 0) revert AlreadyReleased(memberIndex);
        uint256 count = bidCount;
        if (shares.length != count) revert ReleaseLength(shares.length, count);
        if (count < 256 && invalidBitmap >> count != 0) revert BadBitmap();

        address member = _members[memberIndex - 1];
        _verifyRelease(member, shares, invalidBitmap, deadline, signature);
        _storeShares(memberIndex, bit, shares, invalidBitmap);

        releaseMask |= bit;
        ++releaseCount;
        emit ReleaseSubmitted(memberIndex, member, invalidBitmap);
    }

    function _verifyRelease(
        address member,
        uint256[] calldata shares,
        uint256 invalidBitmap,
        uint256 deadline,
        bytes calldata signature
    ) internal view {
        bytes memory signed = PqAuth.message(
            address(this), member, RELEASE_ACTION, 0, deadline, releaseArgsHash(shares, invalidBitmap)
        );
        if (!PqAuth.verify(PqAuth.keyOf(member), signature, signed)) revert ReleaseSignatureInvalid();
    }

    function _storeShares(uint8 memberIndex, uint8 bit, uint256[] calldata shares, uint256 invalidBitmap) internal {
        uint256 count = shares.length;
        for (uint256 i; i < count; ++i) {
            uint256 share = shares[i];
            if ((invalidBitmap >> i) & 1 == 1) {
                if (share != 0) revert BadBitmap();
                continue;
            }
            Bid storage b = _bids[i];
            if (
                share >= Shamir.P
                    || !SealedSlot.checkShare(
                        address(this), b.bidder, b.seq, memberIndex, share, _shareHashes[i][memberIndex - 1]
                    )
            ) revert WrongShare(i);
            _shares[i][memberIndex] = share;
            b.shareMask |= bit;
        }
    }

    // ------------------------------------------------------------------ opening

    /// @notice Decide bids (anyone). A bid is opened when any t of its stored shares
    ///         rebuild the committed key. A bid without such shares is left pending
    ///         while releases can still arrive, and marked unopenable after.
    /// @dev Bids of one bidder are decided in `seq` order (the per-address cap is
    ///      applied in that order), so pass ids in ascending order.
    function openBids(uint256[] calldata ids) external inState(State.Closed) nonReentrant {
        uint256 burnBefore = bondsBurned;
        bool windowOver = releaseWindowOver();
        for (uint256 k; k < ids.length; ++k) {
            uint256 id = ids[k];
            if (id >= bidCount) revert UnknownBid(id);
            _decide(id, windowOver);
        }
        uint256 burned = bondsBurned - burnBefore;
        if (burned != 0) IERC20(_cfg.quoteToken).safeTransfer(BURN, burned);
    }

    function _decide(uint256 id, bool windowOver) internal {
        Bid storage b = _bids[id];
        if (b.status != BidStatus.Pending) return;
        address bidder = b.bidder;
        if (nextSeqToDecide[bidder] != b.seq) return;

        (bool ok, uint256 key) = _recoverKey(id, b);
        if (!ok) {
            if (!windowOver) return;
            b.status = BidStatus.Unopenable;
            bool burn = releaseCount == _members.length;
            _exclude(id, b, burn ? Exclusion.NoKeyAfterAllReleases : Exclusion.NoKey, burn);
        } else {
            uint256 pt = uint256(SealedSlot.open(address(this), bidder, b.seq, key, b.ct));
            // Field decode: the top 16 bytes are the quantity, the next 2 the tick.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128 qty = uint128(pt >> 128);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 tick = uint16(pt >> 112);
            b.quantity = qty;
            b.tick = tick;
            Exclusion why = _eligibility(b, bidder, pt, qty, tick);
            if (why == Exclusion.None) {
                b.status = BidStatus.Opened;
                demandByTick[tick] += qty;
                openedQuantityOf[bidder] += qty;
                emit BidOpened(id, qty, tick);
            } else {
                b.status = BidStatus.Excluded;
                _exclude(id, b, why, why == Exclusion.Malformed);
            }
        }
        ++decidedCount;
        ++nextSeqToDecide[bidder];
    }

    function _eligibility(Bid storage b, address bidder, uint256 pt, uint128 qty, uint16 tick)
        internal
        view
        returns (Exclusion)
    {
        if (pt & PAD_MASK != 0 || qty == 0 || tick >= _cfg.numTicks) return Exclusion.Malformed;
        if (qty < _cfg.minBidQuantity) return Exclusion.BelowMinimum;
        uint256 cap = _cfg.maxQuantityPerAddress;
        if (cap != 0 && openedQuantityOf[bidder] + qty > cap) return Exclusion.OverAddressCap;
        uint256 need = AuctionMath.escrowFor(qty, _cfg.reservePrice, _cfg.tickSize, tick, _cfg.saleDecimals);
        if (b.escrow < need) return Exclusion.EscrowShort;
        return Exclusion.None;
    }

    function _exclude(uint256 id, Bid storage b, Exclusion why, bool burnBond) internal {
        b.exclusion = why;
        if (burnBond && _cfg.bidBond != 0) {
            b.bondBurned = true;
            bondsBurned += _cfg.bidBond;
        }
        emit BidExcluded(id, why, burnBond);
    }

    /// @dev Tries every t-subset of the stored shares (n <= 7, so at most 35) in
    ///      ascending bitmask order and returns the first that rebuilds keyHash.
    ///      Any subset that matches gives the committed K, so which one is used
    ///      does not change the outcome.
    function _recoverKey(uint256 id, Bid storage b) internal view returns (bool, uint256) {
        uint8 mask = b.shareMask;
        uint256 t = threshold;
        if (_popcount(mask) < t) return (false, 0);
        uint256 n = _members.length;
        uint256[] memory xs = new uint256[](t);
        uint256[] memory ys = new uint256[](t);
        // forge-lint: disable-next-line(incorrect-shift)
        for (uint256 subset = 1; subset < (1 << n); ++subset) {
            if (subset & mask != subset || _popcount(subset) != t) continue;
            uint256 k;
            for (uint256 j; j < n; ++j) {
                if ((subset >> j) & 1 == 1) {
                    xs[k] = j + 1;
                    ys[k] = _shares[id][j + 1];
                    ++k;
                }
            }
            (bool ok, uint256 key) = SealedSlot.recover(address(this), b.bidder, b.seq, xs, ys, b.keyHash);
            if (ok) return (true, key);
        }
        return (false, 0);
    }

    function _popcount(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            x &= x - 1;
            ++c;
        }
    }

    // ------------------------------------------------------------------ settlement

    /// @notice True once no more releases can arrive: the deadline passed or all n released.
    function releaseWindowOver() public view returns (bool) {
        return block.timestamp > _cfg.releaseDeadline || releaseCount == _members.length;
    }

    /// @notice Compute the clearing price and exact totals (anyone).
    /// @dev Refused while releases can still arrive or any bid is undecided, so
    ///      nobody can finalize early to drop openable bids. Proceeds are the sum
    ///      of what each winner actually pays (each rounded down), so the quote
    ///      balance always covers every refund plus the proceeds.
    function finalize() external inState(State.Closed) {
        if (!releaseWindowOver()) revert ReleaseWindowOpen();
        uint32 total = bidCount;
        if (decidedCount != total) revert UndecidedBids(decidedCount, total);

        uint256 nt = _cfg.numTicks;
        uint256[] memory demand = new uint256[](nt);
        for (uint256 t; t < nt; ++t) {
            demand[t] = demandByTick[t];
        }
        ClearingPrice.Result memory r = ClearingPrice.findClearingTick(demand, _cfg.totalSupply);
        if (!r.cleared) {
            state = State.Failed;
            emit AuctionFailed("no eligible demand");
            return;
        }
        uint256 price = AuctionMath.priceAt(_cfg.reservePrice, _cfg.tickSize, r.clearingTick);
        uint256 sold;
        uint256 paid;
        for (uint256 i; i < total; ++i) {
            Bid storage b = _bids[i];
            if (b.status != BidStatus.Opened) continue;
            uint256 a = ClearingPrice.allocationFor(r, b.quantity, b.tick);
            sold += a;
            paid += AuctionMath.costFloor(a, price, _cfg.saleDecimals);
        }

        _clearing = r;
        clearingPrice = price;
        totalSold = sold;
        grossProceeds = paid;
        protocolFee = AuctionMath.feeOn(paid, _cfg.protocolFeeBps);
        state = State.Settled;
        emit Finalized(r.clearingTick, price, sold, paid, protocolFee);
    }

    /// @notice Liveness valve: if nobody finalizes within `FINALIZE_GRACE` after the
    ///         release deadline, anyone may fail the auction and refund everyone.
    function failOnTimeout() external inState(State.Closed) {
        if (block.timestamp <= uint256(_cfg.releaseDeadline) + FINALIZE_GRACE) revert TooEarly();
        state = State.Failed;
        emit AuctionFailed("finalize timeout");
    }

    // ------------------------------------------------------------------ claims

    /// @notice Pay out one bid: tokens won plus the refund (escrow not spent, and
    ///         the bond unless burned). Anyone may call; funds go to the bidder.
    function claim(uint256 bidId) external nonReentrant returns (uint256 tokens, uint256 refund) {
        State s = state;
        if (s != State.Settled && s != State.Failed && s != State.Cancelled) revert BadState(s);
        if (bidId >= bidCount) revert UnknownBid(bidId);
        Bid storage b = _bids[bidId];
        if (b.claimed) revert AlreadyClaimed();
        b.claimed = true;

        refund = b.escrow + (b.bondBurned ? 0 : _cfg.bidBond);
        if (s == State.Settled && b.status == BidStatus.Opened) {
            tokens = ClearingPrice.allocationFor(_clearing, b.quantity, b.tick);
            refund -= AuctionMath.costFloor(tokens, clearingPrice, _cfg.saleDecimals);
        }
        if (tokens != 0) IERC20(_cfg.saleToken).safeTransfer(b.bidder, tokens);
        if (refund != 0) IERC20(_cfg.quoteToken).safeTransfer(b.bidder, refund);
        emit Claimed(bidId, b.bidder, tokens, refund);
    }

    /// @notice Pay the proceeds to the issuer and the fee to the fee recipient (anyone may call).
    function claimProceeds() external inState(State.Settled) nonReentrant {
        if (proceedsClaimed) revert AlreadyClaimed();
        proceedsClaimed = true;
        uint256 fee = protocolFee;
        uint256 net = grossProceeds - fee;
        if (fee != 0) IERC20(_cfg.quoteToken).safeTransfer(_cfg.feeRecipient, fee);
        if (net != 0) IERC20(_cfg.quoteToken).safeTransfer(_cfg.issuer, net);
        emit ProceedsClaimed(net, fee);
    }

    /// @notice Return unsold supply (rounding dust included) to the issuer (anyone may call).
    function claimUnsold() external nonReentrant {
        State s = state;
        if (s != State.Settled && s != State.Failed) revert BadState(s);
        if (unsoldClaimed) revert AlreadyClaimed();
        unsoldClaimed = true;
        uint256 unsold = _cfg.totalSupply - (s == State.Settled ? totalSold : 0);
        if (unsold != 0) IERC20(_cfg.saleToken).safeTransfer(_cfg.issuer, unsold);
        emit UnsoldClaimed(unsold);
    }

    // ------------------------------------------------------------------ views

    function config() external view returns (Config memory) {
        return _cfg;
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function clearing() external view returns (ClearingPrice.Result memory) {
        return _clearing;
    }

    function getBid(uint256 bidId) external view returns (Bid memory) {
        if (bidId >= bidCount) revert UnknownBid(bidId);
        return _bids[bidId];
    }

    function shareHashesOf(uint256 bidId) external view returns (bytes32[] memory) {
        return _shareHashes[bidId];
    }

    /// @notice Stored shares of one bid, indexed by member (entry j-1 is member j's).
    function sharesOf(uint256 bidId) external view returns (uint8 mask, uint256[] memory shares) {
        mask = _bids[bidId].shareMask;
        uint256 n = _members.length;
        shares = new uint256[](n);
        for (uint256 j; j < n; ++j) {
            shares[j] = _shares[bidId][j + 1];
        }
    }

    function allocationOf(uint256 bidId) external view returns (uint256) {
        Bid storage b = _bids[bidId];
        if (state != State.Settled || b.status != BidStatus.Opened) return 0;
        return ClearingPrice.allocationFor(_clearing, b.quantity, b.tick);
    }

    function releaseArgsHash(uint256[] calldata shares, uint256 invalidBitmap) public view returns (bytes32) {
        return keccak256(abi.encode(uint256(bidCount), shares, invalidBitmap));
    }

    /// @notice The exact bytes member `memberIndex` signs with ML-DSA-87 for its release.
    function releaseMessage(uint8 memberIndex, uint256[] calldata shares, uint256 invalidBitmap, uint256 deadline)
        external
        view
        returns (bytes memory)
    {
        if (memberIndex == 0 || memberIndex > _members.length) revert BadMemberIndex(memberIndex);
        return PqAuth.message(
            address(this),
            _members[memberIndex - 1],
            RELEASE_ACTION,
            0,
            deadline,
            releaseArgsHash(shares, invalidBitmap)
        );
    }

    /// @notice The 32-byte bid plaintext: uint128 quantity ‖ uint16 tick ‖ 14 zero bytes.
    function encodePlaintext(uint128 quantity, uint16 tick) external pure returns (bytes32) {
        return bytes32((uint256(quantity) << 128) | (uint256(tick) << 112));
    }

    /// @notice Escrow a bid of `quantity` at `tick` needs (excluding the bond).
    function escrowFor(uint256 quantity, uint16 tick) external view returns (uint256) {
        return AuctionMath.escrowFor(quantity, _cfg.reservePrice, _cfg.tickSize, tick, _cfg.saleDecimals);
    }
}
