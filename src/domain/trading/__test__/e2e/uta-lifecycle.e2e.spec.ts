/**
 * UTA integration tests — full trading lifecycle against MockBroker.
 *
 * Not unit tests. These exercise the complete flow:
 *   stage → commit → push → broker executes → state changes → sync
 *
 * MockBroker acts as an in-memory exchange with real behavior:
 * positions update, cash moves, orders track status.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { UnifiedTradingAccount } from '../../UnifiedTradingAccount.js'
import { MockBroker, makeContract } from '../../brokers/mock/index.js'
import '../../contract-ext.js'

let broker: MockBroker
let uta: UnifiedTradingAccount

beforeEach(() => {
  broker = new MockBroker({ cash: 100_000 })
  broker.setQuote('AAPL', 150)
  broker.setQuote('ETH', 1920)
  uta = new UnifiedTradingAccount(broker)
})

// ==================== Full trading lifecycle ====================

describe('UTA — full trading lifecycle', () => {
  it('market buy: stage → commit → push → position appears + cash decreases', async () => {
    uta.stagePlaceOrder({ aliceId: 'mock-AAPL', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 })
    const commitResult = uta.commit('buy 10 AAPL')
    expect(commitResult.prepared).toBe(true)
    expect(commitResult.operationCount).toBe(1)

    const pushResult = await uta.push()
    expect(pushResult.filled).toHaveLength(1)
    expect(pushResult.rejected).toHaveLength(0)
    expect(pushResult.filled[0].orderId).toBeDefined()

    // Position appeared
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].contract.symbol).toBe('AAPL')
    expect(positions[0].quantity.toNumber()).toBe(10)
    expect(positions[0].side).toBe('long')

    // Cash decreased
    const account = await broker.getAccount()
    expect(account.totalCashValue).toBe(100_000 - 10 * 150)
  })

  it('getState reflects positions and pending orders', async () => {
    // Buy some AAPL
    uta.stagePlaceOrder({ aliceId: 'mock-AAPL', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 })
    uta.commit('buy AAPL')
    await uta.push()

    // Place a limit order (goes pending)
    uta.stagePlaceOrder({ aliceId: 'mock-ETH', symbol: 'ETH', side: 'buy', type: 'limit', qty: 1, price: 1800 })
    uta.commit('limit buy ETH')
    const limitPush = await uta.push()
    expect(limitPush.pending).toHaveLength(1)

    // Check state
    const state = await uta.getState()
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0].contract.symbol).toBe('AAPL')
    expect(state.pendingOrders).toHaveLength(1)
    expect(state.totalCashValue).toBe(100_000 - 10 * 150) // only market order deducted
  })

  it('limit order → pending → fill → sync detects filled', async () => {
    uta.stagePlaceOrder({ aliceId: 'mock-AAPL', symbol: 'AAPL', side: 'buy', type: 'limit', qty: 5, price: 145 })
    uta.commit('limit buy AAPL')
    const pushResult = await uta.push()
    expect(pushResult.pending).toHaveLength(1)

    const orderId = pushResult.pending[0].orderId!

    // Not filled yet — sync finds no changes
    const sync1 = await uta.sync()
    expect(sync1.updatedCount).toBe(0)

    // Exchange fills the order
    broker.fillPendingOrder(orderId, 144)

    // Sync detects the fill
    const sync2 = await uta.sync()
    expect(sync2.updatedCount).toBe(1)
    expect(sync2.updates[0].currentStatus).toBe('filled')

    // Position appeared
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].quantity.toNumber()).toBe(5)
    expect(positions[0].avgCost).toBe(144)
  })

  it('partial close reduces position', async () => {
    // Buy 10
    uta.stagePlaceOrder({ aliceId: 'mock-AAPL', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 })
    uta.commit('buy')
    await uta.push()

    // Close 3
    uta.stageClosePosition({ aliceId: 'mock-AAPL', qty: 3 })
    uta.commit('partial close')
    const closeResult = await uta.push()
    expect(closeResult.filled).toHaveLength(1)

    // 7 remaining
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].quantity.toNumber()).toBe(7)
  })

  it('full close removes position + restores cash', async () => {
    broker.setQuote('AAPL', 150)
    uta.stagePlaceOrder({ aliceId: 'mock-AAPL', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 })
    uta.commit('buy')
    await uta.push()

    // Close all (no qty = full close)
    uta.stageClosePosition({ aliceId: 'mock-AAPL' })
    uta.commit('close all')
    await uta.push()

    expect(await broker.getPositions()).toHaveLength(0)

    // Cash restored (buy at 150, sell at 150 → break even)
    const account = await broker.getAccount()
    expect(account.totalCashValue).toBe(100_000)
  })

  it('cancel pending order → sync detects cancelled', async () => {
    uta.stagePlaceOrder({ aliceId: 'mock-AAPL', symbol: 'AAPL', side: 'buy', type: 'limit', qty: 5, price: 140 })
    uta.commit('limit buy')
    const pushResult = await uta.push()
    const orderId = pushResult.pending[0].orderId!

    // Cancel via broker directly (simulating user action)
    uta.stageCancelOrder({ orderId })
    uta.commit('cancel')
    await uta.push()

    // Verify cancelled
    const order = await broker.getOrder(orderId)
    expect(order!.orderState.status).toBe('Cancelled')
  })

  it('trading history records all commits', async () => {
    uta.stagePlaceOrder({ aliceId: 'mock-AAPL', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 })
    uta.commit('buy AAPL')
    await uta.push()

    uta.stageClosePosition({ aliceId: 'mock-AAPL' })
    uta.commit('close AAPL')
    await uta.push()

    const history = uta.log()
    expect(history).toHaveLength(2)
    expect(history[0].message).toBe('close AAPL') // newest first
    expect(history[1].message).toBe('buy AAPL')
  })
})

// ==================== Precision end-to-end ====================

describe('UTA — precision end-to-end', () => {
  it('fractional qty survives stage → push → position', async () => {
    broker.setQuote('ETH', 1920)

    uta.stagePlaceOrder({ aliceId: 'mock-ETH', symbol: 'ETH', side: 'buy', type: 'market', qty: 0.123456789 })
    uta.commit('buy fractional ETH')
    const result = await uta.push()

    expect(result.filled).toHaveLength(1)
    const positions = await broker.getPositions()
    expect(positions[0].quantity.toString()).toBe('0.123456789')
  })

  it('partial close precision: 1.0 - 0.3 = 0.7 exactly', async () => {
    broker.setQuote('ETH', 1920)

    uta.stagePlaceOrder({ aliceId: 'mock-ETH', symbol: 'ETH', side: 'buy', type: 'market', qty: 1.0 })
    uta.commit('buy 1 ETH')
    await uta.push()

    uta.stageClosePosition({ aliceId: 'mock-ETH', qty: 0.3 })
    uta.commit('close 0.3 ETH')
    await uta.push()

    const positions = await broker.getPositions()
    expect(positions[0].quantity.toString()).toBe('0.7')
  })
})
