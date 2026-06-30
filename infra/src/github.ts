import * as pulumi from "@pulumi/pulumi";

export interface GithubEnvInputs {
  backendUrl: pulumi.Input<string>;
  frontendDomain: pulumi.Input<string>;
  frontendBucket: pulumi.Input<string>;
  cloudfrontId: pulumi.Input<string>;
  ecrUrl: pulumi.Input<string>;
  ecsCluster: pulumi.Input<string>;
  ecsService: pulumi.Input<string>;
  backendTaskDefFamily: pulumi.Input<string>;
  githubDeployRoleArn: pulumi.Input<string>;
  privateSubnetIds: pulumi.Input<string[]>;
  backendSecurityGroupId: pulumi.Input<string>;
}

export function githubEnvOutputs(
  inputs: GithubEnvInputs,
): Record<string, pulumi.Input<string>> {
  return {
    BACKEND_URL: inputs.backendUrl,
    FRONTEND_DOMAIN: inputs.frontendDomain,
    FRONTEND_BUCKET: inputs.frontendBucket,
    CLOUDFRONT_ID: inputs.cloudfrontId,
    ECR_URL: inputs.ecrUrl,
    ECS_CLUSTER: inputs.ecsCluster,
    ECS_SERVICE: inputs.ecsService,
    ECS_BACKEND_TASK_DEF: inputs.backendTaskDefFamily,
    AWS_DEPLOY_ROLE_ARN: inputs.githubDeployRoleArn,
    PRIVATE_SUBNET_IDS: pulumi
      .output(inputs.privateSubnetIds)
      .apply((ids) => ids.join(",")),
    BACKEND_SECURITY_GROUP_ID: inputs.backendSecurityGroupId,
  };
}
