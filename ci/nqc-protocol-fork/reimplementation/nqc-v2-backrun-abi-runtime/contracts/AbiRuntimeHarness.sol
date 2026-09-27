// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./NqcV2BackrunExecutor.sol";

interface IFlashReceiverRuntime {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

contract RuntimeToken is IERC20BackrunMinimal {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        uint256 fromBalance = balanceOf[msg.sender];
        require(fromBalance >= amount, "BALANCE");
        unchecked {
            balanceOf[msg.sender] = fromBalance - amount;
            balanceOf[to] += amount;
        }
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= amount, "BALANCE");
        unchecked {
            allowance[from][msg.sender] = allowed - amount;
            balanceOf[from] = fromBalance - amount;
            balanceOf[to] += amount;
        }
        return true;
    }
}

contract RuntimePair is IUniswapV2PairWitnessMinimal {
    RuntimeToken public immutable token0Contract;
    RuntimeToken public immutable token1Contract;
    address public immutable override token0;
    address public immutable override token1;
    uint112 private immutable reserve0;
    uint112 private immutable reserve1;

    constructor(
        RuntimeToken token0_,
        RuntimeToken token1_,
        uint112 reserve0_,
        uint112 reserve1_
    ) {
        token0Contract = token0_;
        token1Contract = token1_;
        token0 = address(token0_);
        token1 = address(token1_);
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function getReserves() external view override returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 7);
    }

    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata
    ) external override {
        require(amount0Out == 0 || amount1Out == 0, "ONE_SIDE");
        if (amount0Out != 0) require(token0Contract.transfer(to, amount0Out), "T0");
        if (amount1Out != 0) require(token1Contract.transfer(to, amount1Out), "T1");
    }
}

contract RuntimeFlashPool is IAaveV3FlashPoolMinimal {
    uint256 public constant PREMIUM = 100;

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external override {
        RuntimeToken token = RuntimeToken(asset);
        require(token.transfer(receiverAddress, amount), "LOAN_TRANSFER");
        bool ok = IFlashReceiverRuntime(receiverAddress).executeOperation(
            asset,
            amount,
            PREMIUM,
            receiverAddress,
            params
        );
        require(ok, "CALLBACK");
        require(
            token.transferFrom(receiverAddress, address(this), amount + PREMIUM),
            "REPAY"
        );
    }
}

contract RuntimeFixture {
    RuntimeToken public immutable tokenA;
    RuntimeToken public immutable tokenB;
    RuntimePair public immutable pair0;
    RuntimePair public immutable pair1;
    RuntimeFlashPool public immutable pool;
    NqcV2BackrunExecutor public immutable executor;

    constructor(address operator) {
        tokenA = new RuntimeToken();
        tokenB = new RuntimeToken();
        pair0 = new RuntimePair(tokenA, tokenB, 1_000_000, 2_000_000);
        pair1 = new RuntimePair(tokenA, tokenB, 3_000_000, 4_000_000);
        pool = new RuntimeFlashPool();
        executor = new NqcV2BackrunExecutor(operator, address(pool));

        tokenA.mint(address(pool), 1_000_000);
        tokenB.mint(address(pair0), 1_000_000);
        tokenA.mint(address(pair1), 1_000_000);
    }
}
