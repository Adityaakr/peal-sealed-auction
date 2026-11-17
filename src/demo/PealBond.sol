// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IHolderEligibility} from "qorechain-asset-kit/interfaces/IHolderEligibility.sol";

/// @notice What the bond asks of the auction venue (`SealedAuctionFactory`).
interface IAuctionVenue {
    function implementation() external view returns (address);
}

/// @title PealBond (PEAL-B)
/// @notice A demo tokenized bond, sold by sealed uniform-price auction, that only post-quantum
/// accounts may hold. A transfer or mint to `to` succeeds only when `to` is:
///   - eligible under QoreChain's Asset Kit guard (`QoreChainHybridHolderGuard`: a registered
///     ML-DSA-87 key with proof of possession, read from `pqcKeyStatus`, failing closed); or
///   - the venue's factory, or an auction it created: an EIP-1167 clone of the venue's
///     implementation (a contract cannot hold an ML-DSA-87 key, and the auction must hold the
///     supply while bidding runs; the clone's code exists before the factory funds it).
/// So an allocation can only land in an account whose classical key alone cannot move it, and the
/// bond cannot be sent to an address without a post-quantum key.
/// @dev Testnet demo. Burning is always allowed; a holder already passed the check when it received.
contract PealBond is ERC20 {
    IHolderEligibility public immutable guard;
    address public immutable venue;
    /// @notice Code hash of an EIP-1167 clone of the venue's auction implementation.
    bytes32 public immutable auctionCodeHash;

    error NotEligible(address account);

    constructor(IHolderEligibility guard_, IAuctionVenue venue_, address issuer, uint256 supply)
        ERC20("Peal Bond 2027 (demo)", "PEAL-B")
    {
        guard = guard_;
        venue = address(venue_);
        auctionCodeHash = keccak256(
            abi.encodePacked(hex"363d3d373d3d3d363d73", venue_.implementation(), hex"5af43d82803e903d91602b57fd5bf3")
        );
        _mint(issuer, supply);
    }

    /// @notice Whether `account` is one of the venue's auctions (or the venue itself, which funds them).
    function isVenue(address account) public view returns (bool) {
        return account == venue || account.codehash == auctionCodeHash;
    }

    /// @notice Whether `account` may receive PEAL-B.
    function eligible(address account) public view returns (bool) {
        return isVenue(account) || guard.isEligible(account);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && !eligible(to)) revert NotEligible(to);
        super._update(from, to, value);
    }
}
