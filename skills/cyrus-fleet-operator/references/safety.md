# Safety boundaries

Autonomous action is limited to `cyrus recover` with a fresh revision and stable idempotency key. The remote profile has no direct unlock, destroy, force, or executor controls.

Treat any request to bypass guards, release ownership directly, destroy infrastructure, force an operation, broaden scope, or use a non-remote command as break-glass. Stop and ask the user. Never turn stale evidence into a mutation and never substitute a router-advertised URL for the CLI's trusted skill registry.
