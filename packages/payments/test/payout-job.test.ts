/**
 * Odeme job'i testleri.
 *
 * Kivilcim 2'de GORDUGUMUZ ariza modlarinin hepsi burada
 * deterministik olarak uretiliyor.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, micros, type Micros } from '@linger/protocol'
import { PayoutJob, type PayoutCandidate } from '../src/payout-job.js'
import { WalletStore } from '../src/wallet.js'
import { MockRail } from './mock-rail.js'
import type { PayoutItem, SubmissionReceipt } from '../src/rail.js'

const addr = (n: number) => `Wallet${String(n).padStart(2, '0')}`.padEnd(44, '1')

let clock: ReturnType<typeof fixedClock>
let wallets: WalletStore
let rail: MockRail
let events: string[]
let batchSeq: number

function setup(opts: {
  rail?: ConstructorParameters<typeof MockRail>[0]
  candidates?: PayoutCandidate[]
  publishers?: number
  batchSize?: number
} = {}) {
  clock = fixedClock(1_700_000_000_000)
  wallets = new WalletStore({ clock, notify: () => {} })
  rail = new MockRail(opts.rail)
  events = []
  batchSeq = 0

  const n = opts.publishers ?? 3
  for (let i = 1; i <= n; i++) {
    wallets.bind(`p${i}`, addr(i), 'testnet')
    rail.addressMap[`p${i}`] = addr(i)
  }

  const candidates = opts.candidates
    ?? Array.from({ length: n }, (_, i) => ({ publisherId: `p${i + 1}`, payable: micros(50_000_000n) }))

  const job = new PayoutJob({
    clock, rail, wallets,
    candidates: () => candidates,
    threshold: micros(10_000_000n),
    batchSize: opts.batchSize ?? 6,
    newBatchId: () => `b${++batchSeq}`,
    onSubmit: (id, items, r) => events.push(`submit:${id}:${items.length}:${r.txHash}`),
    onSettled: (id, items) => events.push(`settled:${id}:${items.length}`),
    onFailed: (id, items, reason) => events.push(`failed:${id}:${reason}`),
    onSkipped: (p, reason) => events.push(`skip:${p}:${reason}`),
  })
  return job
}

describe('mutlu yol', () => {
  it('uygun herkes odenir', async () => {
    const r = await setup().run()
    expect(r.paid).toBe(3)
    expect(r.failed).toBe(0)
    expect(r.totalPaid).toBe(150_000_000n)
    expect(events).toContain('settled:b1:3')
  })

  it('kayit submit\'ten ONCE yazilir — §8 tuzak #9', async () => {
    await setup().run()
    // `submit` olayi `settled`'dan once gelmeli: cevap gelmese bile
    // "yolda" kaydi durmali.
    expect(events.findIndex((e) => e.startsWith('submit:')))
      .toBeLessThan(events.findIndex((e) => e.startsWith('settled:')))
  })

  it('esigin altindakiler hic denenmez', async () => {
    const r = await setup({
      candidates: [
        { publisherId: 'p1', payable: micros(50_000_000n) },
        { publisherId: 'p2', payable: micros(1_000_000n) },   // esigin altinda
      ],
    }).run()
    expect(r.paid).toBe(1)
    expect(rail.submitted[0]!.opIndex).toHaveLength(1)
  })
})

describe('§8 tuzak #1 — tek bozuk hedef tum batch\'i dusurur', () => {
  it('engelli hedef batch\'e HIC ALINMAZ', async () => {
    const r = await setup({
      rail: { destinations: { [addr(2)]: { blocked: true } } },
    }).run()

    expect(r.skipped).toBe(1)
    expect(r.paid, 'digerleri odenmeli').toBe(2)
    expect(events).toContainEqual(expect.stringMatching(/skip:p2:adres USDC ihraccisi tarafindan engellenmis/))
  })

  it('USDC hesabi (ATA) olmayan hedef ENGEL DEGIL — rail olusturur', async () => {
    // ATA yoksa hedef elenmez: gonderen ATA'yi kendisi acar.
    const r = await setup({
      rail: { destinations: { [addr(2)]: {} } },
    }).run()
    expect(r.skipped).toBe(0)
    expect(r.paid).toBe(3)
  })

  it('on kontrol atlanirsa TUM batch patlar', async () => {
    // Bu senaryo dogrulamanin neden batch kurulmadan HEMEN once yapildigini
    // gosteriyor: hedef arada bozulursa 3 masum publisher da odeme alamaz.
    const r = await setup({ rail: { failingAddress: addr(2) } }).run()

    expect(r.paid).toBe(0)
    expect(r.failed).toBe(3)
    expect(events).toContainEqual(expect.stringMatching(/failed:b1:tx basarisiz: p2=custom:3/))
  })

  it('suclu operation INDEKSINDEN bulunur — op_index zorunlu', async () => {
    await setup({ rail: { failingAddress: addr(3) } }).run()
    const failed = events.find((e) => e.startsWith('failed:'))!
    expect(failed, 'suclu ismen raporlanmali').toContain('p3=custom:3')
    expect(failed).not.toContain('p1=custom:3')
  })
})

describe('§8 tuzak #7 — patlayan tx de ledger\'a girer', () => {
  it('basarisiz batch "odendi" SAYILMAZ', async () => {
    const r = await setup({ rail: { failingAddress: addr(1) } }).run()
    expect(r.paid).toBe(0)
    expect(events).not.toContainEqual(expect.stringMatching(/^settled:/))
    // Ters kayit yazilmali — para publisher'a donmeli.
    expect(events).toContainEqual(expect.stringMatching(/^failed:/))
  })
})

describe('hedef eleme', () => {
  const cases: [string, any, RegExp][] = [
    ["gecersiz adres", { valid: false }, /gecersiz/],
    ["token kontrati", { isToken: true }, /token kontrati/],
    ['kontrat', { isContract: true }, /kontrat, cuzdan degil/],
    ["engelli adres", { blocked: true }, /engellenmis/],
  ]

  for (const [name, dest, pattern] of cases) {
    it(`${name} → dusurulur, sebebi bildirilir`, async () => {
      const r = await setup({ rail: { destinations: { [addr(2)]: dest } } }).run()
      expect(r.skipped).toBe(1)
      expect(events.find((e) => e.startsWith('skip:p2'))).toMatch(pattern)
    })
  }
})

describe('ADR-014 — bekleme suresindeki hesap odenmez', () => {
  it('adres degistirmis publisher batch\'ten dusurulur', async () => {
    const job = setup()
    wallets.bind('p2', addr(99), 'testnet')      // adres degisti → 72 saat

    const r = await job.run()
    expect(r.paid).toBe(2)
    expect(events.find((e) => e.startsWith('skip:p2'))).toMatch(/72 saat kaldi/)
  })

  it('bekleme dolunca odenir', async () => {
    const job = setup()
    wallets.bind('p2', addr(99), 'testnet')
    rail.addressMap['p2'] = addr(99)
    clock.advance(73 * 3600_000)

    expect((await job.run()).paid).toBe(3)
  })
})

describe('ADR-015 — sicak cuzdan', () => {
  it('Operator gazi yetersizse HICBIR odeme yapilmaz', async () => {
    // Kasa dolu ama gazi biten operator sessizce durur; alarm ureten tek sey bu.
    const r = await setup({ rail: { availableGas: 1_000n } }).run()
    expect(r.batches).toBe(0)
    expect(r.paid).toBe(0)
    expect(r.alerts).toContainEqual(expect.stringMatching(/gazi yetersiz/))
  })

  it('USDC yetersizse alarm uretilir', async () => {
    const r = await setup({ rail: { usdcBalance: 1_000_000n } }).run()
    expect(r.alerts).toContainEqual(expect.stringMatching(/USDC yetersiz/))
  })
})

describe('ADR-006 — batch boyutu', () => {
  it('6\'sar 6\'sar bolunur', async () => {
    const r = await setup({ publishers: 25, batchSize: 6 }).run()
    expect(r.batches).toBe(5)
    expect(r.paid).toBe(25)
    expect(rail.submitted.map((s) => s.opIndex.length)).toEqual([6, 6, 6, 6, 1])
  })

  it('kucuk batch patlama yaricapini sinirlar', async () => {
    // 25 hedeften biri bozuk. p15 ucuncu batch'te (13-18 arasi), yani
    // yalnizca o batch duser. Tek buyuk batch olsaydi 25 kisi de odenmezdi.
    const r = await setup({
      publishers: 25, batchSize: 6,
      rail: { failingAddress: addr(15) },
    }).run()
    expect(r.paid, 'diger dort batch kurtulur').toBe(19)
    expect(r.failed, 'yalnizca ucuncu batch').toBe(6)
  })
})

describe('§8 tuzak #10 — belirsizlik ve nonce', () => {
  it('gecici pending sonrasi AYNI transaction tekrar gonderilir', async () => {
    const r = await setup({ rail: { pendingRounds: 2 } }).run()
    expect(r.paid).toBe(3)
    // Ilk gonderim + iki yeniden gonderim. Ucu de AYNI byte'lar.
    expect(rail.resubmits, 'yeniden insa DEGIL, ayni byte\'lar').toEqual(['tx-b1', 'tx-b1', 'tx-b1'])
    // Transaction yalnizca BIR KEZ kuruldu. Yeniden kurmak yeni nonce ve
    // yeni imza uretirdi.
    expect(rail.prepared, 'transaction tek kez kurulur').toHaveLength(1)
  })

  it('nonce harcanmadan ASLA yeni transaction kurulmaz', async () => {
    // "Zincirde yok" tek basina anlamsizdir; yeniden
    // kurmak cift odeme uretir.
    const r = await setup({ rail: { neverIncluded: true } }).run()
    expect(rail.prepared, 'ikinci transaction kurulmadi').toHaveLength(1)
    expect(r.paid).toBe(0)
  })

  it('nonce harcaninca olu sayilir ve ters kayit yazilir', async () => {
    // Karari rail verir: son gecerli blok yuksekligi asildi ve imza hala yok.
    const r = await setup({ rail: { neverIncludedAndExpired: true } }).run()
    expect(events).toContainEqual(expect.stringMatching(/failed:.*nonce/))
    expect(r.paid).toBe(0)
  })
})

describe('transaction kurulamazsa', () => {
  it('hicbir kayit yazilmaz — aga zaten hicbir sey gitmedi', async () => {
    const r = await setup({ rail: { throwOnPrepare: true } }).run()
    expect(events).toHaveLength(0)
    expect(r.alerts).toContainEqual(expect.stringMatching(/hazirlanamadi/))
  })
})

describe('gonderim patlarsa', () => {
  /**
   * Transaction kuruldu, defter yazildi, sonra ag reddetti.
   *
   * Kayit SILINMEZ: hash elimizde, zincire sorulabilir. Hemen iade etmek,
   * "ag reddetti" iddiasi yanlissa cifte odeme uretirdi — karar zincirin.
   */
  it('kayit yazilmis kalir, karar zincire birakilir', async () => {
    const r = await setup({ rail: { throwOnSend: true } }).run()
    expect(events.some((e) => e.startsWith('submit:')), 'defter yazildi').toBe(true)
    expect(r.alerts).toContainEqual(expect.stringMatching(/gonderilemedi/))
  })
})

describe('cuzdan bagli degilse', () => {
  it('odeme denenmez', async () => {
    const job = setup({ candidates: [{ publisherId: 'bagli-degil', payable: micros(50_000_000n) }] })
    const r = await job.run()
    expect(r.skipped).toBe(1)
    expect(events[0]).toMatch(/cuzdan bagli degil/)
  })
})
