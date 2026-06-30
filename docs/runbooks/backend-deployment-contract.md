# Backend Deployment Contract

Version: 1.0  
Last updated: 2026-06-16

> **Implementation note:** The infrastructure code in `infra/src/components/Backend.ts` already conforms to this contract. Backend-team sign-off (Theodore/Daniel/Alvin) is tracked separately.

## Environment variables

- `DATABASE_URL` — `postgres://dopamint@<rds-proxy>:5432/dopamint` (password omitted; use `DATABASE_PASSWORD`).
- `DATABASE_PASSWORD` — injected via Secrets Manager.
- `REDIS_PUBSUB_URL` — `rediss://<cluster-config-endpoint>:6379`
- `REDIS_CACHE_URL` — `rediss://<cluster-config-endpoint>:6379`

## Port

The backend must listen on `0.0.0.0:8080`. The ALB target group and ECS health checks expect traffic on this port.

## Health endpoints

- `GET /health/live` — liveness, always returns 200 when the process is running.
- `GET /health/ready` — readiness, returns 200 only when DB and Redis connections are healthy; returns 503 during startup, shutdown, or dependency failures.

## Graceful shutdown

- On `SIGTERM` or `SIGINT`, stop accepting new connections, drain active requests within 25s (matching the ECS task `stopTimeout`), then close DB/Redis pools.

## Migrations

- Run as a one-off Fargate task using the same Docker image before the service update.
- Migrations must be idempotent and backward-compatible (expand/contract).
- Container entrypoint for migration task: `./scripts/migrate.sh`.
- If the migration task exits non-zero, the deployment must halt and the existing ECS service remains untouched. Migrations are not rolled back automatically.
