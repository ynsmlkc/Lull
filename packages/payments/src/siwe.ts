/**
 * Cuzdanla giris imzasi — Sign-In With Ethereum (SIWE) mantigi — ADR-014.
 *
 * Kullanicinin bir adresi kontrol ettigini ispatlamanin yolu: sunucunun urettigi
 * OKUNABILIR bir mesaji cuzdaniyla imzalamak. Cuzdan (MetaMask, Rabby,
 * Coinbase Wallet) `personal_sign` ile yalnizca mesaj imzalar; bu bir
 * transaction DEGILDIR ve aga gonderilemez. Guvenlik bu ayrimdan gelir.
 *
 * Neden ham byte degil de yapili mesaj:
 *   1. Cuzdan mesaji kullaniciya gosterir: "linger.example sitesine giris" —
 *      kullanici neyi imzaladigini okuyabilir.
 *   2. Alan adi mesajin icinde: baska bir sitenin imzalattigi mesaj burada
 *      gecmez (phishing savunmasi).
 *   3. `personal_sign` mesajin onune EIP-191 onekini ("\x19Ethereum Signed
 *      Message:\n") koyar. Bu onekle imzalanan hicbir sey gecerli bir
 *      transaction olamaz — ele gecirilmis bir sunucu bile bu yolla cuzdani
 *      bosaltacak bir imza alamaz.
 *
 * Mesajin ilk satiri bilerek EIP-4361 kalibinda DEGIL: CLI girisi yerel bir
 * sayfadan (127.0.0.1) yapiliyor ve kalibi taniyan cuzdanlar alan adi
 * uyusmazligini "aldatici site" diye isaretler. Icerik ayni guvenceleri
 * tasiyor; sunucu mesajin birebir kendi urettigi metin oldugunu dogruluyor.
 *
 * SINIR: yalnizca EOA (ozel anahtarli cuzdan) imzalari dogrulanir. Kontrat
 * cuzdanlari (ERC-1271) desteklenmiyor; onlar zaten `checkAddress` tarafinda
 * kontrat olarak reddediliyor.
 *
 * DIKKAT: imza ispati hesap ele gecirmeyi ENGELLEMEZ. Saldirgan kendi
 * cuzdaniyla imzalar ve dogrulama sorunsuz gecer. Imza yalnizca "hedef adresin
 * sahibi bu istegi yapti" der. Tek savunma bekleme suresi ve bildirimdir
 * (bkz. wallet.ts).
 */

import { recoverMessageAddress, isHex } from 'viem'
import type { Clock, IdGenerator } from '@linger/protocol'
import { normalizeAddress } from './address.js'
import type { Network } from './wallet.js'

export interface SiweConfig {
  /** Sunucunun herkese acik alan adi. Mesajin icinde imzalanir. */
  readonly domain: string
  readonly network: Network
  /** Challenge omru. Kisa tutulur — replay penceresini daraltir. */
  readonly ttlSec?: number
}

export interface ChallengeResult {
  /** Cuzdana imzalatilacak, OKUNABILIR mesaj. */
  readonly message: string
  readonly expiresAt: number
}

export type VerifyFailure =
  | 'gecersiz_adres'
  | 'gecersiz_imza'
  | 'mesaj_uyusmuyor'
  | 'suresi_dolmus'

export type VerifyResult =
  | { readonly ok: true; readonly account: string }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail: string }

export const DEFAULT_TTL_SEC = 300

/** Arc zincir kimlikleri (EIP-155). */
export const CHAIN_ID = { testnet: 5042002, mainnet: 5042 } as const satisfies Record<Network, number>

/** Mesajin ilk satirindan sonra gelen sabit ifade. */
const STATEMENT =
  'Linger hesabina giris yapiyorsun. Bu bir islem degildir, ucret dogurmaz ve cuzdanindan para cikmaz.'

export class Siwe {
  constructor(
    private readonly cfg: SiweConfig,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Adres icin mesaj uretir. Mesaj submit EDILEMEZ — transaction degil. */
  challenge(address: string): ChallengeResult {
    const ttl = this.cfg.ttlSec ?? DEFAULT_TTL_SEC
    const now = this.clock.now()
    const expiresAt = now + ttl * 1000

    const message = [
      `${this.cfg.domain} bu Arc hesabiyla giris yapmani istiyor:`,
      normalizeAddress(address) ?? address,
      '',
      STATEMENT,
      '',
      `URI: https://${this.cfg.domain}`,
      'Version: 1',
      `Chain ID: ${CHAIN_ID[this.cfg.network]}`,
      `Nonce: ${this.ids.randomHex(16)}`,
      `Issued At: ${new Date(now).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join('\n')

    return { message, expiresAt }
  }

  /**
   * Imzayi dogrular.
   *
   * `issuedMessage` sunucunun bu adres icin URETTIGI mesajdir (WalletAuth
   * bellekte tutar). Istemcinin gonderdigi mesaja GUVENILMEZ: yalnizca
   * birebir ayni ise kabul edilir, aksi halde istemci kendi sectigi bir metni
   * imzalatip gecirebilirdi.
   *
   * Imza `personal_sign` ciktisi: 65 bayt hex (r ‖ s ‖ v).
   */
  async verify(
    address: string,
    issuedMessage: string,
    signedMessage: string,
    signatureHex: string,
  ): Promise<VerifyResult> {
    if (signedMessage !== issuedMessage) {
      return { ok: false, reason: 'mesaj_uyusmuyor', detail: 'imzalanan mesaj uretilen mesaj degil' }
    }

    const expires = /^Expiration Time: (.+)$/m.exec(issuedMessage)?.[1]
    if (!expires || Date.parse(expires) < this.clock.now()) {
      return { ok: false, reason: 'suresi_dolmus', detail: 'challenge suresi dolmus' }
    }

    const account = normalizeAddress(address)
    if (!account) return { ok: false, reason: 'gecersiz_adres', detail: address }

    const sig = signatureHex.trim()
    if (!isHex(sig) || sig.length !== 132) {
      return { ok: false, reason: 'gecersiz_imza', detail: `imza 65 bayt hex olmali, gelen ${sig.length} karakter` }
    }

    let signer: string
    try {
      signer = await recoverMessageAddress({ message: signedMessage, signature: sig })
    } catch (e) {
      return { ok: false, reason: 'gecersiz_imza', detail: e instanceof Error ? e.message : String(e) }
    }

    return signer === account
      ? { ok: true, account }
      : { ok: false, reason: 'gecersiz_imza', detail: 'imza bu adrese ait degil' }
  }
}
