/**
 * ADR-020 — hedef adres dogrulamasi.
 *
 * Gercek EVM anahtarlariyla: uydurma adres, "gecerli gorunen" ama yanlis
 * adresleri yakalamaz.
 */

import { describe, it, expect } from 'vitest'
import { generatePrivateKey, privateKeyToAccount, generateMnemonic, english } from 'viem/accounts'
import {
  checkAddress, checkAddressFormat, checkAddressOnChain, normalizeAddress, shortAddress,
  type OnChainAccount, type OnChainCheckInput,
} from '../src/address.js'
import { USDC_ADDRESS } from '../src/arc-rail.js'

const KEY = generatePrivateKey()
const WALLET = privateKeyToAccount(KEY).address

const healthy: OnChainAccount = { isContract: false, isToken: false, blocked: false }
const input = (over: Partial<OnChainCheckInput> = {}, account: Partial<OnChainAccount> = {}): OnChainCheckInput => ({
  address: WALLET, usdcToken: USDC_ADDRESS, boundToOther: false,
  account: { ...healthy, ...account },
  ...over,
})

describe('bicimsel kontroller', () => {
  it('gecerli cuzdan adresi gecer', () => {
    expect(checkAddressFormat(WALLET).ok).toBe(true)
  })

  it('kucuk harfli adres gecer — cuzdanlarin cogu boyle dondurur', () => {
    expect(checkAddressFormat(WALLET.toLowerCase()).ok).toBe(true)
  })

  it('bastaki ve sondaki bosluklari temizler', () => {
    expect(checkAddressFormat(`  ${WALLET}\n`).ok).toBe(true)
  })

  it('checksum bozuk karisik harfli adres reddedilir — yazim hatasi', () => {
    // Bir harfin buyuklugunu degistir: EIP-55 bunu yakalamak icin var.
    const i = [...WALLET].findIndex((ch, n) => n > 1 && /[a-f]/i.test(ch))
    const ch = WALLET[i]!
    const flipped = WALLET.slice(0, i) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + WALLET.slice(i + 1)
    expect(checkAddressFormat(flipped).reason).toBe('gecersiz_bicim')
  })

  for (const bad of ['', 'abc', '0x123', WALLET.slice(0, 41), `${WALLET}00`, 'G'.repeat(42)]) {
    it(`bozuk adres reddedilir: "${bad.slice(0, 12)}"`, () => {
      const r = checkAddressFormat(bad)
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('gecersiz_bicim')
    })
  }

  it('sifir adresi reddedilir — oraya giden para yanar', () => {
    expect(checkAddressFormat(`0x${'0'.repeat(40)}`).reason).toBe('gecersiz_bicim')
  })

  it('adres checksum bicimine cevrilir', () => {
    expect(normalizeAddress(WALLET.toLowerCase())).toBe(WALLET)
    expect(normalizeAddress('bozuk')).toBeNull()
  })
})

describe('gizli anahtar korumasi — EN ONEMLI KONTROL', () => {
  it('0x onekli ozel anahtar yakalanir', () => {
    expect(checkAddressFormat(KEY).reason).toBe('secret_key')
  })

  it('oneksiz ozel anahtar yakalanir', () => {
    expect(checkAddressFormat(KEY.slice(2)).reason).toBe('secret_key')
  })

  it('12 kelimelik kurtarma ifadesi yakalanir', () => {
    expect(checkAddressFormat(generateMnemonic(english)).reason).toBe('secret_key')
  })

  it('24 kelimelik kurtarma ifadesi yakalanir', () => {
    expect(checkAddressFormat(generateMnemonic(english, 256)).reason).toBe('secret_key')
  })

  it('anahtar hata mesajinda GORUNMEZ', () => {
    const r = checkAddressFormat(KEY)
    expect(JSON.stringify(r)).not.toContain(KEY.slice(2, 20))
  })
})

describe('zincir ustu kontroller', () => {
  it('saglikli cuzdan gecer', () => {
    expect(checkAddressOnChain(input()).ok).toBe(true)
  })

  it('USDC adresinin kendisi reddedilir', () => {
    expect(checkAddressOnChain(input({ address: USDC_ADDRESS })).reason).toBe('token_adresi')
  })

  it('token kontrati reddedilir', () => {
    expect(checkAddressOnChain(input({}, { isToken: true })).reason).toBe('token_adresi')
  })

  it('kontrat adresi reddedilir — para orada kilitlenebilir', () => {
    const r = checkAddressOnChain(input({}, { isContract: true }))
    expect(r.reason).toBe('kontrat_adresi')
    expect(r.hint).toMatch(/MetaMask|Rabby/)
  })

  it('engelli adres reddedilir — tum batch\'i dusururdu', () => {
    expect(checkAddressOnChain(input({}, { blocked: true })).reason).toBe('engelli_adres')
  })

  it('baska hesaba bagli adres reddedilir — sybil savunmasi', () => {
    expect(checkAddressOnChain(input({ boundToOther: true })).reason).toBe('baska_hesaba_bagli')
  })
})

describe('checkAddress — iki asama birlikte', () => {
  it('once bicim: gizli anahtar zincire hic sorulmaz', () => {
    expect(checkAddress(input({ address: KEY })).reason).toBe('secret_key')
  })

  it('bicim gecerse zincir kontrolleri calisir', () => {
    expect(checkAddress(input({}, { isContract: true })).reason).toBe('kontrat_adresi')
  })
})

describe('shortAddress', () => {
  it('uzun adresi kisaltir', () => {
    expect(shortAddress(WALLET)).toBe(`${WALLET.slice(0, 6)}…${WALLET.slice(-4)}`)
  })

  it('kisa metni oldugu gibi birakir', () => {
    expect(shortAddress('abc')).toBe('abc')
  })
})
