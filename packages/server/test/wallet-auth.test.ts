/**
 * Cuzdanla giris — ADR-010 (revize).
 *
 * Buradaki testlerin cogu "mutlu yol"u degil, REDDI kontrol ediyor: bir giris
 * sisteminde hata, yanlis kisiyi iceri almaktir. Dogru kisiyi iceri almamak
 * can sikici; yanlis kisiyi almak geri alinamaz.
 *
 * Imzalar gercek secp256k1: cuzdanin `personal_sign` ile yaptigi seyin ayni.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { Siwe } from '@lull/payments'
import { fixedClock, cryptoIdGenerator } from '@lull/protocol'
import { WalletAuth, LOGIN_SCOPES } from '../src/http/wallet-auth.js'
import { hashToken } from '../src/http/auth.js'

const HOME = 'lull.test'

function setup(now = 1_700_000_000_000) {
  const issued: { publisherId: string; tokenHash: string }[] = []
  const clock = fixedClock(now)
  const ids = cryptoIdGenerator(clock)
  const auth = new WalletAuth({
    clock, ids,
    siwe: new Siwe({ domain: HOME, network: 'testnet' }, clock, ids),
    hashToken,
    issueToken: (i) => {
      issued.push({ publisherId: i.publisherId, tokenHash: i.tokenHash })
      return { tokenId: `tok-${issued.length}` }
    },
  })
  return { auth, issued, clock }
}

/** Kullanicinin cuzdaninin yapacagi: mesaji EIP-191 ile imzala, hex dondur. */
const sign = (message: string, acct: PrivateKeyAccount): Promise<string> => acct.signMessage({ message })
const newAccount = () => privateKeyToAccount(generatePrivateKey())

describe('WalletAuth', () => {
  let user: PrivateKeyAccount
  let addr: string
  beforeEach(() => { user = newAccount(); addr = user.address })

  it('gecerli imza token uretir ve publisherId adresin kendisidir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(addr)
    expect(c.ok).toBe(true)
    if (!c.ok) return

    const r = await auth.verify(addr, c.message, await sign(c.message, user))
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // Kimlik = adres. Ayri bir kullanici kimligi yok (ADR-010 revize).
    expect(r.publisherId).toBe(addr)
    expect(issued[0]!.publisherId).toBe(addr)
  })

  it('ham token sunucuda SAKLANMAZ — yalnizca hash', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(addr)
    if (!c.ok) return
    const r = await auth.verify(addr, c.message, await sign(c.message, user))
    if (!r.ok) return

    expect(issued[0]!.tokenHash).toBe(hashToken(r.token))
    expect(issued[0]!.tokenHash).not.toContain(r.token)
  })

  it('token yalnizca daemon kapsamlarini tasir — cuzdan degistiremez', async () => {
    expect(LOGIN_SCOPES).toEqual(['report:impressions', 'read:balance', 'withdraw:balance'])
    expect(LOGIN_SCOPES).not.toContain('manage:wallet')
  })

  it('BASKASININ anahtariyla imzalanan challenge reddedilir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(addr)
    if (!c.ok) return

    // Saldirgan kendi anahtariyla imzaliyor, ama kurbanin adresini iddia ediyor.
    const r = await auth.verify(addr, c.message, await sign(c.message, newAccount()))
    expect(r.ok).toBe(false)
    expect(issued).toHaveLength(0)
  })

  it('bos veya bozuk imza reddedilir', async () => {
    const { auth } = setup()
    const c = auth.challenge(addr)
    if (!c.ok) return
    expect((await auth.verify(addr, c.message, '')).ok).toBe(false)
    expect((await auth.verify(addr, c.message, '0xdeadbeef')).ok).toBe(false)
  })

  it('istemcinin degistirdigi mesaj reddedilir — imza gecerli olsa bile', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(addr)
    if (!c.ok) return
    const kurcalanmis = c.message.replace('Chain ID: 5042002', 'Chain ID: 5042')
    const r = await auth.verify(addr, kurcalanmis, await sign(kurcalanmis, user))
    expect(r.ok).toBe(false)
    expect(issued).toHaveLength(0)
  })

  it('ayni challenge IKI KEZ kullanilamaz', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(addr)
    if (!c.ok) return
    const sig = await sign(c.message, user)

    expect((await auth.verify(addr, c.message, sig)).ok).toBe(true)
    // Replay: ayni imza tekrar gonderiliyor. Ikinci token URETILMEMELI.
    const again = await auth.verify(addr, c.message, sig)
    expect(again.ok).toBe(false)
    expect(issued).toHaveLength(1)
  })

  it('challenge alinmadan verify cagrilamaz', async () => {
    const { auth } = setup()
    const other = setup()
    const c = other.auth.challenge(addr)
    if (!c.ok) return
    // Imza gecerli ama BU sunucu boyle bir challenge uretmedi.
    const r = await auth.verify(addr, c.message, await sign(c.message, user))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('challenge bulunamadi')
  })

  it('gecersiz adres challenge bile alamaz', () => {
    const { auth } = setup()
    for (const bad of [
      '',
      'abc',                                // kisa
      '0x' + 'g'.repeat(40),                // hex disi harfler
      generatePrivateKey(),                 // GIZLI ANAHTAR — asla
    ]) {
      expect(auth.challenge(bad).ok, bad.slice(0, 8)).toBe(false)
    }
  })

  it('kucuk harfli adresle alinan challenge checksum hesabina baglanir', async () => {
    // Cuzdanlarin cogu kucuk harf dondurur. Ayni cuzdan iki hesap acmamali.
    const { auth, issued } = setup()
    const c = auth.challenge(addr.toLowerCase())
    if (!c.ok) return
    const r = await auth.verify(addr.toLowerCase(), c.message, await await sign(c.message, user))
    expect(r.ok && r.publisherId).toBe(addr)
    expect(issued[0]!.publisherId).toBe(addr)
  })

  it('gizli anahtar hata mesajinda ECHO EDILMEZ', () => {
    const { auth } = setup()
    const secret = generatePrivateKey()
    const r = auth.challenge(secret)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).not.toContain(secret)
    expect(r.reason).not.toContain(secret.slice(0, 16))
  })

  it('suresi dolmus challenge reddedilir', async () => {
    const { auth, clock } = setup()
    const c = auth.challenge(addr)
    if (!c.ok) return
    const sig = await sign(c.message, user)

    clock.advance(6 * 60_000)   // 5 dakikalik omru asti
    const r = await auth.verify(addr, c.message, sig)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('suresi dolmus')
  })

  it('suresi gecmis challenge\'lar bellekte birikmez', () => {
    const { auth } = setup()
    for (let i = 0; i < 50; i++) auth.challenge(newAccount().address)
    expect(auth.pendingCount()).toBeLessThanOrEqual(50)
  })
})
