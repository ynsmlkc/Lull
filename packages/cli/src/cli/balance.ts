/**
 * `lull balance` — kullanicinin parasini gosterir.
 *
 * Uc ayri sayi var ve UCU DE gosterilmek zorunda:
 *
 *   bekleyen    gosterim sayildi ama henuz dogrulanmadi. Ledger'da YOK,
 *               cunku dogrulanana kadar para degil. Kaybolabilir.
 *   odenebilir  dogrulandi, defterde duruyor. Bu para kullanicinin.
 *   yolda       zincire gonderildi, onay bekleniyor.
 *
 * Tek bir "bakiye" gostermek bunlari birlestirmek olurdu ve kullanici
 * "dun 5 dolarim vardi, bugun 3" dediginde hicbir aciklama olmazdi.
 *
 * Odeme neden yapilmadigi da HER ZAMAN yazilir (§6.5). "Bekle" demek yeterli
 * degil — neyin beklendigi soylenmeli, yoksa kullanici sistemin bozuk
 * oldugunu dusunur ve haklidir.
 */

import { loadCredentials } from '../credentials.js'
import { out, ok, info, fail, dim, bold, green, yellow, usdc, banner, rows } from './output.js'

export interface BalanceResponse {
  readonly pendingMicros: string
  readonly payableMicros: string
  readonly inFlightMicros: string
  readonly lifetimeMicros: string
  readonly payoutThresholdMicros: string
  readonly recentPayouts: readonly {
    readonly txHash: string
    readonly amountMicros: string
    readonly at: number
    readonly state: string
  }[]
  readonly blockedReason: string | null
}

// Varsayilan testnet; `LULL_NETWORK=mainnet` ile ana agin linkleri uretilir.
const explorerTx = (hash: string): string =>
  `${process.env['LULL_NETWORK'] === 'mainnet' ? 'https://explorer.arc.io' : 'https://explorer.testnet.arc.io'}/tx/${hash}`

export async function cmdBalance(
  argv: readonly string[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const creds = loadCredentials()
  if (!creds) fail('LUL-2001', 'Not logged in', '`lull login` to connect your wallet')

  let res: Response
  try {
    res = await fetchImpl(`${creds.serverUrl}/v1/me/balance`, {
      headers: { authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    // Ag hatasi bir SORU degil, bir DURUM. Kullaniciya ne yapacagini soyle.
    fail('LUL-3001', 'Could not reach the server', e instanceof Error ? e.message : String(e))
  }

  if (res.status === 401) {
    fail('LUL-2002', 'Token is invalid', '`lull login --force` to reconnect')
  }
  if (!res.ok) fail('LUL-3001', `Server error (HTTP ${res.status})`)

  const b = (await res.json()) as BalanceResponse
  render(b, creds.publisherId, argv.includes('--json') ? JSON.stringify(b) : null)
}

function render(b: BalanceResponse, address: string, jsonOut: string | null): void {
  if (jsonOut !== null) { out(jsonOut); return }

  const pending = BigInt(b.pendingMicros)
  const payable = BigInt(b.payableMicros)
  const inFlight = BigInt(b.inFlightMicros)
  const threshold = BigInt(b.payoutThresholdMicros)

  banner()
  rows([
    ['payable', `${bold(green(usdc(payable)))}`],
    ['pending', `${usdc(pending)} ${dim('· awaiting verification')}`],
    ...(inFlight > 0n
      ? [['in flight', `${usdc(inFlight)} ${dim('· awaiting on-chain confirmation')}`] as const]
      : []),
    ['lifetime earnings', dim(usdc(b.lifetimeMicros))],
  ])

  out()
  out(`  ${dim('wallet')}  ${address}`)
  out()

  /* ── odeme ne zaman ── */

  if (payable >= threshold) {
    ok(`ready to withdraw — any amount, anytime, from the dashboard`)
  } else if (b.blockedReason) {
    // Esik 1 micro: buraya ancak bakiye sifirken dusulur.
    info(dim('nothing to withdraw yet — waiting for the first verified impression'))
    // Sunucunun kendi gerekcesi farkliysa onu da goster — esik disinda bir
    // sebep olabilir (cuzdan bekleme suresi, dondurulmus USDC hesabi).
    if (!/threshold/i.test(b.blockedReason)) info(dim(b.blockedReason))
  } else {
    info(dim('payout pending'))
  }

  /* ── gecmis ── */

  if (b.recentPayouts.length > 0) {
    out()
    out(`  ${dim('recent payouts')}`)
    for (const p of b.recentPayouts.slice(0, 5)) {
      const isaret = p.state === 'settled' ? green('✓') : yellow('·')
      const tarih = new Date(p.at).toLocaleDateString()
      // OSC 8: destekleyen terminalde tiklanabilir, desteklemeyende duz metin.
      // Ikisi de calisir; link'i gizlemek yerine ikisini de veriyoruz.
      out(`  ${isaret} ${usdc(p.amountMicros).padEnd(10)} ${dim(tarih)}  ${dim(link(p.txHash))}`)
    }
  }

  out()
}

/** Terminal destekliyorsa tiklanabilir link, degilse kisa hash. */
export function link(txHash: string, isTty = process.stdout.isTTY === true): string {
  const kisa = `${txHash.slice(0, 8)}\u2026`
  if (!isTty) return kisa               // boruya yazarken kacis dizisi yollamayiz

  // OSC 8. Desteklemeyen terminaller diziyi yutar, yalnizca metni basar;
  // destekleyende tiklanabilir olur. Sonlandirici olarak `\u0007` (BEL)
  // kullaniliyor: ST (`ESC \\`) eski terminallerde daha kotu bozuluyor.
  const url = explorerTx(txHash)
  return `\u001b]8;;${url}\u0007${kisa}\u001b]8;;\u0007`
}
