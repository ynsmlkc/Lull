import { useState, useCallback } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { parseUnits } from 'viem'
import { ExternalLink, Wallet, AlertTriangle } from 'lucide-react'
import {
  VAULT_ADDRESS,
  USDC_ADDRESS,
  ERC20_MINIMAL_ABI,
  ARC_MAINNET_ID,
  ARC_MAINNET_EXPLORER,
  USDC_DECIMALS_ERC20,
} from '../constants'

function parseOnchainError(error: unknown): string {
  const msg = (error as { message?: string })?.message?.toLowerCase() ?? ''
  if (msg.includes('user rejected') || (error as { code?: number })?.code === 4001) {
    return 'Transaction cancelled.'
  }
  if (msg.includes('insufficient') || msg.includes('exceeds balance')) {
    return 'Insufficient USDC balance.'
  }
  if (msg.includes('reverted')) {
    const m = msg.match(/reason="([^"]+)"/)
    return m ? `Transaction failed: ${m[1]}` : 'Transaction failed. Please try again.'
  }
  return 'Something went wrong. Please try again.'
}

const QUICK_AMOUNTS = ['1', '5', '10', '25', '50']

export function FundVault() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [amount, setAmount] = useState('')

  const {
    writeContract: transfer,
    data: txHash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract()

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  const isWrongChain = isConnected && chainId !== ARC_MAINNET_ID

  const handleFund = useCallback(() => {
    if (!amount || parseFloat(amount) <= 0) return
    if (isWrongChain) {
      switchChain({ chainId: ARC_MAINNET_ID })
      return
    }
    let parsed: bigint
    try {
      parsed = parseUnits(amount, USDC_DECIMALS_ERC20)
    } catch {
      return
    }
    if (parsed === 0n) return
    transfer({
      address: USDC_ADDRESS,
      abi: ERC20_MINIMAL_ABI,
      functionName: 'transfer',
      args: [VAULT_ADDRESS, parsed],
      chainId: ARC_MAINNET_ID,
    })
  }, [amount, isWrongChain, transfer, switchChain])

  const canSend =
    isConnected &&
    !isWrongChain &&
    amount.length > 0 &&
    parseFloat(amount) > 0 &&
    !isPending &&
    !isConfirming

  return (
    <div
      style={{
        background: 'var(--surface-strong)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '20px 18px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--subtle)',
          marginBottom: 14,
        }}
      >
        Fund the Vault
      </div>

      {!isConnected ? (
        <div>
          <p
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              marginBottom: 14,
              lineHeight: 1.5,
            }}
          >
            Connect a wallet to send USDC directly to the Lull Vault. Deposits are
            credited to your Lull advertiser account — send from the same wallet you
            use to sign in at{' '}
            <a
              href="https://lullserver-production.up.railway.app/advertisers/app"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
            >
              lullserver
            </a>
            .
          </p>
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button
                onClick={show}
                style={{
                  width: '100%',
                  padding: '12px 0',
                  background: 'var(--accent)',
                  color: '#0d1b2f',
                  border: 'none',
                  borderRadius: 10,
                  fontFamily: 'DM Sans, sans-serif',
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Wallet size={16} />
                Connect Wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        </div>
      ) : (
        <div>
          {isWrongChain && (
            <div
              style={{
                background: 'rgba(232,109,122,0.1)',
                border: '1px solid rgba(232,109,122,0.3)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--danger)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
              }}
            >
              <AlertTriangle size={13} />
              <span>Please switch to Arc mainnet to send USDC.</span>
            </div>
          )}

          <div
            style={{
              fontSize: 11,
              color: 'var(--subtle)',
              marginBottom: 8,
            }}
          >
            From: <span className="mono" style={{ fontSize: 11 }}>{address?.slice(0, 8)}…{address?.slice(-6)}</span>
          </div>

          {/* Amount input */}
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => { reset(); setAmount(e.target.value) }}
              style={{
                flex: 1,
                background: 'none',
                border: 'none',
                outline: 'none',
                color: 'var(--ink)',
                fontFamily: 'Space Grotesk, sans-serif',
                fontSize: 20,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                width: 0,
              }}
            />
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--subtle)',
                flexShrink: 0,
              }}
            >
              USDC
            </span>
          </div>

          {/* Quick amounts */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {QUICK_AMOUNTS.map((q) => (
              <button
                key={q}
                onClick={() => { reset(); setAmount(q) }}
                style={{
                  background: amount === q ? 'var(--accent)' : 'var(--surface)',
                  color: amount === q ? '#0d1b2f' : 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'DM Sans, sans-serif',
                }}
              >
                ${q}
              </button>
            ))}
          </div>

          {/* CTA */}
          {isWrongChain ? (
            <button
              onClick={() => switchChain({ chainId: ARC_MAINNET_ID })}
              disabled={isSwitching}
              style={{
                width: '100%',
                padding: '12px 0',
                background: 'var(--danger)',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontFamily: 'DM Sans, sans-serif',
                fontWeight: 700,
                fontSize: 14,
                cursor: isSwitching ? 'not-allowed' : 'pointer',
                opacity: isSwitching ? 0.6 : 1,
              }}
            >
              {isSwitching ? 'Switching…' : 'Switch to Arc Mainnet'}
            </button>
          ) : (
            <button
              onClick={handleFund}
              disabled={!canSend}
              style={{
                width: '100%',
                padding: '12px 0',
                background: canSend ? 'var(--accent)' : 'var(--surface-muted)',
                color: canSend ? '#0d1b2f' : 'var(--subtle)',
                border: 'none',
                borderRadius: 10,
                fontFamily: 'DM Sans, sans-serif',
                fontWeight: 700,
                fontSize: 14,
                cursor: canSend ? 'pointer' : 'not-allowed',
              }}
            >
              {isPending
                ? 'Confirm in wallet…'
                : isConfirming
                  ? 'Confirming…'
                  : `Send ${amount || '0'} USDC`}
            </button>
          )}

          {/* Success state */}
          {isSuccess && txHash && (
            <div
              style={{
                marginTop: 12,
                background: 'rgba(141,216,159,0.1)',
                border: '1px solid rgba(141,216,159,0.3)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--success)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Sent successfully</div>
              <a
                href={`${ARC_MAINNET_EXPLORER}/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: 'var(--success)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  textDecoration: 'none',
                }}
              >
                <span className="mono" style={{ fontSize: 11 }}>{txHash.slice(0, 12)}…{txHash.slice(-8)}</span>
                <ExternalLink size={11} />
              </a>
            </div>
          )}

          {/* Error state */}
          {writeError && (
            <div
              style={{
                marginTop: 12,
                background: 'rgba(232,109,122,0.1)',
                border: '1px solid rgba(232,109,122,0.3)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--danger)',
              }}
            >
              {parseOnchainError(writeError)}
            </div>
          )}

          {/* Info note */}
          {!isSuccess && (
            <p
              style={{
                marginTop: 12,
                fontSize: 11,
                color: 'var(--subtle)',
                lineHeight: 1.5,
                marginBottom: 0,
              }}
            >
              Deposits are credited to your Lull advertiser account. Send from the
              wallet you sign in with at{' '}
              <a
                href="https://lullserver-production.up.railway.app/advertisers/app"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'none' }}
              >
                lullserver-production.up.railway.app/advertisers/app
              </a>
              .
            </p>
          )}
        </div>
      )}
    </div>
  )
}
