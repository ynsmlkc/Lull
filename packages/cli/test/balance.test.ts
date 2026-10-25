/**
 * `lull balance`.
 *
 * Bu komut kullanicinin parasini gosteriyor; yanlis bir sayi guveni bitirir.
 * Testlerin cogu "dogru sayi mi" degil, "yaniltici mi" sorusunu soruyor:
 * bekleyen ile odenebiliri karistirmak, esigi gizlemek, ya da odemenin neden
 * yapilmadigini soylememek — hepsi teknik olarak dogru ama pratikte yalan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdBalance, link, type BalanceResponse } from '../src/cli/balance.js'
import { saveCredentials } from '../src/credentials.js'

const ADDR = 'GoodWa11et1111111111111111111111111111111111'

let dir: string
let yazilan: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lull-bal-'))
  process.env['LULL_CREDENTIALS'] = join(dir, 'creds.json')
  yazilan = []
  // `fail()` stderr'e yaziyor, geri kalani stdout'a. Ikisini de yakalamak
  // gerekiyor: hata mesajlarini test etmek istiyoruz.
  const yakala = (s: any): boolean => { yazilan.push(String(s)); return true }
  vi.spyOn(process.stdout, 'write').mockImplementation(yakala)
  vi.spyOn(process.stderr, 'write').mockImplementation(yakala)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['LULL_CREDENTIALS']
  rmSync(dir, { recursive: true, force: true })
})

const ekran = (): string => yazilan.join('')

function girisYap(): void {
  saveCredentials({
    serverUrl: 'https://api.test', token: 'lul_t', publisherId: ADDR,
    tokenId: 't1', loggedInAt: 1,
  })
}

const cevap = (over: Partial<BalanceResponse> = {}): typeof fetch =>
  (async () => new Response(JSON.stringify({
    pendingMicros: '0', payableMicros: '0', inFlightMicros: '0',
    lifetimeMicros: '0', payoutThresholdMicros: '1000000',
    recentPayouts: [], blockedReason: null, ...over,
  }), { status: 200 })) as unknown as typeof fetch

describe('lull balance', () => {
  it('giris yapilmamissa aciklayici hata verir', async () => {
    await expect(cmdBalance([], cevap())).rejects.toThrow()
    expect(ekran()).toContain('lull login')
  })

  /**
   * Bekleyen ile odenebilir AYRI gosterilmek zorunda. Toplamak, dogrulama
   * bir gosterimi reddettiginde bakiyenin dusmesine ve hicbir aciklama
   * olmamasina yol acardi.
   */
  it('bekleyen ve odenebilir AYRI gosterilir', async () => {
    girisYap()
    await cmdBalance([], cevap({ pendingMicros: '3200000', payableMicros: '1500000' }))

    const s = ekran()
    expect(s).toContain('payable')
    expect(s).toContain('$1.5')
    expect(s).toContain('pending')
    expect(s).toContain('$3.2')
    // Toplam ($4.7) HICBIR yerde tek sayi olarak gecmemeli.
    expect(s).not.toContain('$4.7')
  })

  it('bekleyenin henuz para OLMADIGI yaziyor', async () => {
    girisYap()
    await cmdBalance([], cevap({ pendingMicros: '3200000' }))
    expect(ekran()).toContain('awaiting verification')
  })

  it('bakiye sifirken cekilecek bir sey olmadigi soylenir', async () => {
    girisYap()
    await cmdBalance([], cevap({
      payableMicros: '0', payoutThresholdMicros: '1',
      blockedReason: 'threshold 1 micro, balance 0',
    }))
    expect(ekran()).toMatch(/nothing to withdraw yet/)
  })

  it('bakiye varsa istedigi an cekebilecegi soylenir', async () => {
    girisYap()
    await cmdBalance([], cevap({ payableMicros: '2500000' }))
    expect(ekran()).toMatch(/ready to withdraw/)
  })

  /**
   * Esik disinda bir sebep varsa (cuzdan bekleme suresi, dondurulmus USDC hesabi)
   * o da gosterilmeli. "Esige ulasmadin" demek, asil sebep baskayken
   * kullaniciyi bosuna bekletirdi.
   */
  it('esik disi engel sebebi de gosterilir', async () => {
    girisYap()
    await cmdBalance([], cevap({
      payableMicros: '400000',
      blockedReason: 'wallet-change hold, 72 hours remaining',
    }))
    expect(ekran()).toContain('72 hours')
  })

  it('yolda para YOKSA o satir hic cikmaz', async () => {
    girisYap()
    await cmdBalance([], cevap({ inFlightMicros: '0' }))
    expect(ekran()).not.toContain('in flight')
  })

  it('yolda para VARSA gosterilir', async () => {
    girisYap()
    await cmdBalance([], cevap({ inFlightMicros: '700000' }))
    const s = ekran()
    expect(s).toContain('in flight')
    expect(s).toContain('$0.7')
  })

  it('cuzdan adresi TAM gosterilir — kisaltilmaz', async () => {
    girisYap()
    await cmdBalance([], cevap())
    // Kullanici parasinin nereye gidecegini dogrulayabilmeli. Kisaltilmis
    // adres bu kontrolu imkansiz kilar.
    expect(ekran()).toContain(ADDR)
  })

  it('--json ham cevabi basar, suslemez', async () => {
    girisYap()
    await cmdBalance(['--json'], cevap({ payableMicros: '1500000' }))
    const s = ekran().trim()
    expect(JSON.parse(s).payableMicros).toBe('1500000')
    // Ham JSON'un alan adlari zaten Ingilizce (`payableMicros`) — "hicbir
    // suslemesi yok" testi bunu degil, insan-okur GORUNUMUN (dolar isareti,
    // satir basliklari) sizmadigini kontrol ediyor.
    expect(s).not.toContain('$')
  })

  it('401 alinca yeniden giris soylenir', async () => {
    girisYap()
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    await expect(cmdBalance([], f)).rejects.toThrow()
    expect(ekran()).toContain('lull login --force')
  })

  it('ag yokken cokmez, ne oldugunu soyler', async () => {
    girisYap()
    const f = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(cmdBalance([], f)).rejects.toThrow()
    expect(ekran()).toContain('reach the server')
  })

  it('son odemeler tarih ve islem linkiyle listelenir', async () => {
    girisYap()
    await cmdBalance([], cevap({
      recentPayouts: [
        { txHash: 'abc123'.padEnd(64, '0'), amountMicros: '2500000', at: 1_700_000_000_000, state: 'settled' },
      ],
    }))
    const s = ekran()
    expect(s).toContain('recent payouts')
    expect(s).toContain('$2.5')
    expect(s).toContain('abc123')
  })
})

describe('link', () => {
  it('TTY\'de tiklanabilir OSC 8 uretir', () => {
    const l = link('a'.repeat(64), true)
    expect(l).toContain('\u001b]8;;')
    expect(l).toContain('explorer.testnet.arc.io')
  })

  /**
   * Boruya yazarken kacis dizisi GONDERILMEZ. `lull balance | grep` yapan
   * biri gorunmez karakterlerle ugrasmamali.
   */
  it('TTY degilse duz metin — kacis dizisi yok', () => {
    const l = link('a'.repeat(64), false)
    expect(l).not.toContain('\u001b')
    expect(l).not.toContain('\u0007')
    expect(l).toBe('aaaaaaaa…')
  })
})
