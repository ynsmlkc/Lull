#!/usr/bin/env node
/**
 * Sunucu giris noktasi — gelistirme.
 *
 * Su an her sey BELLEKTE: ledger, kampanyalar, gosterimler. Postgres
 * arayuzun arkasina sonra girecek (`LedgerStore` zaten soyut).
 *
 * Amac: daemon'in gercek bir sunucuya baglanabilmesi. Kampanyalar elle
 * tanimli (ADR-009: MVP'de admin-only), reklamveren bakiyesi elle yatirilmis
 * (ADR-021: yatirma akisi sonra).
 */

import { serve } from '@hono/node-server'
import { systemClock, cryptoIdGenerator, micros, FALLBACK_CONFIG } from '@lull/protocol'
import type { RemoteConfig } from '@lull/protocol'
import { createApp } from './http/app.js'
import { hashToken } from './http/auth.js'
import { WalletAuth } from './http/wallet-auth.js'
import { serveStatic } from '@hono/node-server/serve-static'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pipeline } from './pipeline.js'
import { readServerEnv } from './env.js'
import { Ledger } from './ledger/ledger.js'
import { CampaignStore } from './ads/campaign-store.js'
import { DepositWatcher, sqliteCursor } from './advertisers/deposits.js'
import { WithdrawService, createSerial } from './payouts/withdraw.js'
import { accountId, PLATFORM_REVENUE } from './ledger/accounts.js'
import { openDb, MEMORY, vacuumExpired } from './store/db.js'
import {
  SqliteLedgerStore, SqliteTokenStore, SqlitePayoutStore,
  SqliteImpressionMirror, walletPersistence, profilePersistence,
} from './store/persistent.js'
import { ProfileStore } from './leaderboard/profiles.js'
import { Leaderboard } from './leaderboard/leaderboard.js'
import { openCountryDb } from './leaderboard/geo.js'
import { PoolStore } from './pools/pool-store.js'
import { poolReserve, poolCampaignIds, type ReserveDeps } from './pools/reserve.js'
import { randomBytes } from 'node:crypto'
import { PayoutRunner } from './payouts/runner.js'
import {
  ArcRail, ArcDepositSource, Siwe, USDC_ADDRESS, RPC_URL, CHAIN_ID, normalizeAddress,
  type Network,
} from '@lull/payments'
import { WalletStore } from '@lull/payments'

const PORT = Number(process.env['PORT'] ?? 8787)
// Yerelde YALNIZCA loopback. Konteynerde 0.0.0.0 gerekiyor ve orada
// `HOST` acikca veriliyor (Dockerfile). Varsayilani 0.0.0.0 yapmak,
// gelistirirken sunucuyu farkinda olmadan tum yerel aga acardi.
const HOST = process.env['HOST'] ?? '127.0.0.1'

/**
 * Gelistirme token'i.
 *
 * Uretimde OLUSTURULMAZ. Sabit degeri bu dosyada yaziyor ve repo herkese
 * acik: uretimde de eklenseydi, repoyu okuyan herkesin elinde gecerli bir
 * token olurdu ve istedigi kadar gosterim bildirebilirdi.
 *
 * Uretimde token'lar yalnizca `lull login` ile, cuzdan imzasi karsiliginda
 * uretilir.
 */
const ENV = readServerEnv(process.env)
const IS_PROD = ENV.isProd
const DEV_TOKEN = IS_PROD ? null : (process.env['LULL_DEV_TOKEN'] ?? 'lul_dev_token_0123456789abcdef0123')
const DEV_PUBLISHER = 'dev-publisher'
const DEV_ADVERTISER = 'dev-advertiser'

const clock = systemClock
const ids = cryptoIdGenerator(clock)
const log = (m: string): void => { process.stdout.write(`${new Date().toISOString()} ${m}\n`) }

/* ─────────────────────────── defter ─────────────────────────── */

/**
 * Kalici depolama.
 *
 * `LULL_DB` bir Railway diskini gostermeli (`/data/lull.db`). Verilmezse
 * BELLEKTE calisir ve her yeniden baslatmada her sey silinir — gelistirmede
 * istenen budur, uretimde felakettir. Bu yuzden uretimde gurultulu uyariyor.
 */
const DB_PATH = process.env['LULL_DB'] ?? MEMORY
if (DB_PATH === MEMORY && process.env['LULL_ENV'] === 'production') {
  log('⚠⚠ LULL_DB TANIMSIZ — veriler BELLEKTE, her deploy\'da bakiyeler SILINIR')
}
const db = openDb(DB_PATH)

const ledger = new Ledger(
  new SqliteLedgerStore(db, clock, () => ids.impressionId()),
  clock,
  () => ids.impressionId(),
)

// ADR-021: reklamverenin parasi defterde gorunmeli. Uretimde cuzdandan
// yatirma akisi bunu yazacak; simdilik elle.
//
// `topupId` sabit oldugu icin idempotent: defter zaten yazilmissa ikinci
// kez eklemez. Yoksa her yeniden baslatmada 100.000 USDC daha basardik.
//
// URETIMDE YAZILMAZ: karsiligi zincirde olmayan 100.000 USDC, odeme gucu
// hesabini ve defterin "her kurus bir yatirmadan gelir" iddiasini bozar.
if (!IS_PROD) {
  ledger.deposit({
    advertiserId: DEV_ADVERTISER,
    amount: micros(100_000_000_000n),          // 100.000 USDC
    topupId: 'dev-seed',
  })
}

/* ─────────────────────────── kampanyalar ─────────────────────────── */

/**
 * Kampanyalar artik REKLAMVERENDEN geliyor, kodda sabit degil.
 *
 * Onceden burada uc tane gomulu kayit vardi ve kampanya eklemek deploy
 * gerektiriyordu. Artik reklamveren cuzdaniyla giriyor, parasini yatiriyor,
 * kampanyasini kendisi olusturuyor.
 */
const campaignStore = new CampaignStore(db, clock, () => ids.impressionId())

// NEXT.md §10 — sponsor havuzlari. Kod govdesi 6 buyuk harf hex.
const pools = new PoolStore(db, clock, () => ids.impressionId(),
  () => randomBytes(3).toString('hex').toUpperCase())
const reserveDeps: ReserveDeps = {
  pools, campaigns: campaignStore, spentOn: (campaignIds) => pipeline.spentOn(campaignIds),
}

/* ─────────────────────────── boru hatti ─────────────────────────── */

const config: RemoteConfig = {
  ...FALLBACK_CONFIG,
  renderEnabled: true,
  surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true },
  // ADR-016 kapisi artik ortamdan: hatali bir surum bulundugunda deploy
  // gerekmeden `LULL_MIN_CLIENT_VERSION` ile kapatilabilir.
  minClientVersion: ENV.minClientVersion,
  minImpressionMs: 10_000,
  rotateMs: 20_000,
  idleGraceMs: 4_000,
  refreshIntervalSec: 1,
  configPollSec: 60,
  reportIntervalSec: 30,
}

const mirror = new SqliteImpressionMirror(db)

const pipeline: Pipeline = new Pipeline({
  clock, ids, ledger,
  persist: {
    loadImpressions: () => mirror.loadImpressions(),
    saveImpression: (i) => mirror.saveImpression(i),
    loadDeliveries: () => mirror.loadDeliveries(),
    saveDelivery: (d) => mirror.saveDelivery(d),
  },
  campaigns: () => campaignStore.all(),
  poolOf: (publisherId) => pools.poolOf(publisherId),
  // NEXT.md §10 — butce ve uye siniri. `pipeline` asagida tanimli; bu
  // kapanislar yalnizca istek aninda cagrildigi icin sorun degil.
  poolAllows: (publisherId, poolId, rate): boolean => {
    const p = pools.get(poolId)
    if (!p) return false
    const ids = poolCampaignIds(reserveDeps, poolId)
    if (pipeline.servedToday(publisherId, ids) >= p.dailyCapPerMember) return false
    return pipeline.spentOn(ids) + rate <= p.budget
  },
  reservedForPools: (advertiserId) => poolReserve(reserveDeps, advertiserId),
  minImpressionMs: config.minImpressionMs,
  minClientVersion: config.minClientVersion,
  // Uretimde 24 saat (§9 katman 2 — zincir ustu odeme geri alinamaz),
  // gelistirmede 30 saniye. Bkz. `env.ts`.
  pendingMs: ENV.pendingMs,
  dailyCap: 400,
})

const tokens = new SqliteTokenStore(db)

/* ─────────────────── cuzdanla giris ─────────────────── */

/** `testnet` (varsayilan) veya `mainnet`. Yanlis yazim sessizce testnet'e DUSMEZ. */
const NETWORK: Network = (() => {
  const v = process.env['LULL_NETWORK'] ?? 'testnet'
  if (v !== 'testnet' && v !== 'mainnet') {
    throw new Error(`LULL_NETWORK 'testnet' veya 'mainnet' olmali, gelen: ${v}`)
  }
  return v
})()
const RPC = process.env['LULL_RPC'] ?? RPC_URL[NETWORK]
/**
 * §8 tuzak #8: Circle'in USDC'si, kendi token'imiz DEGIL. Arc'ta ERC-20
 * arayuzu iki agda da ayni adreste; yalnizca yerel testler icin degistirilir.
 */
const USDC = process.env['LULL_USDC'] ?? USDC_ADDRESS
const HOME_DOMAIN = process.env['LULL_HOME_DOMAIN'] ?? `${HOST}:${PORT}`

const walletAuth = new WalletAuth({
  clock, ids,
  siwe: new Siwe({ domain: HOME_DOMAIN, network: NETWORK }, clock, ids),
  hashToken,
  issueToken: ({ publisherId, tokenHash, scopes, role }) => {
    const tokenId = ids.impressionId()
    tokens.add({
      id: tokenId, publisherId, tokenHash, scopes,
      clientVersion: null, revokedAt: null, lastSeenAt: null,
    })

    // Yayinci girisi cuzdani DA baglar.
    //
    // Kimlik zaten cuzdan (ADR-010): `publisherId` adresin kendisi. Ama
    // odeme isi `WalletStore`'a bakiyor ve orasi bos kalirsa HERKES
    // "cuzdan bagli degil" diye atlanir — kullanici cuzdaniyla giris
    // yaptigi halde. Hicbir odeme hicbir zaman yapilmazdi.
    //
    // Yalnizca ilk girişte: `bind` her cagrildiginda bildirim gonderiyor.
    if (role === 'publisher' && wallets.get(publisherId) === null) {
      wallets.bind(publisherId, publisherId, NETWORK)
    }

    log(`giris (${role}): ${publisherId.slice(0, 8)}…${publisherId.slice(-4)}`)
    return { tokenId }
  },
})

if (DEV_TOKEN) {
  tokens.add({
    id: 'dev-token', publisherId: DEV_PUBLISHER, tokenHash: hashToken(DEV_TOKEN),
    scopes: ['report:impressions', 'read:balance'],
    clientVersion: null, revokedAt: null, lastSeenAt: null,
  })
}

/* ─────────────────────── odeme ─────────────────────── */

// Esik yok — bkz. MIN_WITHDRAW. Bakiye ucu bunu `payoutThresholdMicros` olarak
// raporluyor; 1 micro = "bakiyesi olan herkes cekebilir".
const PAYOUT_THRESHOLD = micros(1n)
const payouts = new SqlitePayoutStore(db)
const wallets = new WalletStore({
  clock,
  holdMs: Number(process.env['LULL_WALLET_HOLD_MS'] ?? 0),   // uretimde 72 saat
  notify: (n) => log(`cuzdan ${n.kind}: ${n.publisherId.slice(0, 8)}… → ${n.newAddress.slice(0, 8)}…`),
  persist: walletPersistence(db),
})

/**
 * Operator cuzdani ve kasa.
 *
 * Para `LullVault` kontratinda duruyor; operator yalnizca odeme cagrisini
 * imzalayip gazini oduyor. Ikisinden biri YOKSA hicbir cekim (otomatik ya da
 * istege bagli) baslatilmaz — sahte bir rayla "odedik" demek, odememekten
 * kotudur: kullanici odendigini sanir ve beklemeyi birakir.
 */
const VAULT = (() => {
  const v = process.env['LULL_VAULT']
  if (!v) return null
  const a = normalizeAddress(v)
  if (!a) throw new Error(`LULL_VAULT gecerli bir adres degil: ${v}`)
  return a
})()
if (process.env['LULL_OPERATOR_KEY'] && !VAULT) {
  throw new Error('LULL_OPERATOR_KEY verilmis ama LULL_VAULT yok — odeme nereden cikacak?')
}
const HOT_SECRET = VAULT ? process.env['LULL_OPERATOR_KEY'] : undefined
/** Reklamverenin para gonderecegi adres: kasanin kendisi. */
const hotAddress = HOT_SECRET ? VAULT : null

/**
 * Sicak cuzdan TEK: tek ray, tek kuyruk.
 *
 * Eskiden her cekim servisi kendi rayini kuruyordu ve ayni anda
 * calisabiliyorlardi. Ayni sicak cuzdandan es zamanli iki cekim ayni
 * bakiyeyi gorur ve mutabakatla carpisir; para `payouts_in_flight`ta asili
 * kalabilirdi. `hotWallet` butun cekimleri ve mutabakati siraya sokuyor.
 */
const hotRail = HOT_SECRET && VAULT
  ? new ArcRail({ network: NETWORK, rpcUrl: RPC, operatorKey: HOT_SECRET, vault: VAULT, usdc: USDC })
  : null
const hotWallet = createSerial()
const payoutRunner = HOT_SECRET
  ? new PayoutRunner({
      clock, wallets, ledger, store: payouts,
      rail: hotRail!,
      threshold: PAYOUT_THRESHOLD,
      newBatchId: () => `b-${ids.impressionId()}`,
      log,
    })
  : null

/**
 * Reklamveren cekimi. Odemeyle AYNI rayi kullaniyor; sicak cuzdan yoksa
 * ikisi de kapali — para gonderecek bir yer yok.
 */
const withdraw = HOT_SECRET
  ? new WithdrawService({
      clock, ledger, store: payouts,
      kind: 'advertiser',
      rail: hotRail!,
      // NEXT.md §10 — acik havuzlara ayrilan para cekilemez; sponsor once
      // havuzu kapatir (ya da butcesini dusurur), sonra ceker.
      spendable: (a) => {
        const left = pipeline.spendable(a) - poolReserve(reserveDeps, a)
        return micros(left > 0n ? left : 0n)
      },
      newBatchId: () => `w-${ids.impressionId()}`,
      log,
      serial: hotWallet,
      confirmWaitMs: 40_000,
    })
  : null

/**
 * Yayinci cekimi — istege bagli, PayoutRunner'in ustune eklendi (bkz. asagi).
 *
 * `spendable` burada dogrudan ledger bakiyesi: yayinci bakiyesi zaten
 * yalnizca `verified` gosterimlerden olusuyor (ADR-011), reklamverendeki
 * gibi "teslim edilmis ama raporlanmamis" rezervi yok.
 */
const publisherWithdraw = HOT_SECRET
  ? new WithdrawService({
      clock, ledger, store: payouts,
      kind: 'publisher',
      rail: hotRail!,
      spendable: (p) => ledger.balance(accountId('publisher', p)),
      newBatchId: () => `w-${ids.impressionId()}`,
      log,
      serial: hotWallet,
      confirmWaitMs: 40_000,
    })
  : null

/**
 * Platformun kendi payinin cekimi — denetimde bulundu: platform payi her
 * gosterimde `PLATFORM_REVENUE`'ye yaziliyordu ama onu okuyan/ceken TEK BIR
 * SATIR kod yoktu. `platform_revenue` sahipsiz, tekil bir hesap — `spendable`
 * burada `id`'yi (hedef adres) yok sayip dogrudan o havuzu okuyor.
 */
const platformWithdraw = HOT_SECRET
  ? new WithdrawService({
      clock, ledger, store: payouts,
      kind: 'platform_revenue',
      rail: hotRail!,
      spendable: () => ledger.balance(PLATFORM_REVENUE),
      newBatchId: () => `w-${ids.impressionId()}`,
      log,
      serial: hotWallet,
      confirmWaitMs: 40_000,
    })
  : null

if (payoutRunner) {
  /**
   * Otomatik esik-tetiklemeli odeme turu ARTIK ZAMANLANMIYOR.
   *
   * Yayinci artik `publisherWithdraw` ile istedigi an cekebiliyor — ADR-006
   * zaten toplu odemenin gaz kazandirsa da tek
   * bozuk hedefin tum batch'i dusurdugunu tespit etmisti. Otomatik job'un
   * tek faydasi operasyonel rahatlikti, bedeli ise "param ne zaman
   * gelecek" belirsizligiydi. Istege bagli cekim ayni raya dayanarak bu
   * belirsizligi kaldiriyor.
   *
   * `PayoutRunner` SILINMEDI: `resumeUnresolved()` hala gerekli — sunucu
   * `payouts_in_flight`ta asili kalmis bir batch birakip duserse (ister
   * eski otomatik turdan, ister yeni istege bagli cekimden), yeniden
   * baslatmada zincire sorup karari veren tek yer burasi.
   */
  //
  // Yalnizca acilista DEGIL, periyodik: zincire ulasilamayan ya da
  // `pending` donen bir cekim, sunucu yeniden baslayana kadar asili
  // kaliyordu — kullanicinin parasi gunlerce "yolda" gorunebilirdi.
  // Cekimlerle AYNI kuyrukta: mutabakat bir cekimin ortasina girmez.
  const coz = (): void => {
    void hotWallet(() => payoutRunner.resumeUnresolved())
      .then((n) => { if (n > 0) log(`${n} asili batch cozuldu`) })
      .catch((e) => log(`⚠ asili batch mutabakati patladi: ${e instanceof Error ? e.message : String(e)}`))
  }
  coz()
  setInterval(coz, Number(process.env['LULL_RECONCILE_MS'] ?? 60_000)).unref()
  log('istege bagli cekim acik · otomatik odeme turu kapali (bkz. main.ts)')
} else {
  log('odeme KAPALI — LULL_OPERATOR_KEY / LULL_VAULT tanimli degil')
}

/* ─────────────────── reklamveren para yatirma ─────────────────── */

/**
 * Zinciri tarayip gelen USDC'yi deftere yazar.
 *
 * Eslesme GONDEREN ADRESE gore: reklamveren cuzdaniyla giris yaptigi icin
 * `ADV` adresinden gelen para `ADV`'nin hesabina gider. Memo yok, reklamveren
 * basina ayri adres yok (ADR-021).
 *
 * Sicak cuzdan yoksa calismaz — para gonderilecek adres de yok zaten.
 */
const depositWatcher = HOT_SECRET && hotAddress
  ? new DepositWatcher({
      clock, ledger,
      source: new ArcDepositSource({
        rpcUrl: RPC, vault: hotAddress, usdc: USDC,
        // Kasanin deploy blogu; ondan once kasaya para gelmis olamaz.
        fromBlock: BigInt(process.env['LULL_VAULT_FROM_BLOCK'] ?? '0'),
      }),
      // Bir adres ancak GIRIS YAPMISSA reklamveren sayilir. Rastgele birinin
      // gonderdigi para deftere yazilmaz — kimin oldugunu bilmiyoruz.
      isKnownAdvertiser: (a) => tokens.forPublisher(a).length > 0,
      cursor: sqliteCursor(db),
      log,
    })
  : null

if (depositWatcher) {
  const her = Number(process.env['LULL_DEPOSIT_INTERVAL_MS'] ?? 20_000)
  setInterval(() => { void depositWatcher.poll() }, her).unref()
  void depositWatcher.poll()
  log(`yatirma izleyicisi: her ${her / 1000}s · adres ${hotAddress}`)
}

/* ─────────────────────── dogrulama job'i ─────────────────────── */

// Uretimde cron; burada basit bir aralik. Ledger'a yazan tek yer burasi.
setInterval(() => {
  const r = pipeline.runVerification()
  if (r.verified || r.rejected) {
    log(`dogrulama: ${r.verified} onayli, ${r.rejected} red, ${r.stillPending} bekliyor`)
    const problems = ledger.audit()
    if (problems.length > 0) log(`⚠ LEDGER INVARIANT IHLALI: ${problems.join('; ')}`)
  }
}, 10_000).unref()

/* ─────────────────────────── siralama ─────────────────────────── */

const profiles = new ProfileStore(profilePersistence(db))
const leaderboard = new Leaderboard({
  entries: () => ledger.entries(),
  profiles,
  advertiserOf: (id) => campaignStore.get(id)?.advertiserId ?? null,
  now: () => clock.now(),
})

/* ─────────────────────────── sunucu ─────────────────────────── */

const app = createApp({
  clock, ids, pipeline, ledger, tokens,
  config: () => config,
  walletAuth,
  ipSalt: ENV.ipSalt,
  payoutThreshold: PAYOUT_THRESHOLD,
  payouts,
  campaigns: campaignStore,
  profiles,
  leaderboard,
  pools,
  // DB-IP Lite ulke veritabani; Docker derlemesinde indiriliyor. Yoksa tahmin
  // kapanir, kullanici ulkesini elle secer.
  countryLookup: openCountryDb(process.env['LULL_GEOIP_DB']
    ?? join(dirname(fileURLToPath(import.meta.url)), 'geo', 'dbip-country-lite.mmdb')),
  ...(withdraw ? { withdraw } : {}),
  ...(publisherWithdraw ? { publisherWithdraw } : {}),
  ...(platformWithdraw ? { platformWithdraw } : {}),
  ...(process.env['LULL_ADMIN_SECRET'] ? { adminSecret: process.env['LULL_ADMIN_SECRET'] } : {}),
  ...(hotAddress ? { depositAddress: hotAddress } : {}),
  network: NETWORK,
  chainId: CHAIN_ID[NETWORK],
  usdcToken: USDC,
})

/**
 * Site, API ile AYNI adreste duruyor.
 *
 * Ayri bir yere koysaydik her uc nokta icin CORS baslıklari gerekirdi ve
 * panelin kimlik islemleri gereksiz yere zorlasirdi. Ayrica tek deploy,
 * tek alan adi, tek sertifika.
 *
 * `/v1/*` ve `/health` YUKARIDA tanimli oldugu icin bu yakalama onlarin
 * onune gecmiyor — Hono sirayla bakiyor.
 */
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public')

/**
 * Statik dosyalar HER ZAMAN dogrulanir.
 *
 * Bunu koymadan once bir deploy sonrasi kullanici hala eski `app.js`'i
 * goruyordu: tarayici dosyayi onbellekten veriyor, sunucudaki yeni surumu
 * hic sormuyordu. "Sayfayi zorla yenile" demek cozum degil — kullanicilarin
 * cogu bunu bilmez ve bilmesi de gerekmez.
 *
 * `no-cache` "onbelleğe alma" DEMEK DEGIL; "kullanmadan once bana sor"
 * demek. Dosya degismediyse 304 doner, indirme olmaz. Toplam site 18 KB;
 * bir tur dogrulamanin bedeli, yanlis surumu gostermenin bedelinin yaninda
 * hicbir sey.
 */
app.use('/*', async (c, next) => {
  await next()
  if (!c.req.path.startsWith('/v1/') && c.req.path !== '/health') {
    c.header('cache-control', 'no-cache')
  }
})
app.use('/*', serveStatic({
  root: PUBLIC,
  // Klasor istendiginde `index.html` don: `/app` → `public/app/index.html`
  rewriteRequestPath: (p) => (p.endsWith('/') ? p + 'index.html' : p),
}))
// Uzantisiz yollar (`/app`, `/privacy`) klasor index'ine duser.
app.use('/*', serveStatic({
  root: PUBLIC,
  rewriteRequestPath: (p) => (p.includes('.') ? p : p.replace(/\/*$/, '') + '/index.html'),
}))


const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const bakiye = ledger.balance(accountId('advertiser', DEV_ADVERTISER))
  log(`lull sunucusu http://${HOST}:${info.port}`)
  log(`${campaignStore.all().length} kampanya · dev reklamveren bakiyesi ${bakiye} micro`)
  if (DEV_TOKEN) log(`gelistirme token'i: ${DEV_TOKEN}`)
  else log("gelistirme token'i YOK (uretim) — giris yalnizca `lull login` ile")
  log(`ag: arc ${NETWORK} (${CHAIN_ID[NETWORK]}) · rpc ${RPC} · usdc ${USDC}`)
  if (hotRail) log(`kasa ${hotRail.vaultAddress} · operator ${hotRail.operatorAddress}`)
  log(`veritabani: ${DB_PATH === MEMORY ? 'BELLEK (kalici degil)' : DB_PATH}`)
  log(`${ledger.publishers().length} publisher · ${pipeline.impressions().length} gosterim yuklendi`)
})

// Olu kayitlari topla. Defter ASLA silinmez; yalnizca suresi gecmis reklam
// sunumlari ve 90 gunden eski karara baglanmis gosterimler.
setInterval(() => {
  const n = vacuumExpired(db, clock.now(), 90 * 86_400_000)
  if (n > 0) log(`temizlik: ${n} olu kayit silindi`)
}, 3600_000).unref()

/* ─────────────────── temiz kapanis ─────────────────── */

/**
 * Railway her deploy'da SIGTERM gonderir ve kisa bir sure sonra sureci
 * oldurur.
 *
 * Artik periyodik bir odeme turu yok, bu yuzden "yeni tur baslatma" diye
 * bir sey durdurulmuyor. Tam o an suren bir istege bagli cekim varsa
 * zincire gonderilmis ama mutabakati yapilmamis batch `payouts_in_flight`
 * ta asili kalir. Kaybolmaz — `resumeUnresolved` bir sonraki aciliste
 * zincire sorup cozuyor.
 */
let kapaniyor = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (kapaniyor) return
    kapaniyor = true
    log(`${sig} — kapaniyor`)
    server.close(() => { db.close(); process.exit(0) })
    // Acik baglantilar kapanmazsa da bekleme: platform zaten olduruyor.
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}
