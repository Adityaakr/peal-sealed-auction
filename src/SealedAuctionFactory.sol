// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SealedAuction} from "./SealedAuction.sol";
import {CommitteeRegistry} from "./CommitteeRegistry.sol";

/// @title SealedAuctionFactory
/// @notice Creates, funds and (when its start time has passed) opens a
///         `SealedAuction` clone in one call, so no auction is ever visible
///         without its supply escrowed.
/// @dev Structure ported from Peal's `AuctionFactory.sol` (clones, one-call
///      create-fund-open, metadata hash, paging); fresh implementation.
contract SealedAuctionFactory {
    using SafeERC20 for IERC20;

    address public immutable implementation;
    CommitteeRegistry public immutable registry;

    address[] internal _auctions;
    mapping(address => bool) public isAuction;
    mapping(address issuer => address[]) internal _byIssuer;

    event AuctionCreated(
        address indexed auction,
        address indexed issuer,
        address indexed saleToken,
        address quoteToken,
        uint256 totalSupply,
        bytes32 committeeSetId,
        uint64 startTime,
        uint64 endTime,
        uint64 releaseDeadline,
        string name,
        string details
    );

    error NotIssuer();
    error MetadataMismatch();
    error NotFunded();

    constructor(address implementation_, CommitteeRegistry registry_) {
        require(implementation_ != address(0) && address(registry_) != address(0), "zero");
        implementation = implementation_;
        registry = registry_;
    }

    /// @notice The caller is always the issuer; it must have approved `totalSupply`
    ///         of the sale token to this factory.
    function createAuction(SealedAuction.Config calldata cfg, string calldata name, string calldata details)
        external
        returns (address auction)
    {
        if (cfg.issuer != msg.sender) revert NotIssuer();
        if (cfg.metadataHash != metadataHash(name, details)) revert MetadataMismatch();

        auction = Clones.clone(implementation);
        SealedAuction(auction).initialize(cfg, registry);

        IERC20 sale = IERC20(cfg.saleToken);
        uint256 before = sale.balanceOf(address(this));
        sale.safeTransferFrom(msg.sender, address(this), cfg.totalSupply);
        if (sale.balanceOf(address(this)) - before != cfg.totalSupply) revert NotFunded();
        sale.forceApprove(auction, cfg.totalSupply);
        SealedAuction(auction).fund();
        if (block.timestamp >= cfg.startTime) SealedAuction(auction).openCommit();

        _auctions.push(auction);
        isAuction[auction] = true;
        _byIssuer[msg.sender].push(auction);
        emit AuctionCreated(
            auction,
            msg.sender,
            cfg.saleToken,
            cfg.quoteToken,
            cfg.totalSupply,
            cfg.committeeSetId,
            cfg.startTime,
            cfg.endTime,
            cfg.releaseDeadline,
            name,
            details
        );
    }

    function metadataHash(string calldata name, string calldata details) public pure returns (bytes32) {
        return keccak256(abi.encode(name, details));
    }

    function auctionCount() external view returns (uint256) {
        return _auctions.length;
    }

    function auctionsPaged(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _auctions.length;
        if (offset >= n) return new address[](0);
        uint256 end = limit > n - offset ? n : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _auctions[i];
        }
    }

    function auctionsOf(address issuer) external view returns (address[] memory) {
        return _byIssuer[issuer];
    }
}
