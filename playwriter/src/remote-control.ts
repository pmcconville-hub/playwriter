/**
 * Remote control: share a browser tab with a remote agent through a traforo tunnel.
 *
 * The extension acts as a traforo "upstream" client (the thing being exposed).
 * A client dials wss://{tunnelId}-tunnel.playwriter.dev/extension. That host is a
 * Cloudflare tunnel worker which forwards the connection to the extension, and the
 * extension treats it as a normal relay connection speaking the exact same extension
 * WS protocol. Every remote-control host is under playwriter.dev, so sharing a tab
 * never sends traffic to a domain the user has not already trusted.
 *
 * The link the user shares is NOT the tunnel host. It points at the viewer page on
 * playwriter.dev and carries the tunnel id in the URL hash:
 *
 *     https://playwriter.dev/remote-control#{tunnelId}
 *
 * The initial viewer request and Referer omit the hash. Viewer JavaScript then uses
 * the tunnel id in the tunnel hostname, which the tunnel service necessarily
 * processes. Humans who open the link get an interactive view of the tab; agents
 * paste the same link into
 * `playwriter session new --remote-control`, and the CLI resolves it to the tunnel.
 *
 * This module is shared between the extension (browser), the relay (node), and the
 * website viewer: keep it dependency-free and runtime-agnostic.
 */
import dedent from 'string-dedent'

export const REMOTE_TUNNEL_BASE_DOMAIN = 'playwriter.dev'
export const REMOTE_VIEWER_BASE_URL = 'https://playwriter.dev'
export const REMOTE_VIEWER_PATH = '/remote-control'
export const REMOTE_TUNNEL_MAX_BUFFERED_BYTES = 2 * 1024 * 1024

export function shouldDropRemoteTunnelFrame({
  bufferedAmount,
  isScreencastFrame,
}: {
  bufferedAmount: number
  isScreencastFrame: boolean
}): boolean {
  return isScreencastFrame && bufferedAmount >= REMOTE_TUNNEL_MAX_BUFFERED_BYTES
}

// ---------------------------------------------------------------------------
// Traforo tunnel protocol (JSON over one WebSocket).
// Mirror of the message types in https://github.com/remorses/traforo src/types.ts.
// Only the subset the extension upstream client needs.
// ---------------------------------------------------------------------------

export type TraforoHttpRequestMessage = {
  type: 'http_request'
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
}

export type TraforoWsOpenMessage = {
  type: 'ws_open'
  connId: string
  path: string
  headers: Record<string, string>
}

export type TraforoWsFrameMessage = {
  type: 'ws_frame'
  connId: string
  data: string
  binary: boolean
}

export type TraforoWsCloseMessage = {
  type: 'ws_close'
  connId: string
  code: number
  reason: string
}

/** Messages the tunnel DO sends to the upstream client (the extension). */
export type TraforoUpstreamMessage =
  | TraforoHttpRequestMessage
  | TraforoWsOpenMessage
  | TraforoWsFrameMessage
  | TraforoWsCloseMessage
  | { type: 'upstream_accepted' }

/** Messages the upstream client (the extension) sends back to the tunnel DO. */
export type TraforoDownstreamMessage =
  | { type: 'http_response'; id: string; status: number; headers: Record<string, string>; body: string | null }
  | { type: 'ws_opened'; connId: string }
  | { type: 'ws_frame'; connId: string; data: string; binary: boolean }
  | { type: 'ws_closed'; connId: string; code: number; reason: string }
  | { type: 'ws_error'; connId: string; error: string }
  | { type: 'ping' }

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** 128 bits of entropy, 32 hex chars. Fits the traforo tunnel id charset (lowercase, <= 63). */
export function generateTunnelId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => {
      return b.toString(16).padStart(2, '0')
    })
    .join('')
}

/** The link the user shares. Anyone holding it can drive the shared tab. */
export function buildRemoteControlUrl({
  tunnelId,
  baseUrl = REMOTE_VIEWER_BASE_URL,
}: {
  tunnelId: string
  baseUrl?: string
}): string {
  return `${baseUrl}${REMOTE_VIEWER_PATH}#${tunnelId}`
}

/** Origin traforo serves this tunnel from. */
export function buildTunnelOrigin({
  tunnelId,
  baseDomain = REMOTE_TUNNEL_BASE_DOMAIN,
}: {
  tunnelId: string
  baseDomain?: string
}): string {
  return `https://${tunnelId}-tunnel.${baseDomain}`
}

/** WebSocket URL the extension dials to register itself as the tunnel upstream. */
export function buildRemoteUpstreamWsUrl({
  tunnelId,
  baseDomain = REMOTE_TUNNEL_BASE_DOMAIN,
}: {
  tunnelId: string
  baseDomain?: string
}): string {
  return `wss://${tunnelId}-tunnel.${baseDomain}/traforo-upstream?_tunnelId=${encodeURIComponent(tunnelId)}`
}

/** Tunnel id carried in the hash of a viewer link, or null for any other URL. */
export function extractViewerTunnelId(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.pathname.replace(/\/$/, '') !== REMOTE_VIEWER_PATH) {
    return null
  }
  const id = parsed.hash.slice(1)
  return /^[a-z0-9-]{1,63}$/.test(id) ? id : null
}

/**
 * Normalize a shared remote control URL to the /extension WebSocket URL a client
 * must dial. Accepts https://, http://, wss://, ws:// forms.
 *
 * Two link shapes are accepted:
 *   https://playwriter.dev/remote-control#{tunnelId}   viewer link (current)
 *   https://{tunnelId}-tunnel.playwriter.dev            tunnel host (older
 *                                                        extensions, self-hosted
 *                                                        tunnel domains)
 *
 * The tunnel host form keeps using the host verbatim, so links from older
 * extensions and self-hosted tunnel domains still work; only the viewer form
 * derives a host from the id.
 */
export function parseRemoteControlUrl(url: string): { wsUrl: string; httpUrl: string; host: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid remote control URL: ${url}`)
  }
  const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
  const isKnown = isSecure || parsed.protocol === 'http:' || parsed.protocol === 'ws:'
  if (!isKnown) {
    throw new Error(`Invalid remote control URL protocol: ${parsed.protocol} (expected https:// or wss://)`)
  }

  // A viewer link without a hash almost always means an unquoted shell argument:
  // `#` starts a comment, so the id is silently cut off before playwriter sees it.
  if (parsed.pathname.replace(/\/$/, '') === REMOTE_VIEWER_PATH && !parsed.hash) {
    throw new Error(
      `Remote control URL is missing its #id: ${url}\nQuote the URL so the shell keeps the part after "#", for example:\n  playwriter session new --remote-control '${REMOTE_VIEWER_BASE_URL}${REMOTE_VIEWER_PATH}#your-id'`,
    )
  }

  const viewerTunnelId = extractViewerTunnelId(url)
  if (viewerTunnelId) {
    const origin = buildTunnelOrigin({ tunnelId: viewerTunnelId })
    return {
      wsUrl: `${origin.replace(/^https/, 'wss')}/extension`,
      httpUrl: origin,
      host: new URL(origin).host,
    }
  }

  const wsProtocol = isSecure ? 'wss:' : 'ws:'
  const httpProtocol = isSecure ? 'https:' : 'http:'
  return {
    wsUrl: `${wsProtocol}//${parsed.host}/extension`,
    httpUrl: `${httpProtocol}//${parsed.host}`,
    host: parsed.host,
  }
}

// ---------------------------------------------------------------------------
// Extension CDP transport codec
// ---------------------------------------------------------------------------
// The tunnel speaks the extension WS protocol, not raw CDP. Commands are wrapped
// in `forwardCDPCommand`, events arrive as `forwardCDPEvent`, and errors come back
// as a plain string instead of the raw-CDP `{ message }` object. The viewer page
// on playwriter.dev uses these helpers so it can drive a shared tab with the same
// screencast code it uses for raw-CDP cloud browsers.

export function encodeExtensionCdpCommand({
  id,
  method,
  params,
  sessionId,
}: {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}): string {
  return JSON.stringify({
    id,
    method: 'forwardCDPCommand',
    params: { method, sessionId, params: params || {} },
  })
}

export type DecodedExtensionMessage =
  | { kind: 'response'; id: number; result?: unknown; error?: string }
  | { kind: 'event'; method: string; sessionId: string; params: unknown }
  | { kind: 'hello'; browser?: string; version?: string }
  | { kind: 'ping' }
  | { kind: 'ignored' }

export function decodeExtensionCdpMessage(raw: string): DecodedExtensionMessage {
  let msg: object
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'ignored' }
    }
    msg = parsed
  } catch {
    return { kind: 'ignored' }
  }
  const id = Reflect.get(msg, 'id')
  const method = Reflect.get(msg, 'method')
  const params = Reflect.get(msg, 'params')
  if (typeof id === 'number' && method === undefined) {
    const error = Reflect.get(msg, 'error')
    return {
      kind: 'response',
      id,
      result: Reflect.get(msg, 'result'),
      error: typeof error === 'string' ? error : undefined,
    }
  }
  if (method === 'forwardCDPEvent' && params && typeof params === 'object') {
    const eventMethod = Reflect.get(params, 'method')
    if (typeof eventMethod !== 'string') {
      return { kind: 'ignored' }
    }
    const sessionId = Reflect.get(params, 'sessionId')
    return {
      kind: 'event',
      method: eventMethod,
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      params: Reflect.get(params, 'params'),
    }
  }
  if (method === 'hello') {
    const browser = params && typeof params === 'object' ? Reflect.get(params, 'browser') : undefined
    const version = params && typeof params === 'object' ? Reflect.get(params, 'version') : undefined
    return {
      kind: 'hello',
      browser: typeof browser === 'string' ? browser : undefined,
      version: typeof version === 'string' ? version : undefined,
    }
  }
  if (method === 'ping') {
    return { kind: 'ping' }
  }
  return { kind: 'ignored' }
}

/**
 * Session id of the tab the extension shared, taken from the
 * `Target.attachedToTarget` event it pushes right after `hello`.
 */
export function readAttachedTargetSession(
  message: DecodedExtensionMessage,
): { sessionId: string; url: string } | null {
  if (message.kind !== 'event' || message.method !== 'Target.attachedToTarget') {
    return null
  }
  const params = message.params as
    | { sessionId?: string; targetInfo?: { url?: string; type?: string } }
    | undefined
  if (!params?.sessionId) {
    return null
  }
  return { sessionId: params.sessionId, url: params.targetInfo?.url || '' }
}

// ---------------------------------------------------------------------------
// Remote scope command guards
// ---------------------------------------------------------------------------

const REMOTE_NEW_TAB_ERROR = dedent`
  This is a shared remote-control browser tab. You cannot create additional tabs and should not try to. The user shared exactly one tab with you (plus any popups that tab opens itself). Keep working inside the shared tab: navigate it with page.goto() instead of opening new pages. If you really need another tab, ask the user to open one and share it with you (they get a separate URL per shared tab).
`

/** Remote control is not a sandbox; only block obvious profile-wide accidents. */
const REMOTE_BLOCKED_CDP_COMMANDS = new Map<string, string>([
  ['Network.clearBrowserCookies', 'clears cookies for EVERY site in the user profile'],
  ['Network.clearBrowserCache', 'clears the browser cache for the whole user profile'],
  ['Network.getAllCookies', 'reads cookies for EVERY site in the user profile'],
  ['Storage.clearCookies', 'clears cookies for EVERY site in the user profile'],
  ['Storage.getCookies', 'reads cookies for EVERY site in the user profile'],
  ['Storage.setCookies', 'changes cookies outside the shared tab'],
])

/**
 * Returns a helpful error string when a CDP command must be rejected on a
 * remote control connection, or null when the command is allowed.
 */
export function getRemoteCdpCommandRejection(method: string): string | null {
  if (method === 'Target.createTarget') {
    return REMOTE_NEW_TAB_ERROR
  }
  const blockedReason = REMOTE_BLOCKED_CDP_COMMANDS.get(method)
  if (blockedReason) {
    return `${method} is not allowed on a shared remote-control tab: it ${blockedReason}.`
  }
  return null
}

/**
 * Returns a helpful error string when an extension protocol message (non-CDP)
 * must be rejected on a remote control connection, or null when allowed.
 */
export function getRemoteExtensionMethodRejection(method: string): string | null {
  if (method === 'createInitialTab') {
    return REMOTE_NEW_TAB_ERROR
  }
  if (method === 'startRecording' || method === 'stopRecording' || method === 'cancelRecording') {
    return 'Screen recording is not supported on shared remote-control tabs yet.'
  }
  if (method === 'ghost-browser') {
    return 'Ghost Browser APIs are not available on shared remote-control tabs.'
  }
  return null
}

/** Error used when a command targets a tab outside the shared remote scope. */
export function buildRemoteTabNotSharedError({ method, sessionId }: { method: string; sessionId?: string }): string {
  return dedent`
    Cannot run ${method}${sessionId ? ` (sessionId: ${sessionId})` : ''}: that tab is not shared over this remote-control link. You only have access to the tab the user shared (and popups it opened). Ask the user to share the other tab if you need it.
  `
}

// ---------------------------------------------------------------------------
// Prompt copied to the clipboard when the user enables remote control
// ---------------------------------------------------------------------------

export function buildRemoteControlPrompt({ url }: { url: string }): string {
  // The URL is single-quoted on purpose: it ends with #<id>, and an unquoted `#`
  // starts a shell comment, which would silently strip the id.
  return dedent`
    Connect to my shared Chrome tab. Keep the quotes; the URL ends with #id:

    npx -y playwriter@latest session new --remote-control '${url}'

    Then use the printed session id. Read https://playwriter.dev/SKILL.md. Do not create new tabs. NEVER share this URL.
  `
}

/** Handshake accepted from current and older extension versions. */
export type RemoteHelloMessage = {
  method: 'hello'
  id?: undefined
  params: {
    browser?: string
    email?: string
    id?: string
    installId?: string
    version?: string
    remote?: boolean
  }
}

export function buildRemoteHelloMessage({
  browser,
  version,
}: {
  browser?: string
  version?: string
}): RemoteHelloMessage {
  return {
    method: 'hello',
    params: {
      browser,
      version,
      remote: true,
    },
  }
}
