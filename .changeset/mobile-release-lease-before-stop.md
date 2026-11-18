---
'@e2e-dev/mobile': patch
---

Fix BrowserStack and TestMu AI runs on Windows failing during cleanup with `could not confirm its sessions ended` and leaving the device session open until idle timeout, and fail the release when the service rejects ending the session.
