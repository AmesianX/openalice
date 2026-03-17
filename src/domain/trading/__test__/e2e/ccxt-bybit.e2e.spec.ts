/**
 * CcxtBroker e2e — real orders against Bybit demo/sandbox.
 *
 * Reads Alice's config, picks the first CCXT Bybit account on a
 * sandbox/demoTrading platform. If none configured, entire suite skips.
 *
 * Run: pnpm test:e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { loadTestAccounts, filterByProvider, type TestAccount } from './setup.js'
import type { IBroker } from '../../brokers/types.js'
import '../../contract-ext.js'

let broker: IBroker | null = null
let accountLabel = ''

beforeAll(async () => {
  const all = await loadTestAccounts()
  const ccxtAccounts = filterByProvider(all, 'ccxt')
  const bybitAccount = ccxtAccounts.find(a => a.id.includes('bybit'))

  if (!bybitAccount) {
    console.log('e2e: No Bybit sandbox/demo account configured, skipping')
    return
  }

  accountLabel = bybitAccount.label
  broker = bybitAccount.broker
  await broker.init()
  console.log(`e2e: ${accountLabel} connected`)
}, 60_000)

afterAll(async () => {
  if (broker) await broker.close()
})

describe('CcxtBroker — Bybit e2e', () => {
  it('has a configured Bybit account (or skips entire suite)', () => {
    if (!broker) {
      console.log('e2e: skipped — no Bybit account')
      return
    }
    expect(broker).toBeDefined()
  })

  it('fetches account info with positive equity', async () => {
    if (!broker) return
    const account = await broker.getAccount()
    expect(account.netLiquidation).toBeGreaterThan(0)
    console.log(`  equity: $${account.netLiquidation.toFixed(2)}, cash: $${account.totalCashValue.toFixed(2)}`)
  })

  it('fetches positions', async () => {
    if (!broker) return
    const positions = await broker.getPositions()
    expect(Array.isArray(positions)).toBe(true)
    console.log(`  ${positions.length} open positions`)
  })

  it('searches ETH contracts', async () => {
    if (!broker) return
    const results = await broker.searchContracts('ETH')
    expect(results.length).toBeGreaterThan(0)
    const perp = results.find(r => r.contract.aliceId?.includes('USDT'))
    expect(perp).toBeDefined()
    console.log(`  found ${results.length} ETH contracts, perp: ${perp!.contract.aliceId}`)
  })

  it('places market buy 0.01 ETH → execution returned', async () => {
    if (!broker) return

    const matches = await broker.searchContracts('ETH')
    const ethPerp = matches.find(m => m.contract.aliceId?.includes('USDT'))
    if (!ethPerp) { console.log('  no ETH/USDT perp, skipping'); return }

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    const result = await broker.placeOrder(ethPerp.contract, order)
    expect(result.success).toBe(true)
    expect(result.orderId).toBeDefined()
    console.log(`  buy orderId=${result.orderId}, execution=${!!result.execution}`)

    if (result.execution) {
      expect(result.execution.shares.toNumber()).toBeGreaterThan(0)
      expect(result.execution.price).toBeGreaterThan(0)
      console.log(`  filled: ${result.execution.shares} @ $${result.execution.price}`)
    }
  }, 15_000)

  it('verifies ETH position exists after buy', async () => {
    if (!broker) return
    const positions = await broker.getPositions()
    const ethPos = positions.find(p => p.contract.symbol === 'ETH')
    expect(ethPos).toBeDefined()
    console.log(`  ETH position: ${ethPos!.quantity} ${ethPos!.side}`)
  })

  it('closes ETH position with reduceOnly', async () => {
    if (!broker) return

    const matches = await broker.searchContracts('ETH')
    const ethPerp = matches.find(m => m.contract.aliceId?.includes('USDT'))
    if (!ethPerp) return

    const result = await broker.closePosition(ethPerp.contract, new Decimal('0.01'))
    expect(result.success).toBe(true)
    console.log(`  close orderId=${result.orderId}, success=${result.success}`)
  }, 15_000)

  it('queries order by ID', async () => {
    if (!broker) return

    // Place a small order to get an orderId
    const matches = await broker.searchContracts('ETH')
    const ethPerp = matches.find(m => m.contract.aliceId?.includes('USDT'))
    if (!ethPerp) return

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    const placed = await broker.placeOrder(ethPerp.contract, order)
    if (!placed.orderId) return

    const detail = await broker.getOrder(placed.orderId)
    expect(detail).not.toBeNull()
    console.log(`  order ${placed.orderId} status=${detail?.orderState.status}`)

    // Clean up
    await broker.closePosition(ethPerp.contract, new Decimal('0.01'))
  }, 15_000)
})
