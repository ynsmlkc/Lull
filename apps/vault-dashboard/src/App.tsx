import { ExternalLink } from 'lucide-react'
import { VaultStats } from './components/VaultStats'
import { ActivityFeed } from './components/ActivityFeed'
import { FundVault } from './components/FundVault'
import { VAULT_ADDRESS, ARC_MAINNET_EXPLORER } from './constants'

export default function App() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: 'var(--bg-gradient)',
        color: 'var(--ink)',
      }}
    >
      {/* Header */}
      <header
        style={{
          borderBottom: '1px solid var(--border)',
          padding: '0 20px',
        }}
      >
        <div
          style={{
            maxWidth: 640,
            margin: '0 auto',
            padding: '18px 0',
            display: 'flex',
            alignItems: 'flex-start',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div className="display" style={{ fontSize: 26, fontWeight: 700, color: 'var(--ink)' }}>
            Lull Vault
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: 'var(--muted)',
              lineHeight: 1.5,
            }}
          >
            Ads for AI coding tools, paid in USDC on Arc.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
            <a
              href="https://lullserver-production.up.railway.app"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--accent)',
                fontSize: 12,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              lullserver app <ExternalLink size={11} />
            </a>
            <a
              href="https://github.com/ynsmlkc/Lull"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--accent)',
                fontSize: 12,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              GitHub <ExternalLink size={11} />
            </a>
            <a
              href={`${ARC_MAINNET_EXPLORER}/address/${VAULT_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--subtle)',
                fontSize: 11,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span className="mono">{VAULT_ADDRESS.slice(0, 10)}…</span>
              <ExternalLink size={10} />
            </a>
          </div>
        </div>
      </header>

      {/* Main */}
      <main
        style={{
          maxWidth: 640,
          margin: '0 auto',
          padding: '24px 20px 48px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        {/* Vault stats */}
        <VaultStats />

        {/* Fund the vault */}
        <FundVault />

        {/* Activity feed */}
        <ActivityFeed />
      </main>
    </div>
  )
}
