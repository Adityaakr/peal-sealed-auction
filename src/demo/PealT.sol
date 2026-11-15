// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title PealT
/// @notice Demo sale token for the fest (PEAL-T). Testnet only; no value.
///         The whole supply is minted once to `holder` (who seeds the faucet).
contract PealT is ERC20 {
    constructor(address holder, uint256 supply) ERC20("Peal Test Token", "PEAL-T") {
        _mint(holder, supply);
    }
}
