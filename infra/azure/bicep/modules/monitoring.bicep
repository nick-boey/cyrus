// Monitoring: saved KQL queries + alert rules over the router's JSON log stream.
//
// Everything here reads `ContainerAppConsoleLogs_CL`, the table the Container
// Apps environment already ships the router's stdout to. The router app sets
// CYRUS_LOG_FORMAT=json, so each line in `Log_s` is one flat JSON object, and
// the `sandbox.*` event family sits on top of that. Nothing here requires an
// agent, an exporter, or an OpenTelemetry dependency.
//
// NAMING (Phase 4 / NOR-282): event names are dotted lowercase
// (`sandbox.gauge`), and every Cyrus-specific attribute lives under `cyrus.*`.
// A dotted key is NOT reachable with dot syntax in KQL — `p.cyrus.issue_key`
// parses as a nested lookup and silently returns null — so every one of them is
// read with bracket syntax: `p["cyrus.issue_key"]`. The structural keys the
// renderer owns (`event`, `component`, `level`, `message`, `timestamp`, `args`)
// deliberately keep their bare Phase 0 names and their dot syntax.
//
// The two facts every query below is built on, both easy to get wrong:
//
//  1. `uptime_ms` comes from `devices.running_since_ms`, which is CONTINUOUS
//     running time. It is NOT `age_ms` (`devices.created_ms`), the device row's
//     age, which survives every stop/resume cycle. A sandbox can be three days
//     old and four minutes up.
//
//  2. ACA `Running` is INFRASTRUCTURE state, not worker-process liveness — an
//     exited entrypoint leaves `tini` alive and the sandbox `Running`. So no
//     alert here keys on `state` alone. Each gauge sample also carries the
//     router's own liveness view (`online`, a live WSS socket, and
//     `last_seen_age_ms`, the age of the last heartbeat pong), and the
//     long-running rule classifies every hit by which of the two disagree.
//
// KQL is assembled with join(..., '\n') rather than a Bicep multi-line string,
// because `'''…'''` does not interpolate and every query needs the app name (and
// some need the thresholds) substituted in.

param namePrefix string
param flatNamePrefix string
param location string
param tags object

param logAnalyticsWorkspaceName string

@description('Router Container App name. Scopes every query to the router app, so a future second app in the same Container Apps environment cannot pollute the sandbox series.')
param routerAppName string

param enableAlerts bool
param alertEmailReceivers array
param sandboxUptimeAlertHours int
param enableOtelLogs bool

@description('Whether distributed tracing is on. Gates the Cyrus Traces saved searches — they query AppRequests/AppDependencies, which stay empty without it, and a saved search that silently returns nothing is worse than no saved search. main.bicep already enforces that this implies enableOtelLogs.')
param enableOtelTraces bool

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

// Application Insights is only the first-party OTLP ingestion endpoint. It is
// workspace-based, so records land in this same Log Analytics workspace under
// AppTraces; it does not introduce a second data store or retention policy.
resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = if (enableOtelLogs) {
  name: 'appi-${namePrefix}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

var appFilter = '| where ContainerAppName_s == "${routerAppName}"'
var sandboxUptimeAlertMs = sandboxUptimeAlertHours * 3600000

// A heartbeat older than this means the worker process is not answering the
// router's pings. Derived from the protocol's own liveness policy rather than
// picked: HEARTBEAT_INTERVAL_MS (30s) x MAX_MISSED_HEARTBEATS (2) is when the
// router itself gives up on a socket, and 3x that leaves room for one reconnect
// cycle before we call a worker dead. Both constants live in
// packages/router-protocol/src/frames.ts; if they change, change this.
var workerHeartbeatStaleMs = 180000

var workerLivenessCase = 'case(online and last_seen_age_ms < ${workerHeartbeatStaleMs}, "live", isnull(last_seen_age_ms), "never-connected", "stale-heartbeat")'

// Shared prologue: narrow to the router app, parse the JSON line, and project
// every gauge attribute into a typed column.
var gaugePrologue = [
  'ContainerAppConsoleLogs_CL'
  appFilter
  '| extend p = parse_json(Log_s)'
  '| where tostring(p.event) == "sandbox.gauge"'
  '| extend'
  '    issue_key        = tostring(p["cyrus.issue_key"]),'
  '    device_id        = tostring(p["cyrus.device_id"]),'
  '    provider         = tostring(p["cyrus.provider"]),'
  '    state            = tostring(p["cyrus.state"]),'
  '    sessions         = toint(p["cyrus.sessions"]),'
  '    online           = tobool(p["cyrus.online"]),'
  '    age_ms           = tolong(p["cyrus.age_ms"]),'
  '    uptime_ms        = tolong(p["cyrus.uptime_ms"]),'
  '    last_seen_age_ms = tolong(p["cyrus.last_seen_age_ms"]),'
  '    parked_for_ms    = tolong(p["cyrus.parked_for_ms"])'
]

////////////////////////////////////////////////////////////////////////////////
// Saved searches — the queries an operator opens the workspace to run
////////////////////////////////////////////////////////////////////////////////

// Current open sandboxes, with their issue keys and uptimes, from a single
// query.
//
// `arg_max` collapses the ~15 samples a 15-minute window holds for each sandbox
// down to the newest one, which is what makes this a point-in-time inventory
// rather than a time series. The window has to comfortably exceed the 60s sweep
// interval (SWEEP_INTERVAL_MS in RouterServer.ts) so a slow tick cannot make a
// live sandbox vanish from the list.
resource sandboxesOpen 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Sandboxes-Open'
  properties: {
    category: 'Cyrus Sandboxes'
    displayName: 'Open sandboxes (issue, sessions, uptime)'
    query: join(
      concat(gaugePrologue, [
        '| where TimeGenerated > ago(15m)'
        '| summarize arg_max(TimeGenerated, *) by device_id'
        '| where state == "running"'
        '| project'
        '    issue_key,'
        '    device_id,'
        '    provider,'
        '    sessions,'
        '    worker = ${workerLivenessCase},'
        '    uptime = uptime_ms * 1ms,'
        '    age    = age_ms * 1ms,'
        '    parked = iff(isnull(parked_for_ms), timespan(null), parked_for_ms * 1ms),'
        '    sampled_at = TimeGenerated'
        '| order by uptime desc'
      ]),
      '\n'
    )
  }
}

// The rollup, as a time series: how many sandboxes were open, and how many were
// pinned by a live session, over time. Emitted once per sweep whether or not any
// sandboxes exist, so a flat line at zero is distinguishable from a router that
// stopped sweeping (which the "sweep stalled" alert below is the guard for).
resource sandboxesOverTime 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Sandboxes-Over-Time'
  properties: {
    category: 'Cyrus Sandboxes'
    displayName: 'Sandbox fleet size over time'
    query: join(
      [
        'ContainerAppConsoleLogs_CL'
        appFilter
        '| extend p = parse_json(Log_s)'
        '| where tostring(p.event) == "sandbox.sweep_completed"'
        '| extend'
        '    sandboxes = toint(p["cyrus.sandboxes"]),'
        '    running   = toint(p["cyrus.running"]),'
        '    stopped   = toint(p["cyrus.stopped"]),'
        '    pinned    = toint(p["cyrus.pinned"]),'
        '    unknown   = toint(p["cyrus.unknown"])'
        '| summarize'
        '    sandboxes = max(sandboxes),'
        '    running   = max(running),'
        '    pinned    = max(pinned),'
        '    unknown   = max(unknown)'
        '  by bin(TimeGenerated, 5m)'
        '| order by TimeGenerated asc'
      ],
      '\n'
    )
  }
}

// "How many sessions per issue" — session affinity is per-sandbox, and the gauge
// carries the reconciled count, so the answer is the max concurrent affinity
// each issue held over the window.
resource sessionsPerIssue 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Sessions-Per-Issue'
  properties: {
    category: 'Cyrus Sandboxes'
    displayName: 'Sessions per issue'
    query: join(
      concat(gaugePrologue, [
        '| summarize'
        '    peak_sessions = max(sessions),'
        '    peak_uptime   = max(uptime_ms) * 1ms,'
        '    samples       = count(),'
        '    last_seen     = max(TimeGenerated)'
        '  by issue_key, provider'
        '| order by peak_sessions desc, peak_uptime desc'
      ]),
      '\n'
    )
  }
}

// The full lifecycle of one issue's sandbox, in order. This is the query to open
// when a specific issue misbehaved: it interleaves every transition
// (boot/running/park/unpark/idle-stop/destroy/teardown) with nothing else in the
// way. Replace the issue key before running.
resource sandboxLifecycle 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Sandbox-Lifecycle'
  properties: {
    category: 'Cyrus Sandboxes'
    displayName: 'Sandbox lifecycle for one issue (edit the issue key)'
    query: join(
      [
        'let target_issue = "REPLACE-ME";'
        'ContainerAppConsoleLogs_CL'
        appFilter
        '| extend p = parse_json(Log_s)'
        '| extend event = tostring(p.event)'
        '| where event startswith "sandbox." and event != "sandbox.gauge"'
        '| where tostring(p["cyrus.issue_key"]) == target_issue'
        '| project'
        '    TimeGenerated,'
        '    event,'
        '    device_id = tostring(p["cyrus.device_id"]),'
        '    provider  = tostring(p["cyrus.provider"]),'
        '    detail    = bag_remove_keys(p, dynamic(["event", "cyrus.issue_key", "cyrus.device_id", "cyrus.provider", "component", "level", "message", "timestamp"]))'
        '| order by TimeGenerated asc'
      ],
      '\n'
    )
  }
}

// Boots that never reached running, and boots that failed outright. A
// `sandbox.boot_started` with neither a `sandbox.running` nor a
// `sandbox.boot_failed` inside the window is a provider call that hung — the
// case that looks identical to "still booting" from the router's console.
resource sandboxBootHealth 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Sandbox-Boot-Health'
  properties: {
    category: 'Cyrus Sandboxes'
    displayName: 'Sandbox boot outcomes (started vs running vs failed)'
    query: join(
      [
        'ContainerAppConsoleLogs_CL'
        appFilter
        '| extend p = parse_json(Log_s)'
        '| extend event = tostring(p.event)'
        '| where event in ("sandbox.boot_started", "sandbox.running", "sandbox.boot_failed")'
        '| summarize'
        '    started   = countif(event == "sandbox.boot_started"),'
        '    reached_running = countif(event == "sandbox.running"),'
        '    failed    = countif(event == "sandbox.boot_failed"),'
        '    last_error = anyif(tostring(p["cyrus.reason"]), event == "sandbox.boot_failed")'
        '  by issue_key = tostring(p["cyrus.issue_key"]), provider = tostring(p["cyrus.provider"])'
        '| extend unresolved = started - reached_running - failed'
        '| where failed > 0 or unresolved > 0'
        '| order by unresolved desc, failed desc'
      ],
      '\n'
    )
  }
}

// Sandboxes stopped out from under a live session, newest first.
//
// The companion to the `-stranded-sessions` alert: the alert says an issue is
// affected, this says how it got there. Each stranded sandbox is joined back to
// the `sandbox.idle_stopped` that preceded it, so `killed_after` shows how long
// the session that was killed had been running — a value of seconds is the
// NOR-366 handoff race, and a large one is something else.
resource sandboxStranded 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Sandbox-Stranded-Sessions'
  properties: {
    category: 'Cyrus Sandboxes'
    displayName: 'Stranded sessions (stopped sandbox still holding affinity)'
    query: join(
      [
        'let stops ='
        '    ContainerAppConsoleLogs_CL'
        appFilter
        '    | extend p = parse_json(Log_s)'
        '    | where tostring(p.event) == "sandbox.idle_stopped"'
        '    | project stopped_at = TimeGenerated,'
        '        device_id = tostring(p["cyrus.device_id"]),'
        '        idle_for  = tolong(p["cyrus.idle_for_ms"]) * 1ms,'
        '        uptime    = tolong(p["cyrus.uptime_ms"]) * 1ms;'
        'ContainerAppConsoleLogs_CL'
        appFilter
        '| extend p = parse_json(Log_s)'
        '| where tostring(p.event) == "sandbox.stranded_session"'
        '| extend device_id = tostring(p["cyrus.device_id"])'
        '| summarize'
        '    first_reported = min(TimeGenerated),'
        '    last_reported  = max(TimeGenerated),'
        '    ticks          = count(),'
        '    issue_key      = any(tostring(p["cyrus.issue_key"])),'
        '    provider       = any(tostring(p["cyrus.provider"])),'
        '    sessions       = max(toint(p["cyrus.sessions"])),'
        '    state          = any(tostring(p["cyrus.state"]))'
        '  by device_id'
        // The stop that produced this, if there was one: the newest idle-stop for
        // the same device at or before we first reported it. `absent` sandboxes and
        // stops older than the window simply have no match, hence the left join.
        '| join kind=leftouter ('
        '    stops | summarize arg_max(stopped_at, *) by device_id'
        '  ) on device_id'
        '| project'
        '    issue_key,'
        '    device_id,'
        '    provider,'
        '    state,'
        '    sessions,'
        '    stopped_at,'
        '    killed_after = uptime,'
        '    stranded_for = last_reported - first_reported,'
        '    ticks,'
        '    first_reported'
        '| order by first_reported desc'
      ],
      '\n'
    )
  }
}

////////////////////////////////////////////////////////////////////////////////
// Skills (NOR-368)
////////////////////////////////////////////////////////////////////////////////
//
// `skill.slash_invoked` is emitted by the sandbox WORKER, not the router, and
// reaches this table only because SandboxLogRelay re-emits forwarded frames onto
// the router's own stdout. It therefore carries the router's ContainerAppName
// like every query above, with `component` reading `sandbox/<worker component>`
// and `cyrus.device_id` / `cyrus.issue_key` supplied by the router's device row
// rather than by the worker.
//
// This event is the ONLY record a slash-invoked skill leaves. Expansion happens
// before the model gets a turn and bypasses the Skill tool entirely, so unlike a
// model-invoked skill there is no tool-use activity to correlate against.

// Which skills people actually reach for, and on how many distinct issues. The
// query to open when deciding what belongs in a dotfiles set.
resource skillSlashUsage 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Skill-Slash-Usage'
  properties: {
    category: 'Cyrus Skills'
    displayName: 'Slash-invoked skills by usage'
    query: join(
      [
        'ContainerAppConsoleLogs_CL'
        appFilter
        '| extend p = parse_json(Log_s)'
        '| where tostring(p.event) == "skill.slash_invoked"'
        '| extend'
        '    skill     = tostring(p["cyrus.skill"]),'
        '    issue_key = tostring(p["cyrus.issue_key"])'
        '| summarize'
        '    invocations   = count(),'
        '    issues        = dcount(issue_key),'
        '    new_sessions  = countif(tobool(p["cyrus.new_session"])),'
        '    first_used    = min(TimeGenerated),'
        '    last_used     = max(TimeGenerated)'
        '  by skill'
        '| order by invocations desc'
      ],
      '\n'
    )
  }
}

// Every slash invocation in order, for tracing one issue's session back to the
// command that started it.
resource skillSlashTimeline 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = {
  parent: logAnalytics
  name: 'Cyrus-Skill-Slash-Timeline'
  properties: {
    category: 'Cyrus Skills'
    displayName: 'Slash-invoked skills over time'
    query: join(
      [
        'ContainerAppConsoleLogs_CL'
        appFilter
        '| extend p = parse_json(Log_s)'
        '| where tostring(p.event) == "skill.slash_invoked"'
        '| project'
        '    TimeGenerated,'
        '    skill       = tostring(p["cyrus.skill"]),'
        '    issue_key   = tostring(p["cyrus.issue_key"]),'
        '    prompt_type = tostring(p["cyrus.prompt_type"]),'
        '    new_session = tobool(p["cyrus.new_session"]),'
        '    streaming   = tobool(p["cyrus.streaming"]),'
        '    device_id   = tostring(p["cyrus.device_id"])'
        '| order by TimeGenerated desc'
      ],
      '\n'
    )
  }
}

////////////////////////////////////////////////////////////////////////////////
// Distributed traces (Phase 5 / NOR-283)
////////////////////////////////////////////////////////////////////////////////
//
// ── A DIFFERENT SET OF TABLES ──
// Spans do NOT land in ContainerAppConsoleLogs_CL, and they do not land in
// AppTraces either — that is where Phase 3's LOG records go. Application
// Insights splits spans by kind: a SERVER or CONSUMER span becomes an
// AppRequests row and a CLIENT/PRODUCER/INTERNAL span becomes an
// AppDependencies row. Everything above keys on the console table and is blind
// to all three, which is why these queries are new rather than amendments.
//
// The join key across every table is OperationId — Application Insights' name
// for the W3C trace id. That is what makes a router log line, a sandbox log
// line, a router span, and a relayed sandbox span all resolve to one story.
//
// ── BRACKET SYNTAX IS MANDATORY ──
// `customDimensions.cyrus.issue_key` parses as a nested lookup and silently
// returns null. Every `cyrus.*` attribute must be read as
// `customDimensions["cyrus.issue_key"]`.

// The headline query: everything that happened for one issue, both processes,
// in one timeline. This is what "why did this take four minutes" is answered
// with.
resource traceForIssue 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = if (enableOtelTraces) {
  parent: logAnalytics
  name: 'Cyrus-Trace-For-Issue'
  properties: {
    category: 'Cyrus Traces'
    displayName: 'Full trace for one issue, router + sandbox (edit the issue key)'
    query: join(
      [
        'let target_issue = "REPLACE-ME";'
        '// Find every trace that touched this issue, from either process.'
        'let trace_ids ='
        '    union AppRequests, AppDependencies'
        '    | where tostring(Properties["cyrus.issue_key"]) == target_issue'
        '    | distinct OperationId;'
        'union AppRequests, AppDependencies'
        '| where OperationId in (trace_ids)'
        '| project'
        '    TimeGenerated,'
        '    trace_id  = OperationId,'
        '    span      = Name,'
        '    service   = AppRoleName,'
        '    duration_ms = DurationMs,'
        '    ok        = Success,'
        // cyrus.source is stamped by SandboxSpanRelay and is the one attribute
        // that says which side of the socket a span came from.
        '    origin    = coalesce(tostring(Properties["cyrus.source"]), "router"),'
        '    issue_key = tostring(Properties["cyrus.issue_key"])'
        '| order by trace_id asc, TimeGenerated asc'
      ],
      '\n'
    )
  }
}

// Where the wall-clock actually goes. Ranked by total time rather than by count,
// because the interesting answer is almost always one slow span type, not a
// frequent fast one.
resource traceSlowestSpans 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = if (enableOtelTraces) {
  parent: logAnalytics
  name: 'Cyrus-Trace-Slowest-Spans'
  properties: {
    category: 'Cyrus Traces'
    displayName: 'Slowest span types, router and sandbox'
    query: join(
      [
        'union AppRequests, AppDependencies'
        '| summarize'
        '    count(),'
        '    p50_ms = percentile(DurationMs, 50),'
        '    p95_ms = percentile(DurationMs, 95),'
        '    max_ms = max(DurationMs),'
        '    total_s = sum(DurationMs) / 1000'
        '  by span = Name, service = AppRoleName'
        '| order by total_s desc'
      ],
      '\n'
    )
  }
}

// The dependency view the phase brief calls out by name: ACA data-plane calls
// that sat on their 120s deadline, and Linear round-trips. Node's fetch has no
// default timeout, so a stalled call is otherwise indistinguishable from one
// that was never made.
resource traceStalledDependencies 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = if (enableOtelTraces) {
  parent: logAnalytics
  name: 'Cyrus-Trace-Stalled-Dependencies'
  properties: {
    category: 'Cyrus Traces'
    displayName: 'Outbound calls that stalled or failed (ACA data plane, Linear)'
    query: join(
      [
        'AppDependencies'
        '| where Name in ("aca.request", "linear.request")'
        '| extend'
        '    timeout_ms = toint(Properties["cyrus.aca.timeout_ms"]),'
        '    operation  = coalesce(tostring(Properties["cyrus.aca.operation"]), tostring(Properties["cyrus.rpc_method"]))'
        // A call within 5s of its own deadline did not "just take a while" —
        // it hit the wall, and the deadline is the only reason it returned.
        '| extend at_deadline = isnotnull(timeout_ms) and DurationMs >= timeout_ms - 5000'
        '| where at_deadline or Success == false'
        '| project'
        '    TimeGenerated,'
        '    trace_id = OperationId,'
        '    Name,'
        '    operation,'
        '    DurationMs,'
        '    timeout_ms,'
        '    at_deadline,'
        '    Success,'
        '    issue_key = tostring(Properties["cyrus.issue_key"])'
        '| order by TimeGenerated desc'
      ],
      '\n'
    )
  }
}

// Cold-boot latency, which is the number the idle-stop and affinity-grace
// defaults are calibrated against. Sourced from the span rather than from the
// two log lines around it, so it is a measured duration and not a subtraction.
resource traceBootLatency 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = if (enableOtelTraces) {
  parent: logAnalytics
  name: 'Cyrus-Trace-Boot-Latency'
  properties: {
    category: 'Cyrus Traces'
    displayName: 'Sandbox boot latency distribution'
    query: join(
      [
        'AppDependencies'
        '| where Name == "sandbox.boot"'
        '| summarize'
        '    boots = count(),'
        '    failed = countif(tostring(Properties["cyrus.boot_failed"]) == "true"),'
        '    p50_s = percentile(DurationMs, 50) / 1000,'
        '    p95_s = percentile(DurationMs, 95) / 1000,'
        '    max_s = max(DurationMs) / 1000'
        '  by provider = tostring(Properties["cyrus.provider"])'
        '| order by boots desc'
      ],
      '\n'
    )
  }
}

// The log↔trace join. An unsampled trace records no spans but its WARN/ERROR
// log records still carry the trace id (see the sampling ADR), so this finds the
// errors and then pulls in whatever span context does exist.
resource traceErrorCorrelation 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = if (enableOtelTraces) {
  parent: logAnalytics
  name: 'Cyrus-Trace-Error-Correlation'
  properties: {
    category: 'Cyrus Traces'
    displayName: 'Errors joined to the spans they happened inside'
    query: join(
      [
        'AppTraces'
        '| where SeverityLevel >= 3'
        '| project'
        '    TimeGenerated,'
        '    trace_id = OperationId,'
        '    Message,'
        '    component = tostring(Properties["component"]),'
        '    issue_key = tostring(Properties["cyrus.issue_key"]),'
        '    exception = tostring(Properties["exception.type"])'
        '| join kind=leftouter ('
        '    union AppRequests, AppDependencies'
        '    | summarize spans = make_set(Name, 20), trace_ms = sum(DurationMs) by OperationId'
        '  ) on $left.trace_id == $right.OperationId'
        '| project-away OperationId'
        '| order by TimeGenerated desc'
      ],
      '\n'
    )
  }
}

////////////////////////////////////////////////////////////////////////////////
// Alert rules
////////////////////////////////////////////////////////////////////////////////

// Optional. With no receivers configured the rules below still evaluate and
// still show up in Azure Monitor's fired-alerts list — they just page nobody.
// That is a deliberate default: it keeps the stack self-contained for an operator
// who has not yet decided where alerts should land, without silently creating an
// email destination nobody asked for.
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (enableAlerts && !empty(alertEmailReceivers)) {
  name: 'ag-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    // Azure caps groupShortName at 12 characters. `take` truncates rather than
    // erroring on a short input, which is the trap the Terraform version had to
    // guard against with min(): its substr() ERRORS when offset+length runs past
    // the end of the string.
    groupShortName: take(flatNamePrefix, 12)
    enabled: true
    emailReceivers: [
      for (receiver, i) in alertEmailReceivers: {
        name: 'email-${i}'
        emailAddress: receiver
        useCommonAlertSchema: true
      }
    ]
  }
}

var actionGroupIds = enableAlerts && !empty(alertEmailReceivers) ? [actionGroup.id] : []

// THE alert this stack exists for: a sandbox that has been running continuously
// for more than sandboxUptimeAlertHours.
//
// Why that number means something: idleStopMs defaults to 5 minutes, so an
// affinity-free sandbox is parked within one sweep tick of going quiet. A sandbox
// that reaches six continuous hours therefore held session affinity for
// essentially that entire period. At the ACA XL tier (4 vCPU / 8 GiB) that is
// simultaneously a real cost signal and a strong stuck-agent signal.
//
// The `worker` dimension is the part that must not be dropped. Alerting on ACA
// state alone would fire on a zombie (entrypoint exited, `tini` keeps the sandbox
// Running) and would say nothing about a hung-but-connected worker. Splitting the
// fired alert by worker liveness tells the responder which investigation they are
// starting:
//
//   live            — worker is answering heartbeats. A genuinely long-running
//                     agent, or one stuck in a loop. Look at the session.
//   stale-heartbeat — sandbox is Running but the worker stopped answering.
//                     Almost certainly a zombie burning 4 vCPU; destroy it.
//   never-connected — reached Running but never dialled back at all. A boot or
//                     egress-policy problem, not an agent problem.
resource sandboxLongRunning 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (enableAlerts) {
  name: 'alert-${namePrefix}-sandbox-long-running'
  location: location
  tags: tags
  properties: {
    displayName: 'alert-${namePrefix}-sandbox-long-running'
    description: 'A Cyrus sandbox has been running continuously for more than ${sandboxUptimeAlertHours}h. Split by worker liveness: "live" is a long/stuck agent, "stale-heartbeat" is a zombie sandbox, "never-connected" is a boot failure that reached Running.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    scopes: [
      logAnalytics.id
    ]
    autoMitigate: true
    criteria: {
      allOf: [
        {
          // Newest sample per sandbox inside the window, then the uptime gate.
          // The threshold is expressed BOTH in the query and in the criteria on
          // purpose: the query filter is what keeps the result set (and so the
          // alert dimensions) to just the offenders, while `threshold` is what an
          // operator sees and tunes in the portal.
          query: join(
            concat(gaugePrologue, [
              '| summarize arg_max(TimeGenerated, *) by device_id'
              '| where state == "running" and uptime_ms >= ${sandboxUptimeAlertMs}'
              '| extend worker = ${workerLivenessCase}'
              '| project issue_key, provider, worker, uptime_hours = round(uptime_ms / 3600000.0, 2)'
            ]),
            '\n'
          )
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'uptime_hours'
          threshold: sandboxUptimeAlertHours
          operator: 'GreaterThanOrEqual'
          dimensions: [
            {
              name: 'issue_key'
              operator: 'Include'
              values: [
                '*'
              ]
            }
            {
              name: 'worker'
              operator: 'Include'
              values: [
                '*'
              ]
            }
            {
              name: 'provider'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
          failingPeriods: {
            minFailingPeriodsToAlert: 1
            numberOfEvaluationPeriods: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

// The guard that makes the rule above trustworthy.
//
// Every sandbox alert is derived from the 60-second lifecycle sweep's gauge. If
// the sweep stops emitting — the router crashed, wedged, or was scaled to zero —
// the long-running rule quietly stops firing and looks exactly like "no sandbox
// has been up too long". Alerting on the ABSENCE of the rollup event is what
// turns that silent failure into a page.
//
// `sandbox.sweep_completed` is emitted once per COMPLETED sweep, including when
// zero sandboxes exist, precisely so this rule can key on it.
//
// `ContainerLifecycle.sweep()` is non-reentrant, so a tick that fires while the
// previous one is still running is skipped and emits no rollup. That is
// deliberate and makes this rule MORE truthful, not less: a sweep wedged on a
// slow provider call is exactly the blind spot this alert exists to catch, and
// before the guard the overlapping ticks kept emitting rollups that masked it. A
// sweep that legitimately runs past the 15m window will page — treat that as the
// signal it is, and look for the "skipping this tick" warning.
resource sandboxSweepStalled 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (enableAlerts) {
  name: 'alert-${namePrefix}-sandbox-sweep-stalled'
  location: location
  tags: tags
  properties: {
    displayName: 'alert-${namePrefix}-sandbox-sweep-stalled'
    description: 'The router\'s 60s container lifecycle sweep has emitted no sandbox.sweep_completed event in 15 minutes. Every other sandbox alert is derived from that sweep, so while this is firing they are all blind.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    scopes: [
      logAnalytics.id
    ]
    autoMitigate: true
    criteria: {
      allOf: [
        {
          // `summarize` with no `by` always returns exactly one row, including
          // for an empty input — that is what lets a COUNT OF ZERO be alertable
          // at all. A bare `| where sweeps < 1` would filter that row away and
          // the rule would never fire, which is the classic way this alert gets
          // written wrong.
          query: join(
            [
              'ContainerAppConsoleLogs_CL'
              appFilter
              '| extend p = parse_json(Log_s)'
              '| where tostring(p.event) == "sandbox.sweep_completed"'
              '| summarize sweeps = count()'
            ],
            '\n'
          )
          timeAggregation: 'Total'
          metricMeasureColumn: 'sweeps'
          threshold: 1
          operator: 'LessThan'
          failingPeriods: {
            minFailingPeriodsToAlert: 1
            numberOfEvaluationPeriods: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

// Boot failures. Distinct from the uptime rule because it is the opposite
// failure — nothing is running and nothing is costing money, but nothing is
// working either, and from Linear it looks like Cyrus simply ignored the issue.
resource sandboxBootFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (enableAlerts) {
  name: 'alert-${namePrefix}-sandbox-boot-failures'
  location: location
  tags: tags
  properties: {
    displayName: 'alert-${namePrefix}-sandbox-boot-failures'
    description: 'Cyrus sandboxes failed to boot. Each failure is one Linear issue that got no agent. Check the "cyrus.reason" attribute on the sandbox.boot_failed events.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    scopes: [
      logAnalytics.id
    ]
    autoMitigate: true
    criteria: {
      allOf: [
        {
          query: join(
            [
              'ContainerAppConsoleLogs_CL'
              appFilter
              '| extend p = parse_json(Log_s)'
              '| where tostring(p.event) == "sandbox.boot_failed"'
              '| summarize failures = count() by issue_key = tostring(p["cyrus.issue_key"]), provider = tostring(p["cyrus.provider"])'
            ],
            '\n'
          )
          timeAggregation: 'Total'
          metricMeasureColumn: 'failures'
          threshold: 0
          operator: 'GreaterThan'
          dimensions: [
            {
              name: 'issue_key'
              operator: 'Include'
              values: [
                '*'
              ]
            }
            {
              name: 'provider'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
          failingPeriods: {
            minFailingPeriodsToAlert: 1
            numberOfEvaluationPeriods: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

// The impossible state, and the only alert here that fires on an INVARIANT
// rather than on a threshold.
//
// `sandbox.stranded_session` means the router still holds session affinity for a
// sandbox that is neither running nor connected. Nothing about it is visible
// anywhere else: Linear renders a normal in-progress agent session for as long
// as it lasts, the gauge records it as three unremarkable fields, and none of the
// other rules here cover it — `-long-running` needs a running sandbox,
// `-boot-failures` needs a boot that failed, and `-sweep-stalled` needs the sweep
// to stop. That combined blind spot is what turned NOR-366's 38-second race into
// a nine-hour outage across five agent sessions.
//
// Severity 1, not 2: every event is one Linear issue whose agent has silently
// stopped making progress, and the user has no way to tell. Recovery is a prompt
// into the thread, which cold-boots the sandbox.
//
// ContainerLifecycle already applies its own grace window before emitting (a cold
// boot presents identically), so this rule needs no threshold beyond "any".
resource sandboxStrandedSessions 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (enableAlerts) {
  name: 'alert-${namePrefix}-sandbox-stranded-sessions'
  location: location
  tags: tags
  properties: {
    displayName: 'alert-${namePrefix}-sandbox-stranded-sessions'
    description: 'A Cyrus sandbox is stopped and offline but still holds session affinity. Linear is showing a live agent session against a sandbox that cannot make progress. Prompt the thread again to cold-boot it, then check the "cyrus.stranded_for_ms" attribute for how long it was lost.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    scopes: [
      logAnalytics.id
    ]
    autoMitigate: true
    criteria: {
      allOf: [
        {
          query: join(
            [
              'ContainerAppConsoleLogs_CL'
              appFilter
              '| extend p = parse_json(Log_s)'
              '| where tostring(p.event) == "sandbox.stranded_session"'
              '| summarize stranded = count() by issue_key = tostring(p["cyrus.issue_key"]), provider = tostring(p["cyrus.provider"])'
            ],
            '\n'
          )
          timeAggregation: 'Total'
          metricMeasureColumn: 'stranded'
          threshold: 0
          operator: 'GreaterThan'
          dimensions: [
            {
              name: 'issue_key'
              operator: 'Include'
              values: [
                '*'
              ]
            }
            {
              name: 'provider'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
          failingPeriods: {
            minFailingPeriodsToAlert: 1
            numberOfEvaluationPeriods: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

output applicationInsightsName string = enableOtelLogs ? applicationInsights.name : ''

@secure()
// The ternary is guarded by the same flag as the resource, and ARM's if()
// evaluates only the selected branch. BCP318 cannot prove that relationship.
#disable-next-line BCP318
output applicationInsightsConnectionString string = enableOtelLogs ? applicationInsights.properties.ConnectionString : ''
