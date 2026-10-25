#!/usr/bin/env node
/**
 * Para dongusunun duman testi — gercek bir sunucuya ve gercek bir zincire karsi.
 *
 * Bir reklamveren cuzdaniyla:
 *   1. imzayla giris yapar (SIWE mantigi, `personal_sign`)
 *   2. kasaya USDC gonderir — tek ERC-20 `transfer`
 *   3. sunucunun yatirmayi zincirden okuyup deftere yazmasini bekler
 *   4. bir kampanya acar
 *   5. harcanmamis butcenin bir kismini geri ceker — para KASADAN, tek bir
 *      `payout` cagrisiyla cuzdana doner
 *   6. iki transfer de zincirde gorunuyor mu diye bakar
 *
 * Testnet'te ya da kucuk tutarlarla mainnet'te calistirilir:
 *
 *   ADVERTISER_KEY=0x… LULL_SERVER=https://… node scripts/arc-smoke.mjs 1.00
 *
 * Anahtar yalnizca bu surecte, imza icin kullanilir; hicbir yere gonderilmez.
 */

import { createPublicClient, createWalletClient, http, parseAbi, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const API = (process.env.LULL_SERVER ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const KEY = process.env.ADVERTISER_KEY
if (!KEY) { console.error('ADVERTISER_KEY gerekli (0x… 32 bayt hex)'); process.exit(2) }

const amountText = process.argv[2] ?? '1.00'
const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amountText)
if (!m) { console.error(`tutar gecersiz: ${amountText}`); process.exit(2) }
const AMOUNT = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))

const ERC20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

const acct = privateKeyToAccount(KEY)
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)}  ${s}`)

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'x-lull-client-version': '0.1.0',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(j)}`)
  return j
}

const health = await call('/health')
if (!health.vault) throw new Error('sunucuda odeme kapali (kasa yok)')
const rpc = process.env.LULL_RPC ?? (health.network === 'mainnet' ? 'https://rpc.mainnet.arc.io' : 'https://rpc.testnet.arc.io')
const chain = {
  id: health.chainId, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
}
const pub = createPublicClient({ chain, transport: http(rpc) })
const wal = createWalletClient({ account: acct, chain, transport: http(rpc) })
const usdc = getAddress(health.usdcToken)
const vault = getAddress(health.vault)
const bal = () => pub.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [acct.address] })

say(`sunucu ${API} · arc ${health.network} (${health.chainId}) · kasa ${vault}`)
say(`reklamveren ${acct.address} · USDC ${Number(await bal()) / 1e6}`)

// 1. giris
const ch = await call('/v1/auth/challenge', { method: 'POST', body: { address: acct.address } })
const signature = await acct.signMessage({ message: ch.message })
const { token } = await call('/v1/auth/verify', {
  method: 'POST', body: { address: acct.address, message: ch.message, signature, role: 'advertiser' },
})
say('✓ giris (imza dogrulandi, islem degil)')

const before = BigInt((await call('/v1/advertiser/me', { token })).balanceMicros)

// 2. yatirma
const depHash = await wal.writeContract({ address: usdc, abi: ERC20, functionName: 'transfer', args: [vault, AMOUNT] })
const depRcpt = await pub.waitForTransactionReceipt({ hash: depHash })
if (depRcpt.status !== 'success') throw new Error(`yatirma geri alindi: ${depHash}`)
say(`✓ yatirma ${amountText} USDC · tx ${depHash}`)

// 3. deftere yazilmasini bekle
let me
for (let i = 0; ; i++) {
  me = await call('/v1/advertiser/me', { token })
  if (BigInt(me.balanceMicros) >= before + AMOUNT) break
  if (i > 40) throw new Error('yatirma 2 dakikada deftere yazilmadi')
  await new Promise((r) => setTimeout(r, 3000))
}
say(`✓ defterde · bakiye ${Number(me.balanceMicros) / 1e6} USDC`)

// 4. kampanya
const camp = await call('/v1/advertiser/campaigns', {
  method: 'POST', token,
  body: { brand: 'Lull', text: 'Ads for AI coding tools, paid in USDC on Arc', cta: 'lull.sh', bidCpmMicros: '2000000' },
})
say(`✓ kampanya ${camp.id ?? ''}`)

// 5. geri cekim — butcenin yarisi
const back = AMOUNT / 2n
const w = await call('/v1/advertiser/withdraw', { method: 'POST', token, body: { amountMicros: back.toString() } })
say(`✓ geri cekim ${Number(back) / 1e6} USDC · tx ${w.txHash}`)

// 6. zincirde dogrula
const outRcpt = await pub.waitForTransactionReceipt({ hash: w.txHash })
if (outRcpt.status !== 'success') throw new Error(`geri cekim geri alindi: ${w.txHash}`)
if (getAddress(outRcpt.to) !== vault) throw new Error('geri cekim kasadan cikmadi')
say(`✓ zincirde · kasa → ${acct.address} · USDC ${Number(await bal()) / 1e6}`)
