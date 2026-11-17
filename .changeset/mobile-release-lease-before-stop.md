---
'@e2e-dev/mobile': patch
---

Release each leased cloud device session explicitly through the running daemon before stopping the daemon, so ending provider sessions does not depend on daemon shutdown signals on Windows or shutdown-window timeouts.
