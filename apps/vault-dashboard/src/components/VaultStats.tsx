import { useReadContract } from 'wagmi'
import { formatUnitsFixed } from '@/onchain-money'
import { VAULT_ADDRESS, LULL_VAULT_ABI, ARC_MAINNET_ID, USDC_ADDRESS, ERC20_MINIMAL_ABI } from '../constants'

interface Stat {
  label: string
  value: string
  mono?: boolean
  success?: boolean
  danger?: boolean
}

function StatCard({ label, value, mono, success, danger }: Stat) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '16px 18px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--subtle)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        className={mono ? 'mono' : ''}
        style={{
          fontSize: mono ? 13 : 15,
          fontWeight: 600,
          color: success ? 'var(--success)' : danger ? 'var(--danger)' : 'var(--ink)',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </div>
  )
}

export function VaultStats() {
  const { data: balance, isLoading: loadingBal } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_MINIMAL_ABI,
    functionName: 'balanceOf',
    args: [VAULT_ADDRESS],
    chainId: ARC_MAINNET_ID,
    query: { refetchInterval: 15_000 },
  })

  const { data: operator, isLoading: loadingOp } = useReadContract({
    address: VAULT_ADDRESS,
    abi: LULL_VAULT_ABI,
    functionName: 'operator',
    chainId: ARC_MAINNET_ID,
    query: { refetchInterval: 15_000 },
  })

  const { data: owner, isLoading: loadingOwner } = useReadContract({
    address: VAULT_ADDRESS,
    abi: LULL_VAULT_ABI,
    functionName: 'owner',
    chainId: ARC_MAINNET_ID,
    query: { refetchInterval: 15_000 },
  })

  const { data: paused, isLoading: loadingPaused } = useReadContract({
    address: VAULT_ADDRESS,
    abi: LULL_VAULT_ABI,
    functionName: 'paused',
    chainId: ARC_MAINNET_ID,
    query: { refetchInterval: 15_000 },
  })

  const formatAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`

  const balanceStr = loadingBal
    ? 'Loading…'
    : balance !== undefined
      ? `${formatUnitsFixed(balance, 6, 6)} USDC`
      : '—'

  const operatorStr = loadingOp ? 'Loading…' : operator ? formatAddr(operator) : '—'
  const ownerStr = loadingOwner ? 'Loading…' : owner ? formatAddr(owner) : '—'
  const pausedVal = paused
  const pausedStr = loadingPaused ? 'Loading…' : pausedVal === true ? 'Paused' : pausedVal === false ? 'Active' : '—'

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--subtle)',
          marginBottom: 12,
        }}
      >
        Live Stats — refreshes every 15s
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 10,
        }}
      >
        <StatCard label="USDC Held" value={balanceStr} />
        <StatCard
          label="Payouts"
          value={pausedStr}
          success={pausedVal === false}
          danger={pausedVal === true}
        />
        <StatCard label="Operator" value={operatorStr} mono />
        <StatCard label="Owner" value={ownerStr} mono />
      </div>
    </div>
  )
}
