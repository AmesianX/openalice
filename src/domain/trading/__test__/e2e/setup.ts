/**
 * E2E test setup — reads Alice's real config to build sandbox/paper brokers.
 *
 * Uses the same code path as main.ts: loadTradingConfig → createPlatformFromConfig
 * → createBrokerFromConfig. Only selects accounts on sandbox/paper platforms.
 *
 * If no sandbox/paper accounts are configured, tests using these helpers should skip.
 */

import { loadTradingConfig } from '@/core/config.js'
import type { IBroker } from '../../brokers/types.js'
import { createPlatformFromConfig, createBrokerFromConfig } from '../../brokers/factory.js'

export interface TestAccount {
  id: string
  label: string
  provider: 'ccxt' | 'alpaca'
  broker: IBroker
}

/**
 * Read platforms.json + accounts.json, build brokers for sandbox/paper accounts only.
 * Does NOT call broker.init() — caller decides when to connect.
 */
export async function loadTestAccounts(): Promise<TestAccount[]> {
  const { platforms, accounts } = await loadTradingConfig()
  const platformMap = new Map(platforms.map(p => [p.id, p]))
  const result: TestAccount[] = []

  for (const acct of accounts) {
    const platCfg = platformMap.get(acct.platformId)
    if (!platCfg) continue

    // Only sandbox/paper/demoTrading accounts — never touch real money
    const isSafe =
      (platCfg.type === 'ccxt' && (platCfg.sandbox || platCfg.demoTrading)) ||
      (platCfg.type === 'alpaca' && platCfg.paper)
    if (!isSafe) continue

    // Must have API key to be useful
    if (!acct.apiKey) continue

    const platform = createPlatformFromConfig(platCfg)
    const broker = createBrokerFromConfig(platform, acct)
    result.push({
      id: acct.id,
      label: acct.label ?? acct.id,
      provider: platCfg.type,
      broker,
    })
  }

  return result
}

/** Filter test accounts by provider type. */
export function filterByProvider(accounts: TestAccount[], provider: 'ccxt' | 'alpaca'): TestAccount[] {
  return accounts.filter(a => a.provider === provider)
}
