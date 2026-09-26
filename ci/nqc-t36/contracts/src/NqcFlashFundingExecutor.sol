// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20FlashMinimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAaveV3FlashPoolMinimal {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IBalancerV2VaultMinimal {
    function flashLoan(
        address recipient,
        IERC20FlashMinimal[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

interface INqcFundedStrategy {
    function executeFunded(
        bytes32 executionIdentityHash,
        address asset,
        uint256 principal,
        bytes calldata payload
    ) external returns (uint256 returnedAssetUnits);
}

/// @notice Bounded single-asset flash-funding coordinator for exact VCR plans.
/// @dev Supports nested Aave V3 flashLoanSimple and Balancer V2 flashLoan callbacks.
///      It owns no discovery, pricing, routing, signing, nonce, relay or RPC logic.
contract NqcFlashFundingExecutor {
    error NotOperator();
    error ExecutionActive();
    error NoExecutionActive();
    error WrongChain(uint256 expected, uint256 actual);
    error Expired(uint256 validThroughBlock, uint256 currentBlock);
    error ZeroAddress();
    error InvalidExecutionIdentity();
    error ExecutionAlreadyConsumed(bytes32 executionIdentityHash);
    error InvalidFundingPlanHash();
    error InvalidAnchor();
    error InvalidCanonicalGeneration();
    error InvalidAsset();
    error InvalidPrincipal();
    error InvalidPayloadHash();
    error PayloadHashMismatch(bytes32 expected, bytes32 actual);
    error InvalidLegCount(uint256 length);
    error InvalidLeg(uint256 index);
    error DuplicateLender(uint256 firstIndex, uint256 secondIndex);
    error PrincipalSumMismatch(uint256 expected, uint256 actual);
    error PlanHashMismatch(bytes32 expected, bytes32 actual);
    error UnexpectedCallbackIndex(uint256 expected, uint256 actual);
    error DuplicateCallback(uint256 index);
    error InvalidCallbackSender(address expected, address actual);
    error InvalidInitiator(address initiator);
    error InvalidCallbackAsset(address expected, address actual);
    error InvalidCallbackAmount(uint256 expected, uint256 actual);
    error InvalidCallbackFee(uint256 expected, uint256 actual);
    error InvalidBalancerVectorLength(uint256 tokens, uint256 amounts, uint256 fees);
    error InvalidProtocolKind(uint8 kind);
    error UnexpectedRepaymentOrder(uint256 expected, uint256 actual);
    error StrategyAlreadyExecuted();
    error StrategyReturnedMismatch(uint256 declaredAmount, uint256 observedAmount);
    error InsufficientFreshPrincipal(uint256 expected, uint256 actual);
    error InsufficientForRepaymentAndProfit(uint256 required, uint256 actual);
    error BaselineViolation(uint256 baseline, uint256 finalBalance);
    error TokenCallFailed(address token, bytes4 selector);

    uint8 internal constant SOURCE_AAVE_V3 = 1;
    uint8 internal constant SOURCE_BALANCER_V2 = 2;
    uint256 internal constant MAX_LEGS = 4;
    uint256 internal constant REPAYMENT_COMPLETE = type(uint256).max;

    struct FundingLeg {
        uint8 sourceKind;
        address lender;
        uint256 principal;
        uint256 expectedFee;
        bytes32 callbackSemanticsHash;
        bytes32 sourceEvidenceHash;
    }

    struct FlashExecutionPlan {
        uint256 chainId;
        uint256 validThroughBlock;
        bytes32 executionIdentityHash;
        bytes32 fundingPlanHash;
        bytes32 anchorHash;
        uint256 canonicalGeneration;
        address asset;
        uint256 principalRequired;
        uint256 minProfitAsset;
        bytes32 payloadHash;
        FundingLeg[] legs;
    }

    struct CallbackEnvelope {
        FlashExecutionPlan plan;
        bytes payload;
        uint256 legIndex;
    }

    address public immutable operator;
    INqcFundedStrategy public immutable strategyExecutor;

    bool private active;
    bytes32 private activePlanHash;
    uint256 private activeBaseline;
    uint256 private nextAcquireIndex;
    uint256 private nextRepayIndex;
    uint256 private enteredMask;
    bool private strategyExecuted;

    mapping(bytes32 => bool) public consumedExecutionIdentity;

    event FundingExecutionCompleted(
        bytes32 indexed executionIdentityHash,
        bytes32 indexed fundingPlanHash,
        bytes32 indexed planHash,
        address asset,
        uint256 principalRequired,
        uint256 realizedProfitAsset,
        uint256 legs
    );

    event FundingLegRepaid(
        bytes32 indexed executionIdentityHash,
        uint256 indexed legIndex,
        uint8 sourceKind,
        address lender,
        uint256 principal,
        uint256 fee,
        uint256 repayment
    );

    constructor(address operator_, address strategyExecutor_) {
        if (operator_ == address(0) || strategyExecutor_ == address(0)) revert ZeroAddress();
        operator = operator_;
        strategyExecutor = INqcFundedStrategy(strategyExecutor_);
    }

    function execute(FlashExecutionPlan calldata plan, bytes calldata payload)
        external
        returns (uint256 realizedProfitAsset)
    {
        if (msg.sender != operator) revert NotOperator();
        if (active) revert ExecutionActive();
        _validatePlan(plan, payload);
        if (consumedExecutionIdentity[plan.executionIdentityHash]) {
            revert ExecutionAlreadyConsumed(plan.executionIdentityHash);
        }

        bytes32 planHash = keccak256(abi.encode(plan));
        uint256 baseline = _balanceOf(plan.asset);

        active = true;
        activePlanHash = planHash;
        activeBaseline = baseline;
        nextAcquireIndex = 0;
        nextRepayIndex = plan.legs.length - 1;
        enteredMask = 0;
        strategyExecuted = false;
        consumedExecutionIdentity[plan.executionIdentityHash] = true;

        _acquire(plan, payload, 0);

        if (!strategyExecuted) revert StrategyAlreadyExecuted();
        if (nextRepayIndex != REPAYMENT_COMPLETE) {
            revert UnexpectedRepaymentOrder(REPAYMENT_COMPLETE, nextRepayIndex);
        }

        uint256 finalBalance = _balanceOf(plan.asset);
        if (finalBalance < baseline) revert BaselineViolation(baseline, finalBalance);
        realizedProfitAsset = finalBalance - baseline;
        if (realizedProfitAsset < plan.minProfitAsset) {
            revert InsufficientForRepaymentAndProfit(plan.minProfitAsset, realizedProfitAsset);
        }

        active = false;
        activePlanHash = bytes32(0);
        activeBaseline = 0;
        nextAcquireIndex = 0;
        nextRepayIndex = 0;
        enteredMask = 0;
        strategyExecuted = false;

        if (realizedProfitAsset != 0) {
            _safeTransfer(plan.asset, operator, realizedProfitAsset);
        }
        uint256 postSweep = _balanceOf(plan.asset);
        if (postSweep != baseline) revert BaselineViolation(baseline, postSweep);

        emit FundingExecutionCompleted(
            plan.executionIdentityHash,
            plan.fundingPlanHash,
            planHash,
            plan.asset,
            plan.principalRequired,
            realizedProfitAsset,
            plan.legs.length
        );
    }

    /// @notice Aave V3 flashLoanSimple callback.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        CallbackEnvelope memory envelope = abi.decode(params, (CallbackEnvelope));
        FundingLeg memory leg = _verifyCallbackEnvelope(envelope, SOURCE_AAVE_V3);
        if (msg.sender != leg.lender) revert InvalidCallbackSender(leg.lender, msg.sender);
        if (initiator != address(this)) revert InvalidInitiator(initiator);
        if (asset != envelope.plan.asset) revert InvalidCallbackAsset(envelope.plan.asset, asset);
        if (amount != leg.principal) revert InvalidCallbackAmount(leg.principal, amount);
        if (premium != leg.expectedFee) revert InvalidCallbackFee(leg.expectedFee, premium);

        _runCallback(envelope);

        uint256 repayment = amount + premium;
        _forceApprove(asset, leg.lender, repayment);
        _markRepaid(envelope.plan, envelope.legIndex, premium);
        return true;
    }

    /// @notice Balancer V2 Vault flash-loan callback.
    function receiveFlashLoan(
        IERC20FlashMinimal[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        CallbackEnvelope memory envelope = abi.decode(userData, (CallbackEnvelope));
        FundingLeg memory leg = _verifyCallbackEnvelope(envelope, SOURCE_BALANCER_V2);
        if (msg.sender != leg.lender) revert InvalidCallbackSender(leg.lender, msg.sender);
        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) {
            revert InvalidBalancerVectorLength(tokens.length, amounts.length, feeAmounts.length);
        }
        if (address(tokens[0]) != envelope.plan.asset) {
            revert InvalidCallbackAsset(envelope.plan.asset, address(tokens[0]));
        }
        if (amounts[0] != leg.principal) revert InvalidCallbackAmount(leg.principal, amounts[0]);
        if (feeAmounts[0] != leg.expectedFee) revert InvalidCallbackFee(leg.expectedFee, feeAmounts[0]);

        _runCallback(envelope);

        uint256 repayment = amounts[0] + feeAmounts[0];
        _safeTransfer(envelope.plan.asset, leg.lender, repayment);
        _markRepaid(envelope.plan, envelope.legIndex, feeAmounts[0]);
    }

    function _runCallback(CallbackEnvelope memory envelope) private {
        uint256 index = envelope.legIndex;
        uint256 bit = 1 << index;
        if ((enteredMask & bit) != 0) revert DuplicateCallback(index);
        enteredMask |= bit;

        if (index + 1 < envelope.plan.legs.length) {
            _acquire(envelope.plan, envelope.payload, index + 1);
        } else {
            _executeStrategy(envelope.plan, envelope.payload);
        }
    }

    function _acquire(FlashExecutionPlan memory plan, bytes memory payload, uint256 index) private {
        if (!active) revert NoExecutionActive();
        if (index != nextAcquireIndex) revert UnexpectedCallbackIndex(nextAcquireIndex, index);
        nextAcquireIndex = index + 1;

        FundingLeg memory leg = plan.legs[index];
        bytes memory envelope = abi.encode(CallbackEnvelope({plan: plan, payload: payload, legIndex: index}));

        if (leg.sourceKind == SOURCE_AAVE_V3) {
            IAaveV3FlashPoolMinimal(leg.lender).flashLoanSimple(
                address(this), plan.asset, leg.principal, envelope, 0
            );
            _forceApprove(plan.asset, leg.lender, 0);
        } else if (leg.sourceKind == SOURCE_BALANCER_V2) {
            IERC20FlashMinimal[] memory tokens = new IERC20FlashMinimal[](1);
            tokens[0] = IERC20FlashMinimal(plan.asset);
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = leg.principal;
            IBalancerV2VaultMinimal(leg.lender).flashLoan(address(this), tokens, amounts, envelope);
        } else {
            revert InvalidProtocolKind(leg.sourceKind);
        }
    }

    function _executeStrategy(FlashExecutionPlan memory plan, bytes memory payload) private {
        if (strategyExecuted) revert StrategyAlreadyExecuted();
        bytes32 actualPayloadHash = keccak256(payload);
        if (actualPayloadHash != plan.payloadHash) {
            revert PayloadHashMismatch(plan.payloadHash, actualPayloadHash);
        }

        uint256 current = _balanceOf(plan.asset);
        if (current < activeBaseline) revert BaselineViolation(activeBaseline, current);
        uint256 fresh = current - activeBaseline;
        if (fresh != plan.principalRequired) {
            revert InsufficientFreshPrincipal(plan.principalRequired, fresh);
        }

        _safeTransfer(plan.asset, address(strategyExecutor), plan.principalRequired);
        uint256 declaredReturned = strategyExecutor.executeFunded(
            plan.executionIdentityHash, plan.asset, plan.principalRequired, payload
        );

        uint256 afterStrategy = _balanceOf(plan.asset);
        if (afterStrategy < activeBaseline) revert BaselineViolation(activeBaseline, afterStrategy);
        uint256 observedReturned = afterStrategy - activeBaseline;
        if (declaredReturned != observedReturned) {
            revert StrategyReturnedMismatch(declaredReturned, observedReturned);
        }

        uint256 required = plan.minProfitAsset;
        for (uint256 i; i < plan.legs.length; ++i) {
            required += plan.legs[i].principal + plan.legs[i].expectedFee;
        }
        if (observedReturned < required) {
            revert InsufficientForRepaymentAndProfit(required, observedReturned);
        }
        strategyExecuted = true;
    }

    function _verifyCallbackEnvelope(CallbackEnvelope memory envelope, uint8 expectedKind)
        private
        view
        returns (FundingLeg memory leg)
    {
        if (!active) revert NoExecutionActive();
        bytes32 actualPlanHash = keccak256(abi.encode(envelope.plan));
        if (actualPlanHash != activePlanHash) revert PlanHashMismatch(activePlanHash, actualPlanHash);
        if (keccak256(envelope.payload) != envelope.plan.payloadHash) {
            revert PayloadHashMismatch(envelope.plan.payloadHash, keccak256(envelope.payload));
        }
        if (envelope.legIndex >= envelope.plan.legs.length) {
            revert UnexpectedCallbackIndex(nextAcquireIndex, envelope.legIndex);
        }
        if (envelope.legIndex + 1 != nextAcquireIndex) {
            revert UnexpectedCallbackIndex(nextAcquireIndex - 1, envelope.legIndex);
        }
        leg = envelope.plan.legs[envelope.legIndex];
        if (leg.sourceKind != expectedKind) revert InvalidProtocolKind(leg.sourceKind);
    }

    function _markRepaid(FlashExecutionPlan memory plan, uint256 index, uint256 fee) private {
        if (nextRepayIndex != index) revert UnexpectedRepaymentOrder(nextRepayIndex, index);
        FundingLeg memory leg = plan.legs[index];
        emit FundingLegRepaid(
            plan.executionIdentityHash,
            index,
            leg.sourceKind,
            leg.lender,
            leg.principal,
            fee,
            leg.principal + fee
        );
        nextRepayIndex = index == 0 ? REPAYMENT_COMPLETE : index - 1;
    }

    function _validatePlan(FlashExecutionPlan calldata plan, bytes calldata payload) private view {
        if (plan.chainId != block.chainid) revert WrongChain(plan.chainId, block.chainid);
        if (block.number > plan.validThroughBlock) revert Expired(plan.validThroughBlock, block.number);
        if (plan.executionIdentityHash == bytes32(0)) revert InvalidExecutionIdentity();
        if (plan.fundingPlanHash == bytes32(0)) revert InvalidFundingPlanHash();
        if (plan.anchorHash == bytes32(0)) revert InvalidAnchor();
        if (plan.canonicalGeneration == 0) revert InvalidCanonicalGeneration();
        if (plan.asset == address(0)) revert InvalidAsset();
        if (plan.principalRequired == 0) revert InvalidPrincipal();
        if (plan.payloadHash == bytes32(0)) revert InvalidPayloadHash();
        bytes32 actualPayloadHash = keccak256(payload);
        if (actualPayloadHash != plan.payloadHash) {
            revert PayloadHashMismatch(plan.payloadHash, actualPayloadHash);
        }

        uint256 length = plan.legs.length;
        if (length == 0 || length > MAX_LEGS) revert InvalidLegCount(length);
        uint256 principalSum;
        for (uint256 i; i < length; ++i) {
            FundingLeg calldata leg = plan.legs[i];
            if (
                (leg.sourceKind != SOURCE_AAVE_V3 && leg.sourceKind != SOURCE_BALANCER_V2)
                    || leg.lender == address(0)
                    || leg.principal == 0
                    || leg.callbackSemanticsHash == bytes32(0)
                    || leg.sourceEvidenceHash == bytes32(0)
            ) revert InvalidLeg(i);
            principalSum += leg.principal;
            for (uint256 j; j < i; ++j) {
                if (plan.legs[j].lender == leg.lender) revert DuplicateLender(j, i);
            }
        }
        if (principalSum != plan.principalRequired) {
            revert PrincipalSumMismatch(plan.principalRequired, principalSum);
        }
    }

    function _balanceOf(address token) private view returns (uint256) {
        return IERC20FlashMinimal(token).balanceOf(address(this));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20FlashMinimal.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, IERC20FlashMinimal.transfer.selector);
        }
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool okZero, bytes memory zeroData) = token.call(
            abi.encodeWithSelector(IERC20FlashMinimal.approve.selector, spender, 0)
        );
        if (!okZero || (zeroData.length != 0 && !abi.decode(zeroData, (bool)))) {
            revert TokenCallFailed(token, IERC20FlashMinimal.approve.selector);
        }
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20FlashMinimal.approve.selector, spender, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, IERC20FlashMinimal.approve.selector);
        }
    }
}
