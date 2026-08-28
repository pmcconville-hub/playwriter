---
'playwriter': minor
---

Remote control: share one tab of your browser with a remote agent, no local playwriter install needed.

Click the new light-blue **Remote control** cloud button in the Playwriter toolbar and confirm the disclosure. The extension opens a secret tunnel (128-bit random id) and copies a ready-to-paste agent prompt to your clipboard. The remote agent connects from any machine:

```bash
# quote the URL: an unquoted # starts a shell comment and drops the id
playwriter session new --remote-control 'https://playwriter.dev/remote-control#xxx'
playwriter -s 1 -e "console.log(await page.title())"
```

**The same link is also a live view.** Open it in any browser and you get the tab streamed frame by frame, with a URL bar and a **Take control** button for clicking, scrolling, and typing. So you can share a tab with a person, not only an agent, and neither side needs an install.

The tunnel id starts in the **URL fragment**, so the initial viewer-page request and Referer omit it. The viewer then uses the id to connect to the tunnel hostname, which the tunnel service and Cloudflare necessarily process.

How it works: the extension acts as the tunnel upstream and speaks the normal extension WS protocol through it. The agent's relay, and the viewer page, both dial `wss://{id}-tunnel.playwriter.dev/extension` and treat the socket as a regular extension connection. No WS protocol changes.

Every remote-control host now sits under **playwriter.dev**, so sharing a tab never sends traffic to a domain you have not already trusted.

Scope and safety:

- The shared tab is the starting control surface, not a security sandbox; the recipient receives broad CDP access and must be fully trusted
- `Target.createTarget` / `context.newPage()` are rejected with a helpful error telling the agent to ask the user for another shared tab instead
- A short denylist blocks explicit whole-profile cookie APIs and obvious destructive clears; URL/domain-targeted cookie commands remain available
- Clicking the button again revokes the link instantly; a new activation generates a fresh URL
- The link survives extension service-worker restarts but dies when the browser closes
- Only a real click starts a share: the button lives in Chrome's isolated extension world and the secret prompt is copied by an offscreen extension document, so page scripts cannot start it or read the link
- Sharing asks for confirmation first, explaining that the agent can read and control the tab and that traffic leaves your machine
- The disclosure covers screenshots, page content, URLs, input events, network data, cookies, authentication data, and browser storage
- Tunnel frames are relayed in memory only. They are never stored, and response caching is off for these tunnels
- The live view never resizes your page. It adapts to the tab's own size instead of overriding device metrics
- The stream keeps running when you switch tabs, because the debugger attachment stops Chrome from backgrounding the shared tab
- The tunnel handshake sends only the browser name and Playwriter version, never your email, Google account ID, or extension install ID

Use case: let agents (Devin, grok bots, a teammate's CLI agent) work inside websites you are already logged into, without sharing passwords.
