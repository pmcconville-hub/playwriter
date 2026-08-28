---
'playwriter': patch
---

Make Remote control live view cheaper to stream.

The viewer now asks Chrome for a **960px JPEG at quality 50**, and only **every third compositor frame**. Shared tabs no longer encode at Retina pixel size. The canvas paints **only the latest frame**, so a slow decode cannot queue stale images.
