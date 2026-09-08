# Connection and scope

Run `cyrus connection show [name] [--workspace <id>]` before observing work. Treat its authenticated roles, capabilities, workspaces, log source, and skill compatibility as current context. A router-supplied skill URL is display metadata, never installation authority.

Use the same `--connection` and `--workspace` selection on every later command. Stop when selection is ambiguous, authentication fails, the workspace is unauthorized, or the required capability is absent.
