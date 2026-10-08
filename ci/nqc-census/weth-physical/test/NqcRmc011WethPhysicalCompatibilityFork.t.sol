// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMainnetWeth {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool);
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface VmNqc {
    function deal(address account, uint256 amount) external;
}

contract NqcRejectingRecipient {
    fallback() external payable { revert("UNEXPECTED_FALLBACK"); }
    receive() external payable { revert("UNEXPECTED_ETH_CALLBACK"); }
    function tokensReceived(address, address, address, uint256, bytes calldata, bytes calldata)
        external pure { revert("UNEXPECTED_ERC777_CALLBACK"); }
}

contract NqcWethPuller {
    function pull(address weth, address owner, address to, uint256 amount)
        external returns (bool)
    {
        return IMainnetWeth(weth).transferFrom(owner, to, amount);
    }
}

/// @notice Historical fork-only physical behavior of the original mainnet WETH
/// at the same D08 A1 end anchor used by RMC011/012.
/// @dev All fixture ETH is minted by Foundry's vm.deal: no externally backed gas
/// or flash principal is supplied. This is NOT a token admission authority,
/// Nexus liquidation execution, a complete cost model, or realized profit.
contract NqcRmc011WethPhysicalCompatibilityForkTest {
    VmNqc internal constant vm = VmNqc(
        address(uint160(uint256(keccak256("hevm cheat code"))))
    );
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant BENEFICIARY = 0x000000000000000000000000000000000000BEEF;
    uint256 internal constant D08_END_BLOCK = 26_095_351;

    receive() external payable {}

    function setUp() public view {
        require(block.chainid == 1, "WRONG_CHAIN");
        require(block.number == D08_END_BLOCK, "WRONG_ANCHOR");
        require(WETH.code.length > 0, "WETH_CODE_ABSENT");
    }

    function _weth() internal pure returns (IMainnetWeth) {
        return IMainnetWeth(WETH);
    }

    function _mintFixture(uint256 quantity) internal {
        vm.deal(address(this), quantity + 2 ether);
        _weth().deposit{value: quantity}();
    }

    function testPinnedMainnetRuntimeAndMetadata() public view {
        IMainnetWeth t = _weth();
        require(t.decimals() == 18, "DECIMALS_CHANGED");
        require(keccak256(bytes(t.name())) == keccak256(bytes("Wrapped Ether")), "NAME_CHANGED");
        require(keccak256(bytes(t.symbol())) == keccak256(bytes("WETH")), "SYMBOL_CHANGED");
        require(t.totalSupply() > 0, "EMPTY_SUPPLY");
    }

    function testDepositMintsExactUnitsWithoutExtraFee() public {
        IMainnetWeth t = _weth();
        uint256 balanceBefore = t.balanceOf(address(this));
        uint256 supplyBefore = t.totalSupply();
        uint256 nativeBefore = WETH.balance;
        _mintFixture(1 ether);
        require(t.balanceOf(address(this)) == balanceBefore + 1 ether, "DEPOSIT_NOT_ONE_TO_ONE");
        require(t.totalSupply() == supplyBefore + 1 ether, "SUPPLY_NOT_ONE_TO_ONE");
        require(WETH.balance == nativeBefore + 1 ether, "WETH_NATIVE_RESERVE_DRIFT");
    }

    function testTransferPreservesExactSenderRecipientDeltas() public {
        IMainnetWeth t = _weth();
        _mintFixture(1 ether);
        uint256 senderBefore = t.balanceOf(address(this));
        uint256 recipientBefore = t.balanceOf(BENEFICIARY);
        uint256 supplyBefore = t.totalSupply();
        require(t.transfer(BENEFICIARY, 0.4 ether), "TRANSFER_RETURNED_FALSE");
        require(t.balanceOf(address(this)) == senderBefore - 0.4 ether,
            "SENDER_INEXACT_DELTA");
        require(t.balanceOf(BENEFICIARY) == recipientBefore + 0.4 ether,
            "RECIPIENT_INEXACT_DELTA_OR_FOT");
        require(t.totalSupply() == supplyBefore, "UNEXPECTED_REBASE_OR_BURN");
    }

    function testAllowanceAndTransferFromConserveExactUnits() public {
        IMainnetWeth t = _weth();
        _mintFixture(1 ether);
        NqcWethPuller spender = new NqcWethPuller();
        uint256 senderBefore = t.balanceOf(address(this));
        uint256 receiverBefore = t.balanceOf(BENEFICIARY);
        require(t.approve(address(spender), 0.7 ether), "APPROVAL_FALSE");
        require(t.allowance(address(this), address(spender)) == 0.7 ether, "APPROVAL_MISMATCH");
        require(spender.pull(WETH, address(this), BENEFICIARY, 0.3 ether), "PULL_FALSE");
        require(t.allowance(address(this), address(spender)) == 0.4 ether,
            "ALLOWANCE_UNEXPECTED_DECREMENT");
        require(t.balanceOf(address(this)) == senderBefore - 0.3 ether, "PULL_SENDER_DELTA");
        require(t.balanceOf(BENEFICIARY) == receiverBefore + 0.3 ether,
            "PULL_RECIPIENT_DELTA");
    }

    function testExcessAllowanceCannotBeSpentAndNoStateChange() public {
        IMainnetWeth t = _weth();
        _mintFixture(1 ether);
        NqcWethPuller spender = new NqcWethPuller();
        require(t.approve(address(spender), 0.2 ether), "APPROVAL_FALSE");
        uint256 senderBefore = t.balanceOf(address(this));
        uint256 receiverBefore = t.balanceOf(BENEFICIARY);
        (bool success, ) = address(spender).call(
            abi.encodeWithSelector(spender.pull.selector, WETH, address(this), BENEFICIARY, 0.3 ether)
        );
        require(!success, "ALLOWANCE_BYPASS");
        require(t.balanceOf(address(this)) == senderBefore, "REVERT_BALANCE_MUTATION");
        require(t.balanceOf(BENEFICIARY) == receiverBefore, "REVERT_RECIPIENT_MUTATION");
        require(t.allowance(address(this), address(spender)) == 0.2 ether,
            "REVERT_ALLOWANCE_MUTATION");
    }

    function testRecipientRevertingHookIsNotInvoked() public {
        IMainnetWeth t = _weth();
        _mintFixture(1 ether);
        NqcRejectingRecipient trap = new NqcRejectingRecipient();
        uint256 senderBefore = t.balanceOf(address(this));
        require(t.transfer(address(trap), 0.25 ether), "TRANSFER_CALLED_RECIPIENT_HOOK");
        require(t.balanceOf(address(trap)) == 0.25 ether, "HOOK_RECEIVER_FOT");
        require(t.balanceOf(address(this)) == senderBefore - 0.25 ether,
            "HOOK_SENDER_DELTA");
    }

    function testWithdrawBurnsExactWethAndReturnsExactEther() public {
        IMainnetWeth t = _weth();
        _mintFixture(2 ether);
        uint256 senderBefore = t.balanceOf(address(this));
        uint256 supplyBefore = t.totalSupply();
        uint256 ethBefore = address(this).balance;
        uint256 wethEthBefore = WETH.balance;
        t.withdraw(0.6 ether);
        require(t.balanceOf(address(this)) == senderBefore - 0.6 ether,
            "WITHDRAW_TOKEN_BURN_DELTA");
        require(t.totalSupply() == supplyBefore - 0.6 ether, "WITHDRAW_SUPPLY_DELTA");
        require(address(this).balance == ethBefore + 0.6 ether, "WITHDRAW_ETH_RETURN");
        require(WETH.balance == wethEthBefore - 0.6 ether, "WITHDRAW_WETH_RESERVE_DRIFT");
    }

    function testZeroTransferAndApprovalDoNotRebaseBalances() public {
        IMainnetWeth t = _weth();
        _mintFixture(1 ether);
        uint256 holderBefore = t.balanceOf(address(this));
        uint256 supplyBefore = t.totalSupply();
        require(t.approve(BENEFICIARY, 0.1 ether), "APPROVAL_FAILED");
        require(t.transfer(BENEFICIARY, 0), "ZERO_TRANSFER_FAILED");
        require(t.balanceOf(address(this)) == holderBefore, "NONTRANSFER_REBASE");
        require(t.totalSupply() == supplyBefore, "NONTRANSFER_SUPPLY_CHANGED");
    }

    function testCannotTransferUnownedWeth() public {
        IMainnetWeth t = _weth();
        // The historical fork may already contain WETH at Foundry's
        // deterministic test-contract address. Never assume a clean balance
        // and never let existing chain state subsidize a test expectation.
        uint256 holderBefore = t.balanceOf(address(this));
        uint256 beneficiaryBefore = t.balanceOf(BENEFICIARY);
        uint256 supplyBefore = t.totalSupply();
        require(holderBefore < type(uint256).max, "BALANCE_OVERFLOW");
        (bool ok, ) = WETH.call(
            abi.encodeWithSelector(t.transfer.selector, BENEFICIARY, holderBefore + 1)
        );
        require(!ok, "UNFUNDED_TRANSFER_SUCCEEDED");
        require(t.balanceOf(address(this)) == holderBefore, "UNFUNDED_HOLDER_MUTATED");
        require(t.balanceOf(BENEFICIARY) == beneficiaryBefore, "UNFUNDED_TRANSFER_MUTATED");
        require(t.totalSupply() == supplyBefore, "UNFUNDED_SUPPLY_MUTATED");
    }
}
