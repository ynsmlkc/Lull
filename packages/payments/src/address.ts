/**
 * Hedef adres dogrulamasi — ADR-020.
 *
 * Zincir ustu odeme GERI ALINAMAZ. Yanlis adrese giden para gitmistir.
 * Bu yuzden kontrollerin hepsi gecilmeden adres baglanmaz.
 *
 * Kontroller iki gruba ayriliyor:
 *   • Bicimsel — ag erisimi gerektirmez, aninda calisir
 *   • Zincir ustu — kontrat mi, USDC'nin kendisi mi, engelli mi
 *
 * Arc bir EVM zinciri: her adres USDC alabilir, alici tarafinda acilacak bir
 * hesap yok. Adresler her yerde EIP-55 checksum bicimine cevrilerek tutulur;
 * ayni cuzdanin kucuk harfli ve checksum'li iki yazimi iki ayri hesap
 * sayilmasin diye.
 */

import { getAddress, isAddress } from 'viem'

export type AddressRejection =
  | 'gecersiz_bicim'
  | 'secret_key'
  | 'kontrat_adresi'
  | 'token_adresi'
  | 'engelli_adres'
  | 'baska_hesaba_bagli'

export interface AddressCheck {
  readonly ok: boolean
  readonly reason: AddressRejection | null
  /** Kullaniciya gosterilecek tek cumle. */
  readonly message: string | null
  /** Kullanicinin ne yapmasi gerektigi. */
  readonly hint: string | null
}

const OK: AddressCheck = { ok: true, reason: null, message: null, hint: null }
const fail = (reason: AddressRejection, message: string, hint?: string): AddressCheck =>
  ({ ok: false, reason, message, hint: hint ?? null })

const SECRET_HINT =
  'Ekrana veya bir dosyaya yapistirdiysan o cuzdani ARTIK KULLANMA. ' +
  'Yeni bir cuzdan olustur ve ACIK adresini (0x ile baslayan 42 karakter) gir.'

/**
 * Yapistirilan sey gizli anahtar veya kurtarma ifadesi mi?
 *
 * Gorunum bicimleri:
 *   • MetaMask / Rabby "private key" disa aktarma → 32 bayt hex (64 karakter, 0x'li ya da 0x'siz)
 *   • Kurtarma ifadesi → 12 veya 24 kucuk harfli kelime
 *
 * Acik adres 20 bayttir (40 hex); 64 hex'lik bir deger adres olamaz.
 */
function looksLikeSecret(raw: string): boolean {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return true

  const words = raw.split(/\s+/)
  return (words.length === 12 || words.length === 24) && words.every((w) => /^[a-z]{3,8}$/.test(w))
}

/**
 * Adresi tek bicime cevirir (EIP-55 checksum). Gecersizse `null`.
 *
 * Kucuk harfli adres kabul edilir — cuzdanlarin cogu `eth_requestAccounts`
 * ile kucuk harf dondurur. Karisik harfli ama checksum'i tutmayan adres
 * REDDEDILIR: bu bir yazim hatasidir ve EIP-55'in var olma sebebi tam olarak
 * bunu yakalamaktir.
 */
export function normalizeAddress(raw: string): `0x${string}` | null {
  const a = raw.trim()
  if (!isAddress(a, { strict: true })) return null
  return getAddress(a)
}

/**
 * Bicimsel kontroller — ag erisimi YOK.
 *
 * Ayri durmasinin sebebi: kullanici adresi yazarken aninda geri bildirim
 * verebilmek ve zincire gereksiz sorgu atmamak.
 */
export function checkAddressFormat(raw: string): AddressCheck {
  const address = raw.trim()

  // EN ONEMLI KONTROL, EN BASTA.
  //
  // Kullanici kazara gizli anahtar veya kurtarma ifadesi yapistirabilir. Bu
  // durumda:
  //   • hemen dur
  //   • degeri EKRANA BASMA
  //   • LOG'A YAZMA
  //   • hata mesajina KOYMA
  // Anahtar bir kez bir yere yazildiginda geri alinamaz.
  if (looksLikeSecret(address)) {
    return fail('secret_key', 'Bu bir GIZLI ANAHTAR veya kurtarma ifadesi. Adres degil.', SECRET_HINT)
  }

  if (normalizeAddress(address) === null) {
    return fail('gecersiz_bicim',
      'Gecerli bir Arc (EVM) adresi degil.',
      'Adres 0x ile baslayan 42 karakterlik hex metindir. Elle yazdiysan cuzdanindan kopyala.')
  }

  // Sifir adresi bicimsel olarak gecerli ama sahibi yok: oraya giden para yanar.
  if (/^0x0{40}$/i.test(address)) {
    return fail('gecersiz_bicim', 'Sifir adresi bir cuzdan degil.', 'Cuzdaninin kendi adresini gir.')
  }

  return OK
}

/** Zincirden okunan hesap durumu. `PaymentRail` doldurur. */
export interface OnChainAccount {
  /** Adreste kod var mi? (EIP-7702 yetkilendirmesi olan cuzdanlar haric.) */
  readonly isContract: boolean
  /** Adres USDC'nin ya da kasanin kendisi mi? */
  readonly isToken: boolean
  /** USDC ihraccisi adresi engellemis mi? */
  readonly blocked: boolean
}

export interface OnChainCheckInput {
  readonly address: string
  readonly account: OnChainAccount
  /** USDC (ERC-20 arayuzu) adresi. */
  readonly usdcToken: string
  /** Adres baska bir publisher'a bagli mi? */
  readonly boundToOther: boolean
}

/** Zincir ustu kontroller — ADR-020 tablosunun 3-6. maddeleri. */
export function checkAddressOnChain(input: OnChainCheckInput): AddressCheck {
  const { address, account } = input

  if (address.toLowerCase() === input.usdcToken.toLowerCase() || account.isToken) {
    return fail('token_adresi',
      'Bu adres bir token kontrati, cuzdan degil.',
      'Cuzdaninin kendi adresini gir.')
  }

  if (input.boundToOther) {
    // Ayni adresin N hesaba baglanabilmesi ADR-010'un sybil savunmasinda delik:
    // 500 GitHub hesabi tek cuzdana odeme yapabilirdi.
    return fail('baska_hesaba_bagli',
      'Bu adres baska bir Linger hesabina bagli.',
      'Her adres yalnizca bir hesaba baglanabilir.')
  }

  if (account.isContract) {
    // Kontrata giden USDC'yi cekmenin yolu kontratin koduna baglidir; cogu
    // durumda para kalici olarak kilitlenir. Kontratlar mesaj da imzalayamaz,
    // yani giris yapamazlar.
    return fail('kontrat_adresi',
      'Bu adres bir kontrat. Cuzdan adresi degil.',
      'MetaMask, Rabby veya Coinbase Wallet gibi bir cuzdanin kendi adresini gir.')
  }

  if (account.blocked) {
    // Engelli hedefe transfer patlar ve TUM batch'i dusurur.
    return fail('engelli_adres',
      'Bu adres USDC ihraccisi tarafindan engellenmis.',
      'Baska bir adres dene.')
  }

  return OK
}

/** Iki asamayi birlestirir. */
export function checkAddress(input: OnChainCheckInput): AddressCheck {
  const format = checkAddressFormat(input.address)
  return format.ok ? checkAddressOnChain(input) : format
}

/** Kullaniciya gosterilirken adresi kisalt. Tam hali kopyalanabilir kalmali. */
export const shortAddress = (a: string): string =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
