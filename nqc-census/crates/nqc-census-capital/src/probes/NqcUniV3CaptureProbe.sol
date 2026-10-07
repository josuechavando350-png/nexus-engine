// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract NqcUniV3CaptureProbe {
    address constant FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    bytes4 constant TOKEN0 = 0x0dfe1681;
    bytes4 constant TOKEN1 = 0xd21220a7;
    bytes4 constant FEE = 0xddca3f43;
    bytes4 constant LIQUIDITY = 0x1a686502;
    bytes4 constant FLASH = 0x490e6cbc;
    bytes4 constant GET_POOL = 0x1698ee82;
    bytes4 constant BALANCE_OF = 0x70a08231;
    uint256 constant RECORD_BYTES = 64;

    // record = pool[20] || token0[20] || token1[20] || fee[3] || balance_mask[1]
    constructor(bytes memory packed) {
        require(packed.length > 0 && packed.length % RECORD_BYTES == 0, "shape");
        uint256 n = packed.length / RECORD_BYTES;
        require(n <= 64, "n");
        bytes32[] memory out = new bytes32[](n * 12);
        for (uint256 i = 0; i < n; ++i) {
            _probe(packed, i * RECORD_BYTES, out, i * 12);
        }
        bytes memory encoded = abi.encode(out);
        assembly ("memory-safe") {
            return(add(encoded, 32), mload(encoded))
        }
    }

    function _probe(bytes memory packed, uint256 offset, bytes32[] memory out, uint256 k) private view {
        address pool;
        address expected0;
        address expected1;
        uint24 expectedFee;
        uint8 mask;
        assembly ("memory-safe") {
            let p := add(add(packed, 32), offset)
            pool := shr(96, mload(p))
            expected0 := shr(96, mload(add(p, 20)))
            expected1 := shr(96, mload(add(p, 40)))
            expectedFee := shr(232, mload(add(p, 60)))
            mask := byte(31, mload(add(p, 32)))
        }

        (bytes32 observed0, bool ok0) = _selectorWord(pool, TOKEN0);
        (bytes32 observed1, bool ok1) = _selectorWord(pool, TOKEN1);
        (bytes32 observedFee, bool okFee) = _selectorWord(pool, FEE);
        (bytes32 observedLiquidity, bool okLiq) = _selectorWord(pool, LIQUIDITY);
        (bytes32 rebound, bool okPool) = _getPoolWord(expected0, expected1, expectedFee);

        uint256 size;
        bytes32 runtimeSha256;
        assembly ("memory-safe") {
            size := extcodesize(pool)
            let ptr := mload(0x40)
            extcodecopy(pool, ptr, 0, size)
            if iszero(staticcall(gas(), 2, ptr, size, ptr, 32)) { revert(0, 0) }
            runtimeSha256 := mload(ptr)
        }

        uint256 selectors;
        if (_at(pool, 399) == TOKEN0) selectors |= 1;
        if (_at(pool, 138) == TOKEN1) selectors |= 2;
        if (_at(pool, 56) == FEE) selectors |= 4;
        if (_at(pool, 421) == LIQUIDITY) selectors |= 8;
        if (_at(pool, 252) == FLASH) selectors |= 16;

        bytes32 bal0;
        bytes32 bal1;
        bool okBal0 = true;
        bool okBal1 = true;
        if ((mask & 1) != 0) (bal0, okBal0) = _balanceWord(expected0, pool);
        if ((mask & 2) != 0) (bal1, okBal1) = _balanceWord(expected1, pool);

        out[k] = bytes32(uint256(uint160(pool)));
        out[k + 1] = observed0;
        out[k + 2] = observed1;
        out[k + 3] = observedFee;
        out[k + 4] = observedLiquidity;
        out[k + 5] = rebound;
        out[k + 6] = bytes32(size);
        out[k + 7] = runtimeSha256;
        out[k + 8] = bytes32(selectors);
        out[k + 9] = bytes32(uint256((ok0 && ok1 && okFee && okLiq && okPool && okBal0 && okBal1) ? 1 : 0));
        out[k + 10] = bal0;
        out[k + 11] = bal1;
    }

    function _selectorWord(address target, bytes4 selector) private view returns (bytes32 word, bool ok) {
        bytes memory data;
        (ok, data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length < 32) return (bytes32(0), false);
        assembly ("memory-safe") { word := mload(add(data, 32)) }
    }

    function _getPoolWord(address token0, address token1, uint24 fee) private view returns (bytes32 word, bool ok) {
        bytes memory data;
        (ok, data) = FACTORY.staticcall(abi.encodeWithSelector(GET_POOL, token0, token1, fee));
        if (!ok || data.length < 32) return (bytes32(0), false);
        assembly ("memory-safe") { word := mload(add(data, 32)) }
    }

    function _balanceWord(address token, address owner) private view returns (bytes32 word, bool ok) {
        bytes memory data;
        (ok, data) = token.staticcall(abi.encodeWithSelector(BALANCE_OF, owner));
        if (!ok || data.length < 32) return (bytes32(0), false);
        assembly ("memory-safe") { word := mload(add(data, 32)) }
    }

    function _at(address target, uint256 offset) private view returns (bytes4 value) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0)
            extcodecopy(target, ptr, offset, 4)
            value := mload(ptr)
        }
    }
}
