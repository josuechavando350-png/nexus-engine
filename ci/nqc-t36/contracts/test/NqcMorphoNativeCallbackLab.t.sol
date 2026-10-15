// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Solidity SOURCE from immutable official morpho-org/morpho-blue git revision,
// checked out ONLY inside CI. This is a synthetic market with REAL Morpho.sol,
// mock tokens, mock oracle, and synthetic DEX, NOT Base chain market replay.
import {Morpho} from "../lib/morpho-blue/src/Morpho.sol";
import {MarketParams, Id} from "../lib/morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "../lib/morpho-blue/src/libraries/MarketParamsLib.sol";
import {NqcMorphoNativeCallbackLab, NqcMarketParams} from "../src/NqcMorphoNativeCallbackLab.sol";

contract LocalToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "TOKEN_BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
    function transferFrom(address sender, address recipient, uint256 amount)
        external returns (bool)
    {
        uint256 allowed = allowance[sender][msg.sender];
        require(allowed >= amount && balanceOf[sender] >= amount, "TOKEN_ALLOWANCE_OR_BALANCE");
        allowance[sender][msg.sender] = allowed - amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract LocalOracle {
    uint256 public price;
    constructor(uint256 initial) { price = initial; }
    function setPrice(uint256 value) external { price = value; }
}

contract LocalDex {
    LocalToken private immutable loan;
    LocalToken private immutable collateral;
    uint256 public numerator; // USDC per cbXRP, scaled 1e18
    bool public skipCollateralPull;
    bool public lieAboutOutput;
    bool public returnTooLittle;
    constructor(LocalToken loan_, LocalToken collateral_) {
        loan = loan_;
        collateral = collateral_;
        numerator = 11 * 10 ** 17; // TEST synthetic 1.10
    }
    function setRate(uint256 newRate) external { numerator = newRate; }
    function setSkipping(bool skip) external { skipCollateralPull = skip; }
    function setLying(bool lie) external { lieAboutOutput = lie; }
    function setShortReturn(bool short) external { returnTooLittle = short; }
    function swapExactCollateral(
        address collateral_, address loan_, uint256 amountIn, uint256 minLoanOut
    ) external returns (uint256 amountOut) {
        require(collateral_ == address(collateral) && loan_ == address(loan), "ROUTE_ASSETS");
        if (!skipCollateralPull) {
            require(collateral.transferFrom(msg.sender, address(this), amountIn), "ROUTER_INPUT");
        }
        amountOut = amountIn * numerator / 10 ** 18;
        if (returnTooLittle) amountOut /= 2;
        require(amountOut >= minLoanOut, "ROUTER_MIN_OUT");
        require(loan.transfer(msg.sender, amountOut), "ROUTER_PAY");
        if (lieAboutOutput) return amountOut + 1;
    }
}

contract LocalBorrower {
    function open(
        Morpho morpho, MarketParams memory params, LocalToken collateral,
        uint256 collateralAssets, uint256 debtAssets
    ) external {
        collateral.approve(address(morpho), collateralAssets);
        morpho.supplyCollateral(params, collateralAssets, address(this), "");
        morpho.borrow(params, debtAssets, 0, address(this), address(this));
    }
}

contract NotOperatorCaller {
    function probe(
        NqcMorphoNativeCallbackLab executor, NqcMarketParams memory params,
        address borrower, uint256 seize, uint256 repayCeiling,
        uint256 minProfit, uint256 minOut, uint256 deadline, bytes32 identity
    ) external {
        executor.execute(params, borrower, seize, repayCeiling, minProfit, minOut, deadline, identity);
    }
}

contract NqcMorphoNativeCallbackLabTest {
    using MarketParamsLib for MarketParams;
    LocalToken private usdc;
    LocalToken private cbxrp;
    LocalOracle private oracle;
    LocalDex private dex;
    LocalBorrower private borrower;
    Morpho private morpho;
    NqcMorphoNativeCallbackLab private liquidator;
    MarketParams private market;
    NqcMarketParams private nqc;
    uint256 private constant COLL = 1000 * 1e6;
    uint256 private constant DEBT = 700 * 1e6;
    uint256 private constant SEIZE = 500 * 1e6;
    uint256 private constant MINPROFIT = 50 * 1e6;

    function setUp() public {
        usdc = new LocalToken();
        cbxrp = new LocalToken();
        oracle = new LocalOracle(13 * 10 ** 35); // initial source: 1.3 USDC/cbXRP
        morpho = new Morpho(address(this));
        morpho.enableIrm(address(0));
        morpho.enableLltv(625 * 10 ** 15);
        market = MarketParams({
            loanToken: address(usdc), collateralToken: address(cbxrp),
            oracle: address(oracle), irm: address(0), lltv: 625 * 10 ** 15
        });
        morpho.createMarket(market);
        usdc.mint(address(this), 100_000 * 1e6); // synthetic lender deposits
        usdc.approve(address(morpho), 100_000 * 1e6);
        morpho.supply(market, 100_000 * 1e6, 0, address(this), "");
        borrower = new LocalBorrower();
        cbxrp.mint(address(borrower), COLL); // synthetic collateral inventory
        borrower.open(morpho, market, cbxrp, COLL, DEBT);
        dex = new LocalDex(usdc, cbxrp);
        usdc.mint(address(dex), 100_000 * 1e6); // synthetic router liquidity
        nqc = NqcMarketParams({
            loanToken: address(usdc), collateralToken: address(cbxrp),
            oracle: address(oracle), irm: address(0), lltv: 625 * 10 ** 15
        });
        liquidator = new NqcMorphoNativeCallbackLab(
            address(morpho), address(dex), address(this), nqc
        );
        oracle.setPrice(10 ** 36); // TEST-ONLY shock makes original borrower unhealthy
    }

    function _execute(bytes32 identity, uint256 minProfit, uint256 minOut)
        internal returns (uint256)
    {
        return liquidator.execute(
            nqc, address(borrower), SEIZE, 600 * 1e6, minProfit, minOut,
            block.number, identity
        );
    }

    function _reverts(bytes memory encoded, bytes4 selector) internal {
        (bool ok, bytes memory ret) = address(liquidator).call(encoded);
        require(!ok, "EXPECTED_REVERT");
        if (selector != bytes4(0)) {
            require(ret.length >= 4, "NO_ERROR_SELECTOR");
            bytes4 actual;
            assembly ("memory-safe") { actual := mload(add(ret, 32)) }
            require(actual == selector, "WRONG_ERROR_SELECTOR");
        }
    }

    function _call(bytes32 id, uint256 profit, uint256 minOut)
        internal view returns (bytes memory)
    {
        return abi.encodeCall(
            NqcMorphoNativeCallbackLab.execute,
            (nqc, address(borrower), SEIZE, 600 * 1e6, profit, minOut,
             block.number, id)
        );
    }

    function testActualUpstreamMorphoSyntheticLiquidationAtomicWithNoFlashLoan() public {
        Id marketId = market.id();
        (, uint128 borrowerDebtSharesBefore,) = morpho.position(marketId, address(borrower));
        uint256 morphoLoanBefore = usdc.balanceOf(address(morpho));
        uint256 operatorUSDCBefore = usdc.balanceOf(address(this));
        uint256 gas0 = gasleft();
        uint256 paid = _execute(bytes32(uint256(1)), MINPROFIT, 490 * 1e6);
        uint256 gasUsedLocalOnly = gas0 - gasleft();
        require(gasUsedLocalOnly > 0, "LOCAL_GAS_MUST_BE_POSITIVE");
        require(paid > MINPROFIT, "NO_MARGIN_IN_SYNTHETIC_DEX");
        require(usdc.balanceOf(address(this)) == operatorUSDCBefore + paid, "NO_OPERATOR_PAYOUT");
        require(usdc.balanceOf(address(liquidator)) == 0, "STRANDED_LOAN_TOKEN");
        require(cbxrp.balanceOf(address(liquidator)) == 0, "STRANDED_COLLATERAL");
        require(usdc.balanceOf(address(morpho)) > morphoLoanBefore, "DEBT_REPAY_MORPHO");
        (, uint128 borrowerDebtSharesAfter,) = morpho.position(marketId, address(borrower));
        require(borrowerDebtSharesAfter < borrowerDebtSharesBefore, "BORROWER_DEBT_NOT_REDUCED");
        require(liquidator.used(bytes32(uint256(1))), "ID_NOT_CONSUMED");
        require(usdc.allowance(address(liquidator), address(morpho)) == 0, "RESIDUAL_DEBT_ALLOWANCE");
        require(cbxrp.allowance(address(liquidator), address(dex)) == 0, "RESIDUAL_DEX_ALLOWANCE");
    }

    function testHealthyBorrowerRejectsEvenWithProfitableMockDEX() public {
        oracle.setPrice(13 * 10 ** 35); // healthy again; no liquidatable slot
        uint256 collateral0 = cbxrp.balanceOf(address(borrower));
        _reverts(_call(bytes32(uint256(2)), MINPROFIT, 490 * 1e6), bytes4(0));
        require(cbxrp.balanceOf(address(borrower)) == collateral0, "HEALTH_REVERT_ROLLBACK");
        require(!liquidator.used(bytes32(uint256(2))), "REVERT_MUST_NOT_CONSUME_ID");
    }

    function testRouterUnderpaysRevertsAtomicState() public {
        dex.setRate(8 * 10 ** 17); // 400e6 USDC < original protocol debt ~444e6
        uint256 collateral0 = cbxrp.balanceOf(address(borrower));
        uint256 morpho0 = usdc.balanceOf(address(morpho));
        _reverts(_call(bytes32(uint256(3)), MINPROFIT, 300 * 1e6),
            NqcMorphoNativeCallbackLab.NotEnoughLoan.selector);
        require(cbxrp.balanceOf(address(borrower)) == collateral0, "ROLLBACK_COLLATERAL");
        require(usdc.balanceOf(address(morpho)) == morpho0, "ROLLBACK_DEBT");
        require(!liquidator.used(bytes32(uint256(3))), "ROLLBACK_ID");
    }

    function testUnexpectedRouteSlippageReverts() public {
        dex.setRate(9 * 10 ** 17);
        _reverts(_call(bytes32(uint256(4)), MINPROFIT, 500 * 1e6), bytes4(0));
    }

    function testMinimumProfitExceedsActualProceedsReverts() public {
        _reverts(_call(bytes32(uint256(5)), 150 * 1e6, 490 * 1e6),
            NqcMorphoNativeCallbackLab.NotEnoughLoan.selector);
    }

    function testNativeCallbackFromExternalAddressRejected() public {
        (bool ok, bytes memory returned) = address(liquidator).call(
            abi.encodeWithSelector(
                NqcMorphoNativeCallbackLab.onMorphoLiquidate.selector,
                20 * 1e6, abi.encode(bytes32(uint256(6)), 10, bytes32(uint256(7)))
            )
        );
        require(!ok && returned.length >= 4, "CALLBACK_SPOOF_ACCEPTED");
    }

    function testOldInventoryCannotFinancePseudoProfit() public {
        usdc.mint(address(liquidator), 300 * 1e6);
        _reverts(_call(bytes32(uint256(7)), MINPROFIT, 490 * 1e6),
            NqcMorphoNativeCallbackLab.ExistingInventory.selector);
    }

    function testLeftoverCollateralCausesFullRollback() public {
        dex.setSkipping(true);
        _reverts(_call(bytes32(uint256(8)), MINPROFIT, 490 * 1e6),
            NqcMorphoNativeCallbackLab.StrandedCollateral.selector);
    }

    function testDishonestRouterAmountRejected() public {
        dex.setLying(true);
        _reverts(_call(bytes32(uint256(9)), MINPROFIT, 490 * 1e6),
            NqcMorphoNativeCallbackLab.FakeSwapResult.selector);
    }

    function testExpiredBlockRejectedBeforeSource() public {
        uint256 deadline = block.number == 0 ? 0 : block.number - 1;
        _reverts(abi.encodeCall(NqcMorphoNativeCallbackLab.execute,
            (nqc,address(borrower),SEIZE,600*1e6,MINPROFIT,490*1e6,deadline,
             bytes32(uint256(10)))), NqcMorphoNativeCallbackLab.UnexpectedBlock.selector);
    }

    function testWrongMarketOrOracleRejectedBeforeSource() public {
        NqcMarketParams memory forged = nqc;
        forged.oracle = address(1);
        _reverts(abi.encodeCall(NqcMorphoNativeCallbackLab.execute,
            (forged,address(borrower),SEIZE,600*1e6,MINPROFIT,490*1e6,
             block.number,bytes32(uint256(11)))),NqcMorphoNativeCallbackLab.WrongMarket.selector);
    }

    function testUnauthorizedEOACannotRunAnotherOperatorPlan() public {
        NotOperatorCaller other = new NotOperatorCaller();
        try other.probe(liquidator,nqc,address(borrower),SEIZE,600*1e6,
            MINPROFIT,490*1e6,block.number,bytes32(uint256(12))) {
            revert("EXPECTED_NOT_OPERATOR");
        } catch (bytes memory reason) {
            bytes4 selector;
            if(reason.length>=4){assembly ("memory-safe") {selector := mload(add(reason,32))}}
            require(selector == NqcMorphoNativeCallbackLab.WrongCaller.selector,"WRONG_REJECT");
        }
    }

    function testZeroValueFundingDoesNotProveNativeGasSponsor() public {
        // This mechanical proof uses local EVM gas, NOT external gas underwriting.
        require(address(liquidator).balance == 0, "NO_SYNTHETIC_NATIVE_FUNDS");
        uint256 paid = _execute(bytes32(uint256(13)), MINPROFIT, 490 * 1e6);
        require(paid > 0, "LOCAL_UNDERLYING_PROFIT");
        require(address(liquidator).balance == 0, "STILL_NO_NATIVE_SPONSOR");
    }
}
