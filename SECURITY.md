# Security Policy

## Remote control scope is best effort

Remote control shares one tab through a secret link. The denylist blocks new-tab
creation, whole-profile cookie APIs, and obvious destructive clears, but the
shared tab is the starting control surface, not a sandbox.

The shared tab can navigate anywhere in your browser, including the extension's
own `chrome-extension://` pages. CDP evaluation in such a page reaches the full
extension API surface: other tabs, all profile cookies, profile identity.

If you give a remote URL to an agent, expect that it can access other tabs too.
Share the link only with a person or agent you fully trust, and revoke with
**Stop sharing** when done.

## Reporting

Open a private security advisory at
https://github.com/remorses/playwriter/security/advisories/new
