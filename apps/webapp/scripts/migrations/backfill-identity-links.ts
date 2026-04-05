import { api } from "@btca/convex/api";
import { WorkOS } from "@workos-inc/node";
import { ConvexHttpClient } from "convex/browser";
import {
  defaultTimestamp,
  getHttpErrorStatus,
  getLegacyClerkUserIdFromWorkosUser,
  getStringArg,
  hasFlag,
  parseArgs,
  printUsageAndExit,
  readJsonFile,
  requireEnv,
  toErrorMessage,
  writeJsonFile,
} from "./lib.ts";
import type {
  IdentityLinkBackfillReport,
  IdentityLinkRecord,
  WorkosImportReport,
} from "./types.ts";

const usage = `Usage:
  node --experimental-strip-types ./scripts/migrations/backfill-identity-links.ts [options]

Options:
  --from=PATH                 Read identity links from a WorkOS import report
  --workos-scan               Scan WorkOS users by externalId instead of reading a report
  --report=PATH               Output report path
  --dry-run                   Print what would happen without writing to Convex
  --help                      Show this message

Environment:
  PUBLIC_CONVEX_URL           Required Convex URL
  CONVEX_PRIVATE_BRIDGE_KEY   Required private bridge key
  WORKOS_API_KEY              Required when using --workos-scan
`;

const args = parseArgs();

if (hasFlag(args, "help")) {
  printUsageAndExit(usage);
}

const sourcePath = getStringArg(args, "from");
const shouldScanWorkos = hasFlag(args, "workos-scan");

if (!sourcePath && !shouldScanWorkos) {
  throw new Error("Pass either --from=PATH or --workos-scan.");
}

const convex = new ConvexHttpClient(requireEnv("PUBLIC_CONVEX_URL"));
const convexPrivateBridgeKey = requireEnv("CONVEX_PRIVATE_BRIDGE_KEY");
const dryRun = hasFlag(args, "dry-run");
const reportPath =
  getStringArg(args, "report") ??
  `./tmp/identity-link-backfill-${defaultTimestamp().replaceAll(".", "-")}.json`;

const loadIdentityLinks = async (): Promise<{
  source: IdentityLinkBackfillReport["source"];
  links: IdentityLinkRecord[];
}> => {
  if (sourcePath) {
    const report = await readJsonFile<WorkosImportReport>(sourcePath);
    return {
      source: "import-report",
      links: report.identityLinks,
    };
  }

  const workos = new WorkOS(requireEnv("WORKOS_API_KEY"));
  const links: IdentityLinkRecord[] = [];
  let after: string | undefined;

  while (true) {
    const users = await workos.userManagement.listUsers({
      ...(after ? { after } : {}),
      limit: 100,
    });

    for (const user of users.data) {
      const clerkUserId = getLegacyClerkUserIdFromWorkosUser(user);

      if (!clerkUserId) {
        continue;
      }

      links.push({
        clerkUserId,
        workosUserId: user.id,
        primaryEmail: user.email ?? null,
      });
    }

    const nextAfter = users.listMetadata.after ?? undefined;

    if (!nextAfter) {
      break;
    }

    after = nextAfter;
  }

  return {
    source: "workos-scan",
    links,
  };
};

const main = async () => {
  const { source, links } = await loadIdentityLinks();
  const report: IdentityLinkBackfillReport = {
    generatedAt: new Date().toISOString(),
    dryRun,
    source,
    attempted: links.length,
    upserted: 0,
    skipped: 0,
    errors: [],
  };

  for (const link of links) {
    if (!link.clerkUserId || !link.workosUserId) {
      report.skipped += 1;
      continue;
    }

    if (dryRun) {
      report.upserted += 1;
      continue;
    }

    try {
      await convex.mutation(api.private.identityLinks.upsert, {
        apiKey: convexPrivateBridgeKey,
        clerkUserId: link.clerkUserId,
        workosUserId: link.workosUserId,
        primaryEmail: link.primaryEmail ?? undefined,
        migrationSource: "manual",
        status: "linked",
      });

      report.upserted += 1;
    } catch (error) {
      if (getHttpErrorStatus(error) === 409) {
        report.skipped += 1;
        continue;
      }

      report.errors.push({
        clerkUserId: link.clerkUserId,
        workosUserId: link.workosUserId,
        message: toErrorMessage(error),
      });
    }
  }

  await writeJsonFile(reportPath, report);

  console.log(`Wrote identity-link backfill report to ${reportPath}`);
  console.log(
    `Identity links: attempted=${report.attempted} upserted=${report.upserted} skipped=${report.skipped}`,
  );

  if (report.errors.length > 0) {
    console.log(`Completed with ${report.errors.length} error(s).`);
  }
};

main().catch((error) => {
  console.error("Failed to backfill identity links:", toErrorMessage(error));
  process.exit(1);
});
