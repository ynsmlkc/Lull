# Kıvılcımlar — atılacak kod

Bu klasördeki hiçbir şey ürüne girmeyecek. Amaç tek: **omurgayı yazmadan önce iki bilinmeyeni kapatmak** (bkz. `PROJECT.md` §12.1).

Sonuçlar `PROJECT.md`'ye tablo olarak işlendikten sonra bu klasör silinir. Tek istisna: Kıvılcım 1'in ürettiği `hooks.jsonl`, anonimleştirilip test fixture'ı olarak saklanacak (§12.1 bitti kriteri) — yoksa her testte gerçek bir Claude Code oturumu açmak gerekir.

---

## Kıvılcım 2 — Arc batch ödeme ✅ yerel EVM düğümünde koşuldu

Bu kıvılcımın kodu artık atılacak kod değil: `packages/payments/test/integration/arc-anvil.test.ts`. Yerel bir `anvil` açar, gerçek `LullVault`'u ve sahte bir USDC'yi deploy eder, sonra `ArcRail`'i ve yatırma kaynağını gerçek düğümde dener.

```bash
(cd contracts/vault && forge build)
LULL_ANVIL=1 pnpm --filter @lull/payments test
```

| İddia | Sonuç |
|---|---|
| Kasaya gelen transfer gönderen adresiyle okunuyor, aynı cursor tekrar getirmiyor | ✅ |
| Tek transaction'da çoklu ödeme, tutarlar zincirde birebir tutuyor | ✅ |
| Aynı byte'ları iki kez göndermek ikinci ödeme YAPMIYOR | ✅ |
| Aynı `batchId` ile yeniden kurulan batch kasada reddediliyor | ✅ |
| Engelli alıcı simülasyonda yakalanıyor, batch hiç imzalanmıyor | ✅ |
| Gönderilmemiş transaction `pending`; nonce'u harcanınca `expired` | ✅ |

---

## Kıvılcım 1 — statusLine ölçümü ⏳ senin çalıştırman gerekiyor

```bash
cd statusline-probe
node install.mjs              # statusLine + hook'lar
node install.mjs --spinner    # üstüne spinnerVerbs + tips
```

Sonra **yeni bir Claude Code oturumunda** 20-30 dakika normal çalış. Uzun süren işler yaptır (büyük grep, test koşumu, çok dosyalı değişiklik) — ölçülmek istenen o bekleme pencereleri.

```bash
node analyze.mjs              # rapor
node uninstall.mjs            # geri al
```

**Güvenlik:** `install.mjs` önce zaman damgalı yedek alır, mevcut hook'ları korur (dizilere ekler), mevcut `statusLine`/`spinnerVerbs` varsa dokunmaz ve uyarır. `uninstall.mjs` yedekten birebir geri döner.

**Rapor şunları çıkarır:**

1. statusLine çağrı sıklığı ve aralık dağılımı
2. Hook envanteri — hangileri ateşleniyor, payload'da hangi alanlar var
3. Bekleme süresi histogramı → **≥10sn oranı = envanterin gerçek boyutu**
4. **statusLine beklerken yenileniyor mu** ← açık soru #1'in kesin cevabı
5. **$/geliştirici/ay projeksiyonu** ← §12.1 bitti kriteri

**Gözle bakılacaklar** (rapor bunları göremez, not al):

- Alt satırda reklam göründü mü, beklerken duruyor mu yoksa donuyor mu?
- `--spinner` ile: spinner `✶ Firecrawl…` diyor mu? Alttaki "Tip:" satırı değişti mi?
- **`settings.json` canlı okunuyor mu?** Probe çalışırken `spinnerVerbs.verbs`'ü elle değiştir — oturumu yeniden başlatmadan değişti mi? Bu, spinner katmanının rotasyona uygun olup olmadığını belirleyen tek soru.
- Footer'daki `esc to interrupt` kayboldu mu? (ekran görüntüsü al — `lull uninstall`'ın testi buna dayanacak)
- Hook shim'i tool call'ları yavaşlattı mı? **Yavaşlattıysa bu kırmızı çizgi.**
