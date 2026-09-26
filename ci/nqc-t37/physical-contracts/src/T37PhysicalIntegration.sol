// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "./NqcFlashFundingExecutor.sol";

contract T37SyntheticMarket {
    uint256 public reserveA = 1_000_000;
    uint256 public reserveB = 2_000_000;
    uint256 public epoch;

    event Touched(address indexed sender, uint256 amount, uint256 reserveA, uint256 reserveB, uint256 epoch);

    function touch(uint256 amount) external returns (bytes32 stateHash) {
        require(amount != 0 && amount < reserveA, "AMOUNT");
        unchecked {
            reserveA -= amount;
            reserveB += amount * 2;
            epoch += 1;
        }
        stateHash = keccak256(abi.encode(reserveA, reserveB, epoch));
        emit Touched(msg.sender, amount, reserveA, reserveB, epoch);
    }

    function stateHash() external view returns (bytes32) {
        return keccak256(abi.encode(reserveA, reserveB, epoch));
    }
}

contract T37MockFlashToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        require(balance >= amount, "BALANCE");
        unchecked {
            balanceOf[msg.sender] = balance - amount;
        }
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "ALLOWANCE");
        uint256 balance = balanceOf[from];
        require(balance >= amount, "BALANCE");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;
        return true;
    }
}

contract T37MockFundedStrategy {
    uint256 public constant EXTRA_PROFIT = 25;

    function executeFunded(
        bytes32,
        address asset,
        uint256 principal,
        bytes calldata
    ) external returns (uint256 returnedAssetUnits) {
        T37MockFlashToken token = T37MockFlashToken(asset);
        token.mint(address(this), EXTRA_PROFIT);
        returnedAssetUnits = principal + EXTRA_PROFIT;
        require(token.transfer(msg.sender, returnedAssetUnits), "RETURN");
    }
}

contract T37MockAaveFlashPool {
    uint256 public constant FEE = 7;

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        T37MockFlashToken token = T37MockFlashToken(asset);
        token.mint(receiverAddress, amount);
        bool ok = NqcFlashFundingExecutor(receiverAddress).executeOperation(
            asset, amount, FEE, receiverAddress, params
        );
        require(ok, "CALLBACK");
        require(token.transferFrom(receiverAddress, address(this), amount + FEE), "REPAY");
    }
}

contract T37MockBalancerVault {
    uint256 public constant FEE = 3;

    function flashLoan(
        address recipient,
        IERC20FlashMinimal[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external {
        require(tokens.length == 1 && amounts.length == 1, "VECTOR");
        T37MockFlashToken token = T37MockFlashToken(address(tokens[0]));
        uint256 beforeBalance = token.balanceOf(address(this));
        token.mint(recipient, amounts[0]);
        uint256[] memory fees = new uint256[](1);
        fees[0] = FEE;
        NqcFlashFundingExecutor(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
        require(token.balanceOf(address(this)) == beforeBalance + amounts[0] + FEE, "REPAY");
    }
}

/// @notice Local-dev physical integration driver only.
/// @dev Real Aave/Balancer protocol parity is supplied by the independently attested T36 historical-fork gate.
contract T37FundingDriver {
    NqcFlashFundingExecutor public immutable executor;
    T37MockFlashToken public immutable token;
    T37MockFundedStrategy public immutable strategy;
    T37MockAaveFlashPool public immutable aave;
    T37MockBalancerVault public immutable balancer;

    constructor(
        address token_,
        address strategy_,
        address aave_,
        address balancer_
    ) {
        token = T37MockFlashToken(token_);
        strategy = T37MockFundedStrategy(strategy_);
        aave = T37MockAaveFlashPool(aave_);
        balancer = T37MockBalancerVault(balancer_);
        executor = new NqcFlashFundingExecutor(address(this), strategy_);
    }

    function run(bytes32 executionIdentityHash)
        external
        returns (uint256 realizedProfitAsset, bytes32 planHash)
    {
        bytes memory payload = abi.encodePacked("T37_LOCAL_DEV_PHYSICAL_FUNDING_V1", executionIdentityHash);
        NqcFlashFundingExecutor.FundingLeg[] memory legs = new NqcFlashFundingExecutor.FundingLeg[](2);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1,
            lender: address(aave),
            principal: 700,
            expectedFee: 7,
            callbackSemanticsHash: keccak256("AAVE_V3_FLASH_LOAN_SIMPLE_CALLBACK_V1"),
            sourceEvidenceHash: keccak256("T36_REAL_AAVE_V3_HISTORICAL_FORK_GATE")
        });
        legs[1] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 2,
            lender: address(balancer),
            principal: 300,
            expectedFee: 3,
            callbackSemanticsHash: keccak256("BALANCER_V2_FLASH_LOAN_CALLBACK_V1"),
            sourceEvidenceHash: keccak256("T36_REAL_BALANCER_V2_HISTORICAL_FORK_GATE")
        });
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan =
            NqcFlashFundingExecutor.FlashExecutionPlan({
                chainId: block.chainid,
                validThroughBlock: block.number,
                executionIdentityHash: executionIdentityHash,
                fundingPlanHash: keccak256(abi.encode("T37_FUNDING_PLAN_V1", executionIdentityHash)),
                anchorHash: keccak256(abi.encode(block.chainid, block.number, blockhash(block.number - 1))),
                canonicalGeneration: 1,
                asset: address(token),
                principalRequired: 1_000,
                minProfitAsset: 15,
                payloadHash: keccak256(payload),
                legs: legs
            });
        planHash = keccak256(abi.encode(plan));
        realizedProfitAsset = executor.execute(plan, payload);
        require(realizedProfitAsset == 15, "REALIZED");
        require(token.balanceOf(address(executor)) == 0, "EXECUTOR_BASELINE");
    }
}
