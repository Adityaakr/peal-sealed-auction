// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqAuth} from "qore-pq-kit/PqAuth.sol";
import {CommitteeRegistry} from "../src/CommitteeRegistry.sol";
import {AuctionBase} from "./utils/AuctionBase.sol";

contract CommitteeRegistryTest is AuctionBase {
    function _ms(CommitteeRegistry.Join[] memory joins) internal pure returns (CommitteeRegistry.Member[] memory ms) {
        ms = new CommitteeRegistry.Member[](joins.length);
        for (uint256 i; i < joins.length; ++i) {
            ms[i] = CommitteeRegistry.Member(joins[i].account, joins[i].kemKeySha3, joins[i].cardHash);
        }
    }

    function test_registersSetWithVerifiedJoins() public view {
        assertTrue(registry.exists(setId));
        (uint8 t, CommitteeRegistry.Member[] memory ms) = registry.getSet(setId);
        assertEq(t, 2);
        assertEq(ms.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(ms[i].account, memberAddr[i]);
            assertEq(ms[i].kemKeySha3, keccak256(abi.encode("kem", i)));
            assertEq(ms[i].cardHash, keccak256(abi.encode("card", i)));
        }
        (, address[] memory accounts) = registry.membersOf(setId);
        assertEq(accounts[2], memberAddr[2]);
    }

    function test_setIdIsContentAddressed() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(2, deadline);
        assertEq(registry.computeSetId(2, _ms(joins)), setId);
        // Registering the same content again is a no-op that returns the same id.
        assertEq(registry.registerSet(2, joins, deadline), setId);
    }

    function test_differentThresholdIsADifferentSet() public {
        bytes32 id3 = _registerCommittee(3);
        assertTrue(id3 != setId);
        (uint8 t,) = registry.getSet(id3);
        assertEq(t, 3);
    }

    function test_emitsCards() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        bytes32 id = registry.computeSetId(1, _ms(joins));
        vm.expectEmit(true, true, true, true, address(registry));
        emit CommitteeRegistry.MemberJoined(id, 1, memberAddr[0], joins[0].kemKeySha3, joins[0].cardHash, joins[0].card);
        registry.registerSet(1, joins, deadline);
    }

    function test_rejectsImpossibleThresholds() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(2, deadline);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.BadThreshold.selector, 0, 3));
        registry.registerSet(0, joins, deadline);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.BadThreshold.selector, 4, 3));
        registry.registerSet(4, joins, deadline);
        CommitteeRegistry.Join[] memory eight = new CommitteeRegistry.Join[](8);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.BadThreshold.selector, 2, 8));
        registry.registerSet(2, eight, deadline);
    }

    function test_rejectsDuplicateMember() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(2, deadline);
        joins[2].account = joins[0].account;
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.DuplicateMember.selector, joins[0].account));
        registry.registerSet(2, joins, deadline);
    }

    function test_rejectsZeroMemberAndZeroKemHash() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(2, deadline);
        joins[1].account = address(0);
        vm.expectRevert(CommitteeRegistry.ZeroMember.selector);
        registry.registerSet(2, joins, deadline);

        joins = _joins(2, deadline);
        joins[1].kemKeySha3 = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.ZeroKemKeyHash.selector, memberAddr[1]));
        registry.registerSet(2, joins, deadline);
    }

    function test_rejectsZeroCardHash() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(2, deadline);
        joins[0].cardHash = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.ZeroCardHash.selector, memberAddr[0]));
        registry.registerSet(2, joins, deadline);
    }

    function test_rejectsExpiredJoins() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.JoinExpired.selector, deadline));
        registry.registerSet(1, joins, deadline);
    }

    function test_rejectsJoinSignedByAnotherKey() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        joins[1].signature = joins[0].signature; // member 1's signature in member 2's slot
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.JoinSignatureInvalid.selector, memberAddr[1]));
        registry.registerSet(1, joins, deadline);
    }

    function test_joinBindsTheKemKeyHash() public {
        // A REST proxy that swaps a member's ML-KEM key cannot get the swapped
        // hash registered: the member signed the original one.
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        joins[0].kemKeySha3 = keccak256("attacker kem key");
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.JoinSignatureInvalid.selector, memberAddr[0]));
        registry.registerSet(1, joins, deadline);
    }

    function test_joinBindsTheCard() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        joins[2].cardHash = keccak256("tampered card");
        // The card is part of the set id, so every member's join now fails; the first one reverts.
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.JoinSignatureInvalid.selector, memberAddr[0]));
        registry.registerSet(1, joins, deadline);
    }

    function test_joinForOneSetCannotJoinAnother() public {
        // Signatures made for the 1-of-3 set are refused for the 3-of-3 set.
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.JoinSignatureInvalid.selector, memberAddr[0]));
        registry.registerSet(3, joins, deadline);
    }

    function test_rejectsMemberWithoutPqKey() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        pqcKeyStatusMock.set(memberAddr[0], false, 0, "", false);
        vm.expectRevert(
            abi.encodeWithSelector(PqAuth.PqKeyUnusable.selector, memberAddr[0], false, uint8(0), false, uint256(0))
        );
        registry.registerSet(1, joins, deadline);
    }

    function test_failsClosedOnEmptyPrecompile() public {
        uint256 deadline = block.timestamp + 1 days;
        CommitteeRegistry.Join[] memory joins = _joins(1, deadline);
        pqcKeyStatusMock.setEmptyReturn(true);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PqPrecompileUnavailable.selector, PqAuth.PQC_KEY_STATUS));
        registry.registerSet(1, joins, deadline);
    }

    function test_unknownSetReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CommitteeRegistry.UnknownSet.selector, bytes32(uint256(1))));
        registry.getSet(bytes32(uint256(1)));
    }
}
