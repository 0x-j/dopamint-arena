# AWS Deploy Runbook

Deploy or update the Dopamint AWS infrastructure and services.

## Before you begin

1. Pick the target environment. This runbook uses `dev` as the example; replace with `prod` or `staging` as needed.
2. Ensure your shell is configured for the target AWS account and region:
   ```bash
   export AWS_PROFILE=commandoss-dev
   export AWS_REGION=us-east-1
   ```
3. Ensure Pulumi is logged in and the stack exists:
   ```bash
   cd infra
   pulumi stack select dev
   ```

## Required tooling

- AWS CLI v2
- Pulumi CLI
- pnpm (managed by `corepack`; run `corepack enable` if needed)
- jq

## First-time setup

1. Install dependencies and create the stack:
   ```bash
   cd infra
   pnpm install
   pulumi stack init dev
   pulumi up -y
   ```
   > The project ships with `Pulumi.dev.yaml` containing the required config for the `dev` stack. If you create a new stack, set `dopamint:environment`, `dopamint:domain`, and `dopamint:route53ZoneId` first.
2. Export GitHub environment variables:
   ```bash
   pulumi stack output githubEnv --json | jq -r 'to_entries[] | "\(.key)=\(.value)"' | \
   while IFS='=' read -r key value; do
     gh variable set "$key" --body "$value" --env dev
   done
   ```

## Deploy infrastructure from local

```bash
cd infra
pulumi stack select dev
pulumi up -y
```

After the update finishes, verify the stack outputs:

```bash
pulumi stack output
```

## Deploy a backend image

The backend image is controlled by the `dopamint:backend-image-tag` Pulumi config key. To deploy a new image tag:

```bash
cd infra
pulumi stack select dev
pulumi config set dopamint:backend-image-tag <git-sha>
pulumi up -y
```

## Ollama sidecar (chat-v2)

The backend task can run an Ollama sidecar container for the chat-v2 feature. It is controlled by Pulumi config:

```bash
cd infra
pulumi stack select dev
# Enable/disable the sidecar (default: true)
pulumi config set dopamint:ollama-enabled true
# Model pulled and proxied by the backend (default: qwen2.5:1.5b)
pulumi config set dopamint:ollama-model qwen2.5:1.5b
# Sidecar image tag (default: 0.6.2)
pulumi config set dopamint:ollama-image-tag 0.6.2
pulumi up -y
```

When enabled, the backend task size increases from `1024 CPU / 2048 MiB` to `2048 CPU / 4096 MiB` to accommodate the model. The sidecar pulls the model at startup, so the first deployment may take 1–2 minutes before `/v1/chat` is healthy. The backend receives `OLLAMA_URL=http://localhost:11434` and `OLLAMA_MODEL` automatically.

To disable chat and revert to the smaller task size:

```bash
pulumi config set dopamint:ollama-enabled false
pulumi up -y
```

## Snapshot the database before risky changes

Before running migrations or schema changes, create a manual snapshot:

```bash
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier $(pulumi stack output dbClusterIdentifier) \
  --db-cluster-snapshot-identifier dopamint-dev-pre-migration-$(date +%Y%m%d-%H%M%S)
```

## Run database migrations

Before rolling out a backend release that changes the schema, run the migration task:

```bash
aws ecs run-task \
  --cluster $(pulumi stack output clusterName) \
  --task-definition $(pulumi stack output migrationTaskDefinitionArn) \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$(pulumi stack output privateSubnetIds --json | jq -r '.[0]')],securityGroups=[$(pulumi stack output backendSecurityGroupId)],assignPublicIp=DISABLED}"
```

Watch the migration logs until it exits:

```bash
aws logs tail $(pulumi stack output backendLogGroup) --prefix migrate --follow
```

If the migration task exits with a non-zero status, stop and follow the [AWS Rollback Runbook](./aws-rollback.md).

## Verify deployment

1. Confirm the ECS service is stable:
   ```bash
   aws ecs wait services-stable \
     --cluster $(pulumi stack output clusterName) \
     --services $(pulumi stack output backendServiceName)
   ```
2. Check the backend health endpoint:
   ```bash
   curl -fsS $(pulumi stack output backendUrl)/health/ready
   ```
3. If the Ollama sidecar is enabled, verify the model is loaded:
   ```bash
   aws logs tail $(pulumi stack output backendLogGroup) --prefix ollama --follow
   # In another terminal, check the chat topic endpoint responds:
   curl -fsS $(pulumi stack output backendUrl)/v1/chat/topic
   ```
4. Check the frontend is reachable:
   ```bash
   curl -fsSI https://$(pulumi stack output frontendDomain)
   ```
5. Review ALB target health:
   ```bash
   aws elbv2 describe-target-health \
     --target-group-arn $(pulumi stack output backendTargetGroupArn)
   ```

## Run 1M-update benchmark

The benchmark exercises 1,000,000 total updates across the tunnel mesh. Actual throughput depends on instance type, workers, and network conditions.

1. Scale the benchmark fleet:
   ```bash
   aws autoscaling set-desired-capacity \
     --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
     --desired-capacity 2
   ```
2. Wait for an instance to be `InService`, then retrieve one instance ID:
   ```bash
   aws autoscaling wait instance-in-service \
     --auto-scaling-group-name $(pulumi stack output benchmarkAsgName)
   INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
     --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
     --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)
   ```
3. Run the benchmark remotely via SSM:
   ```bash
   aws ssm send-command \
     --document-name "AWS-RunShellScript" \
     --targets Key=instanceids,Values="$INSTANCE_ID" \
     --parameters commands=["cd /opt/dopamint/repo/sui-tunnel-ts && UV_THREADPOOL_SIZE=128 numactl --interleave=all node --import tsx src/bench/cli.ts --tunnels 20000 --updates-per-tunnel 50 --agents 2000 --workers 95"] \
     --comment "Dopamint 1M-update benchmark"
   ```
4. Poll the command output until completion:
   ```bash
   COMMAND_ID=$(aws ssm list-command-invocations \
     --instance-id "$INSTANCE_ID" \
     --query 'CommandInvocations[0].CommandId' --output text)
   while true; do
     STATUS=$(aws ssm get-command-invocation \
       --command-id "$COMMAND_ID" \
       --instance-id "$INSTANCE_ID" \
       --query 'Status' --output text)
     echo "Status: $STATUS"
     [[ "$STATUS" == "Success" || "$STATUS" == "Failed" || "$STATUS" == "Cancelled" ]] && break
     sleep 10
   done
   aws ssm get-command-invocation \
     --command-id "$COMMAND_ID" \
     --instance-id "$INSTANCE_ID" \
     --query 'StandardOutputContent'
   ```

## Teardown

1. Scale the benchmark fleet to its configured minimum size (usually `0`) and wait for it to drain:
   ```bash
   aws autoscaling set-desired-capacity \
     --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
     --desired-capacity $(pulumi stack output benchmarkMinSize)
   aws autoscaling wait group-in-service \
     --auto-scaling-group-name $(pulumi stack output benchmarkAsgName)
   ```
2. Destroy the infrastructure:
   ```bash
   cd infra
   pulumi destroy -y
   ```
