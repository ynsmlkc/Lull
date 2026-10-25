import type { Abi } from 'viem'

export const ARC_MAINNET_ID = 5042
export const VAULT_ADDRESS = '0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5' as const
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const
export const VAULT_DEPLOY_BLOCK = 27826765n
export const ARC_MAINNET_EXPLORER = 'https://explorer.arc.io'
export const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io'
export const USDC_DECIMALS_ERC20 = 6

export const ERC20_MINIMAL_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
] as const satisfies Abi

export const LULL_VAULT_ABI = [
  {
    type: 'function',
    name: 'balance',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'operator',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'paused',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'Paid',
    inputs: [
      { name: 'batchId', type: 'bytes32', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BatchPaid',
    inputs: [
      { name: 'batchId', type: 'bytes32', indexed: true },
      { name: 'count', type: 'uint256', indexed: false },
      { name: 'total', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies Abi
