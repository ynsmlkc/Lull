/**
 * Para — ADR-005.
 *
 * Birim **micro** (1e-6 USDC), Arc'taki USDC ERC-20 arayuzunun ondalik
 * hassasiyeti (6 hane) — zincir ustu tutar ile defter tutari BIREBIR ayni sayidir, arada
 * donusum katsayisi yoktur.
 * `int64` tavani 9_223_372_036_854_775_807 micro ≈ 9.223.372.036.854 USDC.
 *
 * Defter ile zincir arasinda katsayi olmadigi icin 10x odeme hatasi riski
 * yoktur; yine de `bigint` cipligi yerine `Micros` markali tip kullanilir.
 *
 * Float YASAK. Bu dosyada `number` yalnizca bps gibi tam sayi katsayilarda
 * gecer, hicbir zaman para tutarinda gecmez.
 */

declare const microsBrand: unique symbol

/** 1e-6 USDC. Ciplak `bigint` ile karistirilamaz — branded. */
export type Micros = bigint & { readonly [microsBrand]: 'Micros' }

/** 1 USDC = 1_000_000 micro. */
export const SCALE = 1_000_000n

/**
 * USDC ERC-20 arayuzunun ondalik hane sayisi (Arc).
 *
 * DIKKAT: Arc'ta gaz olarak kullanilan YEREL USDC 18 ondaliklidir. Defter
 * yalnizca ERC-20 tutarlarini tutar; ikisi asla karistirilmaz.
 */
export const USDC_DECIMALS = 6

/** Defter tutarlari int64 ile sinirli (ERC-20 tutari uint256; defter siniri asan bir tutari zaten kabul etmez). */
export const MAX_MICROS = 9_223_372_036_854_775_807n

export class MoneyError extends Error {
  override readonly name = 'MoneyError'
}

/** Ciplak bigint'i Micros'a cevirir ve int64 sinirini dogrular. */
export function micros(value: bigint): Micros {
  if (typeof value !== 'bigint') throw new MoneyError('micros() bigint bekler')
  if (value > MAX_MICROS || value < -MAX_MICROS) {
    throw new MoneyError(`int64 tasmasi: ${value}`)
  }
  return value as Micros
}

export const ZERO = micros(0n)

/* ─────────────────────────── aritmetik ─────────────────────────── */
// bigint operatorleri brand'i dusurdugu icin sarmalayicilar sart.

export const add = (a: Micros, b: Micros): Micros => micros(a + b)
export const sub = (a: Micros, b: Micros): Micros => micros(a - b)
export const neg = (a: Micros): Micros => micros(-a)
export const sum = (xs: readonly Micros[]): Micros => xs.reduce(add, ZERO)

/* ──────────────────── SDK amount string donusumu ───────────────── */

/**
 * SPL token tutari zincirde tam sayidir (micro); ondalikli metin yalnizca
 * insana ve API cevaplarina gosterilir ("1.5").
 *
 * `Number(v) / 1e6` YASAK: 2^53 micro ustunde precision kaybeder ve
 * ADR-005'in "float yasak" kuralini cigner. Saf bigint aritmetigi:
 */
export function toAmountString(v: Micros): string {
  if (v <= 0n) {
    // Yuvarlamayla sifira dusen tek bir item TUM transaction'i gecersiz kilar.
    throw new MoneyError(`amount > 0 olmali, gelen: ${v}`)
  }
  const whole = v / SCALE
  const frac = (v % SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** "1.5" → 1_500_000n. Round-trip testi icin ve RPC `uiAmountString` cevaplarini okurken. */
export function fromAmountString(s: string): Micros {
  if (!/^-?\d+(\.\d{1,6})?$/.test(s)) {
    throw new MoneyError(`gecersiz amount string: ${JSON.stringify(s)}`)
  }
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [whole = '0', frac = ''] = body.split('.')
  const v = BigInt(whole) * SCALE + BigInt(frac.padEnd(6, '0'))
  return micros(neg ? -v : v)
}

/* ──────────────────────── gelir paylasimi ──────────────────────── */

/** Publisher payi, on binde. %50 = 5000 (ADR-011). */
export const DEFAULT_REV_SHARE_BPS = 5000

export interface RevenueSplit {
  readonly publisher: Micros
  readonly platform: Micros
}

/**
 * ADR-011 — gelir paylasimi.
 *
 * Platform payi ayrica hesaplanmaz, **artik** olarak alinir. Boylece
 * `publisher + platform === rate` her zaman kesin saglanir ve yuvarlama
 * bosluk birakmaz — ADR-005'in "ref basina toplam sifir" invariant'i
 * bu sayede tutar.
 *
 * NOT: ters kayit bu fonksiyonla YENIDEN HESAPLANMAZ. Clawback ve basarisiz
 * odeme geri alimi, orijinal entry'lerin `neg()` ile kopyalanmasiyla yazilir
 * (ADR-005). Negatif girdiyle yeniden hesaplamak yuvarlama artigini ters
 * yone dusurur ve invariant'i kirar.
 */
export function splitRevenue(
  rate: Micros,
  bps: number = DEFAULT_REV_SHARE_BPS,
): RevenueSplit {
  if (rate < 0n) throw new MoneyError('splitRevenue negatif tutar kabul etmez — bkz. ADR-005 ters kayit kurali')
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError(`bps 0..10000 arasi tam sayi olmali, gelen: ${bps}`)
  }
  const publisher = micros((rate * BigInt(bps)) / 10_000n)
  return { publisher, platform: sub(rate, publisher) }
}

/**
 * ADR-009 — teklif CPM cinsindendir (1.000 gosterim).
 * Gosterim basina oran = bid / 1000, kalan platform lehine atilir.
 */
export function rateFromCpm(bidCpm: Micros): Micros {
  if (bidCpm < 0n) throw new MoneyError('CPM negatif olamaz')
  return micros(bidCpm / 1000n)
}

/**
 * Insan icin: 1_500_000n → "1.5 USDC". Sadece gosterim, hesapta kullanilmaz.
 * `toAmountString`'in aksine sifir ve negatifi kabul eder — bakiye ekraninda
 * "0 USDC" ve ters kayitlarda negatif gostermek gerekiyor.
 */
export function format(v: Micros): string {
  if (v === 0n) return '0 USDC'
  const abs = micros(v < 0n ? -v : v)
  return `${v < 0n ? '-' : ''}${toAmountString(abs)} USDC`
}
