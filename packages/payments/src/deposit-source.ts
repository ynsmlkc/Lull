/**
 * Reklamveren yatirma kaynagi — ADR-021.
 *
 * Arc'ta "bu odemeyi kim yapti?" sorusunun cevabi USDC'nin `Transfer`
 * olayinda: `to` kasamiz, `from` gonderen cuzdan. Memo gerekmez —
 * reklamveren de cuzdaniyla giris yaptigi icin gonderen adres hesabin
 * kimligiyle birebir ayni (ADR-010).
 *
 * Hem kasaya dogrudan `transfer` hem de kasanin `deposit` fonksiyonu
 * (`transferFrom`) ayni olayi uretir; ikisi de yakalanir. Bir kontrat
 * araciligiyla gelen para (orn. bir borsa ya da kopru) `from` olarak o
 * kontrati gosterir: taninmayan gonderen olarak bekletilir, kaybolmaz.
 *
 * Kesinlik: Arc'in uzlasmasi deterministik (BFT) — bir blok uretildiginde
 * kesindir, fork ve geri donus yok. Bu yuzden tarama en son bloga kadar
 * yapilir. `finalized` etiketi bilerek KULLANILMIYOR: bazi dugumler (yerel
 * gelistirme dugumleri dahil) onu onlarca blok geriden verir ve yatirmalar
 * sebepsiz yere gecikir.
 */

import { createPublicClient, http, getAddress, type PublicClient } from 'viem'
import { USDC_ABI, USDC_ADDRESS } from './arc-rail.js'

export interface IncomingTransfer {
  /** Tekil kimlik: `<txHash>:<logIndex>`. Bir transaction birden fazla transfer tasiyabilir. */
  readonly signature: string
  /** Gonderen cuzdan. Belirlenemediyse `null`. */
  readonly from: string | null
  /** Micro-USDC. */
  readonly amount: bigint
}

export interface IncomingBatch {
  /** ESKIDEN YENIYE. */
  readonly transfers: readonly IncomingTransfer[]
  /** Bir sonraki taramanin baslayacagi yer. */
  readonly newCursor: string | null
}

export interface DepositSource {
  /** `cursor`'dan SONRAKI, kesinlesmis USDC girislerini dondurur. */
  incoming(cursor: string | null): Promise<IncomingBatch>
}

/** Tek `eth_getLogs` cagrisinin blok araligi. RPC'ler genis araliklari reddeder. */
const CHUNK = 10_000n
/** Tek turda en fazla bu kadar blok: ilk taramada bile sonsuza kadar gitme. */
const MAX_BLOCKS_PER_POLL = 200_000n

export interface ArcDepositSourceConfig {
  readonly rpcUrl: string
  readonly vault: string
  readonly usdc?: string
  /**
   * Cursor yokken taramanin baslayacagi blok — kasanin deploy edildigi blok.
   * Daha oncesinde kasaya gelmis bir para olamaz.
   */
  readonly fromBlock: bigint
}

/**
 * Cursor: islenmis SON blok numarasi (ondalik metin).
 *
 * Blok numarasina gore ilerlemek guvenli: bir blok ya tamamen islenir ya hic.
 * Ayni bloktaki birden fazla yatirma ayni turda okunur.
 */
export class ArcDepositSource implements DepositSource {
  readonly #client: PublicClient
  readonly #vault: `0x${string}`
  readonly #usdc: `0x${string}`
  readonly #fromBlock: bigint

  constructor(cfg: ArcDepositSourceConfig) {
    this.#client = createPublicClient({ transport: http(cfg.rpcUrl) })
    this.#vault = getAddress(cfg.vault)
    this.#usdc = getAddress(cfg.usdc ?? USDC_ADDRESS)
    this.#fromBlock = cfg.fromBlock
  }

  async incoming(cursor: string | null): Promise<IncomingBatch> {
    const head = await this.#client.getBlockNumber()
    const start = cursor !== null ? BigInt(cursor) + 1n : this.#fromBlock
    if (start > head) return { transfers: [], newCursor: cursor }

    const end = head - start + 1n > MAX_BLOCKS_PER_POLL ? start + MAX_BLOCKS_PER_POLL - 1n : head
    const transfers: IncomingTransfer[] = []

    for (let from = start; from <= end; from += CHUNK) {
      const to = from + CHUNK - 1n > end ? end : from + CHUNK - 1n
      const logs = await this.#client.getContractEvents({
        address: this.#usdc,
        abi: USDC_ABI,
        eventName: 'Transfer',
        args: { to: this.#vault },
        fromBlock: from,
        toBlock: to,
        strict: true,
      })
      // RPC loglari blok ve log sirasiyla dondurur; yine de siraya sokuyoruz —
      // cursor'in dogrulugu bu siraya dayaniyor.
      logs.sort((a, b) => (a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber ? -1 : 1))

      for (const l of logs) {
        if (l.args.value <= 0n) continue
        transfers.push({
          signature: `${l.transactionHash}:${l.logIndex}`,
          from: getAddress(l.args.from),
          amount: l.args.value,
        })
      }
    }

    return { transfers, newCursor: end.toString() }
  }

}
