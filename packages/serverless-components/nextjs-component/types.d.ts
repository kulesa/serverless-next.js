import { PublicDirectoryCache } from "@sls-next/s3-static-assets/src/lib/getPublicAssetCacheControl";

export type ServerlessComponentInputs = {
  build?: BuildOptions | boolean;
  nextConfigDir?: string;
  useServerlessTraceTarget?: boolean;
  logLambdaExecutionTimes?: boolean;
  nextStaticDir?: string;
  bucketName?: string;
  bucketRegion?: string;
  publicDirectoryCache?: PublicDirectoryCache;
  memory?: number | { defaultLambda?: number; apiLambda?: number };
  timeout?: number | { defaultLambda?: number; apiLambda?: number };
  name?: string | { defaultLambda?: string; apiLambda?: string };
  runtime?: string | { defaultLambda?: string; apiLambda?: string };
  handler?: string;
  description?: string;
  policy?: string;
  domain?: string | string[];
  domainType?: "www" | "apex" | "both";
  cloudfront?: CloudfrontOptions;
};

type CloudfrontOptions = Record<string, any>;

export type BuildOptions = {
  cwd?: string;
  enabled?: boolean;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
};

export type LambdaType = "defaultLambda" | "apiLambda";

export type LambdaInput = {
  description: string;
  handler: string;
  code: string;
  role: Record<string, unknown>;
  memory: number;
  timeout: number;
  runtime: string;
  name?: string;
};
