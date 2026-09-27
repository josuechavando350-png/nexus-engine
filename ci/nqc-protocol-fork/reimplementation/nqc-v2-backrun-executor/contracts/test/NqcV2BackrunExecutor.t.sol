// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/NqcV2BackrunExecutor.sol";

interface Vm {
    function roll(uint256 newHeight) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
    function expectRevert(bytes4 revertData) external;
}

contract PairWitnessMock is IUniswapV2PairWitnessMinimal {
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

    function setReserves(uint112 reserve0_, uint112 reserve1_) external {
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function getReserves() external view override returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 7);
    }

    function swap(uint256, uint256, address, bytes calldata) external override {}
}

contract NqcV2BackrunExecutorHarness is NqcV2BackrunExecutor {
    constructor(address operator_, address pool_) NqcV2BackrunExecutor(operator_, pool_) {}

    function validateForTest(ExecutionPlan memory plan) external view returns (bytes32) {
        _validatePlan(plan);
        _validateWitnesses(plan);
        return hashPlan(plan);
    }
}

contract NqcV2BackrunExecutorRepairTest {
    Vm private constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant PARENT =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 private constant TARGET_PROVENANCE =
        0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 private constant CANDIDATE_PROVENANCE =
        0x3333333333333333333333333333333333333333333333333333333333333333;

    address private constant TOKEN_A = address(0xA1);
    address private constant TOKEN_B = address(0xB2);

    function _executor()
        private
        returns (
            NqcV2BackrunExecutorHarness executor,
            PairWitnessMock pair0,
            PairWitnessMock pair1
        )
    {
        executor = new NqcV2BackrunExecutorHarness(address(this), address(0xF1A5));
        pair0 = new PairWitnessMock(TOKEN_A, TOKEN_B, 1_000_000, 2_000_000);
        pair1 = new PairWitnessMock(TOKEN_A, TOKEN_B, 3_000_000, 4_000_000);
    }

    function _plan(PairWitnessMock pair0, PairWitnessMock pair1)
        private
        view
        returns (NqcV2BackrunExecutor.ExecutionPlan memory plan)
    {
        NqcV2BackrunExecutor.HopWitness[] memory hops =
            new NqcV2BackrunExecutor.HopWitness[](2);

        hops[0] = NqcV2BackrunExecutor.HopWitness({
            pair: address(pair0),
            tokenIn: TOKEN_A,
            tokenOut: TOKEN_B,
            amountIn: 100_000,
            amountOut: 180_000,
            reserve0: 1_000_000,
            reserve1: 2_000_000
        });

        hops[1] = NqcV2BackrunExecutor.HopWitness({
            pair: address(pair1),
            tokenIn: TOKEN_B,
            tokenOut: TOKEN_A,
            amountIn: 180_000,
            amountOut: 101_000,
            reserve0: 3_000_000,
            reserve1: 4_000_000
        });

        plan = NqcV2BackrunExecutor.ExecutionPlan({
            chainId: block.chainid,
            targetBlock: 100,
            parentHash: PARENT,
            flashAsset: TOKEN_A,
            flashAmount: 100_000,
            minProfit: 1,
            targetProvenance: TARGET_PROVENANCE,
            candidateProvenance: CANDIDATE_PROVENANCE,
            hops: hops
        });
    }

    function _pinTarget() private {
        vm.roll(100);
        vm.setBlockhash(99, PARENT);
    }

    function testValidTwoHopWitnessPasses() public {
        (NqcV2BackrunExecutorHarness executor, PairWitnessMock pair0, PairWitnessMock pair1) =
            _executor();
        _pinTarget();
        NqcV2BackrunExecutor.ExecutionPlan memory plan = _plan(pair0, pair1);
        bytes32 digest = executor.validateForTest(plan);
        require(digest == executor.hashPlan(plan), "HASH_MISMATCH");
    }

    function testWrongTargetBlockFailsClosed() public {
        (NqcV2BackrunExecutorHarness executor, PairWitnessMock pair0, PairWitnessMock pair1) =
            _executor();
        vm.roll(101);
        vm.setBlockhash(99, PARENT);
        vm.expectRevert(NqcV2BackrunExecutor.WrongTargetBlock.selector);
        executor.validateForTest(_plan(pair0, pair1));
    }

    function testWrongParentHashFailsClosed() public {
        (NqcV2BackrunExecutorHarness executor, PairWitnessMock pair0, PairWitnessMock pair1) =
            _executor();
        vm.roll(100);
        vm.setBlockhash(
            99,
            0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        );
        vm.expectRevert(NqcV2BackrunExecutor.ParentHashMismatch.selector);
        executor.validateForTest(_plan(pair0, pair1));
    }

    function testReserveWitnessPlusOneFailsClosed() public {
        (NqcV2BackrunExecutorHarness executor, PairWitnessMock pair0, PairWitnessMock pair1) =
            _executor();
        _pinTarget();
        NqcV2BackrunExecutor.ExecutionPlan memory plan = _plan(pair0, pair1);
        plan.hops[0].reserve0 += 1;
        vm.expectRevert(NqcV2BackrunExecutor.ReserveWitnessMismatch.selector);
        executor.validateForTest(plan);
    }

    function testPairTokenOrderingWitnessFailsClosed() public {
        NqcV2BackrunExecutorHarness executor =
            new NqcV2BackrunExecutorHarness(address(this), address(0xF1A5));
        PairWitnessMock wrong = new PairWitnessMock(address(0xC3), TOKEN_B, 1_000_000, 2_000_000);
        PairWitnessMock pair1 = new PairWitnessMock(TOKEN_A, TOKEN_B, 3_000_000, 4_000_000);
        _pinTarget();
        vm.expectRevert(NqcV2BackrunExecutor.PairIdentityMismatch.selector);
        executor.validateForTest(_plan(wrong, pair1));
    }

    function testDuplicatePairFailsClosed() public {
        (NqcV2BackrunExecutorHarness executor, PairWitnessMock pair0, PairWitnessMock pair1) =
            _executor();
        _pinTarget();
        NqcV2BackrunExecutor.ExecutionPlan memory plan = _plan(pair0, pair1);
        plan.hops[1].pair = plan.hops[0].pair;
        plan.hops[1].reserve0 = plan.hops[0].reserve0;
        plan.hops[1].reserve1 = plan.hops[0].reserve1;
        vm.expectRevert(NqcV2BackrunExecutor.DuplicateRoutePair.selector);
        executor.validateForTest(plan);
    }

    function testTargetAndCandidateProvenanceMustRemainDistinct() public {
        (NqcV2BackrunExecutorHarness executor, PairWitnessMock pair0, PairWitnessMock pair1) =
            _executor();
        _pinTarget();
        NqcV2BackrunExecutor.ExecutionPlan memory plan = _plan(pair0, pair1);
        plan.candidateProvenance = plan.targetProvenance;
        vm.expectRevert(NqcV2BackrunExecutor.InvalidProvenance.selector);
        executor.validateForTest(plan);
    }

    function testPlanHashBindsEveryDocumentedBackrunWitnessClass() public {
        (NqcV2BackrunExecutorHarness executor, PairWitnessMock pair0, PairWitnessMock pair1) =
            _executor();
        NqcV2BackrunExecutor.ExecutionPlan memory base = _plan(pair0, pair1);
        bytes32 expected = executor.hashPlan(base);

        NqcV2BackrunExecutor.ExecutionPlan memory mutated = _plan(pair0, pair1);
        mutated.targetBlock += 1;
        require(executor.hashPlan(mutated) != expected, "TARGET_BLOCK_NOT_BOUND");

        mutated = _plan(pair0, pair1);
        mutated.parentHash = bytes32(uint256(mutated.parentHash) + 1);
        require(executor.hashPlan(mutated) != expected, "PARENT_NOT_BOUND");

        mutated = _plan(pair0, pair1);
        mutated.hops[0].reserve0 += 1;
        require(executor.hashPlan(mutated) != expected, "RESERVE0_NOT_BOUND");

        mutated = _plan(pair0, pair1);
        mutated.hops[0].reserve1 += 1;
        require(executor.hashPlan(mutated) != expected, "RESERVE1_NOT_BOUND");

        mutated = _plan(pair0, pair1);
        mutated.hops[0].pair = address(0x1234);
        require(executor.hashPlan(mutated) != expected, "PAIR_NOT_BOUND");

        mutated = _plan(pair0, pair1);
        mutated.targetProvenance =
            0x4444444444444444444444444444444444444444444444444444444444444444;
        require(executor.hashPlan(mutated) != expected, "TARGET_PROVENANCE_NOT_BOUND");

        mutated = _plan(pair0, pair1);
        mutated.candidateProvenance =
            0x5555555555555555555555555555555555555555555555555555555555555555;
        require(executor.hashPlan(mutated) != expected, "CANDIDATE_PROVENANCE_NOT_BOUND");
    }
}
