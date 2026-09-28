// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../reimplementation/nqc-v2-backrun-executor/contracts/src/NqcV2BackrunExecutor.sol";

interface PftTokenVm {
    function roll(uint256 newHeight) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
    function expectRevert(bytes calldata revertData) external;
}

contract PftStandardToken is IERC20BackrunMinimal {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
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
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract PftFeeOnTransferToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        uint256 fee = amount / 10;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}

contract PftNoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

contract PftFlexiblePair is IUniswapV2PairWitnessMinimal {
    address public immutable override token0;
    address public immutable override token1;
    uint112 private immutable reserve0;
    uint112 private immutable reserve1;

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
        if (amount0Out != 0) _send(token0, to, amount0Out);
        if (amount1Out != 0) _send(token1, to, amount1Out);
    }

    function _send(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20BackrunMinimal.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TOKEN_SEND");
    }
}

contract PftRegressionFlashPool is IAaveV3FlashPoolMinimal {
    PftStandardToken public immutable token;
    uint256 public immutable premium;

    constructor(PftStandardToken token_, uint256 premium_) {
        token = token_;
        premium = premium_;
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
        bool ok = NqcV2BackrunExecutor(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            msg.sender,
            params
        );
        require(ok, "CALLBACK");
        require(token.transferFrom(receiverAddress, address(this), amount + premium), "REPAY");
    }
}

contract PftTokenExecutionRegressionTest {
    PftTokenVm private constant vm =
        PftTokenVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant PARENT =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 private constant TARGET_PROVENANCE =
        0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 private constant CANDIDATE_PROVENANCE =
        0x3333333333333333333333333333333333333333333333333333333333333333;

    function testFeeOnTransferOutputRevertsOnMeasuredShortfall() public {
        PftStandardToken flash = new PftStandardToken();
        PftFeeOnTransferToken mid = new PftFeeOnTransferToken();
        PftRegressionFlashPool pool = new PftRegressionFlashPool(flash, 1);
        PftFlexiblePair pair0 =
            new PftFlexiblePair(address(flash), address(mid), 1_000_000, 1_000_000);
        PftFlexiblePair pair1 =
            new PftFlexiblePair(address(mid), address(flash), 1_000_000, 1_000_000);
        NqcV2BackrunExecutor executor =
            new NqcV2BackrunExecutor(address(this), address(pool));

        mid.mint(address(pair0), 1_000);
        flash.mint(address(pair1), 1_000);
        _anchor();

        NqcV2BackrunExecutor.ExecutionPlan memory plan =
            _plan(address(flash), address(mid), address(pair0), address(pair1));

        vm.expectRevert(
            abi.encodeWithSelector(
                NqcV2BackrunExecutor.InsufficientFreshBalance.selector,
                address(mid),
                uint256(100),
                uint256(90)
            )
        );
        executor.execute(plan);

        require(flash.balanceOf(address(executor)) == 0, "FLASH_RESIDUE");
        require(flash.balanceOf(address(pool)) == 0, "POOL_MUTATED");
        require(flash.balanceOf(address(pair0)) == 0, "INPUT_TRANSFER_NOT_REVERTED");
        require(mid.balanceOf(address(executor)) == 0, "FEE_OUTPUT_NOT_REVERTED");
        require(mid.balanceOf(address(pair0)) == 1_000, "PAIR_OUTPUT_NOT_REVERTED");
    }

    function testNoReturnIntermediateTokenExecutesAndRepays() public {
        PftStandardToken flash = new PftStandardToken();
        PftNoReturnToken mid = new PftNoReturnToken();
        PftRegressionFlashPool pool = new PftRegressionFlashPool(flash, 1);
        PftFlexiblePair pair0 =
            new PftFlexiblePair(address(flash), address(mid), 1_000_000, 1_000_000);
        PftFlexiblePair pair1 =
            new PftFlexiblePair(address(mid), address(flash), 1_000_000, 1_000_000);
        NqcV2BackrunExecutor executor =
            new NqcV2BackrunExecutor(address(this), address(pool));

        mid.mint(address(pair0), 1_000);
        flash.mint(address(pair1), 1_000);
        _anchor();

        uint256 realized = executor.execute(
            _plan(address(flash), address(mid), address(pair0), address(pair1))
        );

        require(realized == 9, "REALIZED");
        require(flash.balanceOf(address(this)) == 9, "OPERATOR_PROFIT");
        require(flash.balanceOf(address(executor)) == 0, "EXECUTOR_FLASH_RESIDUE");
        require(mid.balanceOf(address(executor)) == 0, "EXECUTOR_MID_RESIDUE");
        require(flash.balanceOf(address(pool)) == 101, "REPAYMENT");
        require(mid.balanceOf(address(pair1)) == 100, "NO_RETURN_TRANSFER");
    }

    function _anchor() private {
        vm.roll(100);
        vm.setBlockhash(99, PARENT);
    }

    function _plan(address flash, address mid, address pair0, address pair1)
        private
        view
        returns (NqcV2BackrunExecutor.ExecutionPlan memory plan)
    {
        NqcV2BackrunExecutor.HopWitness[] memory hops =
            new NqcV2BackrunExecutor.HopWitness[](2);
        hops[0] = NqcV2BackrunExecutor.HopWitness({
            pair: pair0,
            tokenIn: flash,
            tokenOut: mid,
            amountIn: 100,
            amountOut: 100,
            reserve0: 1_000_000,
            reserve1: 1_000_000
        });
        hops[1] = NqcV2BackrunExecutor.HopWitness({
            pair: pair1,
            tokenIn: mid,
            tokenOut: flash,
            amountIn: 100,
            amountOut: 110,
            reserve0: 1_000_000,
            reserve1: 1_000_000
        });
        plan = NqcV2BackrunExecutor.ExecutionPlan({
            chainId: block.chainid,
            targetBlock: 100,
            parentHash: PARENT,
            flashAsset: flash,
            flashAmount: 100,
            minProfit: 5,
            targetProvenance: TARGET_PROVENANCE,
            candidateProvenance: CANDIDATE_PROVENANCE,
            hops: hops
        });
    }
}
