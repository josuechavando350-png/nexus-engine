// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Differential-only harness. It is injected into a fixed address on a
/// historical fork and in REVM; it is not production executor source.
interface IPftDiffToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPftDiffAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IPftDiffV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract PftRevmForkHarness {
    address internal constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    error WrongCallbackSender(address sender);
    error WrongInitiator(address initiator);
    error WrongFlashAsset(address expected, address actual);
    error WrongFlashAmount(uint256 expected, uint256 actual);
    error MissingCallback();
    error FlashAccounting(uint256 beforeBalance, uint256 afterBalance, uint256 premium);
    error TokenCallFailed(address token, bytes4 selector);
    error PairIdentity();
    error OutputMismatch(uint256 expected, uint256 actual);

    uint256 private lastPremium;
    bool private callbackSeen;

    event FlashSettled(
        address indexed asset,
        uint256 amount,
        uint256 premium,
        uint256 balanceBefore,
        uint256 balanceAfter
    );

    event SwapSettled(
        address indexed pair,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 balanceOutBefore,
        uint256 balanceOutAfter
    );

    function flashRoundTrip(address asset, uint256 amount) external returns (uint256 premium) {
        uint256 beforeBalance = IPftDiffToken(asset).balanceOf(address(this));
        lastPremium = 0;
        callbackSeen = false;
        IPftDiffAavePool(AAVE_POOL).flashLoanSimple(
            address(this), asset, amount, abi.encode(asset, amount), 0
        );
        if (!callbackSeen) revert MissingCallback();
        premium = lastPremium;
        uint256 afterBalance = IPftDiffToken(asset).balanceOf(address(this));
        if (beforeBalance < afterBalance || beforeBalance - afterBalance != premium) {
            revert FlashAccounting(beforeBalance, afterBalance, premium);
        }
        emit FlashSettled(asset, amount, premium, beforeBalance, afterBalance);
        lastPremium = 0;
        callbackSeen = false;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != AAVE_POOL) revert WrongCallbackSender(msg.sender);
        if (initiator != address(this)) revert WrongInitiator(initiator);
        (address expectedAsset, uint256 expectedAmount) = abi.decode(params, (address, uint256));
        if (asset != expectedAsset) revert WrongFlashAsset(expectedAsset, asset);
        if (amount != expectedAmount) revert WrongFlashAmount(expectedAmount, amount);
        callbackSeen = true;
        lastPremium = premium;
        _forceApprove(asset, AAVE_POOL, amount + premium);
        return true;
    }

    function stateProbe(address weth, address usdc, address pair)
        external
        view
        returns (
            uint256 helperWeth,
            uint256 helperUsdc,
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        )
    {
        helperWeth = IPftDiffToken(weth).balanceOf(address(this));
        helperUsdc = IPftDiffToken(usdc).balanceOf(address(this));
        (bool ok, bytes memory data) = pair.staticcall(
            abi.encodeWithSignature("getReserves()")
        );
        if (!ok || data.length < 96) revert PairIdentity();
        (reserve0, reserve1, blockTimestampLast) =
            abi.decode(data, (uint112, uint112, uint32));
    }

    function swapExact(
        address pair,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external returns (uint256 received) {
        address token0 = IPftDiffV2Pair(pair).token0();
        address token1 = IPftDiffV2Pair(pair).token1();
        uint256 amount0Out;
        uint256 amount1Out;
        if (token0 == tokenIn && token1 == tokenOut) {
            amount1Out = amountOut;
        } else if (token1 == tokenIn && token0 == tokenOut) {
            amount0Out = amountOut;
        } else {
            revert PairIdentity();
        }

        uint256 beforeOut = IPftDiffToken(tokenOut).balanceOf(address(this));
        _safeTransfer(tokenIn, pair, amountIn);
        IPftDiffV2Pair(pair).swap(amount0Out, amount1Out, address(this), "");
        uint256 afterOut = IPftDiffToken(tokenOut).balanceOf(address(this));
        received = afterOut >= beforeOut ? afterOut - beforeOut : 0;
        if (received != amountOut) revert OutputMismatch(amountOut, received);

        emit SwapSettled(
            pair, tokenIn, tokenOut, amountIn, amountOut, beforeOut, afterOut
        );
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IPftDiffToken.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, IPftDiffToken.transfer.selector);
        }
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (_tryApprove(token, spender, amount)) return;
        if (!_tryApprove(token, spender, 0) || !_tryApprove(token, spender, amount)) {
            revert TokenCallFailed(token, IPftDiffToken.approve.selector);
        }
    }

    function _tryApprove(address token, address spender, uint256 amount)
        private
        returns (bool)
    {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IPftDiffToken.approve.selector, spender, amount)
        );
        return ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))));
    }
}
