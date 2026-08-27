---
'playwriter': minor
---

Remote control: share one tab of your browser with a remote agent, no local playwriter install needed.

Click the new light-blue **Remote control** cloud button in the Playwriter toolbar. The extension opens a secret [traforo](https://traforo.dev) tunnel (128-bit random URL) and copies a ready-to-paste agent prompt to your clipboard. The remote agent connects from any machine:

The toolbar runs in Chrome's isolated extension world. Websites cannot invoke its controls, access its callbacks, or intercept the secret prompt as it is copied by an offscreen extension document.

```bash
playwriter session new --remote-control https://xxx-tunnel.traforo.dev
playwriter -s 1 -e "console.log(await page.title())"
```

How it works: the extension itself acts as the tunnel upstream and speaks the normal extension WS protocol through it; the agent's local relay dials `wss://{id}-tunnel.traforo.dev/extension` and treats the socket as a regular extension connection. No WS protocol changes.

Scope and safety:

- The agent controls **only the shared tab**, plus popups/new tabs that tab opens itself (OAuth redirects, payment popups keep working)
- `Target.createTarget` / `context.newPage()` are rejected with a helpful error telling the agent to ask the user for another shared tab instead
- Browser-wide destructive commands (`Network.clearBrowserCookies`, `Network.clearBrowserCache`, `Storage.clearCookies`) are blocked
- Clicking the button again revokes the link instantly; a new activation generates a fresh URL
- The link survives extension service-worker restarts but dies when the browser closes

Use case: let agents (Devin, grok bots, a teammate's CLI agent) work inside websites you are already logged into, without sharing passwords.
