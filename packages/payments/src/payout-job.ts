/**
 * Odeme job'i — ADR-006, ADR-014, ADR-015, §8.
 *
 * Kivilcim 2'de kanitlanan tuzaklarin hepsi burada uygulaniyor. Her adimin
 * yanindaki yorum, o adim atlanirsa NE OLACAGINI soyluyor — cunku bunlarin
 * hepsi teoride degil, olcumle gorulmus davranislar.
 */

import { type Micros, micros, add, ZERO } from '@lull/protocol'
import type { Clock } from '@lull/protocol'
import type {
  PaymentRail, PayoutBatch, PayoutItem, SubmissionReceipt, SettlementResult,
} from './rail.js'
export type { PayoutItem } from './rail.js'
import type { WalletStore } from './wallet.js'

export interface PayoutCandidate {
  readonly publisherId: string
  readonly payable: Micros
}

export interface PayoutJobDeps {
  readonly clock: Clock
  readonly rail: PaymentRail
  readonly wallets: WalletStore
  /** Odenebilir bakiyesi esigi gecen publisher'lar. */
  readonly candidates: () => readonly PayoutCandidate[]
  readonly threshold: Micros
  /**
   * ADR-006 — batch boyutu.
   *
   * Kasa tek cagrida en fazla 64 alici oduyor; batch gaz tasarrufu saglar
   * ama kasa atomiktir: tek bozuk hedef tum batch'i geri alir. Buyuk batch,
   * kucuk kazanc icin en pahali ariza modunu satin alir — bu yuzden 6.
   */
  readonly batchSize?: number
  /** Ledger'a "yolda" kaydini yazar. Submit'ten ONCE cagrilir. */
  readonly onSubmit: (batchId: string, items: readonly PayoutItem[], receipt: SubmissionReceipt) => void
  /** Zincirde onaylandi. */
  readonly onSettled: (batchId: string, items: readonly PayoutItem[], txHash: string) => void
  /** Patladi — ters kayit yazilir, para publisher'a doner. */
  readonly onFailed: (batchId: string, items: readonly PayoutItem[], reason: string) => void
  /** Bir publisher batch'ten dusuruldu. Sebep kullaniciya gosterilir. */
  readonly onSkipped: (publisherId: string, reason: string) => void
  readonly newBatchId: () => string
  /** Operator cuzdaninda en az bu kadar gaz (wei, 18 ondalik USDC) kalmali (ADR-015). */
  readonly minGasReserve?: bigint
}

export interface PayoutRunResult {
  readonly batches: number
  readonly paid: number
  readonly skipped: number
  readonly failed: number
  readonly totalPaid: Micros
  readonly alerts: readonly string[]
}

export const DEFAULT_BATCH_SIZE = 6

/** 0.5 USDC (18 ondalik): Arc'ta yuzlerce odeme transaction'inin gazini karsilar. */
export const DEFAULT_MIN_GAS_RESERVE = 500_000_000_000_000_000n

export class PayoutJob {
  constructor(private readonly deps: PayoutJobDeps) {}

  async run(): Promise<PayoutRunResult> {
    const alerts: string[] = []
    let batches = 0, paid = 0, skipped = 0, failed = 0
    let totalPaid = ZERO

    const eligible = await this.#eligible(alerts, () => { skipped++ })
    if (eligible.length === 0) return { batches: 0, paid: 0, skipped, failed: 0, totalPaid, alerts }

    // Sicak cuzdan kontrolu — ADR-015 + §8 tuzak #11.
    const source = await this.deps.rail.sourceStatus()
    const needed = eligible.reduce((t, i) => add(t, i.amount), ZERO)
    if (source.usdcBalance < needed) {
      alerts.push(`sicak cuzdan USDC yetersiz: ${source.usdcBalance} < ${needed}`)
    }
    const minGas = this.deps.minGasReserve ?? DEFAULT_MIN_GAS_RESERVE
    if (source.availableGas < minGas) {
      // Kasa dolu ama gazi biten operator SESSIZCE durur ve USDC alarmi susar.
      alerts.push(`operator gazi yetersiz: ${source.availableGas} < ${minGas} wei — HICBIR odeme yapilamaz`)
      return { batches: 0, paid: 0, skipped, failed: 0, totalPaid, alerts }
    }

    const size = this.deps.batchSize ?? DEFAULT_BATCH_SIZE
    for (let i = 0; i < eligible.length; i += size) {
      const chunk = eligible.slice(i, i + size)
      const batchId = this.deps.newBatchId()
      const result = await this.#runBatch(batchId, chunk, alerts)
      batches++
      if (result.ok) { paid += chunk.length; totalPaid = add(totalPaid, result.amount) }
      else failed += chunk.length
    }

    return { batches, paid, skipped, failed, totalPaid, alerts }
  }

  /* ── uygun hedefleri sec ── */

  async #eligible(alerts: string[], onSkip: () => void): Promise<PayoutItem[]> {
    const candidates = this.deps.candidates().filter((c) => c.payable >= this.deps.threshold)
    const items: PayoutItem[] = []
    const addresses: string[] = []
    const pending: { c: PayoutCandidate; address: string }[] = []

    for (const c of candidates) {
      // ADR-014 — adres degisikligi beklemesindeki hesaplar odenmez.
      const block = this.deps.wallets.payoutBlock(c.publisherId)
      if (block.blocked) {
        this.deps.onSkipped(c.publisherId, block.reason)
        onSkip()
        continue
      }
      const w = this.deps.wallets.get(c.publisherId)!
      pending.push({ c, address: w.address })
      addresses.push(w.address)
    }

    if (addresses.length === 0) return []

    // §8 tuzak #1 — hedefler batch kurulmadan HEMEN once dogrulanir.
    // TOCTOU penceresi tamamen kapatilamaz ama daraltilir; kalan riski
    // kucuk batch boyutu tasir.
    const statuses = await this.deps.rail.validateDestinations(addresses)
    const byAddress = new Map(statuses.map((s) => [s.address, s]))

    for (const { c, address } of pending) {
      const s = byAddress.get(address)
      const reason = this.#rejectReason(s, c.payable)
      if (reason) {
        this.deps.onSkipped(c.publisherId, reason)
        onSkip()
        continue
      }
      items.push({ publisherId: c.publisherId, address, amount: c.payable })
    }

    return items
  }

  #rejectReason(s: ReturnType<Map<string, any>['get']>, _amount: Micros): string | null {
    if (!s) return 'hedef dogrulanamadi'
    if (!s.valid) return 'gecersiz adres bicimi'
    if (s.isToken) return 'adres bir token kontrati'
    if (s.isContract) return 'adres bir kontrat, cuzdan degil'
    // Engelli hedefe transfer TUM batch'i geri alir.
    if (s.blocked) return 'adres USDC ihraccisi tarafindan engellenmis'
    return null
  }

  /* ── tek batch ── */

  async #runBatch(
    batchId: string,
    items: readonly PayoutItem[],
    alerts: string[],
  ): Promise<{ ok: boolean; amount: Micros }> {
    const batch: PayoutBatch = { batchId, items }
    const amount = items.reduce((t, i) => add(t, i.amount), ZERO)

    // ── 1. Zarfi kur. Aga hicbir sey yazilmadi. ──
    let receipt: SubmissionReceipt
    try {
      receipt = await this.deps.rail.prepare(batch)
    } catch (e) {
      // Kurulum patladi ve HICBIR SEY gonderilmedi. Hicbir kayit yazmadan
      // cikmak guvenli: bir sonraki kosuda bastan denenir.
      alerts.push(`batch ${batchId} hazirlanamadi: ${e instanceof Error ? e.message : String(e)}`)
      return { ok: false, amount: ZERO }
    }

    // ── 2. Defteri ve kaydi YAZ. Gonderimden ONCE. ──
    //
    // Sira bilincli. Once gonderip sonra yazsaydik, arada dusen bir sunucu
    // parayi zincirde gonderilmis ama defterde hala odenebilir birakirdi —
    // ayni para ikinci kez odenirdi. Bu sirayla en kotu ihtimalle para
    // "yolda" asili kalir; hash elimizde oldugu icin sonradan zincire sorup
    // cozulebilir.
    this.deps.onSubmit(batchId, items, receipt)

    // ── 3. Gonder. ──
    try {
      await this.deps.rail.send(receipt)
    } catch (e) {
      // Buraya yalnizca ag ACIKCA reddettiginde dusuluyor; odeme kesin
      // yapilmadi. Yine de `reconcile` ile dogruluyoruz: "kesin" iddiasina
      // guvenip iade etmek, yanilirsak cifte odeme demek.
      alerts.push(`batch ${batchId} gonderilemedi: ${e instanceof Error ? e.message : String(e)}`)
    }

    const settlement = await this.#awaitSettlement(receipt, alerts)

    if (settlement.state === 'settled') {
      this.deps.onSettled(batchId, items, receipt.txHash)
      return { ok: true, amount }
    }

    if (settlement.state === 'failed') {
      // §8 tuzak #7 — ledger'a girdi, ucreti kesildi, AMA odeme olmadi.
      // Hangi hedefin patlattigini operation indeksinden buluyoruz.
      const culprits = settlement.opResults
        .filter((o) => o.code !== 'op_success')
        .map((o) => {
          const item = receipt.opIndex.find((x) => x.index === o.index)
          return `${item?.publisherId ?? `op${o.index}`}=${o.code}`
        })
      const reason = `tx basarisiz: ${culprits.join(', ')}`
      alerts.push(`batch ${batchId} ${reason}`)
      this.deps.onFailed(batchId, items, reason)
      return { ok: false, amount: ZERO }
    }

    // `expired`: nonce baska bir transaction'la harcandi, bu hicbir zaman
    // dahil edilmedi. Para publisher'a geri doner; bir sonraki kosuda yeniden
    // kurulur.
    if (settlement.state === 'expired') {
      this.deps.onFailed(batchId, items, 'transaction nonce\'u harcandi, dahil edilmedi')
      return { ok: false, amount: ZERO }
    }

    // `pending` — hala belirsiz. HICBIR SEY yazilmaz, "yolda" kaydi durur.
    // Bir sonraki kosu ayni transaction ile tekrar dener.
    alerts.push(`batch ${batchId} hala belirsiz — mutabakat sonraki kosuda`)
    return { ok: false, amount: ZERO }
  }

  /**
   * Mutabakat.
   *
   * "Zincirde yok" tek basina anlamsizdir: ya henuz dahil edilmedi, ya hic
   * edilmeyecek. Ayrim yapilmadan yeniden kurmak CIFT ODEME uretir (kasanin
   * batch korumasi bunu zincirde de yakalar, ama defter ona guvenmez). Kural:
   * transaction ancak nonce'u harcandiysa VE hala bulunamiyorsa oludur — bu karari rail verir
   * ve `expired` olarak doner.
   */
  async #awaitSettlement(receipt: SubmissionReceipt, alerts: string[]): Promise<SettlementResult> {
    let last = await this.deps.rail.reconcile(receipt)

    for (let attempt = 0; last.state === 'pending' && attempt < 3; attempt++) {
      // Ayni byte'lari tekrar gonder — ag seviyesinde idempotent (ayni imza).
      try { await this.deps.rail.send(receipt) } catch { /* zaten gonderilmis olabilir */ }
      last = await this.deps.rail.reconcile(receipt)
    }
    return last
  }
}
