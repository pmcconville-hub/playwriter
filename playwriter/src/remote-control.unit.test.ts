import { describe, test, expect } from 'vitest'
import {
  buildRemoteHelloMessage,
  buildRemoteControlPrompt,
  buildRemoteTabNotSharedError,
  buildRemoteControlUrl,
  buildRemoteUpstreamWsUrl,
  generateTunnelId,
  getRemoteCdpCommandRejection,
  getRemoteExtensionMethodRejection,
  parseRemoteControlUrl,
} from './remote-control.js'

describe('remote-control', () => {
  test('tunnel ids are unguessable and accepted by the traforo worker', () => {
    const id = generateTunnelId()
    expect(generateTunnelId()).not.toBe(id)
    // Must match the id charset and length the traforo worker accepts.
    expect(id).toMatch(/^[a-z0-9-]{1,63}$/)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('build and parse remote control urls', () => {
    const url = buildRemoteControlUrl({ tunnelId: 'abc123' })
    expect(url).toMatchInlineSnapshot(`"https://playwriter.dev/r/abc123"`)
    expect(parseRemoteControlUrl(url)).toMatchInlineSnapshot(`
      {
        "host": "playwriter.dev",
        "httpUrl": "https://playwriter.dev/r/abc123",
        "wsUrl": "wss://playwriter.dev/r/abc123/extension",
      }
    `)
    expect(buildRemoteUpstreamWsUrl({ tunnelId: 'abc123' })).toMatchInlineSnapshot(`"wss://playwriter.dev/r/abc123/traforo-upstream?_tunnelId=abc123"`)
    expect(() => parseRemoteControlUrl('ftp://nope')).toThrowErrorMatchingInlineSnapshot(
      `[Error: Invalid remote control URL protocol: ftp: (expected https:// or wss://)]`,
    )
    expect(() => parseRemoteControlUrl('not a url')).toThrowErrorMatchingInlineSnapshot(
      `[Error: Invalid remote control URL: not a url]`,
    )
  })

  test('parses links shared by older extensions that still use subdomains', () => {
    expect(parseRemoteControlUrl('https://abc123-tunnel.traforo.dev')).toMatchInlineSnapshot(`
      {
        "host": "abc123-tunnel.traforo.dev",
        "httpUrl": "https://abc123-tunnel.traforo.dev",
        "wsUrl": "wss://abc123-tunnel.traforo.dev/extension",
      }
    `)
    // wss:// and trailing paths normalize to the same dial target
    expect(parseRemoteControlUrl('wss://abc123-tunnel.traforo.dev/whatever').wsUrl).toBe(
      'wss://abc123-tunnel.traforo.dev/extension',
    )
  })

  test('keeps the tunnel path when normalizing a shared link', () => {
    expect(parseRemoteControlUrl('https://playwriter.dev/r/abc123/')).toMatchInlineSnapshot(`
      {
        "host": "playwriter.dev",
        "httpUrl": "https://playwriter.dev/r/abc123",
        "wsUrl": "wss://playwriter.dev/r/abc123/extension",
      }
    `)
    expect(parseRemoteControlUrl('wss://playwriter.dev/r/abc123/extension').wsUrl).toBe(
      'wss://playwriter.dev/r/abc123/extension',
    )
  })

  test('cdp command guards', () => {
    expect(getRemoteCdpCommandRejection('Page.navigate')).toBeNull()
    expect(getRemoteCdpCommandRejection('Runtime.evaluate')).toBeNull()
    expect(getRemoteCdpCommandRejection('Target.createTarget')).toMatchInlineSnapshot(
      `"This is a shared remote-control browser tab. You cannot create additional tabs and should not try to. The user shared exactly one tab with you (plus any popups that tab opens itself). Keep working inside the shared tab: navigate it with page.goto() instead of opening new pages. If you really need another tab, ask the user to open one and share it with you (they get a separate URL per shared tab)."`,
    )
    expect(getRemoteCdpCommandRejection('Network.clearBrowserCookies')).toMatchInlineSnapshot(
      `"Network.clearBrowserCookies is not allowed on a shared remote-control tab: it clears cookies for EVERY site in the user profile. Use per-domain alternatives (e.g. Network.getCookies + Network.deleteCookies) instead."`,
    )
    expect(getRemoteCdpCommandRejection('Network.clearBrowserCache')).toBeTruthy()
  })

  test('extension method guards', () => {
    expect(getRemoteExtensionMethodRejection('forwardCDPCommand')).toBeNull()
    expect(getRemoteExtensionMethodRejection('createInitialTab')).toContain('shared remote-control browser tab')
    expect(getRemoteExtensionMethodRejection('startRecording')).toMatchInlineSnapshot(
      `"Screen recording is not supported on shared remote-control tabs yet."`,
    )
    expect(getRemoteExtensionMethodRejection('ghost-browser')).toMatchInlineSnapshot(
      `"Ghost Browser APIs are not available on shared remote-control tabs."`,
    )
  })

  test('tab not shared error mentions the method', () => {
    expect(
      buildRemoteTabNotSharedError({ method: 'Page.navigate', sessionId: 'pw-tab-x-2' }),
    ).toMatchInlineSnapshot(
      `"Cannot run Page.navigate (sessionId: pw-tab-x-2): that tab is not shared over this remote-control link. You only have access to the tab the user shared (and popups it opened). Ask the user to share the other tab if you need it."`,
    )
  })

  test('prompt contains the url and the warning', () => {
    const prompt = buildRemoteControlPrompt({ url: 'https://abc-tunnel.traforo.dev' })
    expect(prompt).toContain('session new --remote-control https://abc-tunnel.traforo.dev')
    expect(prompt).toContain('NEVER share this URL')
    expect(prompt).toContain('playwriter.dev/SKILL.md')
  })

  test('remote hello excludes browser identity', () => {
    expect(buildRemoteHelloMessage({ browser: 'chrome', version: '1.2.3' })).toMatchInlineSnapshot(`
      {
        "method": "hello",
        "params": {
          "browser": "chrome",
          "remote": true,
          "version": "1.2.3",
        },
      }
    `)
  })
})
