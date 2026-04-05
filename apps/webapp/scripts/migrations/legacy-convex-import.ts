import { api } from "@btca/convex/api";
import { ConvexHttpClient } from "convex/browser";
import {
  defaultTimestamp,
  getNumberArg,
  getStringArg,
  hasFlag,
  parseArgs,
  printUsageAndExit,
  requireEnv,
  sleep,
  toErrorMessage,
  writeJsonFile,
} from "./lib.ts";

const usage = `Usage:
  node --experimental-strip-types ./scripts/migrations/legacy-convex-import.ts [options]

Options:
  --mode=MODE                 resources | threads | all (default: all)
  --instance=ID               Only migrate one legacy instance
  --clerk-user-id=ID          Only migrate one Clerk user
  --limit=COUNT               Stop after this many instances
  --skip-global-resources     Skip copying active global resources into each user account
  --wait                      Poll until the workflow finishes
  --poll-ms=MS                Poll interval when --wait is set (default: 2000)
  --report=PATH               Output report path
  --dry-run                   Preview the migration without writing to Convex
  --help                      Show this message

Environment:
  PUBLIC_CONVEX_URL           Required Convex URL
  CONVEX_PRIVATE_BRIDGE_KEY   Required private bridge key
`;

const args = parseArgs();

if (hasFlag(args, "help")) {
  printUsageAndExit(usage);
}

const mode = getStringArg(args, "mode", "all");

if (mode !== "resources" && mode !== "threads" && mode !== "all") {
  throw new Error(`Expected --mode to be resources, threads, or all. Received "${mode}".`);
}

const convex = new ConvexHttpClient(requireEnv("PUBLIC_CONVEX_URL"));
const apiKey = requireEnv("CONVEX_PRIVATE_BRIDGE_KEY");
const dryRun = hasFlag(args, "dry-run");
const waitForCompletion = hasFlag(args, "wait");
const includeGlobalResources = !hasFlag(args, "skip-global-resources");
const pollMs = getNumberArg(args, "poll-ms", 2_000);
const reportPath =
  getStringArg(args, "report") ??
  `./tmp/legacy-convex-workflow-${defaultTimestamp().replaceAll(".", "-")}.json`;
const instanceId = getStringArg(args, "instance");
const clerkUserId = getStringArg(args, "clerk-user-id");
const limit = getStringArg(args, "limit") ? getNumberArg(args, "limit", 0) : undefined;

const main = async () => {
  const startedAt = new Date().toISOString();
  const startResult = await convex.mutation(api.private.migrations.start, {
    apiKey,
    mode,
    dryRun,
    includeGlobalResources,
    instanceId: instanceId ?? undefined,
    clerkUserId: clerkUserId ?? undefined,
    limit,
  });

  const initialReport = {
    generatedAt: startedAt,
    dryRun,
    mode,
    runId: `${startResult.runId}`,
    workflowId: `${startResult.workflowId}`,
    waitForCompletion,
    workflowStatus: {
      type: "inProgress" as const,
    },
  };

  if (!waitForCompletion) {
    await writeJsonFile(reportPath, initialReport);
    console.log(`Started legacy Convex migration workflow ${startResult.workflowId}`);
    console.log(`Run ID: ${startResult.runId}`);
    console.log(`Wrote starter report to ${reportPath}`);
    return;
  }

  while (true) {
    const status = await convex.query(api.private.migrations.status, {
      apiKey,
      runId: startResult.runId,
      workflowId: startResult.workflowId,
    });

    if (status.workflowStatus.type === "inProgress") {
      await sleep(pollMs);
      continue;
    }

    const report = {
      generatedAt: startedAt,
      completedAt: new Date().toISOString(),
      dryRun,
      mode,
      runId: `${startResult.runId}`,
      workflowId: `${startResult.workflowId}`,
      run: status.run,
      workflowStatus: status.workflowStatus,
    };

    await writeJsonFile(reportPath, report);

    console.log(
      `Workflow ${startResult.workflowId} finished with status ${status.workflowStatus.type}`,
    );
    console.log(`Wrote workflow report to ${reportPath}`);

    if (status.workflowStatus.type === "failed") {
      process.exitCode = 1;
    }

    return;
  }
};

main().catch((error) => {
  console.error("Failed to run legacy Convex migration workflow:", toErrorMessage(error));
  process.exit(1);
});
