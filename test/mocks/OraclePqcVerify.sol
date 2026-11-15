// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title OraclePqcVerify
/// @notice LOCAL RUNS ONLY (anvil). Stands in for `pqcVerify` at 0x…0A01 when
///         real ML-DSA-87 signatures are used: the EVM cannot verify them, so
///         the local harness verifies each signature off chain with the real
///         ML-DSA-87 implementation and records the verdict here first. The
///         contract under test then sees exactly the verdict the real
///         precompile would give. Anyone can record a verdict, so this must
///         never be deployed to a real network.
contract OraclePqcVerify {
    mapping(bytes32 => bool) public verdict;

    function digest(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(pubkey, signature, message));
    }

    function record(bytes32 d, bool ok) external {
        verdict[d] = ok;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        return verdict[digest(pubkey, signature, message)];
    }
}
