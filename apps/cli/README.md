# cyrus-ai

AI development agent for Linear powered by Claude Code.

## Installation

```bash
npm install -g cyrus-ai
```

## Usage

### Start the agent
```bash
cyrus
```

### Available Commands

- **`cyrus`** - Start the edge worker (default)
- **`cyrus add-repository`** - Add a new repository configuration
- **`cyrus check-tokens`** - Check the status of all Linear tokens
- **`cyrus refresh-token`** - Refresh a specific Linear token

### Adding Repositories

After initial setup, you can add additional repositories without restarting Cyrus:

```bash
cyrus add-repository
```

This command will:
1. Check for existing Linear credentials and reuse them if available
2. Start OAuth flow only if no credentials are found
3. Guide you through configuring the new repository
4. Save the updated configuration

The interactive wizard will prompt you for:
- Repository path (must be absolute)
- Base branch (defaults to 'main')
- Workspace directory for git worktrees
- Whether the repository is active

## Fleet run commands

`cyrus runs` observes agent runs on a **remote** router through a stored
connection (`cyrus connection add <name> <url> --auth entra`). It never reads
this device's own enrollment, so it works from an orchestrator host that runs no
sessions of its own — including under `--profile remote`.

The three subcommands have deliberately different success semantics:

| Command | Question it answers | Ends when |
| --- | --- | --- |
| `cyrus runs list` | What is the fleet doing right now? | Every page has been read |
| `cyrus runs watch` | What is changing? | `--timeout` elapses, or Ctrl-C |
| `cyrus runs wait <runId>` | Has this one run finished, or does it need input? | The run reaches a terminal or waiting state, or `--timeout` elapses |

```bash
# Every agent session in the one authorized workspace, as one row each.
# Succeeds whatever states it reports.
cyrus runs list

# Every TURN instead, including the runs already finished under a session.
cyrus runs list --all-runs

# Narrow it. Names must match exactly; an ambiguous one is refused with candidates.
cyrus runs list --team Platform --state waiting
cyrus runs list --issue NOR-402 --json

# Follow the fleet for ten minutes, as newline-delimited JSON.
cyrus runs watch --state active --timeout 600 --json

# Block until one run ends or asks for input.
cyrus runs wait 019bd6f2-1d1e-7a8e-9f4c-0b7c2a5e91d3 --timeout 900 --json

# Pick the connection and workspace explicitly when more than one is available.
cyrus runs list --connection prod --workspace ws-1
```

### One row per session, not per turn

A Linear agent session spans turns, and the router opens a new run each time one
is routed into a session whose previous run has finished — so Stop followed by
Continue leaves a `stopped` run and an `active` one under the same session.
`list` shows the CURRENT run of each session, because "what is the fleet doing"
has one answer per session and a spent turn rendered beside a live one reads as
two agents on one issue. `--all-runs` turns the collapsing off.

The runs themselves stay per-turn on the router. A run's team and project are
the ones it was routed under, and carrying them across a stop would rewrite the
history of work that already happened. `watch` is unaffected: its change events
are per run, and a new run beginning under an existing session is a real event.

### Filters

`list` and `watch` share one filter vocabulary: `--run`, `--session`, `--issue`,
`--state`, `--runner`, `--model`, `--comment`, `--routed-after`, plus `--owner`,
`--team`, and `--project`.

`wait` takes a run id and nothing else (beyond `--connection`/`--workspace`). A
run id is already the narrowest selector, and a filter over a fact that moves
would be actively harmful: `--state active` would make the run invisible the
moment it completed, turning the outcome the command exists to report into "no
such run".

`--workspace`, `--owner`, `--team`, and `--project` accept a canonical id **or**
the display name captured when the run was routed. A name matching more than one
id is refused with the candidates rather than resolved by position — two Linear
projects can share a name, and guessing would point a recovery at the wrong one.
Every output line carries the canonical id beside the captured name.

`--state` is one of `routed`, `active`, `waiting`, `complete`, `error`,
`stopped`, `unknown`. There is no `stalled`: nothing here infers a verdict from
elapsed time or silence, and `waiting` appears only because a worker reported it.

### Output

- Interactive default: a human table (`list`) or one line per event (`watch`).
- `--json`: a single `{ "schemaVersion": 1, … }` document for `list` and `wait`;
  newline-delimited JSON events for `watch` (`snapshot`, `change`, `resync`,
  `stopped`).
- **stdout carries data only; stderr carries diagnostics and deprecations.** A
  script can pipe stdout straight into a parser.

If the router restarts mid-watch, the stream emits a `resync` event, takes a
fresh snapshot, and resumes from the new cursor. It does not claim it observed
the restart interval.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, or a satisfied wait condition |
| `2` | Invalid invocation, invalid configuration, or an unsupported router capability |
| `3` | A valid non-success run outcome (`error`, `stopped`, `unknown`, or a worker-reported `waiting`) |
| `4` | `runs wait` ran out of time — its **own** condition, never the run's |
| `5` | Authentication or authorization failure |
| `6` | A transient router failure; retrying may work |

`list` and `watch` never exit `3` or `4`: an unhealthy fleet is a successful
read. Codes `3` and `4` are distinct on purpose — a `waiting` run is asking a
question and needs an answer, while a timeout means this command stopped
looking.

### Deprecated syntax

`cyrus runs [issue] [--watch]` still parses for one more release and prints a
deprecation notice on **stderr**. Without `--watch` it runs `list`; with
`--watch` it resolves the single non-terminal matching run and waits on it,
exiting `2` with the candidate run ids if more than one matches. `--after` maps
to `--routed-after`. Migrate to `cyrus runs list` and `cyrus runs wait <runId>`.

**Its exit codes changed.** The old `--watch` exited `1` for any non-`complete`
outcome and for a timeout. It now uses the table above — `3` for a non-success
outcome, `4` for a timeout, `2` for an ambiguous match — so a script testing
`[ $? -eq 1 ]` will no longer fire.

## Fleet log commands

`cyrus logs` reads the historical logs of a **remote** fleet through the same
stored connection `cyrus runs` uses. It is available in both command profiles.

Two subcommands, with different semantics:

| Command | Question it answers | Ends when |
| --- | --- | --- |
| `cyrus logs query` | What was logged in this window? | The window has been read |
| `cyrus logs follow` | What is being logged now? | `--timeout` elapses, or Ctrl-C |

```bash
# The last 15 minutes (the default the router advertises)
cyrus logs query

# Everything one run logged, router and sandbox alike
cyrus logs query --run 019bd6f2-1d1e-7a8e-9f4c-0b7c2a5e91d3 --since 2h

# Warnings and errors on one issue, as JSON
cyrus logs query --issue NOR-402 --level warn --level error --json

# Follow a team's logs, printing the generated backend query to stderr
cyrus logs follow --team team-1 --interval 30 --show-query
```

### Where the logs come from

The router does **not** serve log data. It publishes a credential-free
*descriptor* saying where its logs live, and this CLI authenticates to that
backend directly with **local** credentials — the same non-interactive Entra
chain `cyrus connection` uses, against the Log Analytics audience. Log records
never pass back through the router, which keeps a query that can return
gigabytes off a hop that would have to buffer it, and means your own Azure
grant (typically `Log Analytics Reader`) decides what you can read.

You never write a backend query. Every filter is a typed field, compiled into
the backend's language by an adapter; `--show-query` prints the generated query
to **stderr** so you can reproduce it in the portal.

### Filters

| Flag | Matches |
| --- | --- |
| `--since <duration>` | Look back this far: `30s`, `15m`, `2h`, `1d`, or bare seconds |
| `--from` / `--to` | An explicit window (ISO-8601 instants) |
| `--issue <key>` | The Linear issue identifier, e.g. `NOR-402` |
| `--run <id>` / `--session <id>` | One agent run, or one Linear agent session |
| `--owner` / `--team` / `--project` | The identities the run was routed under |
| `--component <name>` | The component that wrote the line, e.g. `EventRouter` |
| `--level <level>` | `debug`, `info`, `warn`, `error`. Repeatable |
| `--text <substring>` | Case-insensitive substring of the message |
| `--trace <id>` | A W3C trace id, to join a log line to its trace |
| `--limit <count>` | Maximum records. Refused above the source's budget |

Filter names match `cyrus runs` wherever the two share a dimension, so a run
you found with `cyrus runs list --issue NOR-402` reads with
`cyrus logs query --issue NOR-402`.

Router lines and relayed sandbox lines are both returned — nothing filters to
one — and each record carries a `cyrus.source` attribute saying which it was.

### Budgets, and why they refuse rather than truncate

The router advertises a default lookback, a maximum range, a record ceiling, and
a minimum follow interval. Exceeding any of them **fails with exit `2` and emits
nothing**, rather than returning a subset.

That is deliberate: a truncated log window reads exactly like a complete one, so
an operator concludes an error never happened. The same rule applies to a record
over 256 KiB, a result set over 10 MiB, and a `--limit` or `--interval` outside
what the source allows — each is refused with a message naming what to narrow.
Azure partial results are failures for the same reason.

### `follow` is a poll, not a stream

`follow` polls a historical store. Records become queryable only once the
backend has **ingested** them, which lags the moment they were written. So each
poll re-reads an overlap of the previous window and suppresses duplicates by a
content fingerprint, and the command reports the ingestion lag it observed —
widening its overlap when the backend reports worse. It never presents itself as
a live router stream, because a quiet screen must not be read as a quiet fleet.

### Redaction

Known secrets are removed before anything is printed: values under
credential-named keys (`token`, `secret`, `password`, …), credential shapes
(bearer headers, JWTs, operator tokens), and the exact values of credentials in
this process's own environment. A record that was altered carries
`"redacted": true`.

### Exit codes

The same table as `cyrus runs`. `query` and `follow` exit `0` whatever the
records say — a window full of errors is a successful read — so `3` and `4` do
not arise here. Budget refusals are `2`, an Azure `401`/`403` is `5`, and a
partial or failed backend result is `6`.

## Configuration

### Environment Variables

- `CYRUS_HOST_EXTERNAL` - Set to `true` to allow external connections (listens on `0.0.0.0` instead of `localhost`). Default: `false`
  - Use this when running in Docker containers or when you need external access to the webhook server
  - When `true`: Server listens on `0.0.0.0` (all interfaces)
  - When `false` or unset: Server listens on `localhost` (local access only)
- `LINEAR_ALLOWED_TOOLS` - Comma-separated list of tools allowed for Linear-triggered sessions. Overrides `linearAllowedTools` in `~/.cyrus/config.json` when set.
- `DISALLOWED_TOOLS` - Comma-separated list of tools disallowed across all sessions. Overrides `defaultDisallowedTools` in `~/.cyrus/config.json` when set.