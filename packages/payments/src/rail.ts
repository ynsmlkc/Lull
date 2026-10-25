/**
 * Odeme rayi — §6.4.
 *
 * Arc'a dokunan her sey bu arayuzun arkasinda. Sebebi test edilebilirlik:
 * `payments` her zaman mock rail ile birim test edilir, testnet yalnizca ayri
 * bir entegrasyon suite'inde kullanilir (§11).
 */

import type { Micros } from '@linger/protocol'

/**
 * Hedef adresin zincirdeki durumu.
 *
 * Arc'ta USDC bir ERC-20 arayuzuyle tutuluyor ve alicinin onceden bir hesap
 * acmasi gerekmiyor: her EVM adresi USDC alabilir. Engel olanlar: kod tasiyan
 * adresler (kontratlar — para orada kilitlenebilir), USDC'nin kendi adresi ve
 * USDC ihraccisinin engelledigi adresler.
 */
export interface DestinationStatus {
  readonly address: string
  /** Bicimsel olarak gecerli bir EVM adresi mi? */
  readonly valid: boolean
  /** Adreste kod var mi? (EIP-7702 yetkilendirmesi olan cuzdanlar haric.) */
  readonly isContract: boolean
  /** Adres USDC'nin ya da kasanin kendisi mi? */
  readonly isToken: boolean
  /** USDC ihraccisi bu adresi engellemis mi? Engelli hedefe transfer patlar. */
  readonly blocked: boolean
}

export interface PayoutItem {
  readonly publisherId: string
  readonly address: string
  readonly amount: Micros
}

export interface PayoutBatch {
  readonly batchId: string
  readonly items: readonly PayoutItem[]
}

/**
 * Submit sonucu.
 *
 * `txHash` submit'ten ONCE biliniyor: transaction imzalandigi anda kimligi
 * belli. Bu yuzden "submit ettim ama cevap gelmedi" durumunda bile mutabakat
 * kurulabilir.
 */
export interface SubmissionReceipt {
  readonly batchId: string
  readonly txHash: string
  /** ADR §8 tuzak #9 — retry AYNI byte'lari gonderir, yeniden insa etmez. */
  readonly serializedTx: string
  /** Transaction'in gecerlilik dayanagi. Arc'ta `nonce:<n>`. */
  readonly validityRef: string
  /**
   * Bu isaret asildiginda transaction kesin olarak olu sayilir. Arc'ta
   * gondericinin nonce'u: hesabin onaylanmis nonce'u bunu gectiyse ve
   * transaction zincirde yoksa, o nonce baska bir transaction'la harcanmistir.
   */
  readonly validUntil: number
  /** Toplam ucret teklifi (wei, 18 ondalik USDC). Yalnizca teshis icin. */
  readonly feeBid: bigint
  /** Hangi item hangi transfer sirasinda — §8 tuzak #7. */
  readonly opIndex: readonly { publisherId: string; index: number }[]
}

export type SettlementState =
  /** Zincirde, `status === success`. Tek dogru "odendi" tanimi. */
  | 'settled'
  /** Zincire girdi ama geri alindi (revert). Ucret kesildi, para gitmedi. */
  | 'failed'
  /** Henuz zincirde degil ama hala gecerli. AYNI transaction tekrar gonderilir. */
  | 'pending'
  /** Nonce baska bir transaction'la harcandi ve bu yok. Ancak SIMDI yeniden kurulur. */
  | 'expired'

export interface SettlementResult {
  readonly state: SettlementState
  readonly txHash: string
  /** Dahil edildigi blok. */
  readonly slot: number | null
  readonly feeCharged: bigint | null
  /** Basarisizsa hangi transfer neden patladi. */
  readonly opResults: readonly { index: number; code: string }[]
}

export interface SourceAccountStatus {
  readonly address: string
  /** Odemelerin ciktigi kasadaki USDC (micro). */
  readonly usdcBalance: Micros
  /**
   * Operatorun islem ucreti icin harcanabilir bakiyesi (wei, 18 ondalik).
   *
   * Arc'ta gaz da USDC ile odeniyor, ama odemeyi gonderen operator cuzdani
   * kasadan ayri. Kasa dolu ama operatorun gazi bitmisse odemeler SESSIZCE
   * durur; bu yuzden ayri izlenir (§8 tuzak #11).
   */
  readonly availableGas: bigint
}

export interface PaymentRail {
  /** Batch kurulmadan HEMEN once cagrilir — TOCTOU penceresi dar tutulur. */
  validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]>
  sourceStatus(): Promise<SourceAccountStatus>

  /**
   * Transaction'i kurar ve IMZALAR — aga hicbir sey YAZMAZ.
   *
   * Kurmak ile gondermek bilincli olarak ayri. Tek bir `submitBatch` cagrisi
   * olsaydi, cagiran defterine ancak gonderimden SONRA yazabilirdi; arada
   * dusen bir sunucu parayi zincirde gonderilmis ama defterde hala odenebilir
   * birakirdi — yani ayni para ikinci kez odenirdi.
   *
   * Bu ayrimla hash (kimlik) gonderimden ONCE biliniyor: ne olursa olsun
   * neye bakacagimizi biliyoruz.
   */
  prepare(batch: PayoutBatch): Promise<SubmissionReceipt>

  /**
   * Hazirlanmis transaction'i aga gonderir.
   *
   * AYNI byte'lar. Tekrar cagrilabilir: ag ayni nonce'u ikinci kez uygulamaz,
   * dolayisiyla idempotenttir. Yeniden insa etmek bunu bozar.
   */
  send(receipt: SubmissionReceipt): Promise<void>

  /**
   * Zincire bakar ve TEK dogru cevabi verir. `expired` kararini da rail
   * verir (nonce karsilastirmasi) — cagiran saat karsilastirmaz.
   */
  reconcile(receipt: SubmissionReceipt): Promise<SettlementResult>
}
