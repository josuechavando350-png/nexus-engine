// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/NqcV2BackrunExecutor.sol";

interface PftVm {
    function roll(uint256 newHeight) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
}

contract PftToken is IERC20BackrunMinimal {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        unchecked {
            balanceOf[msg.sender] -= amount;
            balanceOf[to] += amount;
        }
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "ALLOWANCE");
        require(balanceOf[from] >= amount, "BALANCE");
        unchecked {
            allowance[from][msg.sender] = approved - amount;
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        return true;
    }
}

contract PftPair is IUniswapV2PairWitnessMinimal {
    address public immutable override token0;
    address public immutable override token1;
    uint112 private reserve0;
    uint112 private reserve1;

    constructor(address token0_, address token1_, uint112 reserve0_, uint112 reserve1_) {
        token0 = token0_;
        token1 = token1_;
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function getReserves() external view override returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 7);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata)
        external
        override
    {
        if (amount0Out != 0) require(PftToken(token0).transfer(to, amount0Out), "T0");
        if (amount1Out != 0) require(PftToken(token1).transfer(to, amount1Out), "T1");
        uint256 b0 = PftToken(token0).balanceOf(address(this));
        uint256 b1 = PftToken(token1).balanceOf(address(this));
        require(b0 <= type(uint112).max && b1 <= type(uint112).max, "RESERVE");
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
    }
}

contract PftFlashPool is IAaveV3FlashPoolMinimal {
    enum Mode {
        Normal,
        WrongInitiator,
        DoubleCallback,
        WrongAsset,
        WrongAmount,
        SkipCallback
    }

    PftToken public immutable token;
    PftToken public immutable alternate;
    uint256 public immutable premium;
    Mode public mode;

    constructor(PftToken token_, PftToken alternate_, uint256 premium_) {
        token = token_;
        alternate = alternate_;
        premium = premium_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external override {
        require(asset == address(token), "ASSET");
        token.mint(receiverAddress, amount);

        if (mode == Mode.SkipCallback) return;

        address callbackAsset = mode == Mode.WrongAsset ? address(alternate) : asset;
        uint256 callbackAmount = mode == Mode.WrongAmount ? amount + 1 : amount;
        address initiator = mode == Mode.WrongInitiator ? address(0xBAD) : msg.sender;

        bool ok = NqcV2BackrunExecutor(receiverAddress).executeOperation(
            callbackAsset,
            callbackAmount,
            premium,
            initiator,
            params
        );
        require(ok, "CALLBACK");

        if (mode == Mode.DoubleCallback) {
            NqcV2BackrunExecutor(receiverAddress).executeOperation(
                asset,
                amount,
                premium,
                msg.sender,
                params
            );
        }

        require(
            token.transferFrom(receiverAddress, address(this), amount + premium),
            "REPAY"
        );
    }

    function replayCallback(
        NqcV2BackrunExecutor executor,
        address asset,
        uint256 amount,
        address initiator,
        bytes calldata params
    ) external {
        executor.executeOperation(asset, amount, premium, initiator, params);
    }
}

contract NqcV2BackrunExecutorAuthorityMatrixTest {
    PftVm private constant vm =
        PftVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant PARENT =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 private constant TARGET_PROVENANCE =
        0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 private constant CANDIDATE_PROVENANCE =
        0x3333333333333333333333333333333333333333333333333333333333333333;

    struct Fixture {
        PftToken tokenA;
        PftToken tokenB;
        PftFlashPool pool;
        PftPair pair0;
        PftPair pair1;
        NqcV2BackrunExecutor executor;
    }

    function _fixture() private returns (Fixture memory f) {
        f.tokenA = new PftToken();
        f.tokenB = new PftToken();
        f.pool = new PftFlashPool(f.tokenA, f.tokenB, 1);
        f.pair0 = new PftPair(address(f.tokenA), address(f.tokenB), 1_000_000, 1_000_000);
        f.pair1 = new PftPair(address(f.tokenA), address(f.tokenB), 1_000_000, 1_000_000);
        f.executor = new NqcV2BackrunExecutor(address(this), address(f.pool));

        f.tokenA.mint(address(f.pair0), 1_000_000);
        f.tokenB.mint(address(f.pair0), 1_000_000);
        f.tokenA.mint(address(f.pair1), 1_000_000);
        f.tokenB.mint(address(f.pair1), 1_000_000);

        vm.roll(100);
        vm.setBlockhash(99, PARENT);
    }

    function _plan(Fixture memory f, uint256 finalAmount, uint256 minProfit)
        private
        view
        returns (NqcV2BackrunExecutor.ExecutionPlan memory plan)
    {
        NqcV2BackrunExecutor.HopWitness[] memory hops =
            new NqcV2BackrunExecutor.HopWitness[](2);
        hops[0] = NqcV2BackrunExecutor.HopWitness({
            pair: address(f.pair0),
            tokenIn: address(f.tokenA),
            tokenOut: address(f.tokenB),
            amountIn: 100,
            amountOut: 100,
            reserve0: 1_000_000,
            reserve1: 1_000_000
        });
        hops[1] = NqcV2BackrunExecutor.HopWitness({
            pair: address(f.pair1),
            tokenIn: address(f.tokenB),
            tokenOut: address(f.tokenA),
            amountIn: 100,
            amountOut: finalAmount,
            reserve0: 1_000_000,
            reserve1: 1_000_000
        });
        plan = NqcV2BackrunExecutor.ExecutionPlan({
            chainId: block.chainid,
            targetBlock: 100,
            parentHash: PARENT,
            flashAsset: address(f.tokenA),
            flashAmount: 100,
            minProfit: minProfit,
            targetProvenance: TARGET_PROVENANCE,
            candidateProvenance: CANDIDATE_PROVENANCE,
            hops: hops
        });
    }

    function testHappyPathPreservesBaselineAndPaysOnlyFreshProfit() public {
        Fixture memory f = _fixture();
        f.tokenA.mint(address(f.executor), 1_000);
        uint256 operatorBefore = f.tokenA.balanceOf(address(this));

        uint256 realized = f.executor.execute(_plan(f, 110, 5));

        require(realized == 9, "PROFIT");
        require(f.tokenA.balanceOf(address(this)) - operatorBefore == 9, "OPERATOR");
        require(f.tokenA.balanceOf(address(f.executor)) == 1_000, "BASELINE");
        require(f.tokenB.balanceOf(address(f.executor)) == 0, "RESIDUE");
        require(f.tokenA.balanceOf(address(f.pool)) == 101, "REPAYMENT");
    }

    function testPreexistingFlashBalanceCannotSubsidizeRepaymentOrProfit() public {
        Fixture memory f = _fixture();
        f.tokenA.mint(address(f.executor), 1_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                NqcV2BackrunExecutor.InsufficientProfit.selector,
                uint256(1),
                uint256(0)
            )
        );
        f.executor.execute(_plan(f, 101, 1));
    }

    function testDirectCallbackFromNonPoolFailsClosed() public {
        Fixture memory f = _fixture();
        vm.expectRevert(NqcV2BackrunExecutor.InvalidCallbackSender.selector);
        f.executor.executeOperation(
            address(f.tokenA),
            100,
            1,
            address(f.executor),
            ""
        );
    }

    function testPoolCallbackWithoutActivePlanFailsClosed() public {
        Fixture memory f = _fixture();
        vm.expectRevert(NqcV2BackrunExecutor.NoActivePlan.selector);
        f.pool.replayCallback(
            f.executor,
            address(f.tokenA),
            100,
            address(f.executor),
            ""
        );
    }

    function testWrongInitiatorFailsClosedInsideActivePlan() public {
        Fixture memory f = _fixture();
        f.pool.setMode(PftFlashPool.Mode.WrongInitiator);
        vm.expectRevert(NqcV2BackrunExecutor.InvalidInitiator.selector);
        f.executor.execute(_plan(f, 110, 5));
    }

    function testWrongFlashAssetFailsClosedInsideActivePlan() public {
        Fixture memory f = _fixture();
        f.pool.setMode(PftFlashPool.Mode.WrongAsset);
        vm.expectRevert(NqcV2BackrunExecutor.InvalidFlashAsset.selector);
        f.executor.execute(_plan(f, 110, 5));
    }

    function testWrongFlashPrincipalFailsClosedInsideActivePlan() public {
        Fixture memory f = _fixture();
        f.pool.setMode(PftFlashPool.Mode.WrongAmount);
        vm.expectRevert(NqcV2BackrunExecutor.InvalidFlashPrincipal.selector);
        f.executor.execute(_plan(f, 110, 5));
    }

    function testSecondCallbackFailsClosed() public {
        Fixture memory f = _fixture();
        f.pool.setMode(PftFlashPool.Mode.DoubleCallback);
        vm.expectRevert(NqcV2BackrunExecutor.CallbackAlreadyConsumed.selector);
        f.executor.execute(_plan(f, 110, 5));
    }

    function testMissingCallbackFailsClosed() public {
        Fixture memory f = _fixture();
        f.pool.setMode(PftFlashPool.Mode.SkipCallback);
        vm.expectRevert(NqcV2BackrunExecutor.CallbackNotConsumed.selector);
        f.executor.execute(_plan(f, 110, 5));
    }
}
