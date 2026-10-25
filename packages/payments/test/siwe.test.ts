/**
 * Cuzdan giris imzasi (SIWE) — ADR-014.
 *
 * Gercek secp256k1 imzalariyla: cuzdanin `personal_sign` yaptigi seyin ayni.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { fixedClock, fakeIdGenerator } from '@lull/protocol'
import { Siwe } from '../src/siwe.js'

const DOMAIN = 'lull.example'

let clock: ReturnType<typeof fixedClock>
let siwe: Siwe
let user: PrivateKeyAccount

/** Cuzdanin yaptigi: EIP-191 onekiyle mesaji imzala, 65 bayt hex dondur. */
const sign = (acct: PrivateKeyAccount, message: string): Promise<string> => acct.signMessage({ message })

const newAccount = () => privateKeyToAccount(generatePrivateKey())

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  siwe = new Siwe({ domain: DOMAIN, network: 'testnet', ttlSec: 300 }, clock, fakeIdGenerator())
  user = newAccount()
})

describe('challenge', () => {
  it('mesaj alan adini, adresi ve zincir kimligini icerir', () => {
    const c = siwe.challenge(user.address)
    expect(c.message).toContain(DOMAIN)
    expect(c.message).toContain(user.address)
    expect(c.message).toContain('Chain ID: 5042002')
  })

  it('kucuk harfli adres mesajda checksum bicimine cevrilir', () => {
    expect(siwe.challenge(user.address.toLowerCase()).message).toContain(user.address)
  })

  it('mainnet zincir kimligi 5042', () => {
    const m = new Siwe({ domain: DOMAIN, network: 'mainnet' }, clock, fakeIdGenerator())
    expect(m.challenge(user.address).message).toContain('Chain ID: 5042\n')
  })

  it('kullaniciya bunun bir islem olmadigini soyler', () => {
    expect(siwe.challenge(user.address).message).toMatch(/islem degildir/)
  })

  it('her challenge farkli nonce tasir', () => {
    const a = siwe.challenge(user.address).message
    const b = siwe.challenge(user.address).message
    expect(a).not.toBe(b)
  })

  it('suresi ttl kadar', () => {
    expect(siwe.challenge(user.address).expiresAt).toBe(clock.now() + 300_000)
  })
})

describe('verify', () => {
  it('dogru imza kabul edilir', async () => {
    const { message } = siwe.challenge(user.address)
    const r = await siwe.verify(user.address, message, message, await sign(user, message))
    expect(r).toEqual({ ok: true, account: user.address })
  })

  it('kucuk harfli adresle gelen giris checksum hesabina baglanir', async () => {
    const { message } = siwe.challenge(user.address)
    const r = await siwe.verify(user.address.toLowerCase(), message, message, await sign(user, message))
    expect(r).toEqual({ ok: true, account: user.address })
  })

  it('BASKA anahtarla atilan imza reddedilir', async () => {
    const { message } = siwe.challenge(user.address)
    const r = await siwe.verify(user.address, message, message, await sign(newAccount(), message))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('gecersiz_imza')
  })

  it('istemcinin kendi sectigi mesaj kabul edilmez — imza gecerli olsa bile', async () => {
    // Saldirgan kendi metnini imzalatip gonderir. Sunucu yalnizca URETTIGI
    // mesajin imzasini kabul eder.
    const { message } = siwe.challenge(user.address)
    const evil = message.replace('Nonce:', 'Nonce: 0000')
    const r = await siwe.verify(user.address, message, evil, await sign(user, evil))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('mesaj_uyusmuyor')
  })

  it('suresi dolmus challenge reddedilir', async () => {
    const { message } = siwe.challenge(user.address)
    clock.advance(301_000)
    const r = await siwe.verify(user.address, message, message, await sign(user, message))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('suresi_dolmus')
  })

  it('bozuk imza uzunlugu reddedilir', async () => {
    const { message } = siwe.challenge(user.address)
    const r = await siwe.verify(user.address, message, message, '0xdeadbeef')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('gecersiz_imza')
  })

  it('bozuk adres reddedilir', async () => {
    const { message } = siwe.challenge('x')
    const r = await siwe.verify('bozuk', message, message, await sign(user, message))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('gecersiz_adres')
  })

  it('imza baska adrese ait mesaj icin gecerli olsa da bu adrese baglanmaz', async () => {
    const other = newAccount()
    const { message } = siwe.challenge(other.address)
    // `user` adresi icin, `other` icin uretilmis mesaj sunuluyor.
    const r = await siwe.verify(user.address, siwe.challenge(user.address).message, message, await sign(other, message))
    expect(r.ok).toBe(false)
  })
})
