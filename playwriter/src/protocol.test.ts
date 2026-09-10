import { describe, expect, test } from 'vitest'
import {
  EXTENSION_INVENTORY_FAILED_CLOSE,
  EXTENSION_INVENTORY_TIMEOUT_CLOSE,
  isBrowserAllowedWebSocketCloseCode,
} from './protocol.js'

describe('browser websocket close codes', () => {
  test('allows 1000 and 3000-4999 only', () => {
    expect([
      isBrowserAllowedWebSocketCloseCode(1000),
      isBrowserAllowedWebSocketCloseCode(1011),
      isBrowserAllowedWebSocketCloseCode(4005),
      isBrowserAllowedWebSocketCloseCode(2999),
      isBrowserAllowedWebSocketCloseCode(5000),
    ]).toEqual([true, false, true, false, false])
  })

  test('inventory close codes are browser-safe', () => {
    expect(isBrowserAllowedWebSocketCloseCode(EXTENSION_INVENTORY_TIMEOUT_CLOSE)).toBe(true)
    expect(isBrowserAllowedWebSocketCloseCode(EXTENSION_INVENTORY_FAILED_CLOSE)).toBe(true)
  })
})
