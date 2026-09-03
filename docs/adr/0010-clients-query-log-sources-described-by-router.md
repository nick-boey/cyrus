---
status: accepted
---

# Clients query log sources described by the router

The router is configured with a named log source and exposes a credential-free
descriptor containing only the metadata needed to query it. The `cyrus logs`
command selects a client-side adapter for that descriptor and authenticates from
the orchestrating machine; the router does not proxy historical log volume or
disclose backend credentials.

For Azure Log Analytics, `cyrus logs` obtains a token from the standard
non-interactive credential chain — workload identity, managed identity,
service-principal environment variables, then Azure CLI credentials — compiles
stable Cyrus filters into KQL, and sends the query directly from the CLI to Log
Analytics. It never opens an interactive browser. Log records never pass back
through the router. `--show-query` exposes the generated native query for
diagnosis without making KQL the normal command contract.

The first adapter treats `ContainerAppConsoleLogs_CL` as the canonical dataset
because it contains structured router logs and relayed worker logs even when
OTLP export is disabled. It preserves trace context for later correlation but
does not query or merge OTLP log and span tables. Follow mode polls the
configured log source, reports source observation times, and does not promise
real-time delivery.

Query budgets are advertised with the descriptor and enforced by the client:
initially a 15-minute default lookback, a 24-hour maximum window, 5,000 returned
records, and a 15-second follow interval. Exceeding a limit fails instead of
silently truncating. Full normalized records are available only to a fleet
operator, remain subject to field-size and known-secret redaction, and must not
be copied wholesale into Linear by the operator skill.

Keeping the adapter in the CLI rather than in an agent skill makes output and
filtering testable and gives future file or service adapters the same interface.
Direct Log Analytics access is operator-level because Azure authorization
applies to the workspace independently of Cyrus. User-scoped historical log
access would require a separately designed router-mediated filtering path. Azure
Log Analytics is the only production adapter in this project; a fake adapter
proves the seam without inventing a file contract prematurely.
