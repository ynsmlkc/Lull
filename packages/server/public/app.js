/* Linger — tarayici tarafi ortak islevler.
 *
 * Cerceve yok, derleme adimi yok. Bes sayfalik bir site icin React
 * getirmek, indirilecek 40 KB'i 200 KB yapardi ve tek kazanci bizim
 * rahatimiz olurdu.
 *
 * Zincir SDK'si de YOK. Giriste imzalanan sey bir islem degil, sunucunun
 * urettigi OKUNABILIR bir mesaj; yatirma ise tek bir ERC-20 `transfer`
 * cagrisi. Ikisi de cuzdanin kendi EIP-1193 API'siyle yapiliyor. SDK'yi
 * tarayiciya koymak yuzlerce KB demekti.
 */

/* ─────────────────────────── para ─────────────────────────── */

/**
 * Micro metnini dolara cevirir. BigInt, float DEGIL.
 *
 * 1 USDC = 1.000.000 micro. `parseFloat` ile bolmek 2^53 ustunde
 * sessizce yuvarlar ve kullanicinin bakiyesini degistirir.
 */
export function usd(micros) {
  const v = BigInt(micros);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1000000n;
  const frac = (a % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + '$' + whole.toString() + (frac ? '.' + frac : '');
}

/** "40.25" → 402500000n. Float'a hic ugramaz. */
export function toMicros(text) {
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(String(text).trim());
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 1000000n + BigInt((m[2] || '').padEnd(6, '0'));
}

export const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');

/* ─────────────────────────── sunucu ─────────────────────────── */

const TOKEN_KEY = 'linger.token';
const ROLE_KEY = 'linger.role';
const ADDR_KEY = 'linger.address';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get role() { return localStorage.getItem(ROLE_KEY); },
  get address() { return localStorage.getItem(ADDR_KEY); },
  save(token, role, address) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    localStorage.setItem(ADDR_KEY, address);
  },
  clear() { [TOKEN_KEY, ROLE_KEY, ADDR_KEY].forEach((k) => localStorage.removeItem(k)); },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.hint || body?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Sunucu cagrisi.
 *
 * Site sunucuyla AYNI adreste duruyor, bu yuzden yol goreli ve CORS yok.
 * Ayri bir alan adina koysaydik her uc icin CORS basliklari gerekirdi ve
 * cerez/kimlik islerinin hepsi zorlasirdi.
 */
export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'x-linger-client-version': '0.1.1' };
  if (body) headers['content-type'] = 'application/json';
  if (auth && session.token) headers.authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // Ag hatasi ile sunucu hatasini AYIRIYORUZ: kullaniciya "tekrar dene"
    // demekle "oturumun dustu" demek farkli seyler.
    throw new ApiError(0, { message: 'Cannot reach the server' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ─────────────────────────── ag ─────────────────────────── */

/**
 * Hangi Arc agi? Sunucu `/health` ile soyluyor; site ayri bir ayar
 * tasimiyor. Cevap gelene kadar testnet varsayilir — gezgin linkleri
 * yalnizca bir sey odendikten sonra gorunuyor, o zamana kadar cevap gelmis
 * oluyor.
 */
export const chain = {
  network: 'testnet', chainId: 5042002, usdcToken: '0x3600000000000000000000000000000000000000', vault: null,
};
export const chainReady = fetch('/health')
  .then((r) => r.json())
  .then((h) => {
    if (h?.network === 'mainnet' || h?.network === 'testnet') chain.network = h.network;
    if (Number.isInteger(h?.chainId)) chain.chainId = h.chainId;
    if (h?.usdcToken) chain.usdcToken = h.usdcToken;
    chain.vault = h?.vault ?? null;
    // Sayfalardaki ag etiketleri (`data-net`) sunucunun gercek agini gostersin.
    for (const el of document.querySelectorAll('[data-net]')) {
      el.textContent = chain.network === 'mainnet' ? 'arc mainnet' : 'arc testnet';
    }
    return chain;
  })
  .catch(() => chain);

const ARC = {
  mainnet: { name: 'Arc', rpc: 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io' },
  testnet: { name: 'Arc Testnet', rpc: 'https://rpc.testnet.arc.io', explorer: 'https://explorer.testnet.arc.io' },
};

/** Arc Explorer baglantilari — ag `/health`'ten. */
export const explorer = {
  tx: (h) => `${ARC[chain.network].explorer}/tx/${h}`,
  account: (a) => `${ARC[chain.network].explorer}/address/${a}`,
};

/* ─────────────────────────── cuzdan ─────────────────────────── */

/**
 * Enjekte edilen EIP-1193 cuzdani — MetaMask, Rabby, Coinbase Wallet.
 *
 * Once EIP-6963: birden fazla cuzdan kuruluysa hepsi kendini duyurur ve
 * `window.ethereum` uzerinde kavga etmezler. Duyuru yoksa eski yol.
 *
 * Eklentiler sayfadan SONRA enjekte olabilir; bu yuzden kisa bir sure
 * tekrar yoklanir.
 */
const announced = [];
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = e.detail;
  if (d?.provider && !announced.some((a) => a.p === d.provider)) {
    announced.push({ name: d.info?.name || 'wallet', p: d.provider });
  }
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function findWallet() {
  if (announced.length > 0) return announced[0];
  const eth = window.ethereum;
  if (typeof eth?.request !== 'function') return null;
  const name = eth.isRabby ? 'Rabby' : eth.isCoinbaseWallet ? 'Coinbase Wallet' : eth.isMetaMask ? 'MetaMask' : 'wallet';
  return { name, p: eth };
}

async function waitForWallet(ms = 1500) {
  const end = Date.now() + ms;
  for (;;) {
    const w = findWallet();
    if (w || Date.now() > end) return w;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Sayfa acildiginda: bir EVM cuzdani var mi? */
export async function walletReady() {
  return (await waitForWallet()) !== null;
}

/** Metin → 0x'li hex (UTF-8). `personal_sign` mesaji hex olarak alir. */
function utf8Hex(text) {
  let h = '0x';
  for (const b of new TextEncoder().encode(text)) h += b.toString(16).padStart(2, '0');
  return h;
}

/** Ayni adresin kucuk harfli ve checksum'li yazimini esit say. */
const sameAddress = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/* ─────────────────────────── giris (imza) ─────────────────────────── */

/**
 * Cuzdanla giris. Sifre yok, hesap yok — adres kimligin kendisi.
 *
 * Uc adim: sunucudan bir mesaj iste, cuzdana imzalat, imzayi geri gonder.
 * Sunucu imzayi dogrularsa token verir.
 *
 * Imzalanan sey bir ISLEM DEGIL, okunabilir bir metin. `personal_sign`
 * onune EIP-191 onekini koyar; bu onekle imzalanan hicbir sey bir
 * transaction olamaz. Yani bu imza hicbir zaman para hareket ettiremez,
 * yalnizca "bu adres benim"i kanitlar.
 *
 * `onStep` her adimda dugmenin yazisini degistiriyor. Cuzdan penceresi
 * acilmadan once kullanicinin ne bekledigini bilmesi gerekiyor — yoksa
 * donen bir dugmeye bakip sayfanin dondugunu saniyor.
 */
export async function login(role, onStep = () => {}) {
  onStep('Looking for your wallet…');
  const w = await waitForWallet();
  if (!w) throw new Error('No EVM wallet found — install MetaMask, Rabby or Coinbase Wallet');

  onStep(`Approve in ${w.name}…`);
  const accounts = await w.p.request({ method: 'eth_requestAccounts' });
  const raw = accounts?.[0];
  if (!raw) throw new Error(`${w.name} returned no address`);

  onStep('Preparing…');
  const challenge = await api('/v1/auth/challenge', {
    method: 'POST', auth: false, body: { address: raw },
  });

  onStep(`Sign the message in ${w.name}…`);
  const signature = await w.p.request({ method: 'personal_sign', params: [utf8Hex(challenge.message), raw] });
  if (typeof signature !== 'string' || !signature.startsWith('0x')) throw new Error('No signature received');

  onStep('Verifying…');
  // Rolu SUNUCU dogruluyor; buradaki deger yalnizca hangi yetkilerin
  // istendigini soyluyor, kendi kendine yetki vermiyor.
  const { token, publisherId } = await api('/v1/auth/verify', {
    method: 'POST', auth: false,
    body: { address: raw, message: challenge.message, signature, role },
  });

  // Sunucu adresi checksum bicimine ceviriyor; oturumda o bicim tutulur.
  session.save(token, role, publisherId);
  return { address: publisherId, role };
}

/* ─────────────────────────── yatirma (transfer) ─────────────────────────── */

/**
 * Cuzdani Arc'a gecirir; ag cuzdanda tanimli degilse ekler.
 *
 * Arc'ta gaz USDC ile odeniyor ve cuzdan bunu "yerel para" olarak 18
 * ondalikla gosteriyor. Ayni bakiye ERC-20 arayuzunde 6 ondalikli; transfer
 * ERC-20 uzerinden yapiliyor, yerel deger (value) her zaman 0.
 */
async function switchToArc(p) {
  await chainReady;
  const hex = '0x' + chain.chainId.toString(16);
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    // 4902: cuzdan bu zinciri tanimiyor — ekleyip tekrar gec.
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    const a = ARC[chain.network];
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex, chainName: a.name,
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        rpcUrls: [a.rpc], blockExplorerUrls: [a.explorer],
      }],
    });
  }
}

/**
 * Kasaya USDC gonderir — tek transaction, ERC-20 `transfer(kasa, tutar)`.
 *
 * Eslesme GONDEREN ADRESE gore yapiliyor (ADR-021). Bu yuzden cuzdanda
 * secili hesap giris yapilan hesap DEGILSE gonderim baslamaz: baska bir
 * hesaptan giden para kasaya ulasir ama kimseye yazilamaz.
 *
 * Donus degeri transaction hash'i. Deftere yazma isini sunucu zinciri
 * okuyarak yapiyor; buradan "yatirildi" demiyoruz.
 */
export async function depositUsdc(micros, onStep = () => {}) {
  await chainReady;
  if (!chain.vault) throw new Error('Deposits are off on this server');
  if (typeof micros !== 'bigint' || micros <= 0n) throw new Error('Enter an amount');

  onStep('Looking for your wallet…');
  const w = await waitForWallet();
  if (!w) throw new Error('No EVM wallet found');

  const accounts = await w.p.request({ method: 'eth_requestAccounts' });
  const from = accounts?.[0];
  if (!sameAddress(from, session.address)) {
    throw new Error(`Switch ${w.name} to ${short(session.address)} — deposits are matched by sender`);
  }

  onStep(`Switch to Arc in ${w.name}…`);
  await switchToArc(w.p);

  // transfer(address,uint256) = 0xa9059cbb ‖ adres (32 bayt) ‖ tutar (32 bayt)
  const data = '0xa9059cbb'
    + chain.vault.slice(2).toLowerCase().padStart(64, '0')
    + micros.toString(16).padStart(64, '0');

  onStep(`Confirm in ${w.name}…`);
  const hash = await w.p.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: chain.usdcToken, data, value: '0x0' }],
  });
  if (typeof hash !== 'string') throw new Error('No transaction hash received');
  return hash;
}

/* ─────────────────────────── kucuk yardimcilar ─────────────────────────── */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(el, on) { el?.classList.toggle('hidden', !on); }

/**
 * Onay isareti — yazi tipi glifi degil, cizilmis SVG.
 *
 * `✓` karakteri her isletim sisteminde farkli boyutta ve kalinlikta
 * geliyor; macOS'ta ince, Windows'ta kalin, Linux'ta bazen hic yok.
 * Cizersek her yerde ayni.
 */
const TICK = `<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.6 3.6L13.5 4.7"/></svg>`;

export function copyButton(btn, text) {
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); } catch { /* izin yok */ }
    const tag = btn.querySelector('.tag') || btn;
    if (tag.dataset.busy) return;              // ust uste tiklamada etiketi kaybetme
    tag.dataset.busy = '1';
    tag.dataset.before = tag.textContent;

    tag.innerHTML = TICK;
    tag.classList.add('done');
    setTimeout(() => {
      tag.textContent = tag.dataset.before;
      tag.classList.remove('done');
      delete tag.dataset.busy;
    }, 1600);
  });
}
