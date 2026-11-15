// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DemoFaucet
/// @notice Rate-limited faucet for a demo token: at most `maxPerClaim` per
///         address per `cooldown` seconds. Testnet only.
/// @dev Rules ported from Peal's `DemoFaucet.sol`; fresh implementation.
contract DemoFaucet {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public immutable maxPerClaim;
    uint64 public immutable cooldown;
    mapping(address => uint64) public lastClaimAt;

    event Claimed(address indexed to, uint256 amount);

    error ZeroAmount();
    error AboveMax(uint256 requested, uint256 max);
    error CoolingDown(uint64 availableAt);
    error Empty(uint256 requested, uint256 available);

    constructor(IERC20 token_, uint256 maxPerClaim_, uint64 cooldown_) {
        require(address(token_) != address(0) && maxPerClaim_ != 0, "config");
        token = token_;
        maxPerClaim = maxPerClaim_;
        cooldown = cooldown_;
    }

    function claim(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > maxPerClaim) revert AboveMax(amount, maxPerClaim);
        uint64 last = lastClaimAt[msg.sender];
        if (last != 0 && block.timestamp < uint256(last) + cooldown) revert CoolingDown(last + cooldown);
        uint256 available = token.balanceOf(address(this));
        if (amount > available) revert Empty(amount, available);
        // Unix seconds fit in uint64 for billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        lastClaimAt[msg.sender] = uint64(block.timestamp);
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function claimableBy(address who) external view returns (uint256 amount, uint64 availableAt) {
        uint64 last = lastClaimAt[who];
        availableAt = last == 0 ? 0 : last + cooldown;
        if (last != 0 && block.timestamp < availableAt) return (0, availableAt);
        uint256 bal = token.balanceOf(address(this));
        amount = bal < maxPerClaim ? bal : maxPerClaim;
    }
}
