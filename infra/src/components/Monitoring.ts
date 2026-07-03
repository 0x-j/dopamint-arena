import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface MonitoringArgs {
  name: string;
  albArnSuffix: pulumi.Input<string>;
  targetGroupArnSuffix: pulumi.Input<string>;
  clusterName: pulumi.Input<string>;
  serviceName: pulumi.Input<string>;
  dbClusterIdentifier: pulumi.Input<string>;
  logGroupName: pulumi.Input<string>;
}

export function createMonitoring(args: MonitoringArgs): void {
  new aws.cloudwatch.MetricAlarm(`${args.name}-alb-5xx`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 2,
    metricName: "HTTPCode_Target_5XX_Count",
    namespace: "AWS/ApplicationELB",
    statistic: "Sum",
    threshold: 10,
    period: 60,
    dimensions: {
      LoadBalancer: args.albArnSuffix,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-alb-latency`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "TargetResponseTime",
    namespace: "AWS/ApplicationELB",
    extendedStatistic: "p99",
    threshold: 1,
    period: 60,
    dimensions: {
      LoadBalancer: args.albArnSuffix,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-ecs-cpu`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "CPUUtilization",
    namespace: "AWS/ECS",
    statistic: "Average",
    threshold: 80,
    period: 60,
    dimensions: {
      ClusterName: args.clusterName,
      ServiceName: args.serviceName,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-ecs-memory`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "MemoryUtilization",
    namespace: "AWS/ECS",
    statistic: "Average",
    threshold: 80,
    period: 60,
    dimensions: {
      ClusterName: args.clusterName,
      ServiceName: args.serviceName,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-db-cpu`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "CPUUtilization",
    namespace: "AWS/RDS",
    statistic: "Average",
    threshold: 80,
    period: 60,
    dimensions: {
      DBClusterIdentifier: args.dbClusterIdentifier,
    },
  });

  // --- Tier A': infra alarms on metrics AWS already emits (no filter, no code) ---

  // No healthy backend targets = the service is effectively down. Minimum over 3 min so
  // a single-target blip during a rolling deploy doesn't page, but a real outage does.
  new aws.cloudwatch.MetricAlarm(`${args.name}-backend-unhealthy`, {
    comparisonOperator: "LessThanThreshold",
    evaluationPeriods: 3,
    metricName: "HealthyHostCount",
    namespace: "AWS/ApplicationELB",
    statistic: "Minimum",
    threshold: 1,
    period: 60,
    dimensions: {
      LoadBalancer: args.albArnSuffix,
      TargetGroup: args.targetGroupArnSuffix,
    },
    treatMissingData: "breaching",
  });

  // Running task count hits 0 = the whole backend is gone (crash loop / failed deploy).
  // Maximum so momentary scale-in during a deploy doesn't trip it — only a true zero does.
  new aws.cloudwatch.MetricAlarm(`${args.name}-ecs-no-tasks`, {
    comparisonOperator: "LessThanThreshold",
    evaluationPeriods: 3,
    metricName: "RunningTaskCount",
    namespace: "ECS/ContainerInsights",
    statistic: "Maximum",
    threshold: 1,
    period: 60,
    dimensions: {
      ClusterName: args.clusterName,
      ServiceName: args.serviceName,
    },
    treatMissingData: "notBreaching",
  });

  // ALB refused a connection = target connection limit reached (the WS per-instance cap
  // under load). Any rejection in a 5-min window is worth surfacing.
  new aws.cloudwatch.MetricAlarm(`${args.name}-alb-rejected-conns`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    metricName: "RejectedConnectionCount",
    namespace: "AWS/ApplicationELB",
    statistic: "Sum",
    threshold: 0,
    period: 300,
    dimensions: {
      LoadBalancer: args.albArnSuffix,
    },
    treatMissingData: "notBreaching",
  });

  // --- Tier A: catch-all error rate ---
  // The backend logs human-readable text (tracing fmt), not JSON, so the previous
  // `{ $.level = "error" }` JSON pattern matched nothing — this metric read 0 regardless
  // of real errors. `ERROR` matches the uppercase level token tracing renders; app
  // message text is lowercase/mixed-case ("rpc error", "Error checking"), so it does not
  // false-match the WARN-level RPC storms.
  new aws.cloudwatch.LogMetricFilter(`${args.name}-backend-errors`, {
    pattern: '"ERROR"',
    logGroupName: args.logGroupName,
    metricTransformation: {
      name: `${args.name}-error-count`,
      namespace: "Dopamint/Backend",
      value: "1",
      defaultValue: "0",
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-backend-errors-alarm`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    metricName: `${args.name}-error-count`,
    namespace: "Dopamint/Backend",
    statistic: "Sum",
    threshold: 10,
    period: 300,
    treatMissingData: "notBreaching",
  });

  // --- Tier A: app-level failure signals (substring filters on existing log lines) ---
  // Patterns are plain substrings (CloudWatch unstructured syntax); tracing's message text
  // is ANSI-free so `"<message>"` matches the deployed logs as-is, no backend change.
  // Thresholds are starting points — tune from the observed baseline.

  // Settle failed to land on-chain: the money path, so any occurrence alarms. Archival failures
  // are deliberately NOT here — a settle logs those *after* it lands (digest returned); they go in
  // the provenance bucket below so a transient S3 blip never pages as a lost settle.
  appFailureSignal({
    name: args.name,
    logGroupName: args.logGroupName,
    key: "settle-failure",
    pattern: '?"settle rejected; dead-lettering" ?"settle enqueue failed"',
    threshold: 0,
    windowMin: 5,
  });

  // Gas/stake sponsorship hard failures (the allocate-401 cascade). The benign
  // "enoki … falling back to settler" line is excluded on purpose — it self-heals.
  appFailureSignal({
    name: args.name,
    logGroupName: args.logGroupName,
    key: "gas-plumbing-failure",
    pattern: '?"sponsor refused" ?"enoki execute failed" ?"faucet mint failed"',
    threshold: 5,
    windowMin: 5,
  });

  // Arena opens failing = games can't start (e.g. seat-B MTPS stake depleted).
  appFailureSignal({
    name: args.name,
    logGroupName: args.logGroupName,
    key: "arena-open-failure",
    pattern: '?"arena open failed, omitting" ?"arena batch open failed"',
    threshold: 20,
    windowMin: 5,
  });

  // Post-settle provenance degraded: the settle LANDED on-chain (digest returned) but the
  // transcript seal or the S3/Walrus archive failed — the ~404-on-/transcript class. Transient
  // blips are tolerable; a sustained rate is the real problem, hence a threshold above 0.
  appFailureSignal({
    name: args.name,
    logGroupName: args.logGroupName,
    key: "archival-failure",
    pattern:
      '?"transcript manifest seal failed" ?"transcript root unavailable" ?"transcript chunk upload failed" ?"s3 archive failed" ?"walrus archival failed"',
    threshold: 5,
    windowMin: 5,
  });

  // --- Tier B: settle success rate + settler gas health (rely on the backend change) ---

  // Positive counter: every on-chain settle logs "settle closed". No alarm — pair it with
  // settle-failure-count on a dashboard for a success ratio.
  new aws.cloudwatch.LogMetricFilter(`${args.name}-settle-success`, {
    pattern: '"settle closed"',
    logGroupName: args.logGroupName,
    metricTransformation: {
      name: `${args.name}-settle-success-count`,
      namespace: "Dopamint/Backend",
      value: "1",
      defaultValue: "0",
    },
  });

  // Settler SIP-58 gas pot ran low: the backend's 60s probe logs this when
  // fundsInAddressBalance < SETTLER_GAS_LOW_SUI. At ~0 every sponsored open/close/mint fails.
  appFailureSignal({
    name: args.name,
    logGroupName: args.logGroupName,
    key: "settler-gas-low",
    pattern: '"settler gas balance low"',
    threshold: 0,
    windowMin: 5,
  });
}

// One app-level failure signal: a log metric filter that counts matching lines, plus an
// alarm that fires when the count exceeds `threshold` within `windowMin` minutes.
// `defaultValue: "0"` keeps the metric continuous so a quiet period reads OK rather than
// INSUFFICIENT_DATA. The log group carries both backend and indexer streams, so counts
// reflect the whole tunnel-manager fleet.
function appFailureSignal(opts: {
  name: string;
  logGroupName: pulumi.Input<string>;
  key: string;
  pattern: string;
  threshold: number;
  windowMin: number;
}): void {
  const metricName = `${opts.name}-${opts.key}-count`;
  new aws.cloudwatch.LogMetricFilter(`${opts.name}-${opts.key}`, {
    pattern: opts.pattern,
    logGroupName: opts.logGroupName,
    metricTransformation: {
      name: metricName,
      namespace: "Dopamint/Backend",
      value: "1",
      defaultValue: "0",
    },
  });
  new aws.cloudwatch.MetricAlarm(`${opts.name}-${opts.key}-alarm`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    metricName,
    namespace: "Dopamint/Backend",
    statistic: "Sum",
    threshold: opts.threshold,
    period: opts.windowMin * 60,
    treatMissingData: "notBreaching",
  });
}
