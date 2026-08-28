declare const process: { env: { PLAYWRITER_PORT: string } }
// Injected by vite at build time from playwriter/package.json version.
// CLI/MCP compare this against their own version to warn when the extension is outdated.
declare const __PLAYWRITER_VERSION__: string
// Bundled automation builds should not burn a tab on the welcome page, especially
// in headless/VPS flows where the extension is installed only to attach to the relay.
declare const __PLAYWRITER_OPEN_WELCOME_PAGE__: boolean

import dedent from 'string-dedent'
const js = dedent
import { createStore } from 'zustand/vanilla'
import type { ExtensionState, ConnectionState, TabState, TabInfo } from './types'
import { initPlaywriterToolbar } from './toolbar/toolbar'
import type { CDPEvent, Protocol } from 'playwriter/src/cdp-types'
import type { ExtensionCommandMessage, ExtensionResponseMessage } from 'playwriter/src/protocol'
import { handleGhostBrowserCommand, type GhostBrowserCommandParams } from 'playwriter/src/ghost-browser'
import { RemoteTunnel } from './remote-tunnel'
import {
  REMOTE_TUNNEL_BASE_DOMAIN,
  buildRemoteHelloMessage,
  buildRemoteControlPrompt,
  buildRemoteTabNotSharedError,
  generateTunnelId,
  getRemoteCdpCommandRejection,
  getRemoteExtensionMethodRejection,
} from 'playwriter/src/remote-control'
// Inlined at build time via vite ?raw. Source: playwriter/src/ghost-cursor-client.ts
import ghostCursorBundleCode from '../../playwriter/dist/ghost-cursor-client.js?raw'
// Bippy: React fiber introspection library, used for "Copy React Source Path" context menu.
// Built by playwriter/scripts/build-client-bundles.ts, exposes globalThis.__bippy
import bippyBundleCode from '../../playwriter/dist/bippy.js?raw'
import {
  getActiveRecordings,
  handleStartRecording,
  handleStopRecording,
  handleIsRecording,
  handleCancelRecording,
  cleanupRecordingForTab,
  ensureOffscreenDocument,
} from './recording'
import type { OffscreenCopyTextResult } from './offscreen-types'

function isTruthy<T>(value: T): value is NonNullable<T> {
  return Boolean(value)
}

const RELAY_HOST = '127.0.0.1'
const RELAY_PORT = Number(process.env.PLAYWRITER_PORT) || 19988

// CDP commands that should return near-instantly on a healthy tab. If a tab is
// frozen/hibernated (e.g. Ghost Browser suspended tabs), chrome.debugger.sendCommand
// hangs forever. These commands get a 10s timeout so frozen tabs fail fast instead of
// blocking the entire Playwright connection setup for 30s per command.
// CDP commands that should return near-instantly on a healthy tab. If a tab is
// frozen/hibernated (e.g. Ghost Browser suspended tabs), chrome.debugger.sendCommand
// hangs forever. These commands get a 10s timeout so frozen tabs fail fast instead of
// blocking the entire Playwright connection setup for 30s per command.
// Note: Page.addScriptToEvaluateOnNewDocument is NOT included because user-provided
// scripts with runImmediately:true can legitimately take longer than 10s.
const FAST_CDP_COMMAND_TIMEOUT_MS = new Map<string, number>([
  ['Browser.getWindowForTarget', 10000],
  ['Page.enable', 10000],
  ['Page.getFrameTree', 10000],
  ['Page.setLifecycleEventsEnabled', 10000],
  ['Page.createIsolatedWorld', 10000],
  ['Page.setDownloadBehavior', 10000],
  ['Log.enable', 10000],
  ['Network.enable', 10000],
  ['Emulation.setFocusEmulationEnabled', 10000],
  ['Emulation.setEmulatedMedia', 10000],
  ['Runtime.runIfWaitingForDebugger', 10000],
  ['Target.setAutoAttach', 10000],
])

async function sendCommandWithTimeout(
  debuggee: chrome.debugger.DebuggerSession,
  method: string,
  params: object | undefined,
  timeout: number,
): Promise<unknown> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      chrome.debugger.sendCommand(debuggee, method, params),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`CDP command timed out after ${timeout}ms: ${method} (tab may be frozen/hibernated)`))
        }, timeout)
      }),
    ])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

type NavigatorWithUaData = Navigator & {
  userAgentData?: {
    brands: Array<{ brand: string; version: string }>
    getHighEntropyValues?: (hints: string[]) => Promise<{
      fullVersionList?: Array<{ brand: string; version: string }>
    }>
  }
}

type ExtensionIdentity = {
  browser: string
  email: string
  id: string
  installId: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createInstallId(): string {
  const values = new Uint32Array(2)
  crypto.getRandomValues(values)
  return Array.from(values)
    .map((value) => {
      return value.toString(36)
    })
    .join('')
}

function browserNameFromBrands(brands: Array<{ brand: string; version: string }>): string | null {
  const brandNames = brands.map((brand) => {
    return brand.brand.trim().toLowerCase()
  })

  if (brandNames.some((brand) => brand === 'brave')) return 'Brave'
  if (brandNames.some((brand) => brand === 'microsoft edge')) return 'Edge'
  if (brandNames.some((brand) => brand === 'opera')) return 'Opera'
  if (brandNames.some((brand) => brand === 'vivaldi')) return 'Vivaldi'
  if (brandNames.some((brand) => brand === 'google chrome canary')) return 'Chrome Canary'
  if (brandNames.some((brand) => brand === 'google chrome')) return 'Chrome'
  if (brandNames.some((brand) => brand === 'chromium')) return 'Chromium'
  return null
}

async function detectBrowserName(): Promise<string> {
  if ((chrome as unknown as { ghostPublicAPI?: unknown }).ghostPublicAPI) {
    return 'Ghost'
  }

  const navigatorWithUaData = navigator as NavigatorWithUaData
  const brands = navigatorWithUaData.userAgentData?.brands
  const highEntropyValues = await navigatorWithUaData.userAgentData?.getHighEntropyValues?.([
    'fullVersionList',
  ]).catch(() => {
    return null
  })
  const fullVersionList = highEntropyValues?.fullVersionList || []

  const highEntropyName = browserNameFromBrands(fullVersionList)
  if (highEntropyName) {
    return highEntropyName
  }

  if (brands && brands.length > 0) {
    const lowEntropyName = browserNameFromBrands(brands)
    if (lowEntropyName) {
      return lowEntropyName
    }
  }

  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('edg/')) return 'Edge'
  if (ua.includes('opr/')) return 'Opera'
  if (ua.includes('vivaldi')) return 'Vivaldi'
  if (ua.includes('brave')) return 'Brave'
  if (ua.includes('chrome')) return 'Chrome'
  return 'Chromium'
}

let identityPromise: Promise<ExtensionIdentity> | null = null
let installIdPromise: Promise<string> | null = null
const tabSessionScope = (() => {
  const values = new Uint32Array(2)
  crypto.getRandomValues(values)
  return Array.from(values)
    .map((value) => {
      return value.toString(36)
    })
    .join('')
})()

async function getInstallId(): Promise<string> {
  if (installIdPromise) {
    return installIdPromise
  }

  installIdPromise = (async () => {
    const existing = await chrome.storage.local.get('playwriterInstallId')
    const storedInstallId = typeof existing.playwriterInstallId === 'string' ? existing.playwriterInstallId : ''
    if (storedInstallId) {
      return storedInstallId
    }

    const installId = createInstallId()
    await chrome.storage.local.set({ playwriterInstallId: installId })
    return installId
  })().catch((error) => {
    installIdPromise = null
    throw error
  })

  return installIdPromise
}

async function getExtensionIdentity(): Promise<ExtensionIdentity> {
  if (identityPromise) {
    return identityPromise
  }

  identityPromise = (async () => {
    const browser = await detectBrowserName()
    const installId = await getInstallId().catch(() => {
      // Storage can be unavailable briefly during startup. Fall back to the runtime scope so
      // we still avoid the coarse browser-only key that causes cross-browser relay takeovers.
      return tabSessionScope
    })
    try {
      const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })
      return {
        browser,
        email: info.email || '',
        id: info.id || '',
        installId,
      }
    } catch {
      return {
        browser,
        email: '',
        id: '',
        installId,
      }
    }
  })()

  return identityPromise
}

const TAB_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'green'
const TAB_GROUP_TITLE = 'playwriter'

let childSessions: Map<string, { tabId: number; targetId?: string }> = new Map()
let nextSessionId = 1
let tabGroupQueue: Promise<void> = Promise.resolve()
// Cache Target.setAutoAttach params so existing and future tabs enable OOPIF target events.
// This ensures Playwright can build the iframe frame tree when connecting over CDP.
let autoAttachParams: Protocol.Target.SetAutoAttachRequest | null = null

// Buffer for recording chunks when WebSocket isn't ready.
// Chunks are keyed by tabId and flushed when WebSocket opens.
interface BufferedChunk {
  tabId: number
  data?: number[]
  final?: boolean
}
const recordingChunkBuffer: BufferedChunk[] = []

// ============================================================================
// Remote control: share a tab with a remote agent through a playwriter.dev tunnel.
// One tunnel per shared root tab; popups/new tabs the tab opens join its scope.
// Runtime objects (WebSockets) live here; only the evidence needed to rebuild
// tunnels after a service-worker restart is persisted in chrome.storage.session
// as {rootTabId, tunnelId, scopeTabIds}. The tunnel URL is derived from the
// persisted tunnelId so the shared link survives SW restarts but dies with the
// browser session (storage.session is cleared on browser exit).
// ============================================================================

type RemoteScope = { rootTabId: number; tabIds: Set<number> }
type RemoteTunnelRuntime = { tunnel: RemoteTunnel; tunnelId: string; scope: RemoteScope; status: string }
const remoteTunnels = new Map<number, RemoteTunnelRuntime>()

/** A message sink for relay-bound responses. Local relay has no remoteScope. */
type RelayMessageSink = { send(message: any): void; remoteScope?: RemoteScope }
/** Active relay connections arriving through tunnels, keyed by tunnelId:connId. */
const remoteRelayConnections = new Map<string, { send(message: any): void; scope: RemoteScope }>()

function findRemoteRuntimeForTab(tabId: number): RemoteTunnelRuntime | undefined {
  for (const runtime of remoteTunnels.values()) {
    if (runtime.scope.tabIds.has(tabId)) {
      return runtime
    }
  }
  return undefined
}

function getAllRemoteScopedTabIds(): Set<number> {
  const ids = new Set<number>()
  for (const runtime of remoteTunnels.values()) {
    for (const id of runtime.scope.tabIds) {
      ids.add(id)
    }
  }
  return ids
}

/**
 * Flush buffered recording chunks to the WebSocket.
 * Called when WebSocket becomes ready.
 */
function flushRecordingChunkBuffer(ws: WebSocket): void {
  if (recordingChunkBuffer.length === 0) {
    return
  }

  logger.debug(`Flushing ${recordingChunkBuffer.length} buffered recording chunks`)

  while (recordingChunkBuffer.length > 0) {
    const chunk = recordingChunkBuffer.shift()!
    const { tabId, data, final } = chunk

    // Send metadata message first
    ws.send(
      JSON.stringify({
        method: 'recordingData',
        params: { tabId, final },
      }),
    )

    // Then send binary data if not final
    if (data && !final) {
      const buffer = new Uint8Array(data)
      ws.send(buffer)
    }
  }
}

class ConnectionManager {
  ws: WebSocket | null = null
  private connectionPromise: Promise<void> | null = null
  preserveTabsOnDetach = false

  async ensureConnection(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    if (store.getState().connectionState === 'extension-replaced') {
      throw new Error('Another Playwriter extension is already connected')
    }

    // Reuse in-progress connection attempt - prevents races between user clicks and maintain loop
    if (this.connectionPromise) {
      return this.connectionPromise
    }

    // Wrap connect() with a global timeout to ensure it never hangs forever.
    // This protects against edge cases where individual timeouts don't fire
    // (e.g., DNS resolution hangs, AbortSignal doesn't work, etc.)
    const GLOBAL_TIMEOUT_MS = 15000
    this.connectionPromise = Promise.race([
      this.connect(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Connection timeout (global)'))
        }, GLOBAL_TIMEOUT_MS)
      }),
    ])

    try {
      await this.connectionPromise
    } finally {
      this.connectionPromise = null
    }
  }

  private async connect(): Promise<void> {
    logger.debug(`Waiting for server at http://${RELAY_HOST}:${RELAY_PORT}...`)

    // Retry for up to 5 seconds with 1s intervals, then give up (maintain loop will retry later)
    // Using fewer attempts since maintainLoop retries every 3 seconds anyway
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await fetch(`http://${RELAY_HOST}:${RELAY_PORT}`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
        logger.debug('Server is available')
        break
      } catch {
        if (attempt === maxAttempts - 1) {
          throw new Error('Server not available')
        }
        logger.debug(`Server not available, retrying... (attempt ${attempt + 1}/${maxAttempts})`)
        await sleep(1000)
      }
    }

    const identity = await getExtensionIdentity()
    const relayUrl = new URL(`ws://${RELAY_HOST}:${RELAY_PORT}/extension`)
    if (identity.browser) {
      relayUrl.searchParams.set('browser', identity.browser)
    }
    if (identity.email) {
      relayUrl.searchParams.set('email', identity.email)
    }
    if (identity.id) {
      relayUrl.searchParams.set('id', identity.id)
    }
    if (identity.installId) {
      relayUrl.searchParams.set('installId', identity.installId)
    }
    if (typeof __PLAYWRITER_VERSION__ !== 'undefined') {
      relayUrl.searchParams.set('v', __PLAYWRITER_VERSION__)
    }
    logger.debug('Creating WebSocket connection to:', relayUrl)
    const socket = new WebSocket(relayUrl.toString())

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        logger.debug('WebSocket connection TIMEOUT after 5 seconds')
        try {
          socket.close()
        } catch {}
        reject(new Error('Connection timeout'))
      }, 5000)

      socket.onopen = () => {
        if (settled) return
        settled = true
        logger.debug('WebSocket connected')
        clearTimeout(timeout)

        // Flush any buffered recording chunks now that WebSocket is ready
        flushRecordingChunkBuffer(socket)

        resolve()
      }

      socket.onerror = (error) => {
        logger.debug('WebSocket error during connection:', error)
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error('WebSocket connection failed'))
      }

      socket.onclose = (event) => {
        logger.debug('WebSocket closed during connection:', { code: event.code, reason: event.reason })
        if (settled) return
        settled = true
        clearTimeout(timeout)
        // Normalize 4002 rejection to consistent error message for callers to detect
        if (event.code === 4002 || event.reason === 'Extension Already In Use') {
          reject(new Error('Extension Already In Use'))
        } else {
          reject(new Error(`WebSocket closed: ${event.reason || event.code}`))
        }
      }
    })

    this.ws = socket

    this.ws.onmessage = async (event: MessageEvent) => {
      let message: any
      try {
        message = JSON.parse(event.data)
      } catch (error: any) {
        logger.debug('Error parsing message:', error)
        sendToLocalRelay({ error: { code: -32700, message: `Error parsing message: ${error.message}` } })
        return
      }

      await dispatchRelayMessage(message, localRelaySink)
    }

    this.ws.onclose = (event: CloseEvent) => {
      this.handleClose(event.reason, event.code)
    }

    this.ws.onerror = (event: Event) => {
      logger.debug('WebSocket error:', event)
    }

    logger.debug('Connection established')
  }

  private handleClose(reason: string, code: number): void {
    // Log memory at disconnect time to help diagnose memory-related terminations
    try {
      // @ts-ignore - performance.memory is Chrome-specific
      const mem = performance.memory
      if (mem) {
        const formatMB = (b: number) => (b / 1024 / 1024).toFixed(2) + 'MB'
        logger.warn(
          `DISCONNECT MEMORY: used=${formatMB(mem.usedJSHeapSize)} total=${formatMB(mem.totalJSHeapSize)} limit=${formatMB(mem.jsHeapSizeLimit)}`,
        )
      }
    } catch {}
    logger.warn(`DISCONNECT: WS closed code=${code} reason=${reason || 'none'} stack=${getCallStack()}`)

    const isExtensionReplaced = reason === 'Extension Replaced' || code === 4001
    const isExtensionInUse = reason === 'Extension Already In Use' || code === 4002
    this.preserveTabsOnDetach = !(isExtensionReplaced || isExtensionInUse)

    // Tabs shared over remote-control tunnels must survive local relay
    // disconnects — remote agents keep driving them without any local playwriter.
    const remoteTabIds = getAllRemoteScopedTabIds()

    const { tabs } = store.getState()

    for (const [tabId] of tabs) {
      if (remoteTabIds.has(tabId)) {
        continue
      }
      chrome.debugger.detach({ tabId }).catch((err) => {
        logger.debug('Error detaching from tab:', tabId, err.message)
      })
    }

    for (const [childSessionId, child] of Array.from(childSessions.entries())) {
      if (!remoteTabIds.has(child.tabId)) {
        childSessions.delete(childSessionId)
      }
    }
    this.ws = null

    // Only one extension can connect to the relay server at a time.
    // Code 4001: Another extension replaced this one (this extension was idle)
    // Code 4002: This extension tried to connect but another is actively in use
    if (isExtensionReplaced || isExtensionInUse) {
      const errorText = isExtensionReplaced
        ? 'Another Playwriter extension took over the connection'
        : 'Another Playwriter extension is actively in use'
      logger.debug(
        isExtensionReplaced
          ? 'Disconnected: another Playwriter extension connected (this one was idle)'
          : 'Rejected: another Playwriter extension is actively in use',
      )
      store.setState((state) => {
        const remoteOnlyTabs = new Map(
          Array.from(state.tabs.entries()).filter(([tabId]) => remoteTabIds.has(tabId)),
        )
        return {
          tabs: remoteOnlyTabs,
          connectionState: 'extension-replaced' as ConnectionState,
          errorText,
        }
      })
      return
    }

    // For normal disconnects, set tabs to 'connecting' state and let maintain loop handle reconnect
    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      for (const [tabId, tab] of newTabs) {
        if (remoteTabIds.has(tabId)) {
          continue
        }
        newTabs.set(tabId, { ...tab, state: 'connecting' })
      }
      return { tabs: newTabs, connectionState: 'idle', errorText: undefined }
    })
  }

  async maintainLoop(): Promise<void> {
    while (true) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        await sleep(1000)
        continue
      }

      // When another Playwriter extension took over, poll until no same-key replacement is
      // connected anymore. Reclaiming while another worker is merely idle is racy: a fresh
      // replacement reports activeTargets=0 before it re-attaches tabs, so the old worker can
      // steal the slot back and disconnect the live browser instance.
      if (store.getState().connectionState === 'extension-replaced') {
        try {
          const response = await fetch(`http://${RELAY_HOST}:${RELAY_PORT}/extension/status`, {
            method: 'GET',
            signal: AbortSignal.timeout(2000),
          })
          const data = (await response.json()) as { connected: boolean; activeTargets: number }
          const slotAvailable = !data.connected
          if (slotAvailable) {
            store.setState({ connectionState: 'idle', errorText: undefined })
            logger.debug(
              'Extension slot is free (connected:',
              data.connected,
              'activeTargets:',
              data.activeTargets,
              '), cleared error state',
            )
          } else {
            logger.debug('Extension slot still taken (activeTargets:', data.activeTargets, '), will retry...')
          }
        } catch {
          logger.debug('Server not available, will retry...')
        }
        await sleep(3000)
        continue
      }

      // Ensure tabs are in 'connecting' state when WS is not connected
      // This handles edge cases where handleClose wasn't called or state got out of sync.
      // Remote-scoped tabs stay 'connected': their consumer is the tunnel, not the local relay.
      const remoteTabIds = getAllRemoteScopedTabIds()
      const currentTabs = store.getState().tabs
      const hasConnectedTabs = Array.from(currentTabs.entries()).some(
        ([tabId, t]) => t.state === 'connected' && !remoteTabIds.has(tabId),
      )
      if (hasConnectedTabs) {
        store.setState((state) => {
          const newTabs = new Map(state.tabs)
          for (const [tabId, tab] of newTabs) {
            if (tab.state === 'connected' && !remoteTabIds.has(tabId)) {
              newTabs.set(tabId, { ...tab, state: 'connecting' })
            }
          }
          return { tabs: newTabs }
        })
      }

      // Try to connect silently in background - don't show 'connecting' badge
      // Individual tab states will show 'connecting' when user explicitly clicks
      try {
        await this.ensureConnection()
        store.setState({ connectionState: 'connected' })

        // Announce tabs that stayed attached while the relay was down (remote-scoped
        // tabs) so the local relay learns their targets. The relay dedupes targets it
        // already knows, so re-announcing is safe.
        await announceConnectedTabsToLocalRelay()

        // Re-attach any tabs that were in 'connecting' state (from a previous disconnect)
        const tabsToReattach = Array.from(store.getState().tabs.entries())
          .filter(([_, tab]) => tab.state === 'connecting')
          .map(([tabId]) => tabId)

        for (const tabId of tabsToReattach) {
          // Re-check state before attaching - might have been attached by user click
          const currentTab = store.getState().tabs.get(tabId)
          if (!currentTab || currentTab.state !== 'connecting') {
            logger.debug('Skipping reattach, tab state changed:', tabId, currentTab?.state)
            continue
          }

          try {
            await chrome.tabs.get(tabId)
            await attachTab(tabId)
            logger.debug('Successfully re-attached tab:', tabId)
          } catch (error: any) {
            logger.debug('Failed to re-attach tab:', tabId, error.message)
            store.setState((state) => {
              const newTabs = new Map(state.tabs)
              newTabs.delete(tabId)
              return { tabs: newTabs }
            })
          }
        }
        this.preserveTabsOnDetach = false
      } catch (error: any) {
        logger.debug('Connection attempt failed:', error.message)
        // Check if rejected because another extension is actively in use
        if (error.message === 'Extension Already In Use') {
          store.setState({
            connectionState: 'extension-replaced',
            errorText: 'Another Playwriter extension is actively in use',
          })
        } else {
          store.setState({ connectionState: 'idle' })
        }
      }

      await sleep(3000)
    }
  }
}

export const connectionManager = new ConnectionManager()

export const store = createStore<ExtensionState>(() => ({
  tabs: new Map(),
  connectionState: 'idle',
  currentTabId: undefined,
  preferredWindowId: undefined,
  errorText: undefined,
}))

// @ts-ignore
globalThis.toggleExtensionForActiveTab = toggleExtensionForActiveTab
// @ts-ignore
globalThis.disconnectEverything = disconnectEverything
// @ts-ignore
globalThis.getExtensionState = () => store.getState()
// @ts-ignore
globalThis.startRemoteControlForActiveTab = startRemoteControlForActiveTab
// @ts-ignore
globalThis.stopRemoteControlForTab = stopRemoteControlForTab
// @ts-ignore
globalThis.getRemoteControlState = getRemoteControlState

declare global {
  var toggleExtensionForActiveTab: () => Promise<{ isConnected: boolean; state: ExtensionState }>
  var getExtensionState: () => ExtensionState
  var disconnectEverything: () => Promise<void>
  var startRemoteControlForActiveTab: () => Promise<{ url: string }>
  var stopRemoteControlForTab: (tabId: number) => boolean
  var getRemoteControlState: () => Array<{ rootTabId: number; url: string; status: string; scopeTabIds: number[] }>
}

const MAX_LOG_STRING_LENGTH = 2000

function truncateLogString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) {
    return value
  }
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}…[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`
}

function safeSerialize(arg: any): string {
  if (arg === undefined) return 'undefined'
  if (arg === null) return 'null'
  if (typeof arg === 'function') return `[Function: ${arg.name || 'anonymous'}]`
  if (typeof arg === 'symbol') return String(arg)
  if (typeof arg === 'string') return truncateLogString(arg)
  if (arg instanceof Error) return truncateLogString(arg.stack || arg.message || String(arg))
  if (typeof arg === 'object') {
    try {
      const seen = new WeakSet()
      const serialized = JSON.stringify(arg, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
          if (value instanceof Map) return { dataType: 'Map', value: Array.from(value.entries()) }
          if (value instanceof Set) return { dataType: 'Set', value: Array.from(value.values()) }
        }
        return value
      })
      return truncateLogString(serialized)
    } catch {
      return truncateLogString(String(arg))
    }
  }
  return truncateLogString(String(arg))
}

function sendLog(level: string, args: any[]) {
  sendMessage({
    method: 'log',
    params: { level, args: args.map(safeSerialize) },
  })
}

export const logger = {
  log: (...args: any[]) => {
    console.log(...args)
    sendLog('log', args)
  },
  debug: (...args: any[]) => {
    console.debug(...args)
    sendLog('debug', args)
  },
  info: (...args: any[]) => {
    console.info(...args)
    sendLog('info', args)
  },
  warn: (...args: any[]) => {
    console.warn(...args)
    sendLog('warn', args)
  },
  error: (...args: any[]) => {
    console.error(...args)
    sendLog('error', args)
  },
}

function getCallStack(): string {
  const stack = new Error().stack || ''
  return stack.split('\n').slice(2, 6).join(' <- ').replace(/\s+/g, ' ')
}

self.addEventListener('error', (event) => {
  const error = event.error
  const stack = error?.stack || `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`
  logger.error('Uncaught error:', stack)
})

self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const stack = reason?.stack || String(reason)
  logger.error('Unhandled promise rejection:', stack)
})

let messageCount = 0
function sendToLocalRelay(message: any): void {
  if (connectionManager.ws?.readyState === WebSocket.OPEN) {
    try {
      connectionManager.ws.send(JSON.stringify(message))
      // Check memory periodically (every ~100 messages)
      if (++messageCount % 100 === 0) {
        checkMemory()
      }
    } catch (error: any) {
      console.debug('ERROR sending message:', error, 'message type:', message.method || 'response')
    }
  }
}

const localRelaySink: RelayMessageSink = { send: sendToLocalRelay }

// Resolve which tab a forwarded CDP event belongs to, for remote scope filtering.
// Events carry the tab session on the outer sessionId (debugger events) or the
// inner params.sessionId (attach/detach events emitted by attachTab/detachTab).
function resolveEventTabId(eventParams: any): number | undefined {
  const candidates = [eventParams?.sessionId, eventParams?.params?.sessionId]
  for (const sid of candidates) {
    if (typeof sid !== 'string') {
      continue
    }
    const bySession = getTabBySessionId(sid)
    if (bySession) {
      return bySession.tabId
    }
    const child = childSessions.get(sid)
    if (child) {
      return child.tabId
    }
  }
  const targetId = eventParams?.params?.targetId
  if (typeof targetId === 'string') {
    const byTarget = getTabByTargetId(targetId)
    if (byTarget) {
      return byTarget.tabId
    }
  }
  return undefined
}

// Fan CDP events out to tunneled relay connections whose scope contains the
// event's tab. Responses never travel here — they go through the sink of the
// connection that issued the command. Logs and recording data stay local only.
function broadcastEventToRemoteRelays(message: any): void {
  if (remoteRelayConnections.size === 0) {
    return
  }
  if (message?.method !== 'forwardCDPEvent') {
    return
  }
  const tabId = resolveEventTabId(message.params)
  if (tabId === undefined) {
    return
  }
  for (const conn of remoteRelayConnections.values()) {
    if (conn.scope.tabIds.has(tabId)) {
      conn.send(message)
    }
  }
}

export function sendMessage(message: any): void {
  sendToLocalRelay(message)
  broadcastEventToRemoteRelays(message)
}

// Handles one relay-bound protocol message from either the local relay WS or a
// tunneled remote relay connection. Responses go back through the originating
// sink so message ids from different relays never collide.
async function dispatchRelayMessage(message: any, sink: RelayMessageSink): Promise<void> {
  // Handle ping from server - respond with pong to keep service worker alive
  if (message.method === 'ping') {
    sink.send({ method: 'pong' })
    return
  }

  // Relay notifies us when action recording starts/stops — update toolbar in all connected tabs
  if (message.method === 'setRecorderState') {
    const recording = !!(message.params as { recording?: boolean })?.recording
    setRecorderStateInAllTabs(recording)
    return
  }

  // Remote relay connections are scoped to the shared tab: block tab creation,
  // recording, and Ghost Browser APIs with helpful errors.
  if (sink.remoteScope) {
    const rejection = getRemoteExtensionMethodRejection(message.method)
    if (rejection) {
      if (message.id !== undefined) {
        sink.send({ id: message.id, error: rejection })
      }
      return
    }
  }

  // Handle createInitialTab - create a new tab when Playwright connects and no tabs exist
  // We use skipAttachedEvent: true because the relay's Target.setAutoAttach handler will send
  // Target.attachedToTarget for all targets in connectedTargets. If we also sent it here,
  // Playwright would receive a duplicate.
  //
  // This differs from the normal flow (user clicks extension icon) where:
  // 1. Extension attaches and sends Target.attachedToTarget to existing Playwright clients
  // 2. New Playwright clients that connect later get targets via Target.setAutoAttach
  //
  // But with createInitialTab, the SAME client that triggered the create is waiting for
  // Target.setAutoAttach - so we'd send the event twice to the same client.
  if (message.method === 'createInitialTab') {
    try {
      logger.debug('Creating initial tab for Playwright client')
      const tab = await createTabInPreferredWindow({ url: 'about:blank', active: false })
      if (tab.id) {
        setTabConnecting(tab.id)
        const { targetInfo, sessionId } = await attachTab(tab.id, { skipAttachedEvent: true })
        logger.debug('Initial tab created and connected:', tab.id, 'sessionId:', sessionId)
        sink.send({
          id: message.id,
          result: {
            success: true,
            tabId: tab.id,
            sessionId,
            targetInfo,
          },
        })
      } else {
        throw new Error('Failed to create tab - no tab ID returned')
      }
    } catch (error: any) {
      logger.debug('Failed to create initial tab:', error)
      sink.send({ id: message.id, error: error.message })
    }
    return
  }

  // Handle recording commands
  if (message.method === 'startRecording') {
    try {
      const result = await handleStartRecording(message.params)
      sink.send({ id: message.id, result })
    } catch (error: any) {
      logger.error('Failed to start recording:', error)
      sink.send({ id: message.id, result: { success: false, error: error.message } })
    }
    return
  }

  if (message.method === 'stopRecording') {
    try {
      const result = await handleStopRecording(message.params)
      sink.send({ id: message.id, result })
    } catch (error: any) {
      logger.error('Failed to stop recording:', error)
      sink.send({ id: message.id, result: { success: false, error: error.message } })
    }
    return
  }

  if (message.method === 'isRecording') {
    try {
      const result = await handleIsRecording(message.params)
      sink.send({ id: message.id, result })
    } catch (error: any) {
      logger.error('Failed to check recording status:', error)
      sink.send({ id: message.id, result: { isRecording: false } })
    }
    return
  }

  if (message.method === 'cancelRecording') {
    try {
      const result = await handleCancelRecording(message.params)
      sink.send({ id: message.id, result })
    } catch (error: any) {
      logger.error('Failed to cancel recording:', error)
      sink.send({ id: message.id, result: { success: false, error: error.message } })
    }
    return
  }

  // Handle Ghost Browser API commands
  // This allows calling chrome.ghostPublicAPI, chrome.ghostProxies, chrome.projects
  // from the playwriter executor sandbox when running in Ghost Browser
  if (message.method === 'ghost-browser') {
    const params = message.params as GhostBrowserCommandParams
    const result = await handleGhostBrowserCommand(params, chrome)
    if (!result.success) {
      logger.error('Ghost Browser API error:', result.error)
    }
    // Auto-connect tabs created via ghostPublicAPI.openTab so they appear in context.pages()
    if (result.success && params.namespace === 'ghostPublicAPI' && params.method === 'openTab') {
      const tabId = result.result as number
      if (tabId) {
        logger.debug('Auto-connecting Ghost Browser tab:', tabId)
        setTabConnecting(tabId)
        await sleep(100)
        await attachTab(tabId)
      }
    }
    sink.send({ id: message.id, result })
    return
  }

  const response: ExtensionResponseMessage = { id: message.id }
  try {
    response.result = await handleCommand(message as ExtensionCommandMessage, sink.remoteScope)
  } catch (error: any) {
    logger.debug('Error handling command:', error)
    response.error = error.message
  }
  sink.send(response)
}

async function getPreferredWindowId(): Promise<number | undefined> {
  const { preferredWindowId, currentTabId } = store.getState()
  if (preferredWindowId !== undefined) {
    try {
      await chrome.windows.get(preferredWindowId)
      return preferredWindowId
    } catch {
      store.setState({ preferredWindowId: undefined })
    }
  }

  if (currentTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(currentTabId)
      if (tab.windowId !== undefined) {
        return tab.windowId
      }
    } catch {}
  }

  try {
    const focusedWindow = await chrome.windows.getLastFocused({ populate: false })
    return focusedWindow.id
  } catch {
    return undefined
  }
}

async function createTabInPreferredWindow(options: { url: string; active: boolean }): Promise<chrome.tabs.Tab> {
  const windowId = await getPreferredWindowId()
  const createProperties: chrome.tabs.CreateProperties = {
    url: options.url,
    active: options.active,
    ...(windowId !== undefined ? { windowId } : {}),
  }

  try {
    return await chrome.tabs.create(createProperties)
  } catch (error) {
    logger.debug('Could not create tab in preferred window, falling back:', (error as Error).message)
    return await chrome.tabs.create({ url: options.url, active: options.active })
  }
}

async function syncTabGroup(): Promise<void> {
  try {
    // Include 'connecting' tabs in the group only when the relay is alive, so that
    // tabs the user drags into the group stay visible while attaching. When the relay
    // is dead all tabs are 'connecting' (waiting for reconnect) and the group should
    // be cleaned up. The onUpdated handler (line ~1601) already guards against the
    // ungroup→disconnect loop for 'connecting' tabs, so excluding them here is safe.
    const { connectionState } = store.getState()
    const isRelayConnected = connectionState === 'connected'
    const connectedTabIds = Array.from(store.getState().tabs.entries())
      .filter(([_, info]) => info.state === 'connected' || (info.state === 'connecting' && isRelayConnected))
      .map(([tabId]) => tabId)

    // Always query by title - no cached ID that can go stale
    const existingGroups = await chrome.tabGroups.query({ title: TAB_GROUP_TITLE })

    // If no connected tabs, clear any existing playwriter groups
    if (connectedTabIds.length === 0) {
      for (const group of existingGroups) {
        const tabsInGroup = await chrome.tabs.query({ groupId: group.id })
        const tabIdsToUngroup = tabsInGroup.map((t) => t.id).filter(isTruthy)
        if (tabIdsToUngroup.length > 0) {
          await chrome.tabs.ungroup(tabIdsToUngroup)
        }
        logger.debug('Cleared playwriter group:', group.id)
      }
      return
    }

    // Consolidate duplicate groups into one
    let groupId: number | undefined = existingGroups[0]?.id
    if (existingGroups.length > 1) {
      const [keep, ...duplicates] = existingGroups
      groupId = keep.id
      for (const group of duplicates) {
        const tabsInDupe = await chrome.tabs.query({ groupId: group.id })
        const tabIdsToUngroup = tabsInDupe.map((t) => t.id).filter(isTruthy)
        if (tabIdsToUngroup.length > 0) {
          await chrome.tabs.ungroup(tabIdsToUngroup)
        }
        logger.debug('Removed duplicate playwriter group:', group.id)
      }
    }

    const allTabs = await chrome.tabs.query({})
    const tabsInGroup = allTabs.filter((t) => t.groupId === groupId && t.id !== undefined)
    const tabIdsInGroup = new Set(tabsInGroup.map((t) => t.id!))

    const tabsToAdd = connectedTabIds.filter((id) => !tabIdsInGroup.has(id))
    const tabsToRemove = Array.from(tabIdsInGroup).filter((id) => !connectedTabIds.includes(id))

    if (tabsToRemove.length > 0) {
      try {
        await chrome.tabs.ungroup(tabsToRemove)
        logger.debug('Removed tabs from group:', tabsToRemove)
      } catch (e: any) {
        logger.debug('Failed to ungroup tabs:', tabsToRemove, e.message)
      }
    }

    if (tabsToAdd.length > 0) {
      if (groupId === undefined) {
        const newGroupId = await chrome.tabs.group({ tabIds: tabsToAdd })
        await chrome.tabGroups.update(newGroupId, { title: TAB_GROUP_TITLE, color: TAB_GROUP_COLOR })
        logger.debug('Created tab group:', newGroupId, 'with tabs:', tabsToAdd)
      } else {
        await chrome.tabs.group({ tabIds: tabsToAdd, groupId })
        await chrome.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: TAB_GROUP_COLOR })
        logger.debug('Added tabs to existing group:', tabsToAdd)
      }
    } else if (groupId !== undefined) {
      // No tabs to add, but ensure the existing group keeps the right color/title.
      // Chrome can reset these on group collapse/expand or tab moves.
      await chrome.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: TAB_GROUP_COLOR })
    }
  } catch (error: any) {
    logger.debug('Failed to sync tab group:', error.message)
  }
}

export function getTabBySessionId(sessionId: string): { tabId: number; tab: TabInfo } | undefined {
  for (const [tabId, tab] of store.getState().tabs) {
    if (tab.sessionId === sessionId) {
      return { tabId, tab }
    }
  }
  return undefined
}

function getTabByTargetId(targetId: string): { tabId: number; tab: TabInfo } | undefined {
  for (const [tabId, tab] of store.getState().tabs) {
    if (tab.targetId === targetId) {
      return { tabId, tab }
    }
  }
  return undefined
}

function emitChildDetachesForTab(tabId: number): void {
  const childEntries = Array.from(childSessions.entries()).filter(([_, parentTab]) => parentTab.tabId === tabId)

  childEntries.forEach(([childSessionId, parentTab]) => {
    const childDetachParams: Protocol.Target.DetachedFromTargetEvent = parentTab.targetId
      ? { sessionId: childSessionId, targetId: parentTab.targetId }
      : { sessionId: childSessionId }
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: childDetachParams,
      },
    })
    logger.debug('Cleaning up child session:', childSessionId, 'for tab:', tabId)
    childSessions.delete(childSessionId)
  })
}

// Resolve which tab a CDP command targets by checking sessionId sources in priority order:
// 1. Top-level sessionId (the CDP session the command was sent on)
// 2. params.sessionId (e.g. Target.detachFromTarget on the root session, see #40)
// 3. params.targetId (e.g. Target.closeTarget)
function getTabForCommand(msg: ExtensionCommandMessage): { tabId: number; tab: TabInfo } | undefined {
  const sessionId = msg.params.sessionId
  if (sessionId) {
    const found = getTabBySessionId(sessionId)
    if (found) {
      return found
    }
    const child = childSessions.get(sessionId)
    if (child) {
      const tab = store.getState().tabs.get(child.tabId)
      if (tab) {
        return { tabId: child.tabId, tab }
      }
    }
  }

  const paramsSessionId =
    msg.params.params && 'sessionId' in msg.params.params && typeof msg.params.params.sessionId === 'string'
      ? msg.params.params.sessionId
      : undefined
  if (paramsSessionId) {
    const found = getTabBySessionId(paramsSessionId)
    if (found) {
      return found
    }
    const child = childSessions.get(paramsSessionId)
    if (child) {
      const tab = store.getState().tabs.get(child.tabId)
      if (tab) {
        return { tabId: child.tabId, tab }
      }
    }
  }

  const targetId =
    msg.params.params && 'targetId' in msg.params.params && typeof msg.params.params.targetId === 'string'
      ? msg.params.params.targetId
      : undefined
  if (targetId) {
    return getTabByTargetId(targetId)
  }

  return undefined
}

async function handleCommand(msg: ExtensionCommandMessage, remoteScope?: RemoteScope): Promise<any> {
  if (msg.method !== 'forwardCDPCommand') return

  // Remote relay connections: reject tab creation and browser-wide destructive
  // commands with helpful errors before any routing happens.
  if (remoteScope) {
    const rejection = getRemoteCdpCommandRejection(msg.params.method)
    if (rejection) {
      throw new Error(rejection)
    }
  }

  const resolved = getTabForCommand(msg)
  let targetTabId = resolved?.tabId
  let targetTab = resolved?.tab

  if (remoteScope && targetTabId !== undefined && !remoteScope.tabIds.has(targetTabId)) {
    throw new Error(buildRemoteTabNotSharedError({ method: msg.params.method, sessionId: msg.params.sessionId }))
  }

  const debuggee = targetTabId ? { tabId: targetTabId } : undefined

  // Root-level Target.setAutoAttach must apply to all connected tabs since
  // CDP auto-attach is per-debugger-session. Without this, OOPIF targets never attach.
  if (msg.params.method === 'Target.setAutoAttach' && !msg.params.sessionId) {
    const params = msg.params.params
    if (!params) {
      return {}
    }

    autoAttachParams = params
    const connectedTabIds = Array.from(store.getState().tabs.entries())
      .filter(([_, info]) => info.state === 'connected')
      .map(([tabId]) => tabId)
      .filter((tabId) => !remoteScope || remoteScope.tabIds.has(tabId))

    await Promise.all(
      connectedTabIds.map(async (tabId) => {
        try {
          await sendCommandWithTimeout({ tabId }, 'Target.setAutoAttach', params, 10000)
        } catch (error) {
          logger.debug('Failed to set auto-attach for tab:', tabId, error)
        }
      }),
    )

    return {}
  }

  // TODO disable network things?
  // if (msg.params.method === 'Network.enable' && msg.params.source !== 'playwriter') {
  //   logger.debug('Skipping Network.enable from non-playwriter CDP client:', msg.params.sessionId)
  //   return {}
  // }

  switch (msg.params.method) {
    case 'Runtime.enable': {
      if (!debuggee) {
        throw new Error(`No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`)
      }
      // Keep Runtime.enable bound to the incoming child sessionId for OOPIF iframes.
      // If we send Runtime.enable on the tab root session, child iframe targets never
      // emit Runtime.executionContextCreated and frame locators can hang.
      const runtimeSession: chrome.debugger.DebuggerSession = {
        ...debuggee,
        sessionId: msg.params.sessionId !== targetTab?.sessionId ? msg.params.sessionId : undefined,
      }
      // When multiple Playwright clients connect to the same tab, each calls Runtime.enable.
      // If Runtime is already enabled, the enable call succeeds but Chrome doesn't re-send
      // Runtime.executionContextCreated events - those were already sent to the first client.
      // By disabling first, we force Chrome to re-send all execution context events when we
      // re-enable, ensuring the new client receives them. The relay server waits for the
      // executionContextCreated events before returning. See cdp-timing.md for details.
      try {
        await sendCommandWithTimeout(runtimeSession, 'Runtime.disable', undefined, 10000)
        await sleep(50)
      } catch (e) {
        logger.debug('Error disabling Runtime (ignoring):', e)
      }
      return await sendCommandWithTimeout(runtimeSession, 'Runtime.enable', msg.params.params, 10000)
    }

    case 'Target.createTarget': {
      const url = msg.params.params?.url || 'about:blank'
      logger.debug('Creating new tab with URL:', url)
      const tab = await createTabInPreferredWindow({ url, active: false })
      if (!tab.id) throw new Error('Failed to create tab')
      setTabConnecting(tab.id)
      logger.debug('Created tab:', tab.id, 'waiting for it to load...')
      await sleep(100)
      const { targetInfo } = await attachTab(tab.id)
      return { targetId: targetInfo.targetId } satisfies Protocol.Target.CreateTargetResponse
    }

    case 'Target.closeTarget': {
      if (!targetTabId) {
        logger.log(`Target not found: ${msg.params.params?.targetId}`)
        return { success: false } satisfies Protocol.Target.CloseTargetResponse
      }
      await chrome.tabs.remove(targetTabId)
      return { success: true } satisfies Protocol.Target.CloseTargetResponse
    }
  }

  if (!debuggee || !targetTab) {
    // Target.detachFromTarget is best-effort — no-op if the session is already gone (#40).
    if (msg.params.method === 'Target.detachFromTarget') {
      return {}
    }

    throw new Error(
      `No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId} params: ${JSON.stringify(msg.params.params || null)}`,
    )
  }

  logger.debug('CDP command:', msg.params.method, 'for tab:', targetTabId)

  const debuggerSession: chrome.debugger.DebuggerSession = {
    ...debuggee,
    sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : undefined,
  }

  const timeout = FAST_CDP_COMMAND_TIMEOUT_MS.get(msg.params.method)
  if (timeout) {
    return await sendCommandWithTimeout(debuggerSession, msg.params.method, msg.params.params, timeout)
  }
  return await chrome.debugger.sendCommand(debuggerSession, msg.params.method, msg.params.params)
}

// CDP events dropped before sending over WebSocket to the relay.
// Only events no Playwright API depends on. The relay also filters these server-side
// for backwards compatibility with old extensions.
// NOTE: *ExtraInfo events feed Playwright's ResponseExtraInfoTracker (request/response.allHeaders()).
// webSocketFrame* events feed page.on('websocket'). Both must be forwarded.
// See: https://github.com/remorses/playwriter/issues/96
const DROPPED_CDP_EVENTS = new Set([
  'Network.dataReceived',
  'Network.resourceChangedPriority',
])

function onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
  if (DROPPED_CDP_EVENTS.has(method)) {
    return
  }

  const tab = source.tabId ? store.getState().tabs.get(source.tabId) : undefined
  if (!tab) return

  if (method !== 'Page.screencastFrame') {
    logger.debug('Forwarding CDP event:', method, 'from tab:', source.tabId)
  }

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    const targetUrl = params.targetInfo?.url as string | undefined
    // Filter out restricted child targets (other extensions' chrome-extension:// iframes,
    // chrome:// pages, devtools://, etc). Without this, Chrome's debugger API throws
    // "Cannot access a chrome-extension:// URL of a different extension" when the relay
    // tries to send commands (e.g. Runtime.runIfWaitingForDebugger) to these targets,
    // crashing the entire debugger session. See: https://github.com/remorses/playwriter/issues/18
    if (isRestrictedUrl(targetUrl)) {
      logger.debug(
        'Ignoring restricted child target:',
        targetUrl,
        'sessionId:',
        params.sessionId,
        'for tab:',
        source.tabId,
      )
      // Detach from the restricted child target to clean up. This command is sent on
      // the parent tab's debugger session (not the child), so it won't trigger the
      // restricted URL error.
      if (source.tabId) {
        chrome.debugger
          .sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: params.sessionId })
          .catch((e) => {
            logger.debug('Failed to detach restricted child target (expected):', e)
          })
      }
      return
    }

    logger.debug('Child target attached:', params.sessionId, 'for tab:', source.tabId)
    const targetId = params.targetInfo?.targetId as string | undefined
    childSessions.set(params.sessionId, { tabId: source.tabId!, targetId })
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    const mainTab = getTabBySessionId(params.sessionId)
    if (mainTab) {
      logger.debug('Main tab detached via CDP event:', mainTab.tabId, 'sessionId:', params.sessionId)
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.delete(mainTab.tabId)
        return { tabs: newTabs }
      })
      emitChildDetachesForTab(mainTab.tabId)
    } else {
      logger.debug('Child target detached:', params.sessionId)
      childSessions.delete(params.sessionId)
    }
  }

  sendMessage({
    method: 'forwardCDPEvent',
    params: {
      sessionId: source.sessionId || tab.sessionId,
      method,
      params,
    },
  })
}

function onDebuggerDetach(source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`): void {
  const tabId = source.tabId
  if (!tabId) {
    logger.debug('Ignoring debugger detach event without a tab id')
    return
  }
  const remoteRuntime = findRemoteRuntimeForTab(tabId)
  if (!store.getState().tabs.has(tabId) && !remoteRuntime) {
    logger.debug('Ignoring debugger detach event for untracked tab:', tabId)
    return
  }

  logger.warn(`DISCONNECT: onDebuggerDetach tabId=${tabId} reason=${reason}`)

  const detachTabFromPlaywright = (detachedTabId: number, tab: TabInfo) => {
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    })
    emitChildDetachesForTab(detachedTabId)
  }

  if (reason === chrome.debugger.DetachReason.CANCELED_BY_USER) {
    // Chrome's debugger info bar cancellation detaches every debugger session
    // in this extension process. Clear every tracked tab so Playwright does not
    // keep sending commands to tabs Chrome already detached from.
    for (const [detachedTabId, tab] of store.getState().tabs.entries()) {
      detachTabFromPlaywright(detachedTabId, tab)
    }
    Array.from(remoteTunnels.keys()).map((rootTabId) => {
      return stopRemoteControlForTab(rootTabId)
    })

    store.setState({ tabs: new Map(), connectionState: 'idle', errorText: undefined })
    return
  }

  if (connectionManager.preserveTabsOnDetach && !remoteRuntime) {
    logger.debug('Ignoring debugger detach during relay reconnect:', tabId, reason)
    return
  }

  const tab = store.getState().tabs.get(tabId)
  if (tab) {
    detachTabFromPlaywright(tabId, tab)
  }
  removeTabFromRemoteScopes(tabId)

  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    newTabs.delete(tabId)
    return { tabs: newTabs }
  })
}

type AttachTabResult = {
  targetInfo: Protocol.Target.TargetInfo
  sessionId: string
}

// Remove chrome-extension:// iframes from the page DOM before attaching the debugger.
// Chrome's chrome.debugger.attach API refuses to attach to tabs that contain frames from
// other extensions ("Cannot access a chrome-extension:// URL of different extension").
// Extensions like LastPass, SurfingKeys, etc. inject chrome-extension:// iframes into every
// page, breaking debugger attachment. This function temporarily removes them so the debugger
// can attach. The iframes stay removed while the debugger is active — they're typically
// re-injected by the owning extension on next page load.
// See: https://github.com/remorses/playwriter/issues/18
async function removeRestrictedIframes(tabId: number): Promise<number> {
  try {
    const results = await chrome.scripting.executeScript({
      // allFrames: true ensures we also scan same-origin subframes, not just the top document.
      target: { tabId, allFrames: true },
      func: (ownExtIds: string[]) => {
        // Traverse both the document and any open shadow roots, since some extensions
        // inject their chrome-extension:// iframes inside shadow DOM.
        const roots: ParentNode[] = [document]
        const elements = document.querySelectorAll('*')
        elements.forEach((el) => {
          const shadow = (el as HTMLElement).shadowRoot
          if (shadow) {
            roots.push(shadow)
          }
        })

        let removed = 0
        for (const root of roots) {
          root.querySelectorAll('iframe').forEach((iframe) => {
            const src = iframe.src || iframe.getAttribute('src') || ''
            if (!src.startsWith('chrome-extension://')) {
              return
            }
            const extId = src.replace('chrome-extension://', '').split('/')[0]
            if (ownExtIds.includes(extId)) {
              return
            }
            iframe.remove()
            removed++
          })
        }
        return removed
      },
      args: [OUR_EXTENSION_IDS],
    })
    const totalRemoved = results.reduce((sum, r) => sum + (r.result ?? 0), 0)
    if (totalRemoved > 0) {
      logger.debug(`Removed ${totalRemoved} restricted chrome-extension:// iframe(s) from tab:`, tabId)
    }
    return totalRemoved
  } catch (e) {
    // Scripting may fail on restricted pages (chrome://, about:, etc.) — that's fine,
    // those pages won't have extension iframes anyway.
    logger.debug('Could not remove restricted iframes (expected on some pages):', (e as Error).message)
    return 0
  }
}

async function attachTab(
  tabId: number,
  { skipAttachedEvent = false }: { skipAttachedEvent?: boolean } = {},
): Promise<AttachTabResult> {
  const debuggee = { tabId }
  let debuggerAttached = false

  try {
    logger.debug('Attaching debugger to tab:', tabId)

    // Bounded retry loop: chrome.debugger.attach fails if the tab contains chrome-extension://
    // iframes from other extensions. We remove them and retry, but aggressive extensions can
    // re-inject between cleanup and retry, so we allow up to 3 attempts.
    const maxAttachAttempts = 3
    for (let attempt = 1; attempt <= maxAttachAttempts; attempt++) {
      try {
        await chrome.debugger.attach(debuggee, '1.3')
        break
      } catch (attachError: any) {
        const msg = attachError.message ?? ''
        const isRestrictedIframeError = msg.includes('chrome-extension://') || msg.includes('different extension')
        if (!isRestrictedIframeError || attempt === maxAttachAttempts) {
          throw attachError
        }
        logger.debug(
          `Debugger attach blocked by chrome-extension:// iframe (attempt ${attempt}/${maxAttachAttempts}), removing and retrying:`,
          tabId,
        )
        await removeRestrictedIframes(tabId)
        await sleep(50)
      }
    }

    debuggerAttached = true
    logger.debug('Debugger attached successfully to tab:', tabId)

    await chrome.debugger.sendCommand(debuggee, 'Page.enable')

    // Reapply cached auto-attach for new tabs so OOPIF targets are reported immediately.
    if (autoAttachParams) {
      try {
        await chrome.debugger.sendCommand(debuggee, 'Target.setAutoAttach', autoAttachParams)
      } catch (error) {
        logger.debug('Failed to apply auto-attach for tab:', tabId, error)
      }
    }

    const contextMenuScript = js`
      document.addEventListener('contextmenu', (e) => {
        window.__playwriter_lastRightClicked = e.target;
      }, true);
    `
    await chrome.debugger.sendCommand(debuggee, 'Page.addScriptToEvaluateOnNewDocument', { source: contextMenuScript })
    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: contextMenuScript })

    // Ghost cursor — survives navigations via addScriptToEvaluateOnNewDocument.
    try {
      await chrome.debugger.sendCommand(debuggee, 'Page.addScriptToEvaluateOnNewDocument', {
        source: ghostCursorBundleCode,
      })
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: ghostCursorBundleCode })
    } catch (err) {
      logger.debug('Could not inject ghost cursor (restricted page):', (err as Error).message)
    }

    const result = (await chrome.debugger.sendCommand(
      debuggee,
      'Target.getTargetInfo',
    )) as Protocol.Target.GetTargetInfoResponse

    const targetInfo = result.targetInfo

    // Log error if URL is empty - this causes Playwright to create broken pages
    if (!targetInfo.url || targetInfo.url === '' || targetInfo.url === ':') {
      logger.error(
        'WARNING: Target.attachedToTarget will be sent with empty URL! tabId:',
        tabId,
        'targetInfo:',
        JSON.stringify(targetInfo),
      )
    }

    const attachOrder = nextSessionId
    const sessionId = `pw-tab-${tabSessionScope}-${nextSessionId++}`

    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      newTabs.set(tabId, {
        sessionId,
        targetId: targetInfo.targetId,
        state: 'connected',
        attachOrder,
      })
      return { tabs: newTabs, connectionState: 'connected', errorText: undefined }
    })

    if (!skipAttachedEvent) {
      sendMessage({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    }

    logger.debug(
      'Tab attached successfully:',
      tabId,
      'sessionId:',
      sessionId,
      'targetId:',
      targetInfo.targetId,
      'url:',
      targetInfo.url,
      'skipAttachedEvent:',
      skipAttachedEvent,
    )

    // Inject the in-page toolbar into the ISOLATED world (best-effort: silently
    // fails on restricted pages like chrome:// or about:blank)
    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: false },
        world: 'ISOLATED',
        func: initPlaywriterToolbar,
      })
      .then(() => {
        syncToolbarState(tabId)
      })
      .catch((err: Error) => {
        logger.debug('Could not inject toolbar (restricted page):', err.message)
      })

    return { targetInfo, sessionId }
  } catch (error) {
    // Clean up debugger if we attached but failed later
    if (debuggerAttached) {
      logger.debug('Cleaning up debugger after partial attach failure:', tabId)
      chrome.debugger.detach(debuggee).catch(() => {})
    }
    throw error
  }
}

function detachTab(tabId: number, shouldDetachDebugger: boolean): void {
  const tab = store.getState().tabs.get(tabId)
  if (!tab) {
    logger.debug('detachTab: tab not found in map:', tabId)
    return
  }

  // Clean up any active recording for this tab
  void cleanupRecordingForTab(tabId)

  // Destroy the in-page toolbar (best-effort: tab may already be closing or navigating)
  void chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        window.__playwriterToolbarDestroy?.()
      },
    })
    .catch(() => {})

  void chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        ;(globalThis as any).__playwriterGhostCursor?.disable?.()
      },
    })
    .catch(() => {})

  logger.warn(`DISCONNECT: detachTab tabId=${tabId} shouldDetach=${shouldDetachDebugger} stack=${getCallStack()}`)

  // Only send detach event if tab was fully attached (has sessionId/targetId)
  // Tabs in 'connecting' state may not have these yet
  if (tab.sessionId && tab.targetId) {
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    })
  }

  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    newTabs.delete(tabId)
    return { tabs: newTabs }
  })

  emitChildDetachesForTab(tabId)

  if (shouldDetachDebugger) {
    chrome.debugger.detach({ tabId }).catch((err) => {
      logger.debug('Error detaching debugger from tab:', tabId, err.message)
    })
  }
}

// Recording started from the toolbar. Passed back on stop so the Stop button
// is never ambiguous when another recording is also active.
let toolbarRecordingId: string | null = null
let toolbarStartInFlight = false

// Sync service-worker state into the isolated toolbar after injection.
function syncToolbarState(tabId: number): void {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func: (recording: boolean, remoteActive: boolean) => {
        window.__playwriterToolbarSetRecording?.(recording)
        window.__playwriterToolbarSetRemote?.(remoteActive)
      },
      args: [toolbarRecordingId !== null, findRemoteRuntimeForTab(tabId) !== undefined],
    })
    .catch(() => {})
}

function setRecorderStateInTab(tabId: number, recording: boolean): void {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func: (rec: boolean) => {
        window.__playwriterToolbarSetRecording?.(rec)
      },
      args: [recording],
    })
    .catch(() => {})
}

function setRemoteStateInTab(tabId: number, active: boolean): Promise<void> {
  return chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func: (on: boolean) => {
        window.__playwriterToolbarSetRemote?.(on)
      },
      args: [active],
    })
    .then(() => {})
    .catch(() => {})
}

function setRemoteStateForScope(scope: RemoteScope, active: boolean): void {
  void Promise.all(
    Array.from(scope.tabIds).map((tabId) => {
      return setRemoteStateInTab(tabId, active)
    }),
  )
}

// Notify all connected tabs when recording starts/stops.
function setRecorderStateInAllTabs(recording: boolean): void {
  const { tabs } = store.getState()
  for (const [tabId, tab] of tabs) {
    if (tab.state !== 'connected') {
      continue
    }
    setRecorderStateInTab(tabId, recording)
  }
}

async function connectTab(tabId: number): Promise<void> {
  try {
    logger.debug(`Starting connection to tab ${tabId}`)

    setTabConnecting(tabId)

    if (remoteTunnels.size === 0) {
      await connectionManager.ensureConnection()
    } else {
      // With an active remote-control tunnel, tabs must attach even when no
      // local playwriter relay is running (remote-only setups). Local relay
      // connection stays best-effort in the background.
      void connectionManager.ensureConnection().catch(() => {})
    }
    await attachTab(tabId)

    logger.debug(`Successfully connected to tab ${tabId}`)
  } catch (error: any) {
    logger.debug(`Failed to connect to tab ${tabId}:`, error)

    // Distinguish between WS connection errors and tab-specific errors
    // WS errors: keep in 'connecting' state, maintainLoop will retry when WS is available
    // Tab errors: show 'error' state (e.g., restricted page, debugger attach failed)
    // Extension in use: set global 'extension-replaced' state to enter polling mode
    const isExtensionInUse =
      error.message === 'Extension Already In Use' ||
      error.message === 'Another Playwriter extension is already connected'

    const isWsError =
      error.message === 'Server not available' ||
      error.message === 'Connection timeout' ||
      error.message.startsWith('WebSocket')

    if (isExtensionInUse) {
      logger.debug(`Another extension is in use, entering polling mode`)
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.delete(tabId)
        return {
          tabs: newTabs,
          connectionState: 'extension-replaced',
          errorText: 'Another Playwriter extension is actively in use',
        }
      })
    } else if (isWsError) {
      logger.debug(`WS connection failed, keeping tab ${tabId} in connecting state for retry`)
      // Tab stays in 'connecting' state - maintainLoop will retry when WS becomes available
    } else {
      // If the tab was closed mid-attach, don't write an error entry —
      // onTabRemoved already deleted it and we'd leak a dead tabId.
      let tabStillExists = true
      try {
        await chrome.tabs.get(tabId)
      } catch {
        tabStillExists = false
      }
      if (!tabStillExists) {
        logger.debug(`Tab ${tabId} was closed during connect, dropping error state`)
        store.setState((state) => {
          const newTabs = new Map(state.tabs)
          newTabs.delete(tabId)
          return { tabs: newTabs }
        })
        return
      }
      if (!store.getState().tabs.has(tabId)) {
        logger.debug(`Tab ${tabId} was detached during connect, dropping error state`)
        return
      }
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.set(tabId, { state: 'error', errorText: `Error: ${error.message}` })
        return { tabs: newTabs }
      })
    }
  }
}

function setTabConnecting(tabId: number): void {
  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    const existing = newTabs.get(tabId)
    newTabs.set(tabId, { ...existing, state: 'connecting' })
    return { tabs: newTabs }
  })
}

async function disconnectTab(tabId: number): Promise<void> {
  logger.debug(`Disconnecting tab ${tabId}`)

  // Disconnecting a remotely shared tab also revokes its remote-control link
  // (root tab) or removes it from the shared scope (popup).
  removeTabFromRemoteScopes(tabId)

  const { tabs } = store.getState()
  if (!tabs.has(tabId)) {
    logger.debug('Tab not in tabs map, ignoring disconnect')
    return
  }

  detachTab(tabId, true)
  // WS connection is maintained even with no tabs - maintainConnection handles it
}

async function toggleExtensionForActiveTab(): Promise<{ isConnected: boolean; state: ExtensionState }> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab?.id) throw new Error('No active tab found')

  await onActionClicked(tab)

  await new Promise<void>((resolve) => {
    const check = () => {
      const state = store.getState()
      const tabInfo = state.tabs.get(tab.id!)
      if (tabInfo?.state === 'connecting') {
        setTimeout(check, 100)
        return
      }
      resolve()
    }
    check()
  })

  const state = store.getState()
  const isConnected = state.tabs.has(tab.id) && state.tabs.get(tab.id)?.state === 'connected'
  return { isConnected, state }
}

async function disconnectEverything(): Promise<void> {
  // Queue disconnect operation to serialize with other tab group operations
  tabGroupQueue = tabGroupQueue.then(async () => {
    const { tabs } = store.getState()
    for (const tabId of tabs.keys()) {
      await disconnectTab(tabId)
    }
  })
  await tabGroupQueue
  // WS connection is maintained - maintainConnection handles it
}

// ============================================================================
// Remote control manager
// ============================================================================

const REMOTE_TABS_STORAGE_KEY = 'playwriterRemoteTabs'

function persistRemoteTabs(): void {
  const entries = Array.from(remoteTunnels.values()).map((runtime) => {
    return {
      rootTabId: runtime.scope.rootTabId,
      tunnelId: runtime.tunnelId,
      scopeTabIds: Array.from(runtime.scope.tabIds),
    }
  })
  void chrome.storage.session.set({ [REMOTE_TABS_STORAGE_KEY]: entries }).catch(() => {})
}

// Re-announce currently attached tabs to the local relay after it reconnects.
// Needed for remote-scoped tabs that stayed attached while the relay was down:
// the relay only learns targets from Target.attachedToTarget events.
async function announceConnectedTabsToLocalRelay(): Promise<void> {
  const { tabs } = store.getState()
  for (const [tabId, tab] of tabs) {
    if (tab.state !== 'connected' || !tab.sessionId) {
      continue
    }
    try {
      const result = (await chrome.debugger.sendCommand(
        { tabId },
        'Target.getTargetInfo',
      )) as Protocol.Target.GetTargetInfoResponse
      sendToLocalRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...result.targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    } catch (error) {
      logger.debug('Failed to re-announce tab to local relay:', tabId, error)
    }
  }
}

// Introduce the extension without exposing local profile identity, then announce
// the shared tab targets to the freshly connected tunneled relay.
async function sendRemoteHelloAndTargets(conn: { send(message: any): void; scope: RemoteScope }): Promise<void> {
  const browser = await detectBrowserName().catch(() => {
    return undefined
  })
  conn.send(
    buildRemoteHelloMessage({
      browser,
      version: typeof __PLAYWRITER_VERSION__ !== 'undefined' ? __PLAYWRITER_VERSION__ : undefined,
    }),
  )

  const { tabs } = store.getState()
  for (const tabId of conn.scope.tabIds) {
    const tab = tabs.get(tabId)
    if (!tab || tab.state !== 'connected' || !tab.sessionId) {
      continue
    }
    try {
      const result = (await chrome.debugger.sendCommand(
        { tabId },
        'Target.getTargetInfo',
      )) as Protocol.Target.GetTargetInfoResponse
      conn.send({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...result.targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    } catch (error) {
      logger.debug('Failed to announce remote tab target:', tabId, error)
    }
  }
}

async function startRemoteControlForTab(
  tabId: number,
  options: { tunnelId?: string; scopeTabIds?: number[] } = {},
): Promise<{ url: string; started: boolean }> {
  const existing = findRemoteRuntimeForTab(tabId)
  if (existing) {
    setRemoteStateForScope(existing.scope, true)
    return { url: existing.tunnel.url, started: false }
  }

  const scope: RemoteScope = { rootTabId: tabId, tabIds: new Set([tabId, ...(options.scopeTabIds || [])]) }

  // Attach every scope tab. Works without a local relay: the tunnel is the consumer.
  for (const scopeTabId of scope.tabIds) {
    const tabState = store.getState().tabs.get(scopeTabId)?.state
    if (tabState === 'connected') {
      continue
    }
    setTabConnecting(scopeTabId)
    await attachTab(scopeTabId)
  }

  const tunnelId = options.tunnelId || generateTunnelId()
  const tunnel = new RemoteTunnel({
    tunnelId,
    baseDomain: REMOTE_TUNNEL_BASE_DOMAIN,
    logger,
    onStatusChange: (status, detail) => {
      const runtime = remoteTunnels.get(tabId)
      if (runtime) {
        runtime.status = status
      }
      logger.debug('Remote tunnel status for tab', tabId, ':', status, detail || '')
    },
    onConnectionOpen: (virtualConn) => {
      const connKey = `${tunnelId}:${virtualConn.id}`
      const conn = {
        send: (message: any) => {
          virtualConn.send(JSON.stringify(message))
        },
        scope,
      }
      remoteRelayConnections.set(connKey, conn)
      void sendRemoteHelloAndTargets(conn)
      return {
        onMessage: (data) => {
          let parsed: any
          try {
            parsed = JSON.parse(data)
          } catch {
            return
          }
          void dispatchRelayMessage(parsed, { send: conn.send, remoteScope: scope })
        },
        onClose: () => {
          remoteRelayConnections.delete(connKey)
        },
      }
    },
  })

  remoteTunnels.set(tabId, { tunnel, tunnelId, scope, status: 'connecting' })
  tunnel.start()
  persistRemoteTabs()
  setRemoteStateForScope(scope, true)
  logger.log('Remote control started for tab', tabId)
  return { url: tunnel.url, started: true }
}

function stopRemoteControlForTab(tabId: number): boolean {
  const runtime = findRemoteRuntimeForTab(tabId)
  if (!runtime) {
    return false
  }
  setRemoteStateForScope(runtime.scope, false)
  runtime.tunnel.close()
  remoteTunnels.delete(runtime.scope.rootTabId)
  persistRemoteTabs()
  logger.log('Remote control stopped for tab', runtime.scope.rootTabId)
  return true
}

// Root tab gone → revoke the whole link. Popup gone → shrink the scope.
function removeTabFromRemoteScopes(tabId: number): void {
  const runtime = findRemoteRuntimeForTab(tabId)
  if (!runtime) {
    return
  }
  if (runtime.scope.rootTabId === tabId) {
    stopRemoteControlForTab(tabId)
    return
  }
  void setRemoteStateInTab(tabId, false)
  runtime.scope.tabIds.delete(tabId)
  persistRemoteTabs()
}

// Rebuild tunnels after a service-worker restart from the persisted evidence.
// Reuses the same tunnelId so the shared URL keeps working across SW restarts.
async function restoreRemoteTabsAfterRestart(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(REMOTE_TABS_STORAGE_KEY)
    const entries = stored[REMOTE_TABS_STORAGE_KEY] as
      | Array<{ rootTabId: number; tunnelId: string; scopeTabIds?: number[] }>
      | undefined
    if (!entries || entries.length === 0) {
      return
    }
    for (const entry of entries) {
      const rootExists = await chrome.tabs.get(entry.rootTabId).then(
        () => true,
        () => false,
      )
      if (!rootExists) {
        continue
      }
      const scopeTabIds: number[] = []
      for (const id of entry.scopeTabIds || []) {
        if (id === entry.rootTabId) {
          continue
        }
        const exists = await chrome.tabs.get(id).then(
          () => true,
          () => false,
        )
        if (exists) {
          scopeTabIds.push(id)
        }
      }
      try {
        await startRemoteControlForTab(entry.rootTabId, { tunnelId: entry.tunnelId, scopeTabIds })
      } catch (error) {
        logger.error('Failed to restore remote control for tab', entry.rootTabId, error)
      }
    }
    persistRemoteTabs()
  } catch (error) {
    logger.debug('Failed to restore remote tabs:', error)
  }
}

async function startRemoteControlForActiveTab(): Promise<{ url: string }> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab?.id) throw new Error('No active tab found')
  return await startRemoteControlForTab(tab.id)
}

function getRemoteControlState(): Array<{ rootTabId: number; url: string; status: string; scopeTabIds: number[] }> {
  return Array.from(remoteTunnels.values()).map((runtime) => {
    return {
      rootTabId: runtime.scope.rootTabId,
      url: runtime.tunnel.url,
      status: runtime.status,
      scopeTabIds: Array.from(runtime.scope.tabIds),
    }
  })
}

async function resetDebugger(): Promise<void> {
  let targets = await chrome.debugger.getTargets()
  targets = targets.filter((x) => x.tabId && x.attached)
  logger.log(`found ${targets.length} existing debugger targets. detaching them before background script starts`)
  for (const target of targets) {
    await chrome.debugger.detach({ tabId: target.tabId })
  }
}

// Our extension IDs - allow attaching to our own extension pages for debugging
const OUR_EXTENSION_IDS = [
  'jfeammnjpkecdekppnclgkkffahnhfhe', // Production extension (Chrome Web Store)
  'pebbngnfojnignonigcnkdilknapkgid', // Dev extension (stable ID from manifest key)
]

// undefined URL is for about:blank pages (not restricted) and chrome:// URLs (restricted).
// We can't distinguish them without the `tabs` permission, so we just let attachment fail.
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false

  // Allow our own extension pages, block all other extensions
  if (url.startsWith('chrome-extension://')) {
    const extensionId = url.replace('chrome-extension://', '').split('/')[0]
    return !OUR_EXTENSION_IDS.includes(extensionId)
  }

  const restrictedPrefixes = [
    'chrome://',
    'devtools://',
    'edge://',
    'https://chrome.google.com/',
    'https://chromewebstore.google.com/',
  ]
  return restrictedPrefixes.some((prefix) => url.startsWith(prefix))
}

const icons = {
  connected: {
    path: {
      '16': '/icons/icon-green-16.png',
      '32': '/icons/icon-green-32.png',
      '48': '/icons/icon-green-48.png',
      '128': '/icons/icon-green-128.png',
    },
    title: 'Connected - Click to disconnect',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  connecting: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Waiting for MCP WS server...',
    badgeText: '...',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  idle: {
    path: {
      '16': '/icons/icon-black-16.png',
      '32': '/icons/icon-black-32.png',
      '48': '/icons/icon-black-48.png',
      '128': '/icons/icon-black-128.png',
    },
    title: 'Click to attach debugger',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  restricted: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Cannot attach to this page',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  extensionReplaced: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Another Playwriter extension connected - Click to retry',
    badgeText: '!',
    badgeColor: [220, 38, 38, 255] as [number, number, number, number],
  },
  tabError: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Error',
    badgeText: '!',
    badgeColor: [220, 38, 38, 255] as [number, number, number, number],
  },
} as const

async function updateIcons(): Promise<void> {
  const state = store.getState()
  const { connectionState, tabs, errorText } = state

  const connectedCount = Array.from(tabs.values()).filter((t) => t.state === 'connected').length

  const allTabs = await chrome.tabs.query({})
  const tabUrlMap = new Map(allTabs.map((tab) => [tab.id, tab.url]))
  const allTabIds = [undefined, ...allTabs.map((tab) => tab.id).filter(isTruthy)]

  for (const tabId of allTabIds) {
    const tabInfo = tabId !== undefined ? tabs.get(tabId) : undefined
    const tabUrl = tabId !== undefined ? tabUrlMap.get(tabId) : undefined

    const iconConfig = (() => {
      if (connectionState === 'extension-replaced') return icons.extensionReplaced
      if (tabId !== undefined && isRestrictedUrl(tabUrl)) return icons.restricted
      if (tabInfo?.state === 'error') return icons.tabError
      if (tabInfo?.state === 'connecting') return icons.connecting
      if (tabInfo?.state === 'connected') return icons.connected
      return icons.idle
    })()

    const title = (() => {
      if (connectionState === 'extension-replaced' && errorText) return errorText
      if (tabInfo?.errorText) return tabInfo.errorText
      return iconConfig.title
    })()

    const badgeText = (() => {
      if (iconConfig === icons.connected || iconConfig === icons.idle || iconConfig === icons.restricted) {
        return connectedCount > 0 ? String(connectedCount) : ''
      }
      return iconConfig.badgeText
    })()

    void chrome.action.setIcon({ tabId, path: iconConfig.path })
    void chrome.action.setTitle({ tabId, title })
    if (iconConfig.badgeColor) void chrome.action.setBadgeBackgroundColor({ tabId, color: iconConfig.badgeColor })
    void chrome.action.setBadgeText({ tabId, text: badgeText })
  }
}

async function onTabRemoved(tabId: number): Promise<void> {
  popupSourceTabMap.delete(tabId)
  removeTabFromRemoteScopes(tabId)
  const { tabs } = store.getState()
  if (!tabs.has(tabId)) return
  logger.debug(`Connected tab ${tabId} was closed, disconnecting`)
  await disconnectTab(tabId)
}

async function onTabActivated(activeInfo: chrome.tabs.TabActiveInfo): Promise<void> {
  store.setState({ currentTabId: activeInfo.tabId, preferredWindowId: activeInfo.windowId })
}

const TUTORIAL_PAGE_PATH = 'src/tutorial.html'

// Icon only attaches a tab. Daemon starts on the first playwriter command.
function shouldOpenTutorialPage(): boolean {
  if (import.meta.env.TESTING) return false
  if (!__PLAYWRITER_OPEN_WELCOME_PAGE__) return false
  return store.getState().connectionState === 'idle'
}

async function openTutorialPage(): Promise<void> {
  try {
    const baseUrl = chrome.runtime.getURL(TUTORIAL_PAGE_PATH)
    const tabs = await chrome.tabs.query({})
    const existing = tabs.find((t) => t.url?.startsWith(baseUrl))
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true })
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true })
      }
      return
    }
    await chrome.tabs.create({ url: `${TUTORIAL_PAGE_PATH}?port=${RELAY_PORT}` })
  } catch (e) {
    logger.debug('Failed to open tutorial page:', e)
  }
}

async function onActionClicked(tab: chrome.tabs.Tab): Promise<void> {
  if (shouldOpenTutorialPage()) {
    void openTutorialPage()
  }

  if (!tab.id) {
    logger.debug('No tab ID available')
    return
  }

  if (tab.windowId !== undefined) {
    store.setState({ currentTabId: tab.id, preferredWindowId: tab.windowId })
  }

  if (isRestrictedUrl(tab.url)) {
    logger.debug('Cannot attach to restricted URL:', tab.url)
    return
  }

  const { tabs, connectionState } = store.getState()
  const tabInfo = tabs.get(tab.id)

  // If another Playwriter extension took over, clear error state and try to reconnect this tab
  if (connectionState === 'extension-replaced') {
    logger.debug('Clearing extension-replaced state, attempting to reconnect')
    store.setState({ connectionState: 'idle', errorText: undefined })
    await connectTab(tab.id)
    return
  }

  if (tabInfo?.state === 'error') {
    logger.debug('Tab has error - disconnecting to clear state')
    await disconnectTab(tab.id)
    return
  }

  if (tabInfo?.state === 'connecting') {
    logger.debug('Tab is already connecting, ignoring click')
    return
  }

  if (tabInfo?.state === 'connected') {
    await disconnectTab(tab.id)
  } else {
    await connectTab(tab.id)
  }
}

// Registered permanently (not per relay connection): with remote-control tunnels
// active, debugger events must keep flowing even when the local relay is down.
chrome.debugger.onEvent.addListener(onDebuggerEvent)
chrome.debugger.onDetach.addListener(onDebuggerDetach)

// resetDebugger detaches everything, so remote tabs must be restored after it.
void resetDebugger().then(() => {
  return restoreRemoteTabsAfterRestart()
})
void connectionManager.maintainLoop()

chrome.contextMenus
  .remove('playwriter-pin-element')
  .catch(() => {})
  .finally(() => {
    chrome.contextMenus?.create({
      id: 'playwriter-pin-element',
      title: 'Copy Playwriter Element Reference',
      contexts: ['all'],
      visible: false,
    })
  })

chrome.contextMenus
  .remove('playwriter-copy-react-source')
  .catch(() => {})
  .finally(() => {
    chrome.contextMenus?.create({
      id: 'playwriter-copy-react-source',
      title: 'Copy React Component Source Path',
      contexts: ['all'],
      visible: false,
    })
  })

function updateContextMenuVisibility(): void {
  const { currentTabId, tabs } = store.getState()
  const isConnected = currentTabId !== undefined && tabs.get(currentTabId)?.state === 'connected'
  void chrome.contextMenus?.update('playwriter-pin-element', { visible: isConnected })
  void chrome.contextMenus?.update('playwriter-copy-react-source', { visible: isConnected })
}

function buildPinnedElementInspectionCode(options: { pinName: string; url: string }): string {
  const URL_LIT = JSON.stringify(options.url).replace(/'/g, '\\u0027')
  return `inspectPinnedElement(${URL_LIT},"globalThis.${options.pinName}")`
}

chrome.runtime.onInstalled.addListener((details) => {
  if (import.meta.env.TESTING) return
  if (!__PLAYWRITER_OPEN_WELCOME_PAGE__) return
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: 'src/welcome.html' })
  }
})

function serializeTabs(tabs: Map<number, TabInfo>): string {
  return JSON.stringify(Array.from(tabs.entries()))
}

store.subscribe((state, prevState) => {
  logger.log(state)
  void updateIcons()
  updateContextMenuVisibility()
  const tabsChanged = serializeTabs(state.tabs) !== serializeTabs(prevState.tabs)
  if (tabsChanged) {
    tabGroupQueue = tabGroupQueue.then(syncTabGroup).catch((e) => {
      logger.debug('syncTabGroup error:', e)
    })
  }
})

logger.debug(`Using relay host: ${RELAY_HOST}, port: ${RELAY_PORT}`)

// Memory monitoring - helps debug service worker termination issues
let lastMemoryUsage = 0
let lastMemoryCheck = Date.now()
const MEMORY_WARNING_THRESHOLD = 50 * 1024 * 1024 // 50MB
const MEMORY_CRITICAL_THRESHOLD = 100 * 1024 * 1024 // 100MB
const MEMORY_GROWTH_THRESHOLD = 10 * 1024 * 1024 // 10MB growth per interval is suspicious

function checkMemory(): void {
  try {
    // @ts-ignore - performance.memory is Chrome-specific and not in TS types
    const memory = performance.memory
    if (!memory) {
      return
    }

    const used = memory.usedJSHeapSize
    const total = memory.totalJSHeapSize
    const limit = memory.jsHeapSizeLimit
    const now = Date.now()
    const timeDelta = now - lastMemoryCheck
    const memoryDelta = used - lastMemoryUsage

    const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + 'MB'
    const growthRate = timeDelta > 0 ? (memoryDelta / timeDelta) * 1000 : 0 // bytes per second

    // Log if memory is high or growing rapidly
    if (used > MEMORY_CRITICAL_THRESHOLD) {
      logger.error(
        `MEMORY CRITICAL: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`,
      )
    } else if (used > MEMORY_WARNING_THRESHOLD) {
      logger.warn(
        `MEMORY WARNING: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`,
      )
    } else if (memoryDelta > MEMORY_GROWTH_THRESHOLD && timeDelta < 60000) {
      logger.warn(
        `MEMORY SPIKE: grew ${formatMB(memoryDelta)} in ${(timeDelta / 1000).toFixed(1)}s (used=${formatMB(used)})`,
      )
    }

    lastMemoryUsage = used
    lastMemoryCheck = now
  } catch (e) {
    // Silently ignore - performance.memory may not be available
  }
}

// Check memory every 5 seconds
setInterval(checkMemory, 5000)

// Initial memory check
checkMemory()

chrome.tabs.onRemoved.addListener(onTabRemoved)
chrome.tabs.onActivated.addListener(onTabActivated)
chrome.action.onClicked.addListener(onActionClicked)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void updateIcons()
  if (changeInfo.groupId !== undefined) {
    // Queue tab group operations to serialize with syncTabGroup and disconnectEverything
    tabGroupQueue = tabGroupQueue
      .then(async () => {
        // Query for playwriter group by title - no stale cached ID
        const existingGroups = await chrome.tabGroups.query({ title: TAB_GROUP_TITLE })
        const groupId = existingGroups[0]?.id
        if (groupId === undefined) {
          return
        }
        const { tabs } = store.getState()
        if (changeInfo.groupId === groupId) {
          if (!tabs.has(tabId) && !isRestrictedUrl(tab.url)) {
            logger.debug('Tab manually added to playwriter group:', tabId)
            await connectTab(tabId)
          }
        } else if (tabs.has(tabId)) {
          const tabInfo = tabs.get(tabId)
          if (tabInfo?.state === 'connecting') {
            logger.debug('Tab removed from group while connecting, ignoring:', tabId)
            return
          }
          logger.debug('Tab manually removed from playwriter group:', tabId)
          await disconnectTab(tabId)
        }
      })
      .catch((e) => {
        logger.debug('onTabUpdated handler error:', e)
      })
  }
})

// Track every new tab's source (opener) tab via webNavigation.
// chrome.tabs.Tab.openerTabId is unreliable for window.open popups — on
// Chromium 145 it is left null. onCreatedNavigationTarget gives a reliable
// source_tab_id → new_tab_id mapping for every window.open / target=_blank
// / cmd+click. Entries expire after 10s to cap memory for plain-new-tab
// cases that never trigger windows.onCreated.
const popupSourceTabMap = new Map<number, number>()

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  popupSourceTabMap.set(details.tabId, details.sourceTabId)
  setTimeout(() => {
    popupSourceTabMap.delete(details.tabId)
  }, 10000)
  void maybeAttachRemoteChildTab(details)
})

// window.open / target=_blank tabs opened FROM a remotely shared tab join its
// scope so agent flows (OAuth redirects, payment popups, etc) keep working.
// Popup windows are handled by the relocation listener below instead — the
// debugger cannot attach to tabs still living in a separate popup window.
async function maybeAttachRemoteChildTab(details: { tabId: number; sourceTabId: number }): Promise<void> {
  const runtime = findRemoteRuntimeForTab(details.sourceTabId)
  if (!runtime) {
    return
  }
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(details.tabId)
  } catch {
    return
  }
  if (isRestrictedUrl(tab.url)) {
    return
  }
  const win = await chrome.windows.get(tab.windowId).catch(() => {
    return null
  })
  if (!win || win.type !== 'normal') {
    return
  }
  runtime.scope.tabIds.add(details.tabId)
  persistRemoteTabs()
  if (store.getState().tabs.has(details.tabId)) {
    return
  }
  try {
    await connectTab(details.tabId)
  } catch (error) {
    logger.debug('Failed to attach remote child tab:', details.tabId, error)
  }
}

// Relocate popup windows opened by a Playwriter-connected tab into the
// source tab's window as a regular tab, since Playwriter cannot attach
// its debugger to separate popup windows. When the source tab is NOT
// connected, leave the popup alone so unrelated sites keep normal Chrome
// popup behavior. After relocation, auto-attach Playwriter to the new
// tab so it appears in context.pages().
chrome.windows.onCreated.addListener(async (popupWindow) => {
  if (popupWindow.type !== 'popup' || popupWindow.id === undefined) {
    return
  }
  try {
    // Retry tab discovery — windows.onCreated can fire before
    // chrome.tabs.query({ windowId }) sees the new popup tab.
    let popupTabs: chrome.tabs.Tab[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      popupTabs = await chrome.tabs.query({ windowId: popupWindow.id })
      if (popupTabs.length > 0) break
      await sleep(20)
    }
    const tabIds = popupTabs.map((t) => t.id).filter(isTruthy)
    if (tabIds.length === 0) {
      logger.debug(`Popup window ${popupWindow.id} has no tabs after retry, skipping`)
      return
    }

    const { tabs: connectedTabs } = store.getState()
    let sourceTabId: number | undefined
    for (const tabId of tabIds) {
      const candidate = popupSourceTabMap.get(tabId)
      if (candidate !== undefined && connectedTabs.has(candidate)) {
        sourceTabId = candidate
        break
      }
    }
    for (const tabId of tabIds) {
      popupSourceTabMap.delete(tabId)
    }
    if (sourceTabId === undefined) {
      logger.debug(
        `Popup window ${popupWindow.id} not opened by a Playwriter-connected tab, leaving alone (tabs=${JSON.stringify(tabIds)})`,
      )
      return
    }

    let destinationWindowId: number
    try {
      const sourceTab = await chrome.tabs.get(sourceTabId)
      if (sourceTab.windowId === undefined) {
        const focused = await chrome.windows.getLastFocused({ populate: false })
        if (focused.id === undefined || focused.id === popupWindow.id) {
          return
        }
        destinationWindowId = focused.id
      } else {
        destinationWindowId = sourceTab.windowId
      }
    } catch (e) {
      logger.debug(`Source tab ${sourceTabId} no longer exists, skipping relocation:`, e)
      return
    }

    logger.debug(
      `Relocating ${tabIds.length} popup tab(s) from window ${popupWindow.id} into source window ${destinationWindowId} (sourceTabId=${sourceTabId})`,
    )
    await chrome.tabs.move(tabIds, { windowId: destinationWindowId, index: -1 })
    try {
      await chrome.windows.remove(popupWindow.id)
    } catch {
      // Chrome may have already closed the empty popup window.
    }
    // Popups opened from a remotely shared tab join its remote scope
    const remoteRuntime = findRemoteRuntimeForTab(sourceTabId)
    for (const tabId of tabIds) {
      if (remoteRuntime) {
        remoteRuntime.scope.tabIds.add(tabId)
        persistRemoteTabs()
      }
      if (connectedTabs.has(tabId)) continue
      try {
        await connectTab(tabId)
      } catch (e) {
        logger.warn(`Failed to auto-connect relocated popup tab ${tabId}:`, e)
      }
    }
  } catch (e) {
    logger.warn('Failed to relocate popup window:', e)
  }
})

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return

  const tabInfo = store.getState().tabs.get(tab.id)
  if (!tabInfo || tabInfo.state !== 'connected') {
    logger.debug('Tab not connected, ignoring')
    return
  }

  const debuggee = { tabId: tab.id }

  if (info.menuItemId === 'playwriter-pin-element') {
    try {
      // Allocate the next pin name by reading and incrementing the shared MAIN-world
      // counter (window.__playwriterPinCount). This ensures right-click and toolbar
      // pins never produce conflicting globalThis.playwriterPinnedElemN names.
      const jsAllocatePin = js`
        (function() {
          window.__playwriterPinCount = (window.__playwriterPinCount || 0) + 1;
          return window.__playwriterPinCount;
        })()
      `
      const counterResult = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsAllocatePin,
        returnByValue: true,
      })) as { result?: { value?: number }; exceptionDetails?: { text: string } }

      const count = counterResult.result?.value ?? 1
      const name = `playwriterPinnedElem${count}`

      const jsAssignPin = js`
        if (window.__playwriter_lastRightClicked) {
          window.${name} = window.__playwriter_lastRightClicked;
          '${name}';
        } else {
          throw new Error('No element was right-clicked');
        }
      `
      const result = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsAssignPin,
        returnByValue: true,
      })) as { result?: { value?: string }; exceptionDetails?: { text: string } }

      if (result.exceptionDetails) {
        logger.error('Failed to pin element:', result.exceptionDetails.text)
        return
      }

      const code = buildPinnedElementInspectionCode({ pinName: name, url: tab.url || '' })
      const clipboardText = "playwriter -e '" + code + "'"

      const jsPinFlashAndCopy = js`
        (() => {
          const el = window.${name};
          if (!el) return;
          const orig = el.getAttribute('style') || '';
          el.setAttribute('style', orig + '; outline: 3px solid #22c55e !important; outline-offset: 2px !important; box-shadow: 0 0 0 3px #22c55e !important;');
          setTimeout(() => el.setAttribute('style', orig), 300);
          return navigator.clipboard.writeText(${JSON.stringify(clipboardText)});
        })()
      `
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsPinFlashAndCopy,
        awaitPromise: true,
        userGesture: true,
      })

      logger.debug('Pinned element as:', name)
    } catch (error: any) {
      logger.error('Failed to pin element:', error.message)
    }
  }

  if (info.menuItemId === 'playwriter-copy-react-source') {
    try {
      // Inject bippy (React fiber introspection) if not already present.
      // bippy exposes globalThis.__bippy with methods to walk the React fiber tree
      // and resolve source file locations from React DevTools metadata.
      const hasBippy = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: '!!globalThis.__bippy',
        returnByValue: true,
      })) as { result?: { value?: boolean } }

      if (!hasBippy.result?.value) {
        await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression: bippyBundleCode,
        })
      }

      // Walk from the right-clicked DOM element up through React fiber tree to find
      // the nearest composite component with source location info. Uses bippy's
      // getSource() first (direct __source prop from JSX transform), then falls back
      // to getOwnerStack() for production builds with source maps.
      const jsResolveSource = js`
        (async () => {
          const el = window.__playwriter_lastRightClicked;
          if (!el) return JSON.stringify({ error: 'No element was right-clicked' });

          const bippy = globalThis.__bippy;
          if (!bippy) return JSON.stringify({ error: 'bippy not loaded' });

          // bippy.normalizeFileName strips "/app-pages-browser/" but not the parenthesized
          // form "/(app-pages-browser)/" that Next.js webpack actually uses. This regex
          // strips all Next.js webpack layer prefixes: (app-pages-browser), (ssr), (rsc),
          // (action-browser), (pages-dir-browser), (pages-dir-edge), (pages-dir-node).
          // Also strips leading "./" that often follows the layer prefix.
          const cleanFileName = (name) => {
            let f = bippy.normalizeFileName(name);
            f = f.replace(/^\/?\\([-\\w]+\\)\\//, '');
            f = f.replace(/^\\.[\\/]/, '');
            return f;
          };

          let fiber;
          try { fiber = bippy.getFiberFromHostInstance(el); } catch {}
          if (!fiber) return JSON.stringify({ error: 'No React fiber found. Is this a React app?' });

          // Walk up to find nearest composite fiber with source info
          let current = fiber;
          for (let i = 0; i < 50 && current; i++) {
            try {
              if (bippy.isCompositeFiber(current)) {
                const source = await bippy.getSource(current);
                if (source && source.fileName && bippy.isSourceFile(source.fileName)) {
                  return JSON.stringify({
                    fileName: cleanFileName(source.fileName),
                    lineNumber: source.lineNumber || null,
                    columnNumber: source.columnNumber || null,
                    componentName: source.functionName || bippy.getDisplayName(current.type) || null,
                  });
                }
                // Try owner stack as fallback for this fiber
                const ownerStack = await bippy.getOwnerStack(current);
                for (const frame of ownerStack) {
                  if (frame.fileName && bippy.isSourceFile(frame.fileName)) {
                    return JSON.stringify({
                      fileName: cleanFileName(frame.fileName),
                      lineNumber: frame.lineNumber || null,
                      columnNumber: frame.columnNumber || null,
                      componentName: frame.functionName || bippy.getDisplayName(current.type) || null,
                    });
                  }
                }
              }
            } catch {}
            current = current.return;
          }
          return JSON.stringify({ error: 'No React source location found. Is this a dev build with source maps?' });
        })()
      `
      const sourceResult = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsResolveSource,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: string }; exceptionDetails?: { text: string } }

      if (sourceResult.exceptionDetails) {
        logger.error('Failed to get React source:', sourceResult.exceptionDetails.text)
        return
      }

      const parsed = JSON.parse(sourceResult.result?.value || '{}')

      if (!parsed.fileName && !parsed.error) {
        parsed.error = 'React source result missing fileName'
      }

      if (parsed.error) {
        // Flash red outline on the element to indicate no React source found
        const jsFlashRed = js`
          (() => {
            const el = window.__playwriter_lastRightClicked;
            if (!el) return;
            const orig = el.getAttribute('style') || '';
            el.setAttribute('style', orig + '; outline: 3px solid #ef4444 !important; outline-offset: 2px !important;');
            setTimeout(() => el.setAttribute('style', orig), 600);
          })()
        `
        await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression: jsFlashRed,
        })
        logger.debug('React source not found:', parsed.error)
        return
      }

      // Build clipboard text: "path/to/file.tsx:42" or "path/to/file.tsx" if no line
      const clipboardText: string = (() => {
        if (parsed.lineNumber) {
          return `${parsed.fileName}:${parsed.lineNumber}`
        }
        return parsed.fileName
      })()

      // Flash green outline and copy to clipboard
      const jsFlashGreenAndCopy = js`
        (() => {
          const el = window.__playwriter_lastRightClicked;
          if (!el) return;
          const orig = el.getAttribute('style') || '';
          el.setAttribute('style', orig + '; outline: 3px solid #22c55e !important; outline-offset: 2px !important; box-shadow: 0 0 0 3px #22c55e !important;');
          setTimeout(() => el.setAttribute('style', orig), 300);
          return navigator.clipboard.writeText(${JSON.stringify(clipboardText)});
        })()
      `
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsFlashGreenAndCopy,
        awaitPromise: true,
        userGesture: true,
      })

      logger.debug('Copied React source path:', clipboardText, 'component:', parsed.componentName)
    } catch (error: any) {
      logger.error('Failed to copy React source:', error.message)
    }
  }
})

// Sync icons on first load
void updateIcons()

function toastToolbar(tabId: number, msg: string): void {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func: (text: string) => {
        window.__playwriterToolbarShowToast?.(text)
      },
      args: [msg],
    })
    .catch(() => {})
}

function playToolbarSound(tabId: number, name: string): void {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func: (soundName: string) => {
        window.__playwriterToolbarPlaySound?.(soundName)
      },
      args: [name],
    })
    .catch(() => {})
}

async function copyTextInOffscreenDocument(text: string): Promise<void> {
  await ensureOffscreenDocument()
  const result: OffscreenCopyTextResult = await chrome.runtime.sendMessage({ action: 'copyText', text })
  if (!result.success) {
    throw new Error('Could not copy toolbar prompt', { cause: new Error(result.error) })
  }
}

// Handle messages from content scripts (recorder commands) and offscreen document (recording chunks)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'copyToolbarText') {
    const senderTabId = sender.tab?.id
    if (
      !senderTabId ||
      sender.frameId !== 0 ||
      store.getState().tabs.get(senderTabId)?.state !== 'connected' ||
      typeof message.text !== 'string'
    ) {
      return false
    }
    void copyTextInOffscreenDocument(message.text).then(
      () => {
        sendResponse({ success: true })
      },
      (error: Error) => {
        logger.error('Could not copy toolbar text:', error)
        sendResponse({ success: false })
      },
    )
    return true
  }

  if (message.action === 'pinToolbarElement') {
    const senderTabId = sender.tab?.id
    if (
      !senderTabId ||
      sender.frameId !== 0 ||
      store.getState().tabs.get(senderTabId)?.state !== 'connected' ||
      typeof message.marker !== 'string'
    ) {
      return false
    }
    void chrome.scripting
      .executeScript({
        target: { tabId: senderTabId, frameIds: [0] },
        world: 'MAIN',
        func: (marker: string) => {
          const target = Array.from(document.querySelectorAll('[data-playwriter-pin-target]')).find((element) => {
            return element.getAttribute('data-playwriter-pin-target') === marker
          })
          if (!target) {
            return null
          }
          const pinNumber = (window.__playwriterPinCount || 0) + 1
          window.__playwriterPinCount = pinNumber
          window[`playwriterPinnedElem${pinNumber}`] = target
          target.removeAttribute('data-playwriter-pin-target')
          return pinNumber
        },
        args: [message.marker],
      })
      .then((results) => {
        sendResponse({ pinNumber: results[0]?.result || undefined })
      })
      .catch((error: Error) => {
        logger.error('Could not pin toolbar element:', error)
        sendResponse({})
      })
    return true
  }

  if (message.action === 'remoteControlStart') {
    const senderTabId = sender.tab?.id
    if (!senderTabId || sender.frameId !== 0 || store.getState().tabs.get(senderTabId)?.state !== 'connected') {
      return false
    }
    void (async () => {
      try {
        const { url, started } = await startRemoteControlForTab(senderTabId)
        const prompt = buildRemoteControlPrompt({ url })
        try {
          await copyTextInOffscreenDocument(prompt)
        } catch (error) {
          if (started) {
            stopRemoteControlForTab(senderTabId)
          }
          throw error
        }
        toastToolbar(
          senderTabId,
          'Remote control ON — prompt copied. NEVER share the link with anyone you don\u2019t trust',
        )
        playToolbarSound(senderTabId, 'success')
      } catch (error: any) {
        logger.error('Remote control start failed:', error)
        toastToolbar(senderTabId, `Remote control failed: ${error.message}`)
      }
    })()
    return false
  }

  if (message.action === 'remoteControlStop') {
    const senderTabId = sender.tab?.id
    if (!senderTabId || sender.frameId !== 0 || store.getState().tabs.get(senderTabId)?.state !== 'connected') {
      return false
    }
    stopRemoteControlForTab(senderTabId)
    void setRemoteStateInTab(senderTabId, false)
    toastToolbar(senderTabId, 'Remote control stopped — link revoked')
    playToolbarSound(senderTabId, 'click')
    return false
  }

  // Action recorder start/stop: isolated toolbar → service worker → relay HTTP endpoint.
  if (message.action === 'actionRecorderStart') {
    const senderTabId = sender.tab?.id
    if (!senderTabId || sender.frameId !== 0 || store.getState().tabs.get(senderTabId)?.state !== 'connected') {
      return false
    }
    if (toolbarRecordingId || toolbarStartInFlight) {
      return false
    }
    toolbarStartInFlight = true
    fetch(`http://${RELAY_HOST}:${RELAY_PORT}/recorder/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => {
          return {}
        })) as { error?: string; recordingId?: string }
        if (response.ok && result.recordingId) {
          toolbarRecordingId = result.recordingId
          if (senderTabId) {
            setRecorderStateInTab(senderTabId, true)
          }
          return
        }
        logger.error('Action recorder start failed:', result.error || response.status)
        if (!senderTabId) {
          return
        }
        setRecorderStateInTab(senderTabId, false)
        toastToolbar(senderTabId, result.error || 'Failed to start recording')
      })
      .catch((err) => {
        logger.error('Action recorder start failed:', err)
        if (!senderTabId) {
          return
        }
        setRecorderStateInTab(senderTabId, false)
        toastToolbar(senderTabId, 'Failed to start recording')
      })
      .finally(() => {
        toolbarStartInFlight = false
      })
    return false
  }

  if (message.action === 'actionRecorderStop') {
    const senderTabId = sender.tab?.id
    if (!senderTabId || sender.frameId !== 0 || store.getState().tabs.get(senderTabId)?.state !== 'connected') {
      return false
    }
    fetch(`http://${RELAY_HOST}:${RELAY_PORT}/recorder/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toolbarRecordingId ? { recordingId: toolbarRecordingId } : {}),
    })
      .then((r) => r.json())
      .then(async (result: { recordingId?: string; error?: string }) => {
        if (!result.recordingId) {
          logger.error('Action recorder stop failed:', result.error || 'unknown')
          if (senderTabId) {
            toastToolbar(senderTabId, result.error || 'Failed to stop recording')
          }
          return
        }
        toolbarRecordingId = null
        if (!senderTabId) return
        const prompt = [
          'I just recorded a browser workflow (recording ' + result.recordingId + ').',
          'Analyze it and create a reusable skill from it.',
          '',
          'First read how Playwriter works (do not skip):',
          'https://playwriter.dev/SKILL.md',
          '',
          'Then run:',
          'playwriter recorder events -r ' + result.recordingId,
        ].join('\n')
        setRecorderStateInTab(senderTabId, false)
        try {
          await copyTextInOffscreenDocument(prompt)
          toastToolbar(senderTabId, 'Prompt copied to clipboard')
          playToolbarSound(senderTabId, 'success')
        } catch (error) {
          logger.error('Could not copy recorder prompt:', error)
          toastToolbar(senderTabId, `Copy failed. Run: playwriter recorder events -r ${result.recordingId}`)
        }
      })
      .catch((err) => {
        logger.error('Action recorder stop failed:', err)
      })
    return false
  }

  if (message.action === 'recordingChunk') {
    const { tabId, data, final } = message

    if (connectionManager.ws?.readyState === WebSocket.OPEN) {
      // Send metadata message first
      sendMessage({
        method: 'recordingData',
        params: { tabId, final },
      })

      // Then send binary data if not final
      if (data && !final) {
        const buffer = new Uint8Array(data)
        connectionManager.ws.send(buffer)
      }
    } else {
      // Buffer chunks when WebSocket isn't ready - they'll be flushed when it opens.
      // This prevents data loss during brief disconnections or slow WebSocket startup.
      logger.debug(`Buffering recording chunk for tab ${tabId} (WebSocket not ready)`)
      recordingChunkBuffer.push({ tabId, data, final })
    }

    return false // Sync response, no need to keep channel open
  }

  if (message.action === 'recordingCancelled') {
    const { tabId } = message

    getActiveRecordings().delete(tabId)
    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      const existing = newTabs.get(tabId)
      if (existing) {
        newTabs.set(tabId, { ...existing, isRecording: false })
      }
      return { tabs: newTabs }
    })

    if (connectionManager.ws?.readyState === WebSocket.OPEN) {
      sendMessage({
        method: 'recordingCancelled',
        params: { tabId },
      })
    }

    return false
  }

  return false
})

// Re-inject the toolbar after hard navigations in connected tabs.
// The isolated script is destroyed on every full page load, so we re-run
// initPlaywriterToolbar once the new document's DOM is ready.
// onDOMContentLoaded is used instead of onCommitted because executeScript
// after the new document exists.
// Note: SPA route changes (pushState/replaceState) don't trigger this because
// the document is not reset — the toolbar DOM persists across SPA navigations.
chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId !== 0) return // top frame only
  const { tabs } = store.getState()
  const tabInfo = tabs.get(details.tabId)
  if (!tabInfo || tabInfo.state !== 'connected') return

  chrome.scripting
    .executeScript({
      target: { tabId: details.tabId, allFrames: false },
      world: 'ISOLATED',
      func: initPlaywriterToolbar,
    })
    .then(() => {
      syncToolbarState(details.tabId)
    })
    .catch((err: Error) => {
      logger.debug('Could not re-inject toolbar after navigation:', err.message)
    })
})
