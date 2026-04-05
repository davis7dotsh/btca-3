import { Autumn } from "autumn-js";
import { WorkOS } from "@workos-inc/node";
import {
  defaultTimestamp,
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
  AutumnReconciliationReport,
  IdentityLinkRecord,
  WorkosImportReport,
} from "./types.ts";

const usage = `Usage:
  node --experimental-strip-types ./scripts/migrations/reconcile-autumn-customers.ts [options]

Options:
  --from=PATH                 Read identity links from a WorkOS import report
  --workos-scan               Scan WorkOS users by externalId instead of reading a report
  --report=PATH               Output report path
  --dry-run                   Print what would happen without updating Autumn
  --help                      Show this message

Environment:
  AUTUMN_SECRET_KEY           Required Autumn secret key
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

const autumn = new Autumn({
  secretKey: requireEnv("AUTUMN_SECRET_KEY"),
});
const dryRun = hasFlag(args, "dry-run");
const reportPath =
  getStringArg(args, "report") ??
  `./tmp/autumn-reconciliation-${defaultTimestamp().replaceAll(".", "-")}.json`;

const loadIdentityLinks = async (): Promise<{
  source: AutumnReconciliationReport["source"];
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

const listCustomerBySearch = async (search: string) => {
  const response = await autumn.customers.list({
    search,
    limit: 25,
  });

  return response.list.filter((customer) => customer.id === search);
};

const main = async () => {
  const { source, links } = await loadIdentityLinks();
  const report: AutumnReconciliationReport = {
    generatedAt: new Date().toISOString(),
    dryRun,
    source,
    attempted: links.length,
    renamedCustomers: 0,
    alreadyCanonical: 0,
    missingLegacyCustomers: 0,
    conflicts: 0,
    skipped: [],
    errors: [],
  };

  for (const link of links) {
    try {
      const canonicalCustomers = await listCustomerBySearch(link.clerkUserId);
      const legacyCustomers = await listCustomerBySearch(link.workosUserId);

      const canonicalCustomer = canonicalCustomers[0] ?? null;
      const legacyCustomer = legacyCustomers[0] ?? null;

      if (canonicalCustomer && !legacyCustomer) {
        report.alreadyCanonical += 1;
        continue;
      }

      if (!canonicalCustomer && !legacyCustomer) {
        report.missingLegacyCustomers += 1;
        report.skipped.push({
          clerkUserId: link.clerkUserId,
          workosUserId: link.workosUserId,
          reason: "No Autumn customer found for either Clerk or WorkOS ID.",
        });
        continue;
      }

      if (canonicalCustomer && legacyCustomer) {
        report.conflicts += 1;
        report.skipped.push({
          clerkUserId: link.clerkUserId,
          workosUserId: link.workosUserId,
          reason:
            "Both Clerk-keyed and WorkOS-keyed Autumn customers exist. Manual review required.",
        });
        continue;
      }

      if (!legacyCustomer) {
        report.skipped.push({
          clerkUserId: link.clerkUserId,
          workosUserId: link.workosUserId,
          reason: "No WorkOS-keyed Autumn customer found to rename.",
        });
        continue;
      }

      if (dryRun) {
        report.renamedCustomers += 1;
        continue;
      }

      await autumn.customers.update({
        customerId: legacyCustomer.id,
        newCustomerId: link.clerkUserId,
        ...(link.primaryEmail ? { email: link.primaryEmail } : {}),
        metadata: {
          ...legacyCustomer.metadata,
          clerkUserId: link.clerkUserId,
          migratedFromWorkosUserId: link.workosUserId,
          migrationSource: "clerk_workos_reconciliation",
        },
      });

      report.renamedCustomers += 1;
    } catch (error) {
      report.errors.push({
        clerkUserId: link.clerkUserId,
        workosUserId: link.workosUserId,
        message: toErrorMessage(error),
      });
    }
  }

  await writeJsonFile(reportPath, report);

  console.log(`Wrote Autumn reconciliation report to ${reportPath}`);
  console.log(
    `Autumn customers: renamed=${report.renamedCustomers} alreadyCanonical=${report.alreadyCanonical} missing=${report.missingLegacyCustomers} conflicts=${report.conflicts}`,
  );

  if (report.skipped.length > 0) {
    console.log(`Skipped ${report.skipped.length} link(s).`);
  }

  if (report.errors.length > 0) {
    console.error("Autumn reconciliation errors:");

    for (const error of report.errors) {
      console.error(`- ${error.clerkUserId} <- ${error.workosUserId}: ${error.message}`);
    }

    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error("Failed to reconcile Autumn customers:", toErrorMessage(error));
  process.exit(1);
});
