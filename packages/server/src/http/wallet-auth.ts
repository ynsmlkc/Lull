/**
 * Cuzdanla giris — ADR-010 (2026-08-15 revizyonu), ADR-014.
 *
 * Akis:
 *   1. Istemci adresini verir       → sunucu SIWE mesaji uretir
 *   2. Kullanici cuzdaniyla imzalar → sunucu dogrular
 *   3. Sunucu device token uretir   → istemci onu saklar
 *
 * Mesaj bir transaction DEGILDIR; aga HICBIR ZAMAN gonderilemez. Guvenlik
 * yapinin kendisinden gelir, bizim dikkatimizden degil (ADR-014).
 *
 * `publisherId` adresin KENDISIDIR (EIP-55 checksum bicimi). Ayri bir
 * kullanici tablosu yok: kimlik ile odeme hedefi ayni sey, ikisini ayirmak
 * gereksiz bir eslesme katmani yaratirdi.
 *
 * Adres HER GIRISTE checksum bicimine cevrilir. Cuzdanlar cogunlukla kucuk
 * harf dondurur; cevirmeseydik ayni cuzdan iki ayri hesap acardi ve
 * kazanci ikiye bolunurdu.
 */

import { Siwe, checkAddressFormat, normalizeAddress } from '@lull/payments'
import type { Clock, IdGenerator, TokenScope } from '@lull/protocol'

export interface PendingChallenge {
  readonly address: string
  /** Sunucunun urettigi SIWE mesaji — gelen imzali mesaj buna birebir eslesmeli. */
  readonly message: string
  readonly expiresAt: number
}

/**
 * Adres basina bekleyen challenge sayisi.
 *
 * Adres basina TEK challenge tutulsaydi, baskasinin adresine surekli yeni
 * challenge isteyen biri o kisinin imzaladigi challenge'i ezip girisini
 * engellerdi. Birkac tane tutuyoruz; her biri tek kullanimlik. IP basina hiz
 * siniri (app.ts) tek bir kaynagin bu pencereyi doldurmasini yavaslatir.
 */
const MAX_PER_ADDRESS = 20

/**
 * Bellekteki toplam bekleyen challenge. Rastgele adreslerle spam bellegi
 * sinirsiz buyutmesin; dolarsa yeni challenge "birazdan tekrar dene" alir.
 */
const MAX_TOTAL = 10_000

export interface WalletAuthDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly siwe: Siwe
  /** Uretilen token'i saklar; ham token DEGIL, hash'i saklanir. */
  readonly issueToken: (input: {
    publisherId: string
    tokenHash: string
    scopes: readonly TokenScope[]
    role: Role
  }) => { tokenId: string }
  readonly hashToken: (raw: string) => string
  /** Testler icin; varsayilanlar `MAX_PER_ADDRESS` / `MAX_TOTAL`. */
  readonly maxPerAddress?: number
  readonly maxTotal?: number
}

/**
 * Rol basina kapsamlar.
 *
 * Ayni cuzdan hem yayinci hem reklamveren olabilir — ama AYNI ANDA DEGIL,
 * ayni token'la degil. Iki ayri giris, iki ayri token.
 *
 * Sebep: kapsam karistirmak, calinmis bir daemon token'inin kampanya
 * olusturup butce harcamasi demek. Daemon her makinede duruyor; panel
 * token'i yalnizca tarayicida.
 */
export type Role = 'publisher' | 'advertiser'

export const SCOPES_BY_ROLE: Record<Role, readonly TokenScope[]> = {
  publisher: ['report:impressions', 'read:balance', 'withdraw:balance'],
  advertiser: ['manage:campaigns', 'read:spend'],
}

/** Geriye donuk ad. */
export const LOGIN_SCOPES = SCOPES_BY_ROLE.publisher

export type ChallengeResult =
  | { readonly ok: true; readonly message: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: string; readonly busy?: true }

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly tokenId: string; readonly publisherId: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }

export class WalletAuth {
  /** Adres → bekleyen challenge'lar (eskiden yeniye). */
  readonly #pending = new Map<string, PendingChallenge[]>()
  #total = 0

  constructor(private readonly deps: WalletAuthDeps) {}

  /** Adres icin challenge uretir. */
  challenge(input: string): ChallengeResult {
    // ADR-020: yalnizca gercek bir cuzdan adresi — kimlik ile odeme hedefi
    // ayni sey oldugu icin ayni kurallar gecerli. Gizli anahtar
    // yapistirilmissa DEGERI hata mesajina KONMAZ.
    const format = checkAddressFormat(input)
    if (!format.ok) return { ok: false, reason: format.message ?? 'gecersiz Arc adresi' }
    const address = normalizeAddress(input)!

    this.#gc()
    if (this.#total >= (this.deps.maxTotal ?? MAX_TOTAL)) {
      return { ok: false, reason: 'cok fazla bekleyen giris — birazdan tekrar dene', busy: true }
    }

    const c = this.deps.siwe.challenge(address)
    const list = this.#pending.get(address) ?? []
    list.push({ address, message: c.message, expiresAt: c.expiresAt })
    this.#total++
    // Pencere dolduysa en eskisi duser.
    if (list.length > (this.deps.maxPerAddress ?? MAX_PER_ADDRESS)) { list.shift(); this.#total-- }
    this.#pending.set(address, list)
    return { ok: true, message: c.message, expiresAt: c.expiresAt }
  }

  /** Imzalanmis challenge'i dogrular ve token uretir. */
  async verify(
    input: string,
    signedMessage: string,
    signatureHex: string,
    role: Role = 'publisher',
  ): Promise<LoginResult> {
    const address = normalizeAddress(input)
    if (!address) return { ok: false, reason: 'gecersiz Arc adresi' }
    const list = this.#pending.get(address)
    if (!list || list.length === 0) {
      return { ok: false, reason: 'challenge bulunamadi — once /v1/auth/challenge' }
    }

    // Imzalanan mesaj, BU adres icin SU AN bekleyen challenge'lardan biri
    // olmali. Kullanilan challenge listeden silinir; yani onceki bir giristen
    // kalan (ve ele gecirilmis) imzali mesaj ikinci bir token alamaz.
    const pending = list.find((p) => p.message === signedMessage)
    if (!pending) {
      return { ok: false, reason: 'imzalanan mesaj bekleyen bir challenge degil (zaten kullanilmis olabilir)' }
    }
    if (pending.expiresAt < this.deps.clock.now()) {
      this.#remove(address, pending)
      return { ok: false, reason: 'challenge suresi dolmus' }
    }

    // Sunucunun URETTIGI mesaj ile istemcinin imzaladigi mesaj birebir ayni
    // olmali; istemcinin kendi sectigi bir metin gecmez.
    const result = await this.deps.siwe.verify(address, pending.message, signedMessage, signatureHex)
    if (!result.ok) {
      return { ok: false, reason: 'imza dogrulanamadi', detail: result.reason }
    }

    // Tek kullanimlik: ayni imzayi ikinci kez gondermek yeni token uretemez.
    if (!this.#remove(address, pending)) {
      return { ok: false, reason: 'imzalanan mesaj bekleyen bir challenge degil (zaten kullanilmis olabilir)' }
    }

    // Ham token YALNIZCA burada, bir kez gorunur. Sunucu hash'ini saklar.
    const raw = `lul_${this.deps.ids.randomHex(24)}`
    const { tokenId } = this.deps.issueToken({
      publisherId: address,
      tokenHash: this.deps.hashToken(raw),
      scopes: SCOPES_BY_ROLE[role],
      role,
    })

    return { ok: true, token: raw, tokenId, publisherId: address }
  }

  /** Listeden siler; zaten yoksa `false`. */
  #remove(address: string, p: PendingChallenge): boolean {
    const list = this.#pending.get(address)
    const i = list ? list.indexOf(p) : -1
    if (!list || i === -1) return false
    list.splice(i, 1)
    this.#total--
    if (list.length === 0) this.#pending.delete(address)
    return true
  }

  /** Suresi dolmus challenge'lari at — bellek sinirsiz buyumesin. */
  #gc(): void {
    const now = this.deps.clock.now()
    for (const [k, list] of this.#pending) {
      const kalan = list.filter((p) => p.expiresAt >= now - 60_000)
      this.#total -= list.length - kalan.length
      if (kalan.length === 0) this.#pending.delete(k)
      else if (kalan.length !== list.length) this.#pending.set(k, kalan)
    }
  }

  pendingCount(): number { return this.#total }
}
