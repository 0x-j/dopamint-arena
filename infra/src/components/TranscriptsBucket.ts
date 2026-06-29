import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface TranscriptsBucketOutputs {
  bucketArn: pulumi.Output<string>;
  bucketName: pulumi.Output<string>;
}

// Private durable backup of settle transcripts (ADR-0023). Walrus stays the public
// verifier source; this bucket is private (no BucketPolicy), versioned, SSE-S3 encrypted.
export function createTranscriptsBucket(
  name: string,
): TranscriptsBucketOutputs {
  const bucket = new aws.s3.BucketV2(`${name}-transcripts`, {
    bucket: `${name}-transcripts`,
  });

  new aws.s3.BucketVersioningV2(`${name}-transcripts-versioning`, {
    bucket: bucket.id,
    versioningConfiguration: { status: "Enabled" },
  });

  new aws.s3.BucketPublicAccessBlock(`${name}-transcripts-public`, {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketServerSideEncryptionConfigurationV2(
    `${name}-transcripts-sse`,
    {
      bucket: bucket.id,
      rules: [
        {
          applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" },
        },
      ],
    },
  );

  return { bucketArn: bucket.arn, bucketName: bucket.bucket };
}
