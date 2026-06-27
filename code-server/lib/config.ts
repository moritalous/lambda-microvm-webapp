export const config = {
  region: 'us-east-1',
  stackName: 'LambdaMicrovmCodeServerStack',
  imageName: 'code-server-microvm',
  tableName: 'microvm-code-server-sessions',
  minimumMemoryInMiB: 2048,
  baseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
  imageDescription: 'code-server on Lambda MicroVM',
  artifactDir: 'artifact/base-image',
  edge: {
    tokenDurationMin: 60,
    tokenRefreshThreshold: 15,
    maxDurationSec: 28800,
    idleSec: 300,
    suspendedSec: 28800,
  },
} as const;

export const ingressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
export const egressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
