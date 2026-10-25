/**
 * Ortam degiskenleri — uretimde EKSIK OLANA VARSAYILAN YOK.
 *
 * Denetimde bulundu: `.env.railway` `LULL_PENDING_MS` icermiyordu ve kod
 * gelistirme varsayilanina (30 saniye) dusuyordu. Tasarimin dayandigi
 * 24 saatlik dogrulama penceresi (§9 katman 2) uretimde hic calismiyordu —
 * kimse fark etmeden. Para yolunu etkileyen bir ayar eksikse sunucu
 * ACILMAMALI; sessizce gevsek bir degerle calismak, hic calismamaktan kotu.
 */

import { semverSchema } from '@lull/protocol'

type Env = Readonly<Record<string, string | undefined>>

const DAY_MS = 86_400_000

export interface ServerEnv {
  readonly isProd: boolean
  /** Gosterimin dogrulanmadan once bekledigi sure. */
  readonly pendingMs: number
  /** ADR-016 — bunun altindaki istemciler reddedilir. */
  readonly minClientVersion: string
  readonly ipSalt: string
}

/**
 * Uretimde eksik ya da gecersiz olan her sey icin bir satir doner.
 * Bos dizi = acilabilir.
 */
export function prodProblems(env: Env): string[] {
  if (env['LULL_ENV'] !== 'production') return []
  const out: string[] = []

  for (const k of ['LULL_DB', 'LULL_HOME_DOMAIN', 'LULL_IP_SALT'] as const) {
    if (!env[k]) out.push(`${k} tanimli degil`)
  }

  // Acikca verilmisse bile mainnet'te alt sinir var: birkac saniyelik pencere,
  // anomali kontrolunun para cikmadan once calismasini anlamsiz kilar.
  // Testnet'te para gercek degil; demo icin pencere kisaltilabilir (0 dahil).
  const pending = env['LULL_PENDING_MS']
  const mainnet = env['LULL_NETWORK'] === 'mainnet'
  if (pending !== undefined && !(Number(pending) >= (mainnet ? 3600_000 : 0))) {
    out.push(mainnet
      ? `LULL_PENDING_MS mainnet'te en az 1 saat olmali (verilen: ${pending})`
      : `LULL_PENDING_MS gecerli bir sure degil (verilen: ${pending})`)
  }

  const min = env['LULL_MIN_CLIENT_VERSION']
  if (min !== undefined && !semverSchema.safeParse(min).success) {
    out.push(`LULL_MIN_CLIENT_VERSION gecerli bir surum degil: ${min}`)
  }

  return out
}

export function readServerEnv(env: Env): ServerEnv {
  const problems = prodProblems(env)
  if (problems.length > 0) {
    throw new Error(`uretim ayarlari eksik — sunucu acilmiyor:\n  • ${problems.join('\n  • ')}`)
  }
  const isProd = env['LULL_ENV'] === 'production'

  return {
    isProd,
    // Uretimde varsayilan 24 saat; gelistirmede 30 saniye (24 saat beklemek
    // gelistirmeyi imkansiz kilar).
    pendingMs: Number(env['LULL_PENDING_MS'] ?? (isProd ? DAY_MS : 30_000)),
    minClientVersion: env['LULL_MIN_CLIENT_VERSION'] ?? '0.0.0',
    ipSalt: env['LULL_IP_SALT'] ?? 'dev-salt-degistir',
  }
}
