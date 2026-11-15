// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqAuth} from "qore-pq-kit/PqAuth.sol";

/// @title CommitteeRegistry
/// @notice Immutable, content-addressed committee sets for Peal Sealed Auction.
///
/// A committee set is `threshold` of `members.length` accounts (at most 7). Each
/// member j (1-based, its share index) is recorded with:
///   - `kemKeySha3`: SHA3-256 of the ML-KEM-1024 key it registered on QoreChain
///     (`MsgRegisterKEMKey`, readable at `/qorechain/pqc/v1/kem/{addr}`);
///   - `cardHash`: the `qore-pq-kit` `cardHash` of its QoreSeal recipient card
///     (keccak256 of the exact text the card's owner signed with QoreSign; the
///     card carries its X25519 key). The card itself is emitted, not stored or
///     parsed: bidders fetch it from the `MemberJoined` event and check it with
///     the kit's `verifyMember` against this hash and both on-chain keys.
///
/// Every member must sign a join with the ML-DSA-87 key it registered on chain.
/// The join binds the member's ML-KEM key hash and card to the exact set it
/// joins, so a bidder who reads keys from an untrusted REST endpoint can check
/// them against hashes the member itself signed. The signature is checked on
/// chain with `pqcVerify` through `PqAuth`:
///
///   PqAuth.message(verifier = this registry, signer = member, action = JOIN_ACTION,
///                  nonce = 0, deadline, argsHash = joinArgsHash(setId, j, kemKeySha3, cardHash))
///
/// The nonce is always 0: a join is valid for one set id only, and registering
/// the same set again is a no-op, so there is nothing to replay into.
///
/// Sets never change after registration. A new committee is a new set id;
/// auctions snapshot the set they were created with.
/// @dev Structure ported from Peal's `CommitteeRegistry.sol` (content addressing,
///      no duplicate members, no impossible thresholds); the ML-DSA joins and
///      key bindings are new.
contract CommitteeRegistry {
    uint256 public constant MAX_MEMBERS = 7;
    bytes32 public constant JOIN_ACTION = keccak256("CommitteeRegistry.join");
    bytes32 public constant SET_DOMAIN = keccak256("peal-sealed-auction.CommitteeSet.v1");

    struct Member {
        address account;
        bytes32 kemKeySha3;
        bytes32 cardHash;
    }

    struct CommitteeSet {
        uint8 threshold;
        uint64 registeredAt;
        Member[] members;
    }

    mapping(bytes32 setId => CommitteeSet) private _sets;

    event CommitteeSetRegistered(bytes32 indexed setId, uint8 threshold, address[] members);
    event MemberJoined(
        bytes32 indexed setId,
        uint8 indexed index,
        address indexed account,
        bytes32 kemKeySha3,
        bytes32 cardHash,
        bytes card
    );

    error BadThreshold(uint256 threshold, uint256 members);
    error ZeroMember();
    error ZeroKemKeyHash(address member);
    error ZeroCardHash(address member);
    error DuplicateMember(address member);
    error JoinExpired(uint256 deadline);
    error JoinSignatureInvalid(address member);
    error UnknownSet(bytes32 setId);

    /// @notice One member's join: its account, the SHA3-256 of its registered
    ///         ML-KEM-1024 key, the hash of its QoreSeal recipient card, the card
    ///         itself (opaque here; emitted for bidders) and its ML-DSA-87
    ///         signature over `joinMessage(setId, index, ...)`.
    struct Join {
        address account;
        bytes32 kemKeySha3;
        bytes32 cardHash;
        bytes card;
        bytes signature;
    }

    /// @notice Register a committee set; every member's ML-DSA-87 join is verified.
    /// @param joins  members in share-index order (joins[0] is member 1)
    /// @return setId the content address of the set (also returned if it already existed)
    function registerSet(uint8 threshold, Join[] calldata joins, uint256 deadline) external returns (bytes32 setId) {
        uint256 n = joins.length;
        if (threshold == 0 || threshold > n || n > MAX_MEMBERS) revert BadThreshold(threshold, n);
        if (block.timestamp > deadline) revert JoinExpired(deadline);

        Member[] memory ms = new Member[](n);
        for (uint256 i; i < n; ++i) {
            address a = joins[i].account;
            if (a == address(0)) revert ZeroMember();
            if (joins[i].kemKeySha3 == bytes32(0)) revert ZeroKemKeyHash(a);
            if (joins[i].cardHash == bytes32(0)) revert ZeroCardHash(a);
            for (uint256 j; j < i; ++j) {
                if (ms[j].account == a) revert DuplicateMember(a);
            }
            ms[i] = Member({account: a, kemKeySha3: joins[i].kemKeySha3, cardHash: joins[i].cardHash});
        }

        setId = computeSetId(threshold, ms);
        if (_sets[setId].threshold != 0) return setId;

        CommitteeSet storage s = _sets[setId];
        s.threshold = threshold;
        s.registeredAt = uint64(block.timestamp);
        address[] memory accounts = new address[](n);
        for (uint256 i; i < n; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _join(s, setId, uint8(i + 1), ms[i], joins[i], deadline); // n <= 7
            accounts[i] = ms[i].account;
        }
        emit CommitteeSetRegistered(setId, threshold, accounts);
    }

    function _join(
        CommitteeSet storage s,
        bytes32 setId,
        uint8 index,
        Member memory m,
        Join calldata j,
        uint256 deadline
    ) internal {
        bytes memory signed = PqAuth.message(
            address(this), m.account, JOIN_ACTION, 0, deadline, joinArgsHash(setId, index, m.kemKeySha3, m.cardHash)
        );
        if (!PqAuth.verify(PqAuth.keyOf(m.account), j.signature, signed)) revert JoinSignatureInvalid(m.account);
        s.members.push(m);
        emit MemberJoined(setId, index, m.account, m.kemKeySha3, m.cardHash, j.card);
    }

    // ------------------------------------------------------------------ views

    /// @notice Content address of a set: threshold and every member's account, ML-KEM key hash and card hash, in order.
    function computeSetId(uint8 threshold, Member[] memory ms) public pure returns (bytes32) {
        return keccak256(abi.encode(SET_DOMAIN, threshold, ms));
    }

    function joinArgsHash(bytes32 setId, uint8 index, bytes32 kemKeySha3, bytes32 cardHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(setId, index, kemKeySha3, cardHash));
    }

    /// @notice The exact bytes member `index` (1-based) signs to join `setId`.
    function joinMessage(
        bytes32 setId,
        uint8 index,
        address member,
        bytes32 kemKeySha3,
        bytes32 cardHash,
        uint256 deadline
    ) external view returns (bytes memory) {
        return PqAuth.message(
            address(this), member, JOIN_ACTION, 0, deadline, joinArgsHash(setId, index, kemKeySha3, cardHash)
        );
    }

    function exists(bytes32 setId) external view returns (bool) {
        return _sets[setId].threshold != 0;
    }

    function getSet(bytes32 setId) external view returns (uint8 threshold, Member[] memory members) {
        CommitteeSet storage s = _sets[setId];
        if (s.threshold == 0) revert UnknownSet(setId);
        return (s.threshold, s.members);
    }

    function membersOf(bytes32 setId) external view returns (uint8 threshold, address[] memory accounts) {
        CommitteeSet storage s = _sets[setId];
        if (s.threshold == 0) revert UnknownSet(setId);
        uint256 n = s.members.length;
        accounts = new address[](n);
        for (uint256 i; i < n; ++i) {
            accounts[i] = s.members[i].account;
        }
        return (s.threshold, accounts);
    }
}
