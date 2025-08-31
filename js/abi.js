// js/abi.js
(function (global) {
  const SAFE_ABI = [
    "function nonce() view returns (uint256)",
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)"
  ];
  const ERC20_ABI = [ "function transfer(address to,uint256 amount) returns (bool)" ];

  global.AppABIs = { SAFE_ABI, ERC20_ABI };
})(window);
