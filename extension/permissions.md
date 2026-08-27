# Chrome Web Store Submission Justifications

## Single Purpose Description

Connects browser tabs to local Playwright automation scripts via Chrome DevTools Protocol, allowing users to automate and control their browser for testing and development without launching a separate Chrome instance.

## Permission Justifications

### activeTab

Required to attach the Chrome debugger to the current tab when the user clicks the extension icon. Allows the extension to access only the tab that the user explicitly activates.

### debugger

Essential for core functionality. This permission allows the extension to attach Chrome DevTools Protocol (CDP) to tabs selected by the user (via clicking the extension icon). CDP access enables the extension to relay automation commands from local Playwright scripts to the browser, allowing actions like page navigation, element interaction, and JavaScript execution for testing and development purposes.

### tabs (Testing Only - Removed in Production Builds)

**Note: This permission is automatically removed during production builds and is only included in test builds.**

The tabs permission is only needed during development/testing to:

- Access the URL property of tabs for test identification (finding tabs by URL pattern)
- Query all tabs with full information for test assertions

In production, the extension functions perfectly without the tabs permission because:

- Tab event listeners (onRemoved, onActivated, onUpdated) work without it
- chrome.tabs.create() and chrome.tabs.remove() work without it
- chrome.tabs.query() for active tab works without it
- chrome.tabs.get() works without it (returns limited info which is sufficient)

The build process (vite.config.mts) automatically removes this permission when TESTING environment variable is not set.

### webNavigation

Required to detect when one tab opens a new tab/window via `window.open`, `target="_blank"`, or similar navigation-triggered tab creation. The extension listens for `chrome.webNavigation.onCreatedNavigationTarget` to build a `new tab id → source tab id` mapping. When a Chrome popup window is created by a Playwriter-connected tab, the extension uses this mapping to know whether to relocate the popup into the source tab's main window so Playwright automation can control it. No URL or page content is collected — only tab-ID correlations.

### scripting (updated use)

The `scripting` permission was originally added for iframe cleanup before debugger attachment. It is now also used to:

1. **Inject the in-page toolbar** (`initPlaywriterToolbar`) into Chrome's isolated extension world for every tab the user connects Playwriter to. The toolbar is a closed Shadow DOM element that floats over the page and provides quick AI-integration tools without exposing privileged callbacks to website scripts.
2. **Re-inject the toolbar** after page navigations via `chrome.webNavigation.onDOMContentLoaded`.
3. **Destroy the toolbar** when the user disconnects Playwriter from a tab, so no extension UI is left behind on pages the user is actively browsing.

Injections target manually connected tabs and the blank tab Playwriter auto-creates when a client connects with no controlled tabs. They target only the top-level frame (`allFrames: false`). Playwriter does not inject into other existing tabs.

### offscreen

Required for screen recording and user-requested clipboard writes. The hidden extension document owns `MediaRecorder` streams and copies toolbar prompts without exposing clipboard content to the website.

### clipboardWrite

Required to copy prompts when the user clicks toolbar actions such as **Remote control**, **Record Skill**, or **Pin element**. Clipboard writes happen only after a trusted user click and are performed by the extension's offscreen document.

### host_permissions (<all_urls>)

Required to attach the debugger to tabs on any domain the user chooses to automate. This permission does not allow the extension to modify page content or inject scripts - it only enables CDP debugger attachment for automation. Users need this flexibility to test and automate workflows across all websites.

## Remote Code Justification

**This extension does NOT download, load, or execute any remote code.**

All extension code (JavaScript, HTML, CSS) is fully bundled within the extension package and statically reviewed.

**WebSocket connections:**
The extension normally connects to `ws://localhost:19988`, a relay on the user's machine. When the user confirms **Remote control** for a tab, the extension also opens a secret, temporary tunnel for that tab at `wss://playwriter.dev/r/{id}`. These connections carry protocol messages only; they never download extension code.

**What the WebSocket is used for:**

- Receiving CDP (Chrome DevTools Protocol) command messages in JSON format from local Playwright scripts
- Forwarding these command messages to attached browser tabs via the `chrome.debugger` API
- Sending CDP event messages back to the local Playwright scripts

**What it is NOT used for:**

- Downloading or executing JavaScript, WebAssembly, or any other executable code
- Loading remote configurations that modify extension behavior

This is functionally similar to Native Messaging but uses WebSockets for cross-platform compatibility with existing Playwright tooling. The WebSocket serves as a local IPC (inter-process communication) channel, not a remote code delivery mechanism.

## Data Collection & Privacy

- No analytics, tracking, or telemetry is collected
- Browser control normally stays local through Chrome DevTools Protocol
- Remote-control traffic passes through `playwriter.dev` only after the user confirms a disclosure, and stops when the user revokes the link
- The remote handshake sends only the browser name and Playwriter version, not the user's email, Google account ID, or extension install ID
- Remote-control traffic is relayed in memory only; it is never stored, and response caching is not enabled for these tunnels

## Screenshots Required

Need to provide at least one screenshot showing:

- Extension icon in toolbar (gray when disconnected, green when connected)
- Extension attached to a tab with Chrome's "debugging this browser" banner visible
- Welcome page or usage demonstration
