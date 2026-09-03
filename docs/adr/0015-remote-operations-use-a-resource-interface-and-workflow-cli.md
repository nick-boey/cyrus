---
status: accepted
---

# Remote operations use a resource interface and workflow CLI

Remote observability is split into two deep modules. The router-side Fleet
Operations module exposes a small resource interface for discovery,
authenticated context, run observations and changes, and asynchronous recovery
operations. The CLI-side Remote Operator module exposes workflow-oriented
connection, run listing/watching/waiting, direct log querying, and safe run
recovery.

The log-source adapter is an internal CLI seam with Azure Log Analytics and
deterministic fake adapters. The router advertises an authorized descriptor but
never proxies logs or holds the operator's backend credential. Recovery presents
one semantic intent — reconcile this run safely — and hides device, container,
replay, affinity, and issue-lock mechanics inside the router implementation.

The official fleet-operator skill composes run observation, log evidence, and
recovery through the CLI. A separate diagnosis command is deferred until
repeated skill behavior proves that moving the workflow into code would create
real leverage. This keeps the router interface small without forcing
orchestrators to understand transport, cloud, or executor implementation
details.

The shared command vocabulary remains top-level and is selected by a command
profile rather than duplicated under a remote namespace. Run watches consume
durable material observation changes; recovery progress remains its own resource
rather than being hidden inside a run snapshot.
