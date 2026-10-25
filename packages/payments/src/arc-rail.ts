/**
 * `PaymentRail`'in GERCEK uygulamasi — Arc agina baglanir.
 *
 * Buraya kadarki her sey mock ray uzerinde calisti; burasi paranin fiilen
 * hareket ettigi yer. Dolayisiyla buradaki her karar geri alinamaz sonuclar
 * dogurur: zincire yazilan bir odeme geri cagirilamaz.
 *
 * Para operator cuzdaninda DEGIL, `LullVault` kontratinda duruyor.
 * Operator yalnizca `payout(batchId, alicilar, tutarlar)` cagirir ve gazi
 * oder. Bu ayrimin iki kazanci var:
 *
 *   • Operator anahtari calinsa bile kasa sahibi kasayi durdurabilir
 *     (`pause`) ve operatoru degistirebilir.
 *   • Kasa her `batchId`'yi YALNIZCA BIR KEZ oder. Sunucu ne yaparsa yapsin —
 *     yeniden baslatma, yeniden kurma, cift gonderim — ayni batch zincirde iki
 *     kez odenemez. Defterdeki cifte odeme korumasinin zincir ustundeki eşi.
 *
 * Uc kural (onceki rayla ayni):
 *
 *   1. TRANSACTION BIR KEZ KURULUR. Retry AYNI byte'lari gonderir; ayni
 *      byte'lar ayni nonce'tur ve ag onu ikinci kez uygulamaz (§8 tuzak #9).
 *   2. "GONDERDIM" ODENDI DEMEK DEGIL. Yalnizca `status === success` odendi
 *      demektir. Zincire girip geri alinan transaction ucret keser, para
 *      gondermez. Arc'ta kesinlik deterministik: makbuzu olan blok geri donmez.
 *   3. KASA BAKIYESI YETMEZ. Operatorun gazi biterse odemeler sessizce durur;
 *      ikisi ayri izlenir (§8 tuzak #11). Arc'ta gaz da USDC'dir ama
 *      18 ondaliklidir — ERC-20 arayuzu 6 ondalikli. Ikisi asla karistirilmaz.
 */

import {
  createPublicClient, http, encodeFunctionData, keccak256, parseAbi,
  stringToHex, getAddress, defineChain, TransactionReceiptNotFoundError,
  type Hex, type PublicClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { micros } from '@lull/protocol'
import type {
  PaymentRail, PayoutBatch, DestinationStatus, SubmissionReceipt,
  SettlementResult, SourceAccountStatus,
} from './rail.js'
import { normalizeAddress } from './address.js'
import type { Network } from './wallet.js'
import { CHAIN_ID } from './siwe.js'

/** USDC'nin ERC-20 arayuzu — Arc'ta iki agda da ayni adres, 6 ondalik. */
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const

export const RPC_URL = {
  testnet: 'https://rpc.testnet.arc.io',
  mainnet: 'https://rpc.mainnet.arc.io',
} as const satisfies Record<Network, string>

const EXPLORER = {
  testnet: 'https://explorer.testnet.arc.io',
  mainnet: 'https://explorer.arc.io',
} as const satisfies Record<Network, string>

/** Kasanin tek seferde odeyebilecegi en fazla alici (kontratta da ayni sinir). */
export const MAX_BATCH_ITEMS = 64

export const VAULT_ABI = parseAbi([
  'function payout(bytes32 batchId, address[] recipients, uint256[] amounts)',
  'function batchPaid(bytes32 batchId) view returns (bool)',
  'function operator() view returns (address)',
  'function paused() view returns (bool)',
  'event Paid(bytes32 indexed batchId, address indexed to, uint256 amount)',
])

export const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function isBlacklisted(address) view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

export function arcChain(network: Network, rpcUrl: string) {
  return defineChain({
    id: CHAIN_ID[network],
    name: network === 'mainnet' ? 'Arc' : 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Arc Explorer', url: EXPLORER[network] } },
  })
}

export interface ArcRailConfig {
  readonly network: Network
  readonly rpcUrl: string
  /** Operator cuzdaninin gizli anahtari. Yalnizca sunucuda, secret manager'dan. */
  readonly operatorKey: string
  /** `LullVault` adresi — paranin durdugu ve odemenin ciktigi yer. */
  readonly vault: string
  /**
   * Odenecek USDC.
   *
   * §8 tuzak #8: Circle'in USDC'si kullanilir, kendi token'imiz DEGIL. Kasa
   * kurulurken token adresi sabitleniyor; bu yalnizca okuma icin.
   */
  readonly usdc?: string
}

/** Gaz tahminine eklenen pay: tahmin ile gercek arasindaki fark batch'i dusurmesin. */
const GAS_HEADROOM_PCT = 125n
/** Ucret teklifi tavani: ag ucreti ani yukselirse transaction yine de girsin. */
const FEE_HEADROOM_PCT = 200n

/** EIP-7702 yetkilendirmesi: kodu `0xef0100` ile baslayan adres hala bir EOA'dir. */
const DELEGATION_PREFIX = '0xef0100'

export class ArcRail implements PaymentRail {
  readonly #client: PublicClient
  readonly #operator: PrivateKeyAccount
  readonly #vault: `0x${string}`
  readonly #usdc: `0x${string}`
  readonly #chainId: number

  constructor(private readonly cfg: ArcRailConfig) {
    this.#client = createPublicClient({ chain: arcChain(cfg.network, cfg.rpcUrl), transport: http(cfg.rpcUrl) })
    this.#operator = parseOperatorKey(cfg.operatorKey)
    this.#vault = getAddress(cfg.vault)
    this.#usdc = getAddress(cfg.usdc ?? USDC_ADDRESS)
    this.#chainId = CHAIN_ID[cfg.network]
  }

  /** Operator (gaz odeyen) adresi. */
  get operatorAddress(): string { return this.#operator.address }
  /** Reklamverenin para gonderdigi ve odemenin ciktigi adres. */
  get vaultAddress(): string { return this.#vault }

  /* ───────────────────────── hedef kontrolu ───────────────────────── */

  /**
   * Batch kurulmadan HEMEN once cagrilir.
   *
   * TOCTOU: kullanici bu kontrol ile gonderim arasinda engellenebilir. Pencereyi
   * kapatamayiz, yalnizca daraltiriz — ve kapatmaya gerek yok: kasa batch'i
   * atomik oduyor, engelli hedefe transfer TUM batch'i geri alir ve hicbir
   * odeme yapilmaz. Ustelik `prepare` gaz tahmini sirasinda transaction'i
   * simule ediyor; patlayacak bir batch hic imzalanmiyor.
   */
  async validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]> {
    return Promise.all(addresses.map(async (address): Promise<DestinationStatus> => {
      const a = normalizeAddress(address)
      if (!a) return { address, valid: false, isContract: false, isToken: false, blocked: false }

      // RPC HATASI yukari atilir — "goremiyorum" ile "yok" ayni sey degil;
      // ikisini birlestirmek gecici bir kesinti yuzunden gercek bir
      // alacakliyi batch'ten dusurmek demek.
      const code = await this.#client.getCode({ address: a })
      const isContract = code !== undefined && code !== '0x' && !code.startsWith(DELEGATION_PREFIX)

      return {
        address,
        valid: true,
        isContract,
        isToken: a === this.#usdc || a === this.#vault,
        blocked: await this.#isBlacklisted(a),
      }
    }))
  }

  /**
   * USDC engel listesi.
   *
   * Arc'in USDC arayuzu bu gorunumu sunmayabilir; o durumda `false` doner ve
   * koruma gaz tahminindeki simulasyona kalir (engelli hedef simulasyonu
   * patlatir, batch imzalanmaz).
   */
  async #isBlacklisted(a: `0x${string}`): Promise<boolean> {
    try {
      return await this.#client.readContract({
        address: this.#usdc, abi: USDC_ABI, functionName: "isBlacklisted", args: [a],
      })
    } catch {
      return false
    }
  }

  /* ───────────────────────── kaynak hesap ───────────────────────── */

  async sourceStatus(): Promise<SourceAccountStatus> {
    const [vaultUsdc, gas] = await Promise.all([
      this.#client.readContract({
        address: this.#usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [this.#vault],
      }),
      this.#client.getBalance({ address: this.#operator.address }),
    ])
    return { address: this.#vault, usdcBalance: micros(vaultUsdc), availableGas: gas }
  }

  /* ───────────────────────── gonderim ───────────────────────── */

  /** Kurar ve imzalar. Aga YAZMAZ — yalnizca nonce, ucret ve simulasyon icin okur. */
  async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (batch.items.length === 0) throw new Error('bos batch gonderilemez')
    if (batch.items.length > MAX_BATCH_ITEMS) {
      // Sessizce kirpmak yok: batch bolunmeden gonderilemez.
      throw new Error(`batch cok buyuk: ${batch.items.length} > ${MAX_BATCH_ITEMS} alici — batchSize dusur`)
    }

    const recipients = batch.items.map((it) => {
      const a = normalizeAddress(it.address)
      if (!a) throw new Error(`gecersiz hedef adres: ${it.publisherId}`)
      return a as `0x${string}`
    })
    // Float'tan GECMEZ: defter tutari ile zincir tutari ayni tam sayidir
    // (ikisi de 6 ondalik micro-USDC).
    const amounts = batch.items.map((it) => BigInt(it.amount))

    const data = encodeFunctionData({
      abi: VAULT_ABI, functionName: 'payout',
      args: [batchKey(batch.batchId), recipients, amounts],
    })

    const from = this.#operator.address
    // `pending`: kuyrukta bekleyen kendi transaction'larimizin ustune yazmayalim.
    const nonce = await this.#client.getTransactionCount({ address: from, blockTag: 'pending' })

    // Gaz tahmini transaction'i SIMULE EDER. Kasada yeterli para yoksa, alici
    // engelliyse, batch zaten odenmisse ya da kasa durdurulmussa burada patlar
    // — imza atilmadan, deftere hicbir sey yazilmadan.
    const gasEstimate = await this.#client.estimateGas({ account: from, to: this.#vault, data })
    const gas = (gasEstimate * GAS_HEADROOM_PCT) / 100n

    const fees = await this.#client.estimateFeesPerGas()
    const maxFeePerGas = (fees.maxFeePerGas * FEE_HEADROOM_PCT) / 100n
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas

    const serialized = await this.#operator.signTransaction({
      type: 'eip1559',
      chainId: this.#chainId,
      to: this.#vault,
      data,
      nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      value: 0n,
    })

    // Hash (kimlik) imzalandigi anda BILINIYOR. Kritik: "gonderdim ama cevap
    // gelmedi" durumunda bile ne aradigimizi biliyoruz.
    return {
      batchId: batch.batchId,
      txHash: keccak256(serialized),
      serializedTx: serialized,
      validityRef: `nonce:${nonce}`,
      validUntil: nonce,
      feeBid: gas * maxFeePerGas,
      // §8 tuzak #7 — hangi item kasanin dongusunde kacinci sirada. Bu esleme
      // SUBMIT'TEN ONCE sabitlenir ve kaydedilir.
      opIndex: batch.items.map((it, index) => ({ publisherId: it.publisherId, index })),
    }
  }

  /**
   * Hazirlanmis transaction'i gonderir. AYNI byte'lar, her seferinde.
   *
   * Gonderim hatasi "odeme yapilmadi" DEMEK DEGIL: zaman asimi ya da baglanti
   * kopmasi, RPC transaction'i kabul ettikten SONRA da olabilir. Bu yuzden
   * belirsiz hatalar YUTULUYOR — karar `reconcile`'a, yani zincire birakiliyor.
   *
   * Yalnizca ag transaction'in DETERMINISTIK olarak patlayacagini soyledigi
   * durumda hata firlatiliyor; o durumda odeme kesin olarak yapilmadi.
   */
  async send(receipt: SubmissionReceipt): Promise<void> {
    try {
      await this.#client.sendRawTransaction({ serializedTransaction: receipt.serializedTx as Hex })
    } catch (e) {
      // "Zaten biliniyor" IYI haber: onceki gonderim havuzda ya da zincirde.
      // "nonce too low" ya bu transaction'in girdigini ya da nonce'un baska
      // bir transaction'la harcandigini soyler — ikisini `reconcile` ayirir.
      if (isAlreadyKnown(e)) return
      if (isDefinitelyRejected(e)) throw new SubmitRejected(receipt, describeError(e))
    }
  }

  /* ───────────────────────── mutabakat ───────────────────────── */

  /**
   * Zincire bakar ve TEK dogru cevabi verir.
   *
   * `status === success` disindaki hicbir sey "odendi" degildir.
   */
  async reconcile(receipt: SubmissionReceipt): Promise<SettlementResult> {
    // SIRA ONEMLI: once nonce, SONRA makbuz. Ters siralamada, makbuz sorgusu
    // "yok" derken transaction tam o sirada dahil edilebilir ve biz nonce'u
    // gecmis gorup olu ilan ederdik. Bu sirayla "yok" cevabi, nonce
    // ilerledikten SONRA alindigi icin kesindir.
    const confirmedNonce = await this.#client.getTransactionCount({
      address: this.#operator.address, blockTag: 'latest',
    })

    const r = await this.#receipt(receipt.txHash as Hex)
    if (r === null) {
      // Zincirde yok. Nonce baska bir transaction'la harcandiysa bu transaction
      // ARTIK ASLA giremez — yeniden kurulabilir. Harcanmadiysa bekle.
      const dead = confirmedNonce > receipt.validUntil
      return { state: dead ? 'expired' : 'pending', txHash: receipt.txHash, slot: null, feeCharged: null, opResults: [] }
    }

    const fee = r.gasUsed * r.effectiveGasPrice
    const block = Number(r.blockNumber)

    if (r.status === 'success') {
      return { state: 'settled', txHash: receipt.txHash, slot: block, feeCharged: fee, opResults: [] }
    }
    // Kasa atomik: geri alinan batch'te HICBIR transfer gerceklesmedi. Hangi
    // alicinin patlattigini makbuz soylemiyor; tum batch suclu sayilir.
    return {
      state: 'failed', txHash: receipt.txHash, slot: block, feeCharged: fee,
      opResults: [{ index: -1, code: 'reverted' }],
    }
  }

  async #receipt(hash: Hex) {
    try {
      return await this.#client.getTransactionReceipt({ hash })
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return null
      throw e
    }
  }
}

/** Ag tarafindan KESIN olarak reddedilmis gonderim. Odeme yapilmadi. */
export class SubmitRejected extends Error {
  constructor(readonly receipt: SubmissionReceipt, message: string) {
    super(message)
    this.name = 'SubmitRejected'
  }
}

/* ───────────────────────── yardimcilar ───────────────────────── */

/**
 * Defterdeki batch kimligini kasanin anahtarina cevirir.
 *
 * Deterministik: ayni `batchId` her zaman ayni anahtar. Kasa anahtari bir kez
 * kabul ettigi icin, ayni batch'in ikinci kez odenmesi zincirde imkansiz.
 */
export const batchKey = (batchId: string): Hex => keccak256(stringToHex(batchId))

/**
 * Operator gizli anahtarini okur. 32 bayt hex, `0x`'li ya da `0x`'siz.
 * Hata mesajina DEGERI KOYMAYIZ.
 */
export function parseOperatorKey(raw: string): PrivateKeyAccount {
  const s = raw.trim()
  const hex = (s.startsWith('0x') ? s : `0x${s}`) as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('operator anahtari okunamadi: 32 bayt hex bekleniyor')
  }
  return privateKeyToAccount(hex)
}

function isAlreadyKnown(e: unknown): boolean {
  return /already known|known transaction|nonce too low|replacement transaction underpriced/i.test(errText(e))
}

/**
 * Ag transaction'i KESIN reddetti mi?
 *
 * Ayrim hayati: reddedilmis bir transaction guvenle yeniden kurulabilir,
 * belirsiz olan KURULAMAZ. Belirsizi reddedilmis saymak cifte odeme demektir,
 * bu yuzden varsayilan "belirsiz" tarafinda.
 */
function isDefinitelyRejected(e: unknown): boolean {
  return /execution reverted|insufficient funds|intrinsic gas too low|exceeds block gas limit|invalid sender|invalid chain id/i.test(errText(e))
}

const errText = (e: unknown): string => {
  const details = (e as { details?: string; shortMessage?: string } | null)
  return `${e instanceof Error ? e.message : String(e)} ${details?.details ?? ''} ${details?.shortMessage ?? ''}`
}

function describeError(e: unknown): string {
  return errText(e).trim().slice(0, 300)
}

/** Tarayicida acilan linkler. Kullanici "nereye gitti?" diye bakabilsin. */
export const explorerTxUrl = (network: Network, hash: string): string =>
  `${EXPLORER[network]}/tx/${hash}`

export const explorerAccountUrl = (network: Network, address: string): string =>
  `${EXPLORER[network]}/address/${address}`
