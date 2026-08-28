---
'playwriter': patch
---

Block explicit whole-profile cookie APIs through Remote control links.

Remote clients cannot call `Network.getAllCookies`, `Storage.getCookies`, or
`Storage.setCookies`. URL/domain-targeted commands such as `Network.getCookies`,
`Network.setCookie`, and `Network.deleteCookies` remain available.
