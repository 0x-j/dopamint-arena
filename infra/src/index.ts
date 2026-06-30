import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { getConfig, resolveBackendImageTag } from "./config.js";
import { createNetwork } from "./components/Network.js";
import { createDns } from "./components/Dns.js";
import { createSecurityGroups } from "./resources/security-groups.js";
import { createAlb } from "./resources/alb.js";
import { createIam } from "./resources/iam.js";
import { createEcr } from "./resources/ecr.js";
import { createEcs } from "./resources/ecs.js";
import { createFrontend } from "./components/Frontend.js";
import { createDatabase } from "./components/Database.js";
import { createDatabaseProxy } from "./components/DatabaseProxy.js";
import { createCache } from "./components/Cache.js";
import { createTranscriptsBucket } from "./components/TranscriptsBucket.js";
import { createBackend } from "./components/Backend.js";
import { createBackendService } from "./components/BackendService.js";
import { createBackendAlias } from "./components/BackendAlias.js";
import { createMonitoring } from "./components/Monitoring.js";
import { createExplorerServices } from "./components/ExplorerServices.js";
import { githubEnvOutputs } from "./github.js";

const cfg = getConfig();
const backendImageTag: pulumi.Input<string> = cfg.backendImageTag
  ? pulumi.output(cfg.backendImageTag)
  : resolveBackendImageTag(cfg.environment);

const network = createNetwork(`dopamint-${cfg.environment}`);
const sgs = createSecurityGroups(`dopamint-${cfg.environment}`, network.vpcId);

const dns = createDns(`dopamint-${cfg.environment}`, {
  domain: cfg.domain,
  route53ZoneId: cfg.route53ZoneId,
  certificateArn: cfg.certificateArn,
});

const alb = createAlb(`dopamint-${cfg.environment}`, {
  vpcId: network.vpcId,
  subnetIds: network.publicSubnetIds,
  securityGroupId: sgs.alb.id,
  certificateArn: dns.certificateArn,
});

const frontend = createFrontend(`dopamint-${cfg.environment}`, {
  domain: cfg.domain,
  backendDomain: cfg.backendDomain,
  albDnsName: alb.alb.dnsName,
  certificateArn: dns.certificateArn,
  zoneId: dns.zoneId,
});

const database = createDatabase(`dopamint-${cfg.environment}`, {
  subnetIds: network.privateSubnetIds,
  securityGroupId: sgs.db.id,
  instanceClass: cfg.dbInstanceClass,
  serverless: cfg.dbServerless,
  minCapacity: cfg.dbMinCapacity,
  maxCapacity: cfg.dbMaxCapacity,
});

// Settler signing key: stored in Secrets Manager (sourced from secret config), never
// inlined into the task definition. Created only when the stack configures it.
let settlerKeySecretArn: pulumi.Output<string> | undefined;
if (cfg.settlerKey) {
  const settlerKeySecret = new aws.secretsmanager.Secret(
    `dopamint-${cfg.environment}-settler-key`,
    {
      description: `Sui settler signing key for dopamint-${cfg.environment}`,
    },
  );
  new aws.secretsmanager.SecretVersion(
    `dopamint-${cfg.environment}-settler-key-version`,
    {
      secretId: settlerKeySecret.id,
      secretString: cfg.settlerKey,
    },
  );
  settlerKeySecretArn = settlerKeySecret.arn;
}

const ecr = createEcr(`dopamint-${cfg.environment}`);
const ecs = createEcs(`dopamint-${cfg.environment}`);

const dbProxy = createDatabaseProxy(`dopamint-${cfg.environment}`, {
  subnetIds: network.privateSubnetIds,
  securityGroupId: sgs.db.id,
  dbClusterIdentifier: database.clusterIdentifier,
  secretArn: database.dbSecretArn,
});

// Full Postgres URL over the RDS Proxy, stored as a secret (password never in plaintext
// env). Injected into the explorer services via ECS `secrets` as DATABASE_URL.
const databaseUrlSecret = new aws.secretsmanager.Secret(
  `dopamint-${cfg.environment}-database-url`,
  {
    description: `Postgres DATABASE_URL (via RDS Proxy) for dopamint-${cfg.environment}`,
  },
);
new aws.secretsmanager.SecretVersion(
  `dopamint-${cfg.environment}-database-url-version`,
  {
    secretId: databaseUrlSecret.id,
    secretString: pulumi.interpolate`postgresql://dopamint:${database.dbPassword}@${dbProxy.proxyEndpoint}:5432/dopamint`,
  },
);

const cache = createCache(`dopamint-${cfg.environment}`, {
  subnetIds: network.privateSubnetIds,
  securityGroupId: sgs.cache.id,
  nodeType: cfg.cacheNodeType,
});

const transcriptsBucket = createTranscriptsBucket(
  `dopamint-${cfg.environment}`,
);

const iam = createIam(`dopamint-${cfg.environment}`, {
  githubOrg: "CommandOSSLabs",
  githubRepo: "dopamint-arena",
  taskExecSecretArns: [
    database.dbPasswordSecretArn,
    databaseUrlSecret.arn,
    ...(settlerKeySecretArn ? [settlerKeySecretArn] : []),
  ],
  taskRoleTranscriptsBucketArn: transcriptsBucket.bucketArn,
});

const backend = createBackend({
  name: `dopamint-${cfg.environment}`,
  repositoryUrl: ecr.repositoryUrl,
  imageTag: backendImageTag,
  pubSubEndpoint: cache.pubSubEndpoint,
  cacheEndpoint: cache.cacheEndpoint,
  taskExecutionRoleArn: iam.taskExecutionRole.arn,
  taskRoleArn: iam.taskRole.arn,
  logGroupName: ecs.logGroupName,
  settlerKeySecretArn,
  databaseUrlSecretArn: databaseUrlSecret.arn,
  s3TranscriptsBucket: transcriptsBucket.bucketName,
  ollamaEnabled: cfg.ollamaEnabled,
  ollamaModel: cfg.ollamaModel,
  ollamaImageTag: cfg.ollamaImageTag,
  corsAllowedOrigins: cfg.corsAllowedOrigins,
});

const backendService = createBackendService({
  name: `dopamint-${cfg.environment}`,
  clusterId: ecs.clusterArn,
  taskDefinitionArn: backend.taskDefinitionArn,
  targetGroupArn: alb.targetGroup.arn,
  securityGroupId: sgs.backend.id,
  subnetIds: network.privateSubnetIds,
  listener: alb.listener,
});

const explorer = createExplorerServices({
  name: `dopamint-${cfg.environment}`,
  clusterId: ecs.clusterArn,
  clusterName: ecs.clusterName,
  repositoryUrl: ecr.repositoryUrl,
  imageTag: backendImageTag,
  logGroupName: ecs.logGroupName,
  taskExecutionRoleArn: iam.taskExecutionRole.arn,
  taskRoleArn: iam.taskRole.arn,
  subnetIds: network.privateSubnetIds,
  securityGroupId: sgs.backend.id, // already allowed to DB proxy (5432) + Redis (6379)
  databaseUrlSecretArn: databaseUrlSecret.arn,
  pubSubEndpoint: cache.pubSubEndpoint,
  vpcId: network.vpcId,
  listener: alb.listener,
  corsAllowedOrigins: cfg.corsAllowedOrigins,
});

createBackendAlias({
  name: `dopamint-${cfg.environment}`,
  backendDomain: cfg.backendDomain,
  zoneId: dns.zoneId,
  albDnsName: alb.alb.dnsName,
  albHostedZoneId: alb.alb.zoneId,
});

createMonitoring({
  name: `dopamint-${cfg.environment}`,
  albArnSuffix: alb.alb.arnSuffix,
  targetGroupArnSuffix: alb.targetGroup.arnSuffix,
  clusterName: ecs.clusterName,
  serviceName: backendService.serviceName,
  dbClusterIdentifier: database.clusterIdentifier,
  logGroupName: ecs.logGroupName,
});

export const vpcId = network.vpcId;
export const privateSubnetIds = network.privateSubnetIds;
export const publicSubnetIds = network.publicSubnetIds;
export const certificateArn = dns.certificateArn;
export const albDnsName = alb.alb.dnsName;
export const albArnSuffix = alb.alb.arnSuffix;
export const githubDeployRoleArn = iam.githubDeployRoleArn;
export const frontendBucket = frontend.bucketName;
export const frontendDomain = frontend.distributionDomain;
export const cloudfrontId = frontend.distributionId;
export const dbProxyEndpoint = dbProxy.proxyEndpoint;
export const pubSubEndpoint = cache.pubSubEndpoint;
export const cacheEndpoint = cache.cacheEndpoint;
export const backendRepositoryUrl = ecr.repositoryUrl;
export const clusterName = ecs.clusterName;
export const backendLogGroup = ecs.logGroupName;
export const backendTaskDefinitionArn = backend.taskDefinitionArn;
export const migrationTaskDefinitionArn = backend.migrationTaskDefinitionArn;
export const backendServiceName = backendService.serviceName;
export const backendTargetGroupArn = alb.targetGroup.arn;
export const backendSecurityGroupId = sgs.backend.id;
export const dbClusterIdentifier = database.clusterIdentifier;
export const dbSubnetGroupName = database.dbSubnetGroupName;
export const dbSecurityGroupId = sgs.db.id;
export const dbProxyName = dbProxy.proxyName;

export const backendUrl = dns.certificateArn
  ? pulumi.interpolate`https://${cfg.backendDomain}`
  : pulumi.interpolate`http://${alb.alb.dnsName}`;

export const githubEnv = githubEnvOutputs({
  backendUrl,
  frontendDomain: frontend.distributionDomain,
  frontendBucket: frontend.bucketName,
  cloudfrontId: frontend.distributionId,
  ecrUrl: ecr.repositoryUrl,
  ecsCluster: ecs.clusterName,
  ecsService: backendService.serviceName,
  backendTaskDefFamily: backend.taskDefinition.family,
  githubDeployRoleArn: iam.githubDeployRoleArn,
  privateSubnetIds: network.privateSubnetIds,
  backendSecurityGroupId: sgs.backend.id,
});

export const indexerServiceName = explorer.indexerServiceName;
export const explorerApiServiceName = explorer.apiServiceName;
export const explorerApiTargetGroupArn = explorer.apiTargetGroupArn;
