---
status: accepted
---

# Remote observability separates user and operator principals

Remote observability supports two explicitly different principals: a user
connection that can observe only that user's agent runs, and a fleet-operator
connection that can observe agent runs across users. Existing device bearer
tokens retain their current least-privilege scope and are not silently
broadened.

A fleet operator presents an Entra access token on each router request. The
router validates its configured tenant, audience, and application role; read and
recovery authority are separate roles. The role establishes eligibility, while a
router-side mapping from the token's immutable principal ID selects the
workspace IDs the operator may access. Non-Entra deployments may mint tokens
resolved through the same permission model, but they do not reuse or reinterpret
device tokens.

Recovery is capability-scoped separately from observation. A user's device token
may recover only that user's runs; a fleet read role cannot recover; a fleet
recovery role may recover across users in its mapped workspaces; a
container-device token cannot recover. Raw unlock, destroy, and equivalent
break-glass administration are not part of the orchestrator-facing contract.

Azure deployments optionally accept operator principal or group IDs and
provision the router mapping plus Log Analytics Reader access. A documented
manual path remains for deployments whose deployment identity cannot assign
Entra roles.

This separation preserves the safe existing `cyrus connect` and `GET /runs`
behavior while making user, team, and project filters meaningful for authorized
fleet operators. It also prevents a convenient CLI command profile from
being mistaken for an authorization boundary: every cross-user read or mutation
remains enforced by the router.
