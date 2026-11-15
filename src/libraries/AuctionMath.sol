// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title AuctionMath
/// @notice Price and cost arithmetic in token base units.
/// @dev Rules ported from Peal (`contracts/src/auctionkit/AuctionMath.sol`, see
///      README "Prior work"); fresh implementation.
///
///      A price is quote base units per one whole sale token:
///          price(tick) = reservePrice + tick * tickSize
///          cost        = quantity * price / 10**saleDecimals
///      `quantity` is always in sale base units so partial fills can be expressed.
///      `mulDiv` keeps the 512-bit product, since `quantity * price` overflows for
///      ordinary 18-decimal amounts.
///
///      Rounding always protects the contract's solvency:
///      - escrow (what a bidder deposits) rounds up, so it covers the worst case;
///      - payment (what a winner is charged) rounds down, so nobody is overcharged.
///      The gap is at most one base unit and goes back to the bidder.
library AuctionMath {
    uint256 internal constant BPS = 10_000;

    function priceAt(uint256 reservePrice, uint256 tickSize, uint16 tick) internal pure returns (uint256) {
        return reservePrice + uint256(tick) * tickSize;
    }

    function costFloor(uint256 quantity, uint256 price, uint8 saleDecimals) internal pure returns (uint256) {
        return Math.mulDiv(quantity, price, 10 ** saleDecimals, Math.Rounding.Floor);
    }

    function costCeil(uint256 quantity, uint256 price, uint8 saleDecimals) internal pure returns (uint256) {
        return Math.mulDiv(quantity, price, 10 ** saleDecimals, Math.Rounding.Ceil);
    }

    /// @notice Deposit a bid needs: its quantity at its own highest price, rounded up.
    function escrowFor(uint256 quantity, uint256 reservePrice, uint256 tickSize, uint16 maxTick, uint8 saleDecimals)
        internal
        pure
        returns (uint256)
    {
        return costCeil(quantity, priceAt(reservePrice, tickSize, maxTick), saleDecimals);
    }

    /// @notice Protocol fee on settled proceeds, rounded down.
    function feeOn(uint256 proceeds, uint16 feeBps) internal pure returns (uint256) {
        return Math.mulDiv(proceeds, feeBps, BPS, Math.Rounding.Floor);
    }
}
