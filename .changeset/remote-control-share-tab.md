---
'playwriter': minor
---

Remote control: share one tab of your browser with a remote agent, no local playwriter install needed.

Click the new light-blue **Remote control** cloud button in the Playwriter toolbar and confirm the disclosure. The extension opens a secret tunnel on `playwriter.dev` (128-bit random URL) and copies a ready-to-paste agent prompt to your clipboard. The remote agent connects from any machine:

```bash
playwriter session new --remote-control https://playwriter.dev/r/xxx
playwriter -s 1 -e "console.log(await page.title())"
```

How it works: the extension itself acts as the tunnel upstream and speaks the normal extension WS protocol through it; the agent's local relay dials `wss://playwriter.dev/r/{id}/extension` and treats the socket as a regular extension connection. No WS protocol changes.

Scope and safety:

- The agent controls **only the shared tab**, plus popups/new tabs that tab opens itself (OAuth redirects, payment popups keep working)
- `Target.createTarget` / `context.newPage()` are rejected with a helpful error telling the agent to ask the user for another shared tab instead
- Browser-wide destructive commands (`Network.clearBrowserCookies`, `Network.clearBrowserCache`, `Storage.clearCookies`) are blocked
- Clicking the button again revokes the link instantly; a new activation generates a fresh URL
- The link survives extension service-worker restarts but dies when the browser closes
- Only a real click starts a share: the button lives in Chrome's isolated extension world and the secret prompt is copied by an offscreen extension document, so page scripts cannot start it or read the link
- Sharing asks for confirmation first, explaining that the agent can read and control the tab and that traffic passes through `playwriter.dev`
- Tunnel frames are relayed in memory only. They are never stored, and response caching is off for these tunnels
- The tunnel handshake sends only the browser name and Playwriter version, never your email, Google account ID, or extension install ID

Use case: let agents (Devin, grok bots, a teammate's CLI agent) work inside websites you are already logged into, without sharing passwords.
