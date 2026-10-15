// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Research-only one-transaction Morpho Blue liquidation, with NO extra flash loan.
/// @dev Requires the authentic protocol's ordering: collateral transfer -> callback -> loan repayment.
///      This is NOT production audited; no real-route gas, sponsor, or live capture is certified.
struct NqcMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface INqcMorphoLiquidate {
    function liquidate(
        NqcMarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256, uint256);
}

interface INqcToken {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address receiver, uint256 amount) external returns (bool);
}

interface INqcSwap {
    function swapExactCollateral(
        address collateral,
        address loan,
        uint256 amountIn,
        uint256 minLoanOut
    ) external returns (uint256 loanOut);
}

contract NqcMorphoNativeCallbackLab {
    error WrongCaller();
    error WrongProtocol();
    error WrongMarket();
    error AlreadyActive();
    error NoActiveExecution();
    error WrongContext();
    error UnexpectedBlock();
    error IllegalValue();
    error ExistingInventory();
    error NotEnoughCollateral();
    error NotEnoughLoan(uint256 received, uint256 required);
    error FakeSwapResult();
    error StrandedCollateral();
    error UnexpectedTokenState();
    error ReusedId();
    error TokenFailure();

    INqcMorphoLiquidate public immutable morpho;
    INqcSwap public immutable router;
    address public immutable operator;
    address public immutable loanToken;
    address public immutable collateralToken;
    bytes32 public immutable immutableMarketId;

    bool private active;
    bool private callbackCalled;
    bytes32 private currentContext;
    uint256 private seizeExpected;
    uint256 private loanFloor;
    uint256 private maxRepay;
    mapping(bytes32 => bool) public used;

    event LocalNativeLiquidation(
        bytes32 indexed executionId,
        address indexed borrower,
        uint256 seizedAssets,
        uint256 assetsRepaid,
        uint256 loanSurplusBeforeNativeGas
    );

    constructor(
        address morpho_,
        address router_,
        address operator_,
        NqcMarketParams memory market_
    ) {
        require(
            morpho_ != address(0) && router_ != address(0) && operator_ != address(0) &&
                market_.loanToken != address(0) && market_.collateralToken != address(0) &&
                market_.loanToken != market_.collateralToken && market_.oracle != address(0),
            "INVALID_SOURCE"
        );
        morpho = INqcMorphoLiquidate(morpho_);
        router = INqcSwap(router_);
        operator = operator_;
        loanToken = market_.loanToken;
        collateralToken = market_.collateralToken;
        immutableMarketId = keccak256(abi.encode(market_));
    }

    function execute(
        NqcMarketParams calldata market_,
        address borrower,
        uint256 seizedAssets,
        uint256 maxRepaidAssets,
        uint256 minLoanProfit,
        uint256 minimumSwapOut,
        uint256 validThroughBlock,
        bytes32 executionId
    ) external payable returns (uint256 surplus) {
        if (msg.sender != operator) revert WrongCaller();
        if (msg.value != 0) revert IllegalValue();
        if (active) revert AlreadyActive();
        if (block.number > validThroughBlock) revert UnexpectedBlock();
        if (keccak256(abi.encode(market_)) != immutableMarketId) revert WrongMarket();
        if (used[executionId] || executionId == bytes32(0)) revert ReusedId();
        if (borrower == address(0) || seizedAssets == 0 || maxRepaidAssets == 0) {
            revert WrongContext();
        }
        if (minLoanProfit == 0 || minimumSwapOut < minLoanProfit) revert WrongContext();
        if (_balance(loanToken) != 0 || _balance(collateralToken) != 0) {
            revert ExistingInventory();
        }
        used[executionId] = true;
        active = true;
        seizeExpected = seizedAssets;
        maxRepay = maxRepaidAssets;
        loanFloor = minLoanProfit;
        currentContext = keccak256(
            abi.encode(block.chainid, address(this), borrower, executionId, seizedAssets,
                maxRepaidAssets, minLoanProfit, minimumSwapOut)
        );
        callbackCalled = false;
        (uint256 seized, uint256 repaid) = morpho.liquidate(
            market_, borrower, seizedAssets, 0,
            abi.encode(executionId, minimumSwapOut, currentContext)
        );
        if (!callbackCalled || seized != seizedAssets || repaid > maxRepaidAssets) {
            revert WrongContext();
        }
        // The real Morpho has already pulled repaidAssets at this point.
        surplus = _balance(loanToken);
        if (surplus < minLoanProfit) revert NotEnoughLoan(surplus, minLoanProfit);
        if (_balance(collateralToken) != 0) revert StrandedCollateral();
        _approve(loanToken, address(morpho), 0);
        active = false;
        currentContext = bytes32(0);
        _transfer(loanToken, operator, surplus);
        if (_balance(loanToken) != 0 || _balance(collateralToken) != 0) {
            revert UnexpectedTokenState();
        }
        emit LocalNativeLiquidation(executionId, borrower, seized, repaid, surplus);
    }

    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert WrongProtocol();
        if (!active || callbackCalled) revert NoActiveExecution();
        (bytes32 executionId, uint256 minimumSwapOut, bytes32 committed) =
            abi.decode(data, (bytes32, uint256, bytes32));
        if (
            executionId == bytes32(0) || committed != currentContext ||
                used[executionId] == false
        ) revert WrongContext();
        callbackCalled = true; // before ANY user router interaction, no nested callbacks
        if (repaidAssets > maxRepay || repaidAssets == 0) revert WrongContext();
        if (_balance(collateralToken) != seizeExpected) revert NotEnoughCollateral();
        uint256 beforeLoan = _balance(loanToken);
        _approve(collateralToken, address(router), 0);
        _approve(collateralToken, address(router), seizeExpected);
        uint256 declared = router.swapExactCollateral(
            collateralToken, loanToken, seizeExpected, minimumSwapOut
        );
        _approve(collateralToken, address(router), 0);
        uint256 observed = _balance(loanToken) - beforeLoan;
        if (declared != observed) revert FakeSwapResult();
        if (_balance(collateralToken) != 0) revert StrandedCollateral();
        uint256 required = repaidAssets + loanFloor;
        if (observed < minimumSwapOut || observed < required) {
            revert NotEnoughLoan(observed, required);
        }
        _approve(loanToken, address(morpho), repaidAssets);
    }

    function _balance(address token) private view returns (uint256) {
        return INqcToken(token).balanceOf(address(this));
    }
    function _approve(address token, address spender, uint256 amount) private {
        if (!INqcToken(token).approve(spender, amount)) revert TokenFailure();
    }
    function _transfer(address token, address receiver, uint256 amount) private {
        if (!INqcToken(token).transfer(receiver, amount)) revert TokenFailure();
    }
}
