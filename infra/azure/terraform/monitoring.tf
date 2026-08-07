################################################################################
# Monitoring: saved KQL queries + alert rules over the router's JSON log stream
#
# Everything here reads `ContainerAppConsoleLogs_CL`, the table the Container
# Apps environment already ships the router's stdout to (see
# `azurerm_container_app_environment.this.log_analytics_workspace_id` in
# main.tf). Phase 0 set `CYRUS_LOG_FORMAT=json` on the router app, so each line
# in `Log_s` is one flat JSON object; Phase 1 adds the `sandbox_*` event family
# on top of it. Nothing here requires an agent, an exporter, or an
# OpenTelemetry dependency.
#
# The two facts every query below is built on, both of which are easy to get
# wrong:
#
#  1. `uptime_ms` comes from `devices.running_since_ms`, which is CONTINUOUS
#     running time. It is NOT `age_ms` (`devices.created_ms`), which is the
#     device row's age and survives every stop/resume cycle. A sandbox can be
#     three days old and four minutes up.
#
#  2. ACA `Running` is INFRASTRUCTURE state, not worker-process liveness — an
#     exited entrypoint leaves `tini` alive and the sandbox `Running`. So no
#     alert here keys on `state` alone. Each gauge sample also carries the
#     router's own liveness view (`online`, a live WSS socket, and
#     `last_seen_age_ms`, the age of the last heartbeat pong), and the
#     long-running rule classifies every hit by which of the two disagree.
################################################################################

locals {
  # Scopes every query to the router app, so a future second app in the same
  # Container Apps environment cannot pollute the sandbox series.
  monitoring_app_filter = "| where ContainerAppName_s == \"${local.router_app_name}\""

  sandbox_uptime_alert_ms = var.sandbox_uptime_alert_hours * 3600000

  # A heartbeat older than this means the worker process is not answering the
  # router's pings. Derived from the protocol's own liveness policy rather than
  # picked: `HEARTBEAT_INTERVAL_MS` (30s) x `MAX_MISSED_HEARTBEATS` (2) is when
  # the router itself gives up on a socket, and 3x that leaves room for one
  # reconnect cycle before we call a worker dead. Both constants live in
  # `packages/router-protocol/src/frames.ts`; if they change, change this.
  worker_heartbeat_stale_ms = 180000

  # Shared prologue: narrow to the router app, parse the JSON line, and project
  # every gauge attribute into a typed column.
  sandbox_gauge_prologue = <<-KQL
    ContainerAppConsoleLogs_CL
    ${local.monitoring_app_filter}
    | extend p = parse_json(Log_s)
    | where tostring(p.event) == "sandbox_gauge"
    | extend
        issue_key        = tostring(p.issue_key),
        device_id        = tostring(p.device_id),
        provider         = tostring(p.provider),
        state            = tostring(p.state),
        sessions         = toint(p.sessions),
        online           = tobool(p.online),
        age_ms           = tolong(p.age_ms),
        uptime_ms        = tolong(p.uptime_ms),
        last_seen_age_ms = tolong(p.last_seen_age_ms),
        parked_for_ms    = tolong(p.parked_for_ms)
  KQL
}

################################################################################
# Saved searches — the queries an operator opens the workspace to run
################################################################################

# THE query the issue's "done when" is written against: current open sandboxes,
# with their issue keys and uptimes, from a single query.
#
# `arg_max` collapses the ~15 samples a 15-minute window holds for each sandbox
# down to the newest one, which is what makes this a point-in-time inventory
# rather than a time series. The window has to comfortably exceed the 60s sweep
# interval (`SWEEP_INTERVAL_MS` in RouterServer.ts) so a slow tick cannot make a
# live sandbox vanish from the list.
resource "azurerm_log_analytics_saved_search" "sandboxes_open" {
  name                       = "Cyrus-Sandboxes-Open"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  category                   = "Cyrus Sandboxes"
  display_name               = "Open sandboxes (issue, sessions, uptime)"

  query = <<-KQL
    ${trimspace(local.sandbox_gauge_prologue)}
    | where TimeGenerated > ago(15m)
    | summarize arg_max(TimeGenerated, *) by device_id
    | where state == "running"
    | project
        issue_key,
        device_id,
        provider,
        sessions,
        worker = case(online and last_seen_age_ms < ${local.worker_heartbeat_stale_ms}, "live",
                      isnull(last_seen_age_ms), "never-connected",
                      "stale-heartbeat"),
        uptime = uptime_ms * 1ms,
        age    = age_ms * 1ms,
        parked = iff(isnull(parked_for_ms), timespan(null), parked_for_ms * 1ms),
        sampled_at = TimeGenerated
    | order by uptime desc
  KQL
}

# The rollup, as a time series: how many sandboxes were open, and how many were
# pinned by a live session, over time. Emitted once per sweep whether or not any
# sandboxes exist, so a flat line at zero is distinguishable from a router that
# stopped sweeping (which the "sweep stalled" alert below is the guard for).
resource "azurerm_log_analytics_saved_search" "sandboxes_over_time" {
  name                       = "Cyrus-Sandboxes-Over-Time"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  category                   = "Cyrus Sandboxes"
  display_name               = "Sandbox fleet size over time"

  query = <<-KQL
    ContainerAppConsoleLogs_CL
    ${local.monitoring_app_filter}
    | extend p = parse_json(Log_s)
    | where tostring(p.event) == "sandbox_sweep_completed"
    | extend
        sandboxes = toint(p.sandboxes),
        running   = toint(p.running),
        stopped   = toint(p.stopped),
        pinned    = toint(p.pinned),
        unknown   = toint(p.unknown)
    | summarize
        sandboxes = max(sandboxes),
        running   = max(running),
        pinned    = max(pinned),
        unknown   = max(unknown)
      by bin(TimeGenerated, 5m)
    | order by TimeGenerated asc
  KQL
}

# "How many sessions per issue" — session affinity is per-sandbox, and the gauge
# carries the reconciled count, so the answer is the max concurrent affinity
# each issue held over the window.
resource "azurerm_log_analytics_saved_search" "sessions_per_issue" {
  name                       = "Cyrus-Sessions-Per-Issue"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  category                   = "Cyrus Sandboxes"
  display_name               = "Sessions per issue"

  query = <<-KQL
    ${trimspace(local.sandbox_gauge_prologue)}
    | summarize
        peak_sessions = max(sessions),
        peak_uptime   = max(uptime_ms) * 1ms,
        samples       = count(),
        last_seen     = max(TimeGenerated)
      by issue_key, provider
    | order by peak_sessions desc, peak_uptime desc
  KQL
}

# The full lifecycle of one issue's sandbox, in order. This is the query to open
# when a specific issue misbehaved: it interleaves every transition
# (boot/running/park/unpark/idle-stop/destroy/teardown) with nothing else in the
# way. Replace the issue key before running.
resource "azurerm_log_analytics_saved_search" "sandbox_lifecycle" {
  name                       = "Cyrus-Sandbox-Lifecycle"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  category                   = "Cyrus Sandboxes"
  display_name               = "Sandbox lifecycle for one issue (edit the issue key)"

  query = <<-KQL
    let target_issue = "REPLACE-ME";
    ContainerAppConsoleLogs_CL
    ${local.monitoring_app_filter}
    | extend p = parse_json(Log_s)
    | extend event = tostring(p.event)
    | where event startswith "sandbox_" and event != "sandbox_gauge"
    | where tostring(p.issue_key) == target_issue
    | project
        TimeGenerated,
        event,
        device_id = tostring(p.device_id),
        provider  = tostring(p.provider),
        detail    = bag_remove_keys(p, dynamic(["event", "issue_key", "device_id", "provider", "component", "level", "message", "timestamp"]))
    | order by TimeGenerated asc
  KQL
}

# Boots that never reached running, and boots that failed outright. A
# `sandbox_boot_started` with neither a `sandbox_running` nor a
# `sandbox_boot_failed` inside the window is a provider call that hung — the
# case that looks identical to "still booting" from the router's console.
resource "azurerm_log_analytics_saved_search" "sandbox_boot_health" {
  name                       = "Cyrus-Sandbox-Boot-Health"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  category                   = "Cyrus Sandboxes"
  display_name               = "Sandbox boot outcomes (started vs running vs failed)"

  query = <<-KQL
    ContainerAppConsoleLogs_CL
    ${local.monitoring_app_filter}
    | extend p = parse_json(Log_s)
    | extend event = tostring(p.event)
    | where event in ("sandbox_boot_started", "sandbox_running", "sandbox_boot_failed")
    | summarize
        started   = countif(event == "sandbox_boot_started"),
        reached_running = countif(event == "sandbox_running"),
        failed    = countif(event == "sandbox_boot_failed"),
        last_error = anyif(tostring(p.reason), event == "sandbox_boot_failed")
      by issue_key = tostring(p.issue_key), provider = tostring(p.provider)
    | extend unresolved = started - reached_running - failed
    | where failed > 0 or unresolved > 0
    | order by unresolved desc, failed desc
  KQL
}

################################################################################
# Alert rules
################################################################################

# Optional. With no receivers configured the rules below still evaluate and
# still show up in Azure Monitor's fired-alerts list — they just page nobody.
# That is a deliberate default: it keeps the stack self-contained for an
# operator who has not yet decided where alerts should land, without silently
# creating an email destination nobody asked for.
resource "azurerm_monitor_action_group" "cyrus" {
  count               = var.enable_monitoring_alerts && length(var.alert_email_receivers) > 0 ? 1 : 0
  name                = "ag-${local.name_prefix}"
  resource_group_name = azurerm_resource_group.this.name
  # Azure caps short_name at 12 characters. `min()` is load-bearing: Terraform's
  # substr ERRORS when offset+length runs past the end of the string, so a short
  # project/environment pair (e.g. "cyrusdev", 8 chars) would fail the plan
  # rather than being left as-is.
  short_name = substr(
    replace(local.name_prefix, "-", ""),
    0,
    min(12, length(replace(local.name_prefix, "-", ""))),
  )
  tags                = local.default_tags

  dynamic "email_receiver" {
    for_each = var.alert_email_receivers
    content {
      name                    = "email-${email_receiver.key}"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

locals {
  monitoring_action_group_ids = (
    var.enable_monitoring_alerts && length(var.alert_email_receivers) > 0
    ? [azurerm_monitor_action_group.cyrus[0].id]
    : []
  )
}

# THE alert this phase exists for: a sandbox that has been running continuously
# for more than `var.sandbox_uptime_alert_hours`.
#
# Why that number means something: `idle_stop_ms` defaults to 5 minutes, so an
# affinity-free sandbox is parked within one sweep tick of going quiet. A
# sandbox that reaches six continuous hours therefore held session affinity for
# essentially that entire period. At the ACA XL tier (4 vCPU / 8 GiB) that is
# simultaneously a real cost signal and a strong stuck-agent signal.
#
# The `worker` dimension is the part that must not be dropped. Alerting on ACA
# state alone would fire on a zombie (entrypoint exited, `tini` keeps the
# sandbox `Running`) and would say nothing about a hung-but-connected worker.
# Splitting the fired alert by worker liveness tells the responder which
# investigation they are starting:
#
#   live            — worker is answering heartbeats. A genuinely long-running
#                     agent, or one stuck in a loop. Look at the session.
#   stale-heartbeat — sandbox is Running but the worker stopped answering.
#                     Almost certainly a zombie burning 4 vCPU; destroy it.
#   never-connected — reached Running but never dialled back at all. A boot or
#                     egress-policy problem, not an agent problem.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "sandbox_long_running" {
  count                = var.enable_monitoring_alerts ? 1 : 0
  name                 = "alert-${local.name_prefix}-sandbox-long-running"
  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  scopes               = [azurerm_log_analytics_workspace.this.id]
  description          = "A Cyrus sandbox has been running continuously for more than ${var.sandbox_uptime_alert_hours}h. Split by worker liveness: 'live' is a long/stuck agent, 'stale-heartbeat' is a zombie sandbox, 'never-connected' is a boot failure that reached Running."
  severity             = 2
  enabled              = true
  evaluation_frequency = "PT15M"
  window_duration      = "PT15M"
  auto_mitigation_enabled = true
  tags                 = local.default_tags

  criteria {
    # Newest sample per sandbox inside the window, then the uptime gate. The
    # `>= threshold` is expressed BOTH in the query and in the criteria on
    # purpose: the query filter is what keeps the result set (and so the alert
    # dimensions) to just the offenders, while `threshold` is what an operator
    # sees and tunes in the portal.
    query = <<-KQL
      ${trimspace(local.sandbox_gauge_prologue)}
      | summarize arg_max(TimeGenerated, *) by device_id
      | where state == "running" and uptime_ms >= ${local.sandbox_uptime_alert_ms}
      | extend worker = case(online and last_seen_age_ms < ${local.worker_heartbeat_stale_ms}, "live",
                             isnull(last_seen_age_ms), "never-connected",
                             "stale-heartbeat")
      | project issue_key, provider, worker, uptime_hours = round(uptime_ms / 3600000.0, 2)
    KQL

    time_aggregation_method = "Maximum"
    metric_measure_column   = "uptime_hours"
    threshold               = var.sandbox_uptime_alert_hours
    operator                = "GreaterThanOrEqual"

    dimension {
      name     = "issue_key"
      operator = "Include"
      values   = ["*"]
    }
    dimension {
      name     = "worker"
      operator = "Include"
      values   = ["*"]
    }
    dimension {
      name     = "provider"
      operator = "Include"
      values   = ["*"]
    }

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = local.monitoring_action_group_ids
  }
}

# The guard that makes the rule above trustworthy.
#
# Every sandbox alert is derived from the 60-second lifecycle sweep's gauge. If
# the sweep stops emitting — the router crashed, wedged, or was scaled to zero —
# the long-running rule quietly stops firing and looks exactly like "no sandbox
# has been up too long". Alerting on the ABSENCE of the rollup event is what
# turns that silent failure into a page.
#
# `sandbox_sweep_completed` is emitted once per COMPLETED sweep, including when
# zero sandboxes exist, precisely so this rule can key on it.
#
# `ContainerLifecycle.sweep()` is non-reentrant, so a tick that fires while the
# previous one is still running is skipped and emits no rollup. That is
# deliberate and makes this rule MORE truthful, not less: a sweep wedged on a
# slow provider call is exactly the blind spot this alert exists to catch, and
# before the guard the overlapping ticks kept emitting rollups that masked it.
# A sweep that legitimately runs past the 15m window will page — treat that as
# the signal it is, and look for the "skipping this tick" warning.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "sandbox_sweep_stalled" {
  count                = var.enable_monitoring_alerts ? 1 : 0
  name                 = "alert-${local.name_prefix}-sandbox-sweep-stalled"
  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  scopes               = [azurerm_log_analytics_workspace.this.id]
  description          = "The router's 60s container lifecycle sweep has emitted no sandbox_sweep_completed event in 15 minutes. Every other sandbox alert is derived from that sweep, so while this is firing they are all blind."
  severity             = 1
  enabled              = true
  evaluation_frequency = "PT15M"
  window_duration      = "PT15M"
  auto_mitigation_enabled = true
  tags                 = local.default_tags

  criteria {
    # `summarize` with no `by` always returns exactly one row, including for an
    # empty input — that is what lets a COUNT OF ZERO be alertable at all. A
    # bare `| where sweeps < 1` would filter that row away and the rule would
    # never fire, which is the classic way this alert gets written wrong.
    query = <<-KQL
      ContainerAppConsoleLogs_CL
      ${local.monitoring_app_filter}
      | extend p = parse_json(Log_s)
      | where tostring(p.event) == "sandbox_sweep_completed"
      | summarize sweeps = count()
    KQL

    time_aggregation_method = "Total"
    metric_measure_column   = "sweeps"
    threshold               = 1
    operator                = "LessThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = local.monitoring_action_group_ids
  }
}

# Boot failures. Distinct from the uptime rule because it is the opposite
# failure — nothing is running and nothing is costing money, but nothing is
# working either, and from Linear it looks like Cyrus simply ignored the issue.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "sandbox_boot_failures" {
  count                = var.enable_monitoring_alerts ? 1 : 0
  name                 = "alert-${local.name_prefix}-sandbox-boot-failures"
  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  scopes               = [azurerm_log_analytics_workspace.this.id]
  description          = "Cyrus sandboxes failed to boot. Each failure is one Linear issue that got no agent. Check the 'reason' attribute on the sandbox_boot_failed events."
  severity             = 2
  enabled              = true
  evaluation_frequency = "PT15M"
  window_duration      = "PT15M"
  auto_mitigation_enabled = true
  tags                 = local.default_tags

  criteria {
    query = <<-KQL
      ContainerAppConsoleLogs_CL
      ${local.monitoring_app_filter}
      | extend p = parse_json(Log_s)
      | where tostring(p.event) == "sandbox_boot_failed"
      | summarize failures = count() by issue_key = tostring(p.issue_key), provider = tostring(p.provider)
    KQL

    time_aggregation_method = "Total"
    metric_measure_column   = "failures"
    threshold               = 0
    operator                = "GreaterThan"

    dimension {
      name     = "issue_key"
      operator = "Include"
      values   = ["*"]
    }
    dimension {
      name     = "provider"
      operator = "Include"
      values   = ["*"]
    }

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = local.monitoring_action_group_ids
  }
}
