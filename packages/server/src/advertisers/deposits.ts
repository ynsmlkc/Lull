/**
 * Reklamveren para yatirma — ADR-021.
 *
 * Problem: hazinemize USDC geliyor, BU PARA KIMIN?
 *
 * Klasik cozum memo'dur ve kotudur: kullanici yazmayi unutur, para sahipsiz
 * kalir, elle destek gerekir. Ikinci klasik cozum reklamveren basina ayri
 * adrestir; temiz ama hepsini yonetmek gerekir.
 *
 * Bizim cozumumuz daha basit: reklamveren de CUZDANIYLA giris yapiyor
 * (ADR-010). O zaman GONDEREN ADRESE bakariz — `ADV`'den gelen para `ADV`'nin
 * hesabina yazilir. Eslesme kendiliginden oluyor, memo yok.
 *
 * Bedeli: borsadan gonderen para eslesmez, cunku gonderen adres borsanindir.
 * Panelde acikca yaziyor. Testnet icin sorun degil; mainnet'te bu paralar
 * "eslesmeyen yatirma" olarak birikir ve elle cozulur.
 */

import type { Clock } from '@linger/protocol'
import { micros, type Micros } from '@linger/protocol'
import type { DepositSource } from '@linger/payments'
import type { Ledger } from '../ledger/ledger.js'

export interface DepositWatcherDeps {
  readonly clock: Clock
  readonly ledger: Ledger
  /** Zincirden gelen girisleri okur (Arc RPC ya da test sahtesi). */
  readonly source: DepositSource
  /** Bu adres bir reklamverene ait mi? Degilse para bekletilir. */
  readonly isKnownAdvertiser: (address: string) => boolean
  readonly log: (m: string) => void
  /** Nereden devam edilecegi. Yeniden baslatmada kaldigi yerden. */
  readonly cursor: {
    readonly get: () => string | null
    readonly set: (c: string) => void
  }
}

export interface DepositResult {
  readonly credited: number
  readonly unmatched: number
  readonly total: Micros
}

export class DepositWatcher {
  #running = false

  constructor(private readonly deps: DepositWatcherDeps) {}

  /**
   * Zinciri tarar ve yeni girisleri deftere yazar.
   *
   * Cursor bir ISLEM IMZASIDIR: son islenenden sonrasini istiyoruz. Zaman
   * damgasina gore ilerlemek YANLIS olurdu — ayni saniyede birden fazla
   * yatirma olabilir.
   */
  async poll(): Promise<DepositResult> {
    if (this.#running) return { credited: 0, unmatched: 0, total: micros(0n) }
    this.#running = true
    try {
      return await this.#poll()
    } finally {
      this.#running = false
    }
  }

  async #poll(): Promise<DepositResult> {
    let batch
    try {
      batch = await this.deps.source.incoming(this.deps.cursor.get())
    } catch (e) {
      // Ag hatasi SESSIZ gecilmez ama akisi durdurmaz: bir sonraki turda
      // ayni cursor'dan devam edilir, hicbir yatirma atlanmaz.
      this.deps.log(`yatirma taramasi basarisiz: ${e instanceof Error ? e.message : String(e)}`)
      return { credited: 0, unmatched: 0, total: micros(0n) }
    }

    let credited = 0, unmatched = 0
    let toplam = 0n

    for (const t of batch.transfers) {
      if (t.amount <= 0n) continue

      if (t.from === null || !this.deps.isKnownAdvertiser(t.from)) {
        // Taninmayan ya da belirsiz gonderen. Para duruyor, kaybolmadi — ama
        // kimin oldugunu bilmedigimiz icin deftere yazamiyoruz. Cursor
        // ilerledigi icin bir daha bakilmayacak; elle cozulmesi gerekiyor.
        unmatched++
        const who = t.from ? `${t.from.slice(0, 8)}…${t.from.slice(-4)}` : 'belirsiz gonderen'
        this.deps.log(`⚠ eslesmeyen yatirma: ${micros(t.amount)} micro-USDC ${who} tx ${t.signature.slice(0, 12)}…`)
        continue
      }

      // Idempotency: `topupId` islem imzasi. Ayni yatirma iki kez taranirsa
      // defter ikincisini reddeder (ADR-005).
      const topupId = `chain:${t.signature}`
      try {
        this.deps.ledger.deposit({ advertiserId: t.from, amount: micros(t.amount), topupId })
        credited++
        toplam += t.amount
        this.deps.log(`yatirma: ${t.amount} micro-USDC → ${t.from.slice(0, 8)}…`)
      } catch (e) {
        this.deps.log(`yatirma yazilamadi (${topupId}): ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Cursor EN SONDA ilerletilir. Once ilerletseydik ve arada patlasaydik,
    // islenmemis yatirmalar atlanirdi.
    if (batch.newCursor) this.deps.cursor.set(batch.newCursor)

    return { credited, unmatched, total: micros(toplam) }
  }
}

/** Cursor'u diskte tutar — yeniden baslatmada bastan taramamak icin. */
export function sqliteCursor(db: import('../store/db.js').Db, key = 'deposit_cursor') {
  return {
    get: (): string | null => {
      const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any
      return r ? String(r.value) : null
    },
    set: (c: string): void => {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, c)
    },
  }
}
