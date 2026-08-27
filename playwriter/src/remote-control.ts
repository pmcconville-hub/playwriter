/**
 * Remote control: share a browser tab with a remote agent through a traforo tunnel.
 *
 * The extension acts as a traforo "upstream" client (the thing being exposed).
 * The relay on the agent's machine dials wss://playwriter.dev/r/{tunnelId}/extension,
 * traforo forwards the connection to the extension, and the extension treats it as a
 * normal relay connection speaking the exact same extension WS protocol.
 *
 * Tunnels are path-routed on playwriter.dev so shared links stay on a domain the
 * user already trusts. The traforo worker strips the /r/{tunnelId} prefix before
 * the tunnel sees the request, so the extension still answers on /extension.
 *
 * This module is shared between the extension (browser) and the relay (node):
 * keep it dependency-free and runtime-agnostic (globalThis.crypto works in both).
 */
import dedent from 'string-dedent'

export const REMOTE_TUNNEL_BASE_URL = 'https://playwriter.dev'
export const REMOTE_TUNNEL_PATH_PREFIX = '/r/'

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
  baseUrl = REMOTE_TUNNEL_BASE_URL,
}: {
  tunnelId: string
  baseUrl?: string
}): string {
  return `${baseUrl}${REMOTE_TUNNEL_PATH_PREFIX}${tunnelId}`
}

/** WebSocket URL the extension dials to register itself as the tunnel upstream. */
export function buildRemoteUpstreamWsUrl({
  tunnelId,
  baseUrl = REMOTE_TUNNEL_BASE_URL,
}: {
  tunnelId: string
  baseUrl?: string
}): string {
  const httpUrl = buildRemoteControlUrl({ tunnelId, baseUrl })
  return `${httpUrl.replace(/^http/, 'ws')}/traforo-upstream?_tunnelId=${encodeURIComponent(tunnelId)}`
}

// Built from the constant so the link format and the parser can never drift.
const REMOTE_TUNNEL_PATH_RE = new RegExp(`^${REMOTE_TUNNEL_PATH_PREFIX}([a-z0-9-]{1,63})(?:/|$)`)

/**
 * Normalize a user-provided remote control URL to the /extension WebSocket URL
 * the relay must dial. Accepts https://, http://, wss://, ws:// forms.
 *
 * Both link formats are accepted, because an older extension keeps producing
 * subdomain links long after the relay is updated:
 *   https://playwriter.dev/r/{tunnelId}       (current)
 *   https://{tunnelId}-tunnel.traforo.dev     (legacy)
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
  const wsProtocol = isSecure ? 'wss:' : 'ws:'
  const httpProtocol = isSecure ? 'https:' : 'http:'
  // Legacy subdomain links carry the id in the host, so their path is ignored.
  const pathMatch = parsed.pathname.match(REMOTE_TUNNEL_PATH_RE)
  const basePath = pathMatch ? `${REMOTE_TUNNEL_PATH_PREFIX}${pathMatch[1]}` : ''
  return {
    wsUrl: `${wsProtocol}//${parsed.host}${basePath}/extension`,
    httpUrl: `${httpProtocol}//${parsed.host}${basePath}`,
    host: parsed.host,
  }
}

// ---------------------------------------------------------------------------
// Remote scope command guards
// ---------------------------------------------------------------------------

const REMOTE_NEW_TAB_ERROR = dedent`
  This is a shared remote-control browser tab. You cannot create additional tabs and should not try to. The user shared exactly one tab with you (plus any popups that tab opens itself). Keep working inside the shared tab: navigate it with page.goto() instead of opening new pages. If you really need another tab, ask the user to open one and share it with you (they get a separate URL per shared tab).
`

/** CDP commands with browser-wide destructive effects, never allowed from remote agents. */
const REMOTE_BLOCKED_CDP_COMMANDS = new Map<string, string>([
  ['Network.clearBrowserCookies', 'clears cookies for EVERY site in the user profile'],
  ['Network.clearBrowserCache', 'clears the browser cache for the whole user profile'],
  ['Storage.clearCookies', 'clears cookies for EVERY site in the user profile'],
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
    return `${method} is not allowed on a shared remote-control tab: it ${blockedReason}. Use per-domain alternatives (e.g. Network.getCookies + Network.deleteCookies) instead.`
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
  return dedent`
    I am sharing one tab of my own browser with you through Playwriter remote control.

    Create a session connected to my tab:

    npx -y playwriter@latest session new --remote-control ${url}

    Then drive the tab with the printed session id, for example:

    npx -y playwriter@latest -s <id> -e "console.log(await page.title())"

    Read https://playwriter.dev/SKILL.md first for the full API (snapshots, clicking, etc).

    Rules:
    - You control ONLY this shared tab (plus popups it opens). Do not try to open new tabs; navigate the shared tab instead.
    - This link grants control of my browser tab as me. NEVER share this URL with anyone or include it in logs, commits, or messages.
    - I can revoke access at any time by clicking the Remote control button again.
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
