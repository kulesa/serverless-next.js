import nodeFileTrace, { NodeFileTraceReasons } from "@zeit/node-file-trace";
import execa from "execa";
import fse from "fs-extra";
import { join } from "path";
import getAllFiles from "./lib/getAllFilesInDirectory";
import path from "path";
import { getSortedRoutes } from "./lib/sortedRoutes";
import {
  OriginRequestDefaultHandlerManifest,
  OriginRequestApiHandlerManifest,
  RoutesManifest
} from "../types";
import isDynamicRoute from "./lib/isDynamicRoute";
import pathToPosix from "./lib/pathToPosix";
import expressifyDynamicRoute from "./lib/expressifyDynamicRoute";
import pathToRegexStr from "./lib/pathToRegexStr";
import normalizeNodeModules from "./lib/normalizeNodeModules";
import createServerlessConfig from "./lib/createServerlessConfig";
import { isTrailingSlashRedirect } from "./routing/redirector";

export const DEFAULT_LAMBDA_CODE_DIR = "default-lambda";
export const API_LAMBDA_CODE_DIR = "api-lambda";

type BuildOptions = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cmd?: string;
  useServerlessTraceTarget?: boolean;
  logLambdaExecutionTimes?: boolean;
  handler?: string;
};

const defaultBuildOptions = {
  args: [],
  cwd: process.cwd(),
  env: {},
  cmd: "./node_modules/.bin/next",
  useServerlessTraceTarget: false,
  logLambdaExecutionTimes: false
};

class Builder {
  nextConfigDir: string;
  dotNextDir: string;
  serverlessDir: string;
  outputDir: string;
  buildOptions: BuildOptions = defaultBuildOptions;

  constructor(
    nextConfigDir: string,
    outputDir: string,
    buildOptions?: BuildOptions
  ) {
    this.nextConfigDir = path.resolve(nextConfigDir);
    this.dotNextDir = path.join(this.nextConfigDir, ".next");
    this.serverlessDir = path.join(this.dotNextDir, "serverless");
    this.outputDir = outputDir;
    if (buildOptions) {
      this.buildOptions = buildOptions;
    }
  }

  async readPublicFiles(): Promise<string[]> {
    const dirExists = await fse.pathExists(join(this.nextConfigDir, "public"));
    if (dirExists) {
      return getAllFiles(join(this.nextConfigDir, "public"))
        .map((e) => e.replace(this.nextConfigDir, ""))
        .map((e) => e.split(path.sep).slice(2).join("/"));
    } else {
      return [];
    }
  }

  async readPagesManifest(): Promise<{ [key: string]: string }> {
    const path = join(this.serverlessDir, "pages-manifest.json");
    const hasServerlessPageManifest = await fse.pathExists(path);

    if (!hasServerlessPageManifest) {
      return Promise.reject(
        "pages-manifest not found. Check if `next.config.js` target is set to 'serverless'"
      );
    }

    const pagesManifest = await fse.readJSON(path);
    const pagesManifestWithoutDynamicRoutes = Object.keys(pagesManifest).reduce(
      (acc: { [key: string]: string }, route: string) => {
        if (isDynamicRoute(route)) {
          return acc;
        }

        acc[route] = pagesManifest[route];
        return acc;
      },
      {}
    );

    const dynamicRoutedPages = Object.keys(pagesManifest).filter(
      isDynamicRoute
    );
    const sortedDynamicRoutedPages = getSortedRoutes(dynamicRoutedPages);
    const sortedPagesManifest = pagesManifestWithoutDynamicRoutes;

    sortedDynamicRoutedPages.forEach((route) => {
      sortedPagesManifest[route] = pagesManifest[route];
    });

    return sortedPagesManifest;
  }

  copyLambdaHandlerDependencies(
    fileList: string[],
    reasons: NodeFileTraceReasons,
    handlerDirectory: string
  ): Promise<void>[] {
    return fileList
      .filter((file) => {
        // exclude "initial" files from lambda artefact. These are just the pages themselves
        // which are copied over separately
        return (
          (!reasons[file] || reasons[file].type !== "initial") &&
          file !== "package.json"
        );
      })
      .map((filePath: string) => {
        const resolvedFilePath = path.resolve(filePath);
        const dst = normalizeNodeModules(
          path.relative(this.serverlessDir, resolvedFilePath)
        );

        return fse.copy(
          resolvedFilePath,
          join(this.outputDir, handlerDirectory, dst)
        );
      });
  }

  /**
   * Check whether this .next/serverless/pages file is a JS file used only for prerendering at build time.
   * @param prerenderManifest
   * @param relativePageFile
   */
  isPrerenderedJSFile(
    prerenderManifest: any,
    relativePageFile: string
  ): boolean {
    if (path.extname(relativePageFile) === ".js") {
      // Page route is without .js extension
      let pageRoute = relativePageFile.slice(0, -3);

      // Prepend "/"
      pageRoute = pageRoute.startsWith("/") ? pageRoute : `/${pageRoute}`;

      // Normalise index route
      pageRoute = pageRoute === "/index" ? "/" : pageRoute;

      return (
        !!prerenderManifest.routes && !!prerenderManifest.routes[pageRoute]
      );
    }

    return false;
  }

  /**
   * Process and copy RoutesManifest.
   * @param source
   * @param destination
   */
  async processAndCopyRoutesManifest(source: string, destination: string) {
    const routesManifest = require(source) as RoutesManifest;

    // Remove default trailing slash redirects as they are already handled without regex matching.
    routesManifest.redirects = routesManifest.redirects.filter((redirect) => {
      return !isTrailingSlashRedirect(redirect, routesManifest.basePath);
    });

    await fse.writeFile(destination, JSON.stringify(routesManifest));
  }

  async buildDefaultLambda(
    buildManifest: OriginRequestDefaultHandlerManifest
  ): Promise<void[]> {
    let copyTraces: Promise<void>[] = [];

    if (this.buildOptions.useServerlessTraceTarget) {
      const ignoreAppAndDocumentPages = (page: string): boolean => {
        const basename = path.basename(page);
        return basename !== "_app.js" && basename !== "_document.js";
      };

      const allSsrPages = [
        ...Object.values(buildManifest.pages.ssr.nonDynamic),
        ...Object.values(buildManifest.pages.ssr.dynamic).map(
          (entry) => entry.file
        )
      ].filter(ignoreAppAndDocumentPages);

      const ssrPages = Object.values(allSsrPages).map((pageFile) =>
        path.join(this.serverlessDir, pageFile)
      );

      const { fileList, reasons } = await nodeFileTrace(ssrPages, {
        base: process.cwd()
      });

      copyTraces = this.copyLambdaHandlerDependencies(
        fileList,
        reasons,
        DEFAULT_LAMBDA_CODE_DIR
      );
    }

    let prerenderManifest = require(join(
      this.dotNextDir,
      "prerender-manifest.json"
    ));

    const hasAPIRoutes = await fse.pathExists(
      join(this.serverlessDir, "pages/api")
    );

    return Promise.all([
      ...copyTraces,
      this.buildOptions?.handler
        ? fse.copy(
            join(this.nextConfigDir, this.buildOptions.handler),
            join(
              this.outputDir,
              DEFAULT_LAMBDA_CODE_DIR,
              this.buildOptions.handler
            )
          )
        : Promise.resolve(),
      fse.copy(
        require.resolve("@sls-next/lambda-at-edge/dist/default-handler.js"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "index.js")
      ),
      fse.writeJson(
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "manifest.json"),
        buildManifest
      ),
      fse.copy(
        join(this.serverlessDir, "pages"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "pages"),
        {
          filter: (file: string) => {
            const isNotPrerenderedHTMLPage = path.extname(file) !== ".html";
            const isNotStaticPropsJSONFile = path.extname(file) !== ".json";
            const isNotApiPage = pathToPosix(file).indexOf("pages/api") === -1;

            // If there are API routes, include all JS files.
            // If there are no API routes, exclude all JS files that used only for prerendering at build time.
            // We do this because if there are API routes, preview mode is possible which may use these JS files.
            // This is what Vercel does: https://github.com/vercel/next.js/discussions/15631#discussioncomment-44289
            // TODO: possibly optimize bundle further for those apps using API routes.
            const isNotExcludedJSFile =
              hasAPIRoutes ||
              !this.isPrerenderedJSFile(
                prerenderManifest,
                path.relative(join(this.serverlessDir, "pages"), file)
              );

            return (
              isNotApiPage &&
              isNotPrerenderedHTMLPage &&
              isNotStaticPropsJSONFile &&
              isNotExcludedJSFile
            );
          }
        }
      ),
      fse.copy(
        join(this.dotNextDir, "prerender-manifest.json"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "prerender-manifest.json")
      ),
      this.processAndCopyRoutesManifest(
        join(this.dotNextDir, "routes-manifest.json"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "routes-manifest.json")
      )
    ]);
  }

  async buildApiLambda(
    apiBuildManifest: OriginRequestApiHandlerManifest
  ): Promise<void[]> {
    let copyTraces: Promise<void>[] = [];

    if (this.buildOptions.useServerlessTraceTarget) {
      const allApiPages = [
        ...Object.values(apiBuildManifest.apis.nonDynamic),
        ...Object.values(apiBuildManifest.apis.dynamic).map(
          (entry) => entry.file
        )
      ];

      const apiPages = Object.values(allApiPages).map((pageFile) =>
        path.join(this.serverlessDir, pageFile)
      );

      const { fileList, reasons } = await nodeFileTrace(apiPages, {
        base: process.cwd()
      });

      copyTraces = this.copyLambdaHandlerDependencies(
        fileList,
        reasons,
        API_LAMBDA_CODE_DIR
      );
    }

    return Promise.all([
      ...copyTraces,
      this.buildOptions?.handler
        ? fse.copy(
            join(this.nextConfigDir, this.buildOptions.handler),
            join(
              this.outputDir,
              API_LAMBDA_CODE_DIR,
              this.buildOptions.handler
            )
          )
        : Promise.resolve(),
      fse.copy(
        require.resolve("@sls-next/lambda-at-edge/dist/api-handler.js"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "index.js")
      ),
      fse.copy(
        join(this.serverlessDir, "pages/api"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "pages/api")
      ),
      fse.writeJson(
        join(this.outputDir, API_LAMBDA_CODE_DIR, "manifest.json"),
        apiBuildManifest
      ),
      fse.copy(
        join(this.dotNextDir, "routes-manifest.json"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "routes-manifest.json")
      )
    ]);
  }

  async prepareBuildManifests(): Promise<{
    defaultBuildManifest: OriginRequestDefaultHandlerManifest;
    apiBuildManifest: OriginRequestApiHandlerManifest;
  }> {
    const pagesManifest = await this.readPagesManifest();

    const buildId = await fse.readFile(
      path.join(this.dotNextDir, "BUILD_ID"),
      "utf-8"
    );
    const { logLambdaExecutionTimes = false } = this.buildOptions;

    const defaultBuildManifest: OriginRequestDefaultHandlerManifest = {
      buildId,
      logLambdaExecutionTimes,
      pages: {
        ssr: {
          dynamic: {},
          nonDynamic: {}
        },
        html: {
          dynamic: {},
          nonDynamic: {}
        }
      },
      publicFiles: {},
      trailingSlash: false
    };

    const apiBuildManifest: OriginRequestApiHandlerManifest = {
      apis: {
        dynamic: {},
        nonDynamic: {}
      }
    };

    const ssrPages = defaultBuildManifest.pages.ssr;
    const htmlPages = defaultBuildManifest.pages.html;
    const apiPages = apiBuildManifest.apis;

    const isHtmlPage = (path: string): boolean => path.endsWith(".html");
    const isApiPage = (path: string): boolean => path.startsWith("pages/api");

    Object.entries(pagesManifest).forEach(([route, pageFile]) => {
      const dynamicRoute = isDynamicRoute(route);
      const expressRoute = dynamicRoute ? expressifyDynamicRoute(route) : null;

      if (isHtmlPage(pageFile)) {
        if (dynamicRoute) {
          const route = expressRoute as string;
          htmlPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
        } else {
          htmlPages.nonDynamic[route] = pageFile;
        }
      } else if (isApiPage(pageFile)) {
        if (dynamicRoute) {
          const route = expressRoute as string;
          apiPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
        } else {
          apiPages.nonDynamic[route] = pageFile;
        }
      } else if (dynamicRoute) {
        const route = expressRoute as string;
        ssrPages.dynamic[route] = {
          file: pageFile,
          regex: pathToRegexStr(route)
        };
      } else {
        ssrPages.nonDynamic[route] = pageFile;
      }
    });

    const publicFiles = await this.readPublicFiles();

    publicFiles.forEach((pf) => {
      defaultBuildManifest.publicFiles["/" + pf] = pf;
    });

    // Read next.config.js
    const nextConfigPath = path.join(this.nextConfigDir, "next.config.js");

    if (await fse.pathExists(nextConfigPath)) {
      const nextConfig = await require(nextConfigPath);

      let normalisedNextConfig;
      if (typeof nextConfig === "object") {
        normalisedNextConfig = nextConfig;
      } else if (typeof nextConfig === "function") {
        // Execute using phase based on: https://github.com/vercel/next.js/blob/8a489e24bcb6141ad706e1527b77f3ff38940b6d/packages/next/next-server/lib/constants.ts#L1-L4
        normalisedNextConfig = nextConfig("phase-production-server", {});
      }

      // Support trailing slash: https://nextjs.org/docs/api-reference/next.config.js/trailing-slash
      defaultBuildManifest.trailingSlash =
        normalisedNextConfig?.trailingSlash ?? false;
    }

    return {
      defaultBuildManifest,
      apiBuildManifest
    };
  }

  async cleanupDotNext(): Promise<void> {
    const exists = await fse.pathExists(this.dotNextDir);

    if (exists) {
      const fileItems = await fse.readdir(this.dotNextDir);

      await Promise.all(
        fileItems
          .filter(
            (fileItem) => fileItem !== "cache" // avoid deleting the cache folder as that leads to slow next builds!
          )
          .map((fileItem) => fse.remove(join(this.dotNextDir, fileItem)))
      );
    }
  }

  async build(debugMode: boolean): Promise<void> {
    const { cmd, args, cwd, env, useServerlessTraceTarget } = Object.assign(
      defaultBuildOptions,
      this.buildOptions
    );

    await this.cleanupDotNext();

    await fse.emptyDir(join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR));
    await fse.emptyDir(join(this.outputDir, API_LAMBDA_CODE_DIR));

    const { restoreUserConfig } = await createServerlessConfig(
      cwd,
      path.join(this.nextConfigDir),
      useServerlessTraceTarget
    );

    try {
      const subprocess = execa(cmd, args, {
        cwd,
        env
      });

      if (debugMode) {
        // @ts-ignore
        subprocess.stdout.pipe(process.stdout);
      }

      await subprocess;
    } finally {
      await restoreUserConfig();
    }

    const {
      defaultBuildManifest,
      apiBuildManifest
    } = await this.prepareBuildManifests();

    await this.buildDefaultLambda(defaultBuildManifest);

    const hasAPIPages =
      Object.keys(apiBuildManifest.apis.nonDynamic).length > 0 ||
      Object.keys(apiBuildManifest.apis.dynamic).length > 0;

    if (hasAPIPages) {
      await this.buildApiLambda(apiBuildManifest);
    }
  }
}

export default Builder;
