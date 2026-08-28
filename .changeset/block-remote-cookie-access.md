---
'playwriter': patch
---

Block profile-wide cookie reads and writes through one-tab Remote control links.

Remote clients can no longer call CDP cookie methods such as
`Network.getAllCookies`, `Network.getCookies`, `Network.setCookie`,
`Storage.getCookies`, or `Storage.setCookies`. These methods can access browser
profile data outside the tab that the user chose to share.
