---
status: accepted
---

# A credential rotation replaces the container, without asking

Azure Container Apps has no verb that changes a running sandbox's environment, so
a rotated credential can only reach a container by creating a new one. Worse, three
of the four boot paths actively resurrect the old value: a `Running` container is
returned as-is, a parked one is resumed from a memory image that still holds the
old env, and an absent one is restored from an explicit snapshot whose env is
inherited by design. Rotating a token and re-prompting the issue therefore had no
effect, and neither did deleting the container by hand — the snapshot taken when
it parked put the superseded token straight back.

We now fingerprint the user's stored secret bundle, stamp it on the container and
on its snapshots, and treat a mismatch exactly as a stale worker image is already
treated: the container and its snapshots are deleted and a fresh one is created
from the image. The replacement happens automatically, with a notice posted to the
Linear session — no confirmation is asked for.

## Considered options

**Ask first, via a Linear elicitation.** This was the original proposal, and it is
what the router already does for repository selection. Rejected: it needs a pending
table, held-event replay, TTL expiry, and ignored-answer handling, all to ask a
question whose answer is always yes — the user rotated the credential on purpose,
moments earlier. A config flag is the cheap brake if one is ever wanted.

**Only replace a container that is parked, never one that is `Running`.** Rejected:
the next prompt would still be served by the container holding the dead token,
which is the entire bug. A stale worker image already deletes a live container
mid-flight, so this adds no new class of hazard.

**Record the fingerprint on the router's device row instead of as a container
label.** Rejected: the label reuses the staleness filter that already handles all
three resurrection paths, including the snapshot-lineage check. A device-row column
would need a schema change and would still have to duplicate the snapshot check
separately.

**Fingerprint the whole boot environment rather than the stored secrets.**
Rejected: that pulls `CYRUS_REPOS_JSON` in, so editing the repository registry or
a `[repo=name#branch]` tag would start deleting live containers. The label is named
`cyrus.secrets`, not `cyrus.env`, to keep that boundary from eroding.

## Consequences

Replacement is only safe because the persistence floor holds the work: the WIP
snapshot and the uploaded bundle mean a destroyed container costs a cold clone and
a workspace rebuild, not lost changes. Any future change that weakens the floor
weakens this decision with it.

Every container alive when this shipped carried no fingerprint label, and an absent
label counts as stale — so each live issue was replaced once, on its next routed
event. This mirrors how a missing `cyrus.disk` label already behaved.

A terminal-teardown wake deliberately passes no fingerprint, because rebuilding a
container moments before destroying it buys nothing. The cost is one narrow
interleaving: if a teardown wake wins the boot race and an ordinary prompt joins
that attempt, the prompt is served by the old container once before the next routed
event corrects it.
