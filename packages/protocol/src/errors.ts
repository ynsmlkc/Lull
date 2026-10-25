/**
 * Hata taksonomisi.
 *
 * Kapali bir union; yeni kod eklemek bilincli bir karardir. CLI asla stack
 * trace basmaz — kullaniciya `LUL-xxxx` kodu ve tek cumlelik aciklama gider.
 *
 * Kod araliklari:
 *   1xxx  istemci / kurulum
 *   2xxx  kimlik ve yetki
 *   3xxx  gosterim ingest
 *   4xxx  cuzdan ve adres
 *   5xxx  odeme ve ledger
 *   9xxx  sunucu / beklenmeyen
 */

export const ERROR_CODES = {
  // 1xxx — istemci
  LUL_1001: 'Daemon calismiyor',
  LUL_1002: 'Daemon soketine baglanilamadi',
  LUL_1003: 'Claude Code settings.json bulunamadi',
  LUL_1004: 'settings.json zaten baska bir statusLine iceriyor',
  LUL_1005: 'Istemci surumu cok eski — guncelleme gerekli',
  LUL_1006: 'Kurulum bozuk — `lull doctor` calistir',

  // 2xxx — kimlik
  LUL_2001: 'Giris yapilmamis',
  LUL_2002: 'Device token gecersiz veya iptal edilmis',
  LUL_2003: 'Bu islem icin yetki yok',
  LUL_2004: 'GitHub dogrulamasi tamamlanmadi',

  // 3xxx — gosterim
  LUL_3001: 'Gosterim suresi esigin altinda',
  LUL_3002: 'Nonce gecersiz veya suresi dolmus',
  LUL_3003: 'Gosterim zaten kaydedilmis',
  LUL_3004: 'Aktif kampanya yok',
  LUL_3005: 'Render uzaktan kapatildi',

  // 4xxx — cuzdan
  LUL_4001: 'Gecersiz Arc adresi',
  LUL_4002: 'Bu adres bir program hesabi (PDA) — cuzdan adresi degil',
  LUL_4003: 'Bu adres bir token hesabi — cuzdan adresini gir',
  LUL_4004: 'USDC token hesabi dondurulmus',
  LUL_4005: 'Bu adres USDC mint adresinin kendisi',
  LUL_4006: 'Gizli anahtar girildi — bu cuzdani artik kullanma',
  LUL_4007: 'Bu adres baska bir hesaba bagli',
  LUL_4008: 'Adres degisikligi bekleme suresinde',
  LUL_4009: 'Desteklenmeyen adres tipi',
  LUL_4010: 'Adres sahipligi dogrulanamadi',

  // 5xxx — odeme
  LUL_5001: 'Bakiye odeme esiginin altinda',
  LUL_5002: 'Odeme zaten islemde',
  LUL_5003: 'Odeme gonderildi ama henuz onaylanmadi',
  LUL_5004: 'Odeme basarisiz — ters kayit yazildi',
  LUL_5005: 'Kampanya butcesi yetersiz',
  LUL_5006: 'Ledger invariant ihlali',

  // 9xxx
  LUL_9001: 'Sunucu hatasi',
  LUL_9002: 'Hiz siniri asildi',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** Tel uzerinden giden hata sekli. `v1` icinde bu sekil degismez. */
export interface ErrorEnvelope {
  readonly code: ErrorCode
  /** Kullaniciya gosterilecek tek cumle. */
  readonly message: string
  /** Kullanicinin ne yapmasi gerektigi. Varsa CLI bunu ikinci satira basar. */
  readonly hint?: string
  /** Yalnizca sunucu log'unda iz surmek icin. Kullaniciya gosterilmez. */
  readonly traceId?: string
}

export class LullError extends Error {
  override readonly name = 'LullError'
  readonly code: ErrorCode
  readonly hint: string | undefined
  readonly traceId: string | undefined

  constructor(code: ErrorCode, opts: { hint?: string; traceId?: string; cause?: unknown } = {}) {
    super(ERROR_CODES[code], opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.code = code
    this.hint = opts.hint
    this.traceId = opts.traceId
  }

  toEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      message: ERROR_CODES[this.code],
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    }
  }

  /** CLI ciktisi. Stack trace ASLA basilmaz. */
  toDisplayString(): string {
    return this.hint
      ? `${this.code}: ${this.message}\n  → ${this.hint}`
      : `${this.code}: ${this.message}`
  }
}

export const isErrorCode = (v: unknown): v is ErrorCode =>
  typeof v === 'string' && v in ERROR_CODES
