/**
 * `lull login` — yerel imzalama akisi.
 *
 * Test edilen sey "tarayici acildi mi" degil; yerel sunucunun DISARIYA ne
 * verdigi. Bu surec kisa omurlu ama makinede bir port aciyor: ne servis
 * ettigi, kime servis ettigi ve neyi geri vermedigi onemli.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoginServer, parseLoginArgs, kimligiTazele } from '../src/cli/login.js'
import { saveCredentials, loadCredentials, clearCredentials } from '../src/credentials.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'lull-login-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const GOOD = 'GoodWa11et1111111111111111111111111111111111'

/** Lull sunucusunu taklit eder — cagrilari kaydeder. */
function fakeServer(over: { verify?: unknown; verifyStatus?: number } = {}) {
  const calls: { path: string; body: any }[] = []
  const impl = (async (url: any, init: any) => {
    const path = String(url)
    const body = JSON.parse(String(init.body))
    calls.push({ path, body })
    if (path.endsWith('/v1/auth/challenge')) {
      return new Response(JSON.stringify({
        message: 'lull.test bu Solana hesabiyla giris yapmani istiyor', expiresAt: 9e12,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(
      JSON.stringify(over.verify ?? { token: 'lul_gizli_token', tokenId: 't1', publisherId: GOOD }),
      { status: over.verifyStatus ?? 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Tarayicinin yapacagini yapar: sayfayi al, nonce ile POST at. */
async function browse(url: string) {
  const page = await fetch(url)
  const html = await page.text()
  const nonce = /const NONCE = "([0-9a-f]+)"/.exec(html)?.[1]
  // DIKKAT: varsayilan parametre `undefined`'da devreye girer. Nonce'suz
  // istegi test edebilmek icin acik bir `null` gerekiyor — bu tam olarak
  // testi ilk yazdigimda dusurdugum tuzak: `undefined` gecince nonce YINE
  // gidiyordu ve test guvenligi degil kendini dogruluyordu.
  const post = (path: string, body: unknown, useNonce: string | null | undefined = nonce) =>
    fetch(url.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(useNonce ? { 'x-lull-nonce': useNonce } : {}) },
      body: JSON.stringify(body),
    })
  return { html, nonce, post, status: page.status }
}

/** Sunucuyu baslatir ve URL'sini verir — `openImpl` tarayici yerine gecer. */
function start(fetchImpl: typeof fetch) {
  let resolveUrl!: (u: string) => void
  const url = new Promise<string>((r) => { resolveUrl = r })
  const done = runLoginServer({
    serverUrl: 'https://api.example.test',
    fetchImpl,
    openImpl: (u) => resolveUrl(u),
  })
  // Reddedilirse test cokmesin; bilerek bitmeyen testler var.
  done.catch(() => {})
  return { url, done }
}

describe('runLoginServer', () => {
  it('imzalanmis mesaj dogrulaninca token doner', async () => {
    const srv = fakeServer()
    const { url, done } = start(srv.impl)
    const u = await url

    const b = await browse(u)
    expect(b.status).toBe(200)
    expect(b.nonce).toMatch(/^[0-9a-f]{32}$/)

    await b.post('/challenge', { address: GOOD })
    const vr = await b.post('/verify', { address: GOOD, message: 'msg', signature: 'c2ln' })
    expect(vr.status).toBe(200)

    const result = await done
    expect(result.token).toBe('lul_gizli_token')
    expect(result.publisherId).toBe(GOOD)
    expect(srv.calls.map((c) => c.path.split('/v1')[1])).toEqual(['/auth/challenge', '/auth/verify'])
  })

  /**
   * En onemlisi. Sayfa tarayicida calisiyor; token'i oraya gondermek onu
   * eklentilerin, gecmisin ve kopyala-yapistir kazalarinin menziline sokardi.
   * Tarayicinin token'i BILMESI GEREKMIYOR — yalnizca CLI'nin bilmesi lazim.
   */
  it('token TARAYICIYA geri gonderilmez', async () => {
    const srv = fakeServer()
    const { url, done } = start(srv.impl)
    const b = await browse(await url)

    const vr = await b.post('/verify', { address: GOOD, message: 'msg', signature: 'c2ln' })
    const body = await vr.text()

    expect(body).not.toContain('lul_gizli_token')
    expect(JSON.parse(body)).toEqual({ publisherId: GOOD })
    expect((await done).token).toBe('lul_gizli_token')     // CLI biliyor
  })

  it('nonce\'suz istek reddedilir', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/verify', { address: GOOD, message: 'x', signature: 'x' }, null)
    expect(r.status).toBe(403)
    expect(srv.calls).toHaveLength(0)          // Lull sunucusuna hic gidilmedi
  })

  it('yanlis nonce reddedilir', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/challenge', { address: GOOD }, 'f'.repeat(32))
    expect(r.status).toBe(403)
    expect(srv.calls).toHaveLength(0)
  })

  it('yalnizca 127.0.0.1 dinlenir — ag uzerinden erisilemez', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const u = await url
    expect(u).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(u).not.toContain('0.0.0.0')
  })

  it('sunucu dogrulamayi reddederse akis bitmez, hata sayfaya doner', async () => {
    const srv = fakeServer({ verify: { code: 'LUL_2002', message: 'imza dogrulanamadi' }, verifyStatus: 401 })
    const { url, done } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/verify', { address: GOOD, message: 'kotu', signature: 'kotu' })
    expect(r.status).toBe(401)

    // Sunucu HALA acik: kullanici tekrar deneyebilmeli. Ilk hatada kapatmak,
    // yanlis cuzdani secen birini bastan basa zorlardi.
    const ikinci = await b.post('/challenge', { address: GOOD })
    expect(ikinci.status).toBe(200)

    let bitti = false
    void done.then(() => { bitti = true }, () => { bitti = true })
    await new Promise((r2) => setTimeout(r2, 30))
    expect(bitti).toBe(false)
  })

  it('sayfa disariya baglanti kuramaz (CSP)', async () => {
    const { url } = start(fakeServer().impl)
    const res = await fetch(await url)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    await res.text()
  })

  it('devasa govde bellegi doldurmaz', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)
    const r = await b.post('/challenge', { address: 'x'.repeat(300_000) })
    expect(r.status).toBe(500)
    expect(srv.calls).toHaveLength(0)
  })

  it('GET disi ve bilinmeyen yollar 404', async () => {
    const { url } = start(fakeServer().impl)
    const u = await url
    expect((await fetch(u + 'baska')).status).toBe(404)
  })
})

describe('parseLoginArgs', () => {
  it('--server bayragi ortam degiskenini ezer', () => {
    process.env['LULL_SERVER'] = 'https://ortam.test'
    expect(parseLoginArgs(['--server', 'https://bayrak.test']).serverUrl).toBe('https://bayrak.test')
    expect(parseLoginArgs([]).serverUrl).toBe('https://ortam.test')
    delete process.env['LULL_SERVER']
  })

  it('sondaki slash temizlenir — yoksa `//v1/...` olusur', () => {
    expect(parseLoginArgs(['--server', 'https://a.test///']).serverUrl).toBe('https://a.test')
  })

  it('--no-browser taninir', () => {
    expect(parseLoginArgs(['--no-browser']).noBrowser).toBe(true)
  })
})

describe('credentials', () => {
  it('dosya yalnizca sahibi tarafindan okunabilir (0600)', () => {
    const p = join(tmp(), 'creds.json')
    saveCredentials({ serverUrl: 'https://a.test', token: 'lul_x', publisherId: GOOD, tokenId: 't', loggedInAt: 1 }, p)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readFileSync(p, 'utf8')).toContain('lul_x')
  })

  it('eksik alanli dosya "giris yapilmamis" sayilir', () => {
    const p = join(tmp(), 'creds.json')
    saveCredentials({ serverUrl: 'https://a.test', token: '', publisherId: GOOD, tokenId: 't', loggedInAt: 1 }, p)
    expect(loadCredentials(p)).toBeNull()
  })

  it('bozuk JSON cokmez, null doner', () => {
    const d = tmp()
    const p = join(d, 'creds.json')
    require('node:fs').writeFileSync(p, '{ yarim')
    expect(loadCredentials(p)).toBeNull()
  })

  it('olmayan dosya null doner, silme false', () => {
    const p = join(tmp(), 'yok.json')
    expect(loadCredentials(p)).toBeNull()
    expect(clearCredentials(p)).toBe(false)
  })

  it('gidis donus bozulmaz', () => {
    const p = join(tmp(), 'creds.json')
    const c = { serverUrl: 'https://a.test', token: 'lul_x', publisherId: GOOD, tokenId: 't1', loggedInAt: 42 }
    saveCredentials(c, p)
    expect(loadCredentials(p)).toEqual(c)
    expect(clearCredentials(p)).toBe(true)
    expect(loadCredentials(p)).toBeNull()
  })
})

/**
 * Yerel sunucu artik zincire HIC gitmez: USDC hesabi (ATA) ilk odemede
 * gonderen tarafindan acildigi icin "hesap kontrolu" ucu kalmadi. Eski uc
 * tanimsiz olmali — sayfa baska bir yere baglanamamali.
 */
describe('kaldirilan uclar', () => {
  it('eski hesap-kontrol ucu yok', async () => {
    const { url } = start(fakeServer().impl)
    const b = await browse(await url)
    const r = await b.post('/token-hesabi', { address: GOOD })
    expect(r.status).toBe(404)
  })
})

/** Sayfa dogru portu gosteriyor mu — kullanici adresi oradan okuyor. */
describe('giris sayfasi', () => {
  it('kendi portunu gosterir', async () => {
    const { url } = start(fakeServer().impl)
    const u = await url
    const port = new URL(u).port
    const html = await (await fetch(u)).text()
    expect(html).toContain(`127.0.0.1:${port}`)
  })
})

/**
 * Giristen sonra daemon yeni kimligi ALMALI.
 *
 * Gercekte yasandi: kullanici cuzdanini degistirip yeniden giris yapti,
 * "giris yapildi" gordu, reklam donmeye devam etti — ama daemon eski
 * kimlikle calistigi icin kazanc ESKI cuzdana yaziliyordu. Kimlik dosyadan
 * yalnizca acilista okunuyor.
 *
 * Onceden burada "daemon calisiyorsa `lull restart` yap" diye bir dipnot
 * vardi. Dipnot, sessizce yanlis hesaba para yazan bir durumu cozmez.
 */
describe('giristen sonra daemon kimligi', () => {
  const yakala = () => {
    const satirlar: string[] = []
    const orijinal = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((s: string) => { satirlar.push(String(s)); return true }) as typeof process.stdout.write
    return { satirlar, bitir: () => { process.stdout.write = orijinal } }
  }

  it('daemon calisiyorsa yeniden baslatilir', async () => {
    let cagrildi = 0
    const c = yakala()
    await kimligiTazele(async () => { cagrildi++; return { pid: 4242 } })
    c.bitir()
    expect(cagrildi).toBe(1)
    expect(c.satirlar.join('')).toContain('4242')
  })

  it('daemon calismiyorsa hicbir sey soylenmez', async () => {
    const c = yakala()
    await kimligiTazele(async () => null)
    c.bitir()
    expect(c.satirlar.join('')).toBe('')
  })

  /**
   * En onemlisi: basarisizlik SESSIZ GECILEMEZ. Kullanici bu durumda
   * kazancinin eski cuzdana gittigini bilmeli.
   */
  it('yeniden baslatilamazsa UYARIR ve ne yapacagini soyler', async () => {
    const c = yakala()
    await kimligiTazele(async () => ({ error: 'port mesgul' }))
    c.bitir()
    const cikti = c.satirlar.join('')
    expect(cikti).toContain('port mesgul')
    expect(cikti).toContain('lull restart')
    expect(cikti).toContain('OLD')          // sonucunu acikca yazar
  })

  it('basarisizlikta sessizce basarili gibi davranmaz', async () => {
    const c = yakala()
    await kimligiTazele(async () => ({ error: 'x' }))
    c.bitir()
    expect(c.satirlar.join('')).not.toContain('running with the new identity')
  })
})

/**
 * Istege bagli siralama adimi — giristen SONRA ayni sayfada.
 *
 * Korunan: token tarayiciya gitmez (istekler yerel surecten iletilir),
 * giristen once profil uclari kapali, kaydetme/atlama sunucuyu kapatir,
 * giris sonucu siralama adimini BEKLEMEZ (kimlik hemen kaydedilir).
 */
describe('siralama adimi', () => {
  function profileServer(profile: unknown = null) {
    const calls: { path: string; method: string; auth: string | null; body: any }[] = []
    const impl = (async (url: any, init: any = {}) => {
      const path = String(url)
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : null
      calls.push({ path, method, auth: (init.headers ?? {})['authorization'] ?? null, body })
      const reply = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
      if (path.endsWith('/v1/auth/challenge')) return reply({ transaction: 'AAAAfake', network_passphrase: 'Test SDF Network ; September 2015', expiresAt: 9e12 })
      if (path.endsWith('/v1/auth/verify')) return reply({ token: 'lul_gizli_token', tokenId: 't1', publisherId: GOOD })
      if (path.endsWith('/v1/me/profile') && method === 'GET') return reply({ profile, suggestedCountry: 'TR' })
      if (path.endsWith('/v1/me/profile') && method === 'PUT') return reply({ profile: body })
      return reply({ message: 'not found' }, 404)
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  async function loggedIn(srv: ReturnType<typeof profileServer>) {
    const { url, done } = start(srv.impl)
    const b = await browse(await url)
    await b.post('/challenge', { address: GOOD })
    await b.post('/verify', { address: GOOD, transaction: 'AAAAsigned' })
    return { b, done }
  }

  it('giristen once profil uclari kapali', async () => {
    const { url } = start(profileServer().impl)
    const b = await browse(await url)
    expect((await b.post('/profile/get', {})).status).toBe(409)
    expect((await b.post('/profile/save', { nickname: 'ada', listed: true })).status).toBe(409)
  })

  it('giris sonucu siralama adimini beklemez', async () => {
    const { done } = await loggedIn(profileServer())
    await expect(done).resolves.toMatchObject({ publisherId: GOOD })
  })

  it('profil yerel surecten token ile okunur; token sayfaya donmez', async () => {
    const srv = profileServer({ nickname: 'ada', country: null, listed: false })
    const { b } = await loggedIn(srv)
    const r = await b.post('/profile/get', {})
    const text = await r.text()
    expect(JSON.parse(text)).toEqual({ profile: { nickname: 'ada', country: null, listed: false }, suggestedCountry: 'TR' })
    expect(text).not.toContain('lul_gizli_token')
    const call = srv.calls.find((c) => c.path.endsWith('/v1/me/profile'))!
    expect(call).toMatchObject({ method: 'GET', auth: 'Bearer lul_gizli_token' })
  })

  it('kaydetme PUT gonderir ve sunucuyu kapatir', async () => {
    const srv = profileServer()
    const { b } = await loggedIn(srv)
    const r = await b.post('/profile/save', { nickname: 'ada', country: 'TR', listed: true, extra: 'drop me' })
    expect(r.status).toBe(200)
    expect(srv.calls.at(-1)).toMatchObject({ method: 'PUT', body: { nickname: 'ada', country: 'TR', listed: true } })
    await new Promise((res) => setTimeout(res, 300))
    await expect(b.post('/profile/get', {})).rejects.toThrow()
  })

  it('atlamak sunucuyu kapatir ve Lull sunucusuna profil yazmaz', async () => {
    const srv = profileServer()
    const { b } = await loggedIn(srv)
    expect((await b.post('/profile/skip', {})).status).toBe(200)
    expect(srv.calls.some((c) => c.method === 'PUT')).toBe(false)
    await new Promise((res) => setTimeout(res, 300))
    await expect(b.post('/profile/get', {})).rejects.toThrow()
  })

  it('sayfa ulke kodlarini ve gizli siralama kutusunu tasir; kutu isaretsiz', async () => {
    const { url } = start(profileServer().impl)
    const b = await browse(await url)
    expect(b.html).toContain('id="profilebox"')
    expect(b.html).toMatch(/class="manual hide" id="profilebox"/)
    expect(b.html).toContain('"TR"')
    expect(b.html).not.toMatch(/id="p-listed"[^>]*checked/)
  })
})
