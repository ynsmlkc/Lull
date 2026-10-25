import { useEffect, useRef, useState } from 'react'
import { createPublicClient, http, parseAbiItem, formatUnits } from 'viem'
import { ExternalLink, RefreshCw } from 'lucide-react'
import {
  VAULT_ADDRESS,
  USDC_ADDRESS,
  VAULT_DEPLOY_BLOCK,
  ARC_MAINNET_EXPLORER,
  ARC_MAINNET_RPC,
  USDC_DECIMALS_ERC20,
} from '../constants'

interface ActivityEvent {
  type: 'Paid' | 'BatchPaid' | 'Deposited' | 'Transfer'
  txHash: string
  blockNumber: bigint
  description: string
  amountUsdc?: string
}

const CHUNK = 10_000n

const vaultEventAbis = {
  Paid: parseAbiItem(
    'event Paid(bytes32 indexed batchId, address indexed to, uint256 amount)',
  ),
  BatchPaid: parseAbiItem(
    'event BatchPaid(bytes32 indexed batchId, uint256 count, uint256 total)',
  ),
  Deposited: parseAbiItem(
    'event Deposited(address indexed from, uint256 amount)',
  ),
}

const transferAbi = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

function formatUsdc6(raw: bigint) {
  return parseFloat(formatUnits(raw, USDC_DECIMALS_ERC20)).toFixed(2)
}

function shortHash(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-8)}`
}

const typeLabel: Record<ActivityEvent['type'], string> = {
  Paid: 'Paid',
  BatchPaid: 'Batch',
  Deposited: 'Deposit',
  Transfer: 'Transfer In',
}

const typeBg: Record<ActivityEvent['type'], string> = {
  Paid: 'rgba(172,198,233,0.15)',
  BatchPaid: 'rgba(172,198,233,0.10)',
  Deposited: 'rgba(141,216,159,0.15)',
  Transfer: 'rgba(141,216,159,0.12)',
}

const typeColor: Record<ActivityEvent['type'], string> = {
  Paid: '#acc6e9',
  BatchPaid: '#7bafd4',
  Deposited: '#8dd89f',
  Transfer: '#8dd89f',
}

export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState<string>('')
  const fetchedRef = useRef(false)

  async function fetchEvents() {
    if (fetchedRef.current) return
    fetchedRef.current = true
    setStatus('loading')
    setEvents([])

    const client = createPublicClient({
      transport: http(ARC_MAINNET_RPC),
    })

    try {
      const head = await client.getBlockNumber()
      const collected: ActivityEvent[] = []

      for (let from = VAULT_DEPLOY_BLOCK; from <= head; from += CHUNK) {
        const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
        setProgress(
          `Scanning blocks ${from.toLocaleString()} – ${to.toLocaleString()} / ${head.toLocaleString()}`,
        )

        // Vault: Paid
        const paidLogs = await client.getLogs({
          address: VAULT_ADDRESS,
          event: vaultEventAbis.Paid,
          fromBlock: from,
          toBlock: to,
        })
        for (const log of paidLogs) {
          if (!log.transactionHash) continue
          const amt = log.args.amount ?? 0n
          collected.push({
            type: 'Paid',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber ?? 0n,
            description: `Paid ${formatUsdc6(amt)} USDC to ${(log.args.to as string).slice(0, 8)}…`,
            amountUsdc: formatUsdc6(amt),
          })
        }

        // Vault: BatchPaid
        const batchLogs = await client.getLogs({
          address: VAULT_ADDRESS,
          event: vaultEventAbis.BatchPaid,
          fromBlock: from,
          toBlock: to,
        })
        for (const log of batchLogs) {
          if (!log.transactionHash) continue
          const total = log.args.total ?? 0n
          const count = log.args.count ?? 0n
          collected.push({
            type: 'BatchPaid',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber ?? 0n,
            description: `Batch of ${count.toString()} paid — ${formatUsdc6(total)} USDC total`,
            amountUsdc: formatUsdc6(total),
          })
        }

        // Vault: Deposited
        const depositLogs = await client.getLogs({
          address: VAULT_ADDRESS,
          event: vaultEventAbis.Deposited,
          fromBlock: from,
          toBlock: to,
        })
        for (const log of depositLogs) {
          if (!log.transactionHash) continue
          const amt = log.args.amount ?? 0n
          collected.push({
            type: 'Deposited',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber ?? 0n,
            description: `${formatUsdc6(amt)} USDC deposited by ${(log.args.from as string).slice(0, 8)}…`,
            amountUsdc: formatUsdc6(amt),
          })
        }

        // USDC Transfer events into the vault
        const transferLogs = await client.getLogs({
          address: USDC_ADDRESS,
          event: transferAbi,
          args: { to: VAULT_ADDRESS },
          fromBlock: from,
          toBlock: to,
        })
        for (const log of transferLogs) {
          if (!log.transactionHash) continue
          const val = log.args.value ?? 0n
          collected.push({
            type: 'Transfer',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber ?? 0n,
            description: `${formatUsdc6(val)} USDC transferred in from ${(log.args.from as string).slice(0, 8)}…`,
            amountUsdc: formatUsdc6(val),
          })
        }
      }

      // Deduplicate by txHash+type, sort newest first
      const seen = new Set<string>()
      const deduped = collected.filter((e) => {
        const key = `${e.txHash}-${e.type}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      deduped.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1))
      setEvents(deduped)
      setStatus('done')
      setProgress('')
    } catch (err) {
      console.error('ActivityFeed fetch error:', err)
      setStatus('error')
      setProgress('')
      fetchedRef.current = false
    }
  }

  useEffect(() => {
    void fetchEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function retry() {
    fetchedRef.current = false
    void fetchEvents()
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--subtle)',
          }}
        >
          Activity
        </div>
        {status !== 'loading' && (
          <button
            onClick={retry}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              padding: 0,
            }}
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        )}
      </div>

      {status === 'loading' && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 16,
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--subtle)', marginBottom: 8 }}>
            Scanning chain for events…
          </div>
          <div style={{ fontSize: 11, color: 'var(--subtle)', fontFamily: 'JetBrains Mono, monospace' }}>
            {progress}
          </div>
        </div>
      )}

      {status === 'error' && (
        <div
          style={{
            background: 'rgba(232,109,122,0.1)',
            border: '1px solid rgba(232,109,122,0.3)',
            borderRadius: 10,
            padding: 14,
            fontSize: 13,
            color: 'var(--danger)',
          }}
        >
          Failed to fetch events. Check your connection and try refreshing.
        </div>
      )}

      {status === 'done' && events.length === 0 && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 16,
            fontSize: 13,
            color: 'var(--subtle)',
          }}
        >
          No events found since deployment block.
        </div>
      )}

      {events.length > 0 && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {events.map((ev, i) => (
            <div
              key={`${ev.txHash}-${ev.type}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '11px 14px',
                borderBottom:
                  i < events.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  background: typeBg[ev.type],
                  color: typeColor[ev.type],
                  borderRadius: 5,
                  padding: '2px 7px',
                  whiteSpace: 'nowrap',
                }}
              >
                {typeLabel[ev.type]}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: 'var(--ink-2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {ev.description}
              </span>
              <a
                href={`${ARC_MAINNET_EXPLORER}/tx/${ev.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                title={ev.txHash}
                style={{
                  flexShrink: 0,
                  color: 'var(--subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  fontSize: 11,
                  textDecoration: 'none',
                }}
              >
                <span className="mono" style={{ fontSize: 10 }}>
                  {shortHash(ev.txHash)}
                </span>
                <ExternalLink size={10} />
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
