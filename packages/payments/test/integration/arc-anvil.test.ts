/**
 * ArcRail + ArcDepositSource — GERCEK bir EVM dugumunde, GERCEK kasayla.
 *
 * Birim testler mock ray uzerinde kosuyor; burasi raydaki her ariza modunun
 * gercek zincir davranisiyla eslestigini kanitlayan yer: cift gonderim,
 * ayni batch'in tekrar odenmesi, engelli alici, harcanmis nonce.
 *
 * Yerel bir `anvil` acar (Arc testnet zincir kimligiyle), Foundry'nin
 * derledigi `LullVault` ve sahte USDC'yi deploy eder. Ag ya da cuzdan
 * gerekmez; yalnizca Foundry kurulu olmali:
 *
 *   cd contracts/vault && forge build
 *   LULL_ANVIL=1 pnpm --filter @lull/payments test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient, createWalletClient, http, parseAbi, getAddress, type Hex, type Abi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { micros } from '@lull/protocol'
import { ArcRail, arcChain } from '../../src/arc-rail.js'
import { ArcDepositSource } from '../../src/deposit-source.js'

const RUN = process.env['LULL_ANVIL'] === '1'
const PORT = 8547
const RPC = `http://127.0.0.1:${PORT}`

// anvil'in herkesce bilinen gelistirme anahtarlari — gercek degeri yok.
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
] as const
const owner = privateKeyToAccount(KEYS[0])
const operator = privateKeyToAccount(KEYS[1])
const advertiser = privateKeyToAccount(KEYS[2])
const dev1 = privateKeyToAccount(KEYS[3]).address
const dev2 = privateKeyToAccount(KEYS[4]).address

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/vault/out')
const artifact = (file: string, name: string): { abi: Abi; bytecode: Hex } => {
  const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object }
}

const TOKEN_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function setBlocked(address who)',
])

const chain = arcChain('testnet', RPC)
const pub = createPublicClient({ chain, transport: http(RPC) })
const wallet = (acct: typeof owner) => createWalletClient({ account: acct, chain, transport: http(RPC) })

let node: ChildProcess
let usdc: `0x${string}`
let vault: `0x${string}`
let fromBlock: bigint
let rail: ArcRail

const usdcOf = (a: `0x${string}`) =>
  pub.readContract({ address: usdc, abi: TOKEN_ABI, functionName: 'balanceOf', args: [a] })

async function deploy(art: { abi: Abi; bytecode: Hex }, args: readonly unknown[]): Promise<`0x${string}`> {
  const hash = await wallet(owner).deployContract({ abi: art.abi, bytecode: art.bytecode, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  return getAddress(r.contractAddress!)
}

async function send(acct: typeof owner, fn: 'mint' | 'transfer' | 'setBlocked', args: readonly unknown[]) {
  const hash = await wallet(acct).writeContract({ address: usdc, abi: TOKEN_ABI, functionName: fn, args } as never)
  await pub.waitForTransactionReceipt({ hash })
}

describe.skipIf(!RUN)('Arc rayi — yerel anvil + gercek LullVault', () => {
  beforeAll(async () => {
    node = spawn('anvil', ['--port', String(PORT), '--chain-id', '5042002', '--silent'], { stdio: 'ignore' })
    for (let i = 0; ; i++) {
      try { await pub.getBlockNumber(); break } catch {
        if (i > 50) throw new Error('anvil acilmadi')
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    usdc = await deploy(artifact('LullMocks.sol', 'MockBlockableERC20'), [])
    fromBlock = await pub.getBlockNumber()
    vault = await deploy(artifact('LullVault.sol', 'LullVault'), [usdc, owner.address, operator.address])

    rail = new ArcRail({ network: 'testnet', rpcUrl: RPC, operatorKey: KEYS[1], vault, usdc })
  }, 30_000)

  afterAll(() => { node?.kill() })

  it('reklamverenin kasaya gonderdigi USDC gonderen adresiyle okunur', async () => {
    await send(owner, 'mint', [advertiser.address, 100_000_000n])
    await send(advertiser, 'transfer', [vault, 100_000_000n])

    const src = new ArcDepositSource({ rpcUrl: RPC, vault, usdc, fromBlock })
    const first = await src.incoming(null)
    expect(first.transfers).toHaveLength(1)
    expect(first.transfers[0]).toMatchObject({ from: advertiser.address, amount: 100_000_000n })

    // Ayni cursor'dan ikinci tarama hicbir seyi tekrar getirmez.
    const again = await src.incoming(first.newCursor)
    expect(again.transfers).toHaveLength(0)
  })

  it('kaynak durumu: kasa USDC\'si ve operatorun gazi ayri okunur', async () => {
    const s = await rail.sourceStatus()
    expect(s.address).toBe(vault)
    expect(s.usdcBalance).toBe(100_000_000n)
    expect(s.availableGas).toBeGreaterThan(0n)
  })

  it('hedef kontrolu: cuzdan gecer, kontrat ve token adresleri isaretlenir', async () => {
    const [w, v, t] = await rail.validateDestinations([dev1, vault, usdc])
    expect(w).toMatchObject({ valid: true, isContract: false, isToken: false, blocked: false })
    expect(v!.isToken).toBe(true)
    expect(t!.isToken).toBe(true)
    expect(t!.isContract).toBe(true)
  })

  it('batch odenir; AYNI byte\'lar tekrar gonderilse de para bir kez gider', async () => {
    const batch = {
      batchId: 'b-happy',
      items: [
        { publisherId: dev1, address: dev1, amount: micros(3_000_000n) },
        { publisherId: dev2, address: dev2, amount: micros(2_000_000n) },
      ],
    }
    const receipt = await rail.prepare(batch)
    expect(receipt.validityRef).toMatch(/^nonce:\d+$/)

    await rail.send(receipt)
    await rail.send(receipt)               // cift gonderim — yutulmali
    const r = await rail.reconcile(receipt)
    expect(r.state).toBe('settled')
    expect(r.feeCharged).toBeGreaterThan(0n)

    expect(await usdcOf(dev1)).toBe(3_000_000n)
    expect(await usdcOf(dev2)).toBe(2_000_000n)
    expect(await usdcOf(vault)).toBe(95_000_000n)
  })

  it('ayni batchId yeniden KURULAMAZ — kasa zincirde reddeder', async () => {
    await expect(rail.prepare({
      batchId: 'b-happy',
      items: [{ publisherId: dev1, address: dev1, amount: micros(1n) }],
    })).rejects.toThrow()
    expect(await usdcOf(dev1)).toBe(3_000_000n)
  })

  it('engelli alici: batch hic imzalanmaz, kimse odenmez', async () => {
    await send(owner, 'setBlocked', [dev2])
    await expect(rail.prepare({
      batchId: 'b-blocked',
      items: [
        { publisherId: dev1, address: dev1, amount: micros(1_000_000n) },
        { publisherId: dev2, address: dev2, amount: micros(1_000_000n) },
      ],
    })).rejects.toThrow()
    expect(await usdcOf(dev1)).toBe(3_000_000n)
    await send(owner, 'setBlocked', ['0x0000000000000000000000000000000000000000'])
  })

  it('gonderilmemis transaction bekliyor; nonce\'u harcaninca OLU sayilir', async () => {
    const one = (id: string) => ({ batchId: id, items: [{ publisherId: dev1, address: dev1, amount: micros(500_000n) }] })

    const orphan = await rail.prepare(one('b-orphan'))
    expect((await rail.reconcile(orphan)).state).toBe('pending')

    // Ayni nonce'la baska bir batch girer.
    const winner = await rail.prepare(one('b-winner'))
    expect(winner.validUntil).toBe(orphan.validUntil)
    await rail.send(winner)
    expect((await rail.reconcile(winner)).state).toBe('settled')

    expect((await rail.reconcile(orphan)).state).toBe('expired')
    // Olu transaction'i simdi gondermek hicbir sey odemez.
    await rail.send(orphan)
    expect(await usdcOf(dev1)).toBe(3_500_000n)
  })
})
