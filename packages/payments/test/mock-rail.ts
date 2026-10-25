/**
 * Mock odeme rayi — §11 test stratejisi.
 *
 * `payments` HER ZAMAN bunun uzerinde birim test edilir; testnet yalnizca
 * ayri bir entegrasyon suite'inde. Sebebi: Kivilcim 2'de gordugumuz ariza
 * modlarini (adres engelli, tx failed ama zincirde, nonce harcanmis) istedigimiz
 * anda ve deterministik olarak uretebilmek.
 */

import { type Micros, micros, ZERO } from '@linger/protocol'
import type {
  PaymentRail, PayoutBatch, SubmissionReceipt, SettlementResult,
  DestinationStatus, SourceAccountStatus,
} from '../src/rail.js'

export interface MockRailOptions {
  /** Adres → durum. Tanimsiz adres saglikli bir cuzdan sayilir (ATA yok, olusturulur). */
  destinations?: Record<string, Partial<DestinationStatus>>
  usdcBalance?: bigint
  availableGas?: bigint
  /** Bu adres batch'te varsa transaction TAMAMEN patlar (§8 tuzak #1). */
  failingAddress?: string
  /** Transaction KURULURKEN patlasin — hicbir sey gonderilmez. */
  throwOnPrepare?: boolean
  /** GONDERIM patlasin — transaction kurulmus, defter yazilmis olur. */
  throwOnSend?: boolean
  /** Mutabakat kac kez `pending` donsun. */
  pendingRounds?: number
  /** Hicbir zaman dahil edilmesin ve nonce HARCANMASIN — belirsiz kalir. */
  neverIncluded?: boolean
  /** Hicbir zaman dahil edilmesin ve nonce HARCANSIN — olu transaction. */
  neverIncludedAndExpired?: boolean
}

export class MockRail implements PaymentRail {
  #height = 250_000_000
  #seq = 1
  readonly submitted: SubmissionReceipt[] = []
  readonly resubmits: string[] = []
  /** Kurulmus transaction'lar — gonderilmis olanlar `submitted`'da. */
  readonly prepared: SubmissionReceipt[] = []
  #pendingLeft: number

  constructor(private readonly opts: MockRailOptions = {}) {
    this.#pendingLeft = opts.pendingRounds ?? 0
  }

  async validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]> {
    return addresses.map((address) => {
      const o = this.opts.destinations?.[address]
      return {
        address,
        valid: o?.valid ?? true,
        isContract: o?.isContract ?? false,
        isToken: o?.isToken ?? false,
        blocked: o?.blocked ?? false,
      }
    })
  }

  async sourceStatus(): Promise<SourceAccountStatus> {
    return {
      address: 'SourceWallet1111111111111111111111111111111',
      usdcBalance: micros(this.opts.usdcBalance ?? 1_000_000_000_000n),
      availableGas: this.opts.availableGas ?? 10n ** 18n,
    }
  }

  async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (this.opts.throwOnPrepare) throw new Error('zarf kurulamadi')

    const receipt: SubmissionReceipt = {
      batchId: batch.batchId,
      // Kivilcim 2: hash submit'ten ONCE bilinir.
      txHash: `hash-${batch.batchId}`,
      serializedTx: `tx-${batch.batchId}`,
      validityRef: `nonce:${this.#seq++}`,
      validUntil: this.#height + 150,
      feeBid: BigInt(batch.items.length) * 1000n,
      opIndex: batch.items.map((it, index) => ({ publisherId: it.publisherId, index })),
    }
    this.prepared.push(receipt)
    return receipt
  }

  async send(receipt: SubmissionReceipt): Promise<void> {
    if (this.opts.throwOnSend) throw new Error('ag reddetti')
    this.submitted.push(receipt)
    this.resubmits.push(receipt.serializedTx)
  }

  async reconcile(receipt: SubmissionReceipt): Promise<SettlementResult> {
    if (this.opts.neverIncludedAndExpired) {
      return { state: 'expired', txHash: receipt.txHash, slot: null, feeCharged: null, opResults: [] }
    }
    if (this.opts.neverIncluded) {
      return { state: 'pending', txHash: receipt.txHash, slot: null, feeCharged: null, opResults: [] }
    }
    if (this.#pendingLeft > 0) {
      this.#pendingLeft--
      return { state: 'pending', txHash: receipt.txHash, slot: null, feeCharged: null, opResults: [] }
    }

    const bad = this.opts.failingAddress
    const failingIndex = bad
      ? receipt.opIndex.findIndex((o) => this.#addressOf(o.publisherId) === bad)
      : -1

    if (failingIndex >= 0) {
      // §8 tuzak #7 — zincire GIRDI, ucret KESILDI, ama odeme olmadi.
      return {
        state: 'failed',
        txHash: receipt.txHash,
        slot: 310_000_001,
        feeCharged: receipt.feeBid,
        opResults: [{ index: receipt.opIndex[failingIndex]!.index, code: 'custom:3' }],
      }
    }

    return {
      state: 'settled',
      txHash: receipt.txHash,
      slot: 310_000_002,
      feeCharged: receipt.feeBid,
      opResults: [],
    }
  }

  /** Test kolayligi: publisherId ile adres eslesmesi disaridan verilir. */
  addressMap: Record<string, string> = {}
  #addressOf(publisherId: string): string { return this.addressMap[publisherId] ?? '' }
}
