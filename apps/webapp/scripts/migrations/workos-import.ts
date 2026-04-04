import { WorkOS } from "@workos-inc/node";
import {
  defaultTimestamp,
  getHttpErrorStatus,
  getNumberArg,
  getStringArg,
  hasFlag,
  parseArgs,
  parseJsonObjectFile,
  printUsageAndExit,
  readCsvRecords,
  readJsonFile,
  requireEnv,
  sleep,
  toErrorMessage,
  writeJsonFile,
} from "./lib.ts";
import type { ClerkMigrationBundle, WorkosImportReport } from "./types.ts";

const usage = `Usage:
  node --experimental-strip-types ./scripts/migrations/workos-import.ts --in=PATH [options]

Options:
  --in=PATH                   Required Clerk export bundle path
  --passwords=PATH            Optional password digest file (.csv or .json)
  --role-map=PATH             Optional JSON file mapping Clerk roles to WorkOS role slugs
  --report=PATH               Output report path
  --import-organizations      Create WorkOS organizations and memberships too
  --dry-run                   Print what would happen without creating records
  --rate-limit-ms=NUMBER      Delay between mutating WorkOS calls (default: 75)
  --help                      Show this message

Environment:
  WORKOS_API_KEY              Required WorkOS secret key
`;

const args = parseArgs();

if (hasFlag(args, "help")) {
  printUsageAndExit(usage);
}

const sourcePath = getStringArg(args, "in");

if (!sourcePath) {
  throw new Error("Missing required --in=PATH argument.");
}

const workos = new WorkOS(requireEnv("WORKOS_API_KEY"));
const dryRun = hasFlag(args, "dry-run");
const importOrganizations = hasFlag(args, "import-organizations");
const rateLimitMs = getNumberArg(args, "rate-limit-ms", 75);
const passwordPath = getStringArg(args, "passwords");
const roleMapPath = getStringArg(args, "role-map");
const reportPath =
  getStringArg(args, "report") ??
  sourcePath.replace(/\.json$/u, "") +
    `.workos-import-${defaultTimestamp().replaceAll(".", "-")}.json`;

const describeImportError = (error: unknown) => {
  const parts: string[] = [];
  const message = toErrorMessage(error);

  if (message.length > 0) {
    parts.push(message);
  }

  if (typeof error === "object" && error !== null) {
    const status = getHttpErrorStatus(error);

    if (status !== null) {
      parts.push(`status=${status}`);
    }

    const details =
      "rawData" in error
        ? error.rawData
        : "response" in error
          ? error.response
          : "data" in error
            ? error.data
            : null;

    if (details !== null && details !== undefined) {
      try {
        const normalized = typeof details === "string" ? details : JSON.stringify(details, null, 2);

        if (normalized.length > 0 && normalized !== message) {
          parts.push(normalized);
        }
      } catch {
        // Ignore secondary serialization issues and keep the primary message.
      }
    }
  }

  return parts.join(" | ");
};

const printImportErrors = (report: WorkosImportReport) => {
  if (report.errors.length === 0) {
    return;
  }

  console.error("Import errors:");

  for (const error of report.errors) {
    console.error(`- [${error.scope}] ${error.id}: ${error.message}`);
  }
};

const readPasswordDigests = async (filePath: string) => {
  if (filePath.endsWith(".json")) {
    const parsed = await readJsonFile<unknown>(filePath);

    if (Array.isArray(parsed)) {
      return new Map(
        parsed.flatMap((value) => {
          if (typeof value !== "object" || value === null) {
            return [];
          }

          const candidate = value as Record<string, unknown>;
          const clerkUserId =
            typeof candidate.user_id === "string"
              ? candidate.user_id
              : typeof candidate.id === "string"
                ? candidate.id
                : typeof candidate.clerkUserId === "string"
                  ? candidate.clerkUserId
                  : null;
          const passwordDigest =
            typeof candidate.password_digest === "string"
              ? candidate.password_digest
              : typeof candidate.passwordDigest === "string"
                ? candidate.passwordDigest
                : null;

          return clerkUserId && passwordDigest ? [[clerkUserId, passwordDigest] as const] : [];
        }),
      );
    }

    if (typeof parsed === "object" && parsed !== null) {
      return new Map(
        Object.entries(parsed).flatMap(([clerkUserId, passwordDigest]) =>
          typeof passwordDigest === "string" ? [[clerkUserId, passwordDigest] as const] : [],
        ),
      );
    }

    throw new Error(`Unsupported JSON password digest format in ${filePath}.`);
  }

  const rows = await readCsvRecords(filePath);

  return new Map(
    rows.flatMap((row) => {
      const clerkUserId = row.user_id || row.id || row.clerk_user_id || row.clerkUserId;
      const passwordDigest = row.password_digest || row.passwordDigest;

      return clerkUserId && passwordDigest ? [[clerkUserId, passwordDigest] as const] : [];
    }),
  );
};

const readRoleMap = async (filePath: string) => {
  const parsed = await parseJsonObjectFile(filePath);

  return new Map(
    Object.entries(parsed).flatMap(([clerkRole, workosRole]) => {
      if (typeof workosRole === "string") {
        return [[clerkRole, [workosRole]] as const];
      }

      if (Array.isArray(workosRole) && workosRole.every((value) => typeof value === "string")) {
        return [[clerkRole, workosRole] as const];
      }

      throw new Error(
        `Invalid role mapping for "${clerkRole}". Expected a string or string array.`,
      );
    }),
  );
};

const loadExistingMembershipUserIds = async (organizationId: string) => {
  const existingUserIds = new Set<string>();
  let after: string | undefined;

  while (true) {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      organizationId,
      ...(after ? { after } : {}),
      limit: 100,
    });

    for (const membership of memberships.data) {
      existingUserIds.add(membership.userId);
    }

    const nextAfter = memberships.listMetadata.after ?? undefined;

    if (!nextAfter) {
      break;
    }

    after = nextAfter;
  }

  return existingUserIds;
};

const main = async () => {
  const bundle = await readJsonFile<ClerkMigrationBundle>(sourcePath);
  const passwordDigests = passwordPath ? await readPasswordDigests(passwordPath) : new Map();
  const roleMap = roleMapPath ? await readRoleMap(roleMapPath) : new Map();
  const report: WorkosImportReport = {
    generatedAt: new Date().toISOString(),
    sourcePath,
    dryRun,
    importedUsers: 0,
    existingUsers: 0,
    skippedUsers: 0,
    importedOrganizations: 0,
    existingOrganizations: 0,
    importedMemberships: 0,
    existingMemberships: 0,
    skippedMemberships: 0,
    identityLinks: [],
    skipped: [],
    errors: [],
  };
  const importedUsers = new Map<string, string>();
  const importedOrganizations = new Map<string, string>();
  const membershipCache = new Map<string, Set<string>>();

  for (const user of bundle.users) {
    if (!user.primaryEmail) {
      report.skippedUsers += 1;
      report.skipped.push({
        scope: "user",
        id: user.clerkUserId,
        reason: "Missing primary email address.",
      });
      continue;
    }

    try {
      const existingUser = await workos.userManagement
        .getUserByExternalId(user.clerkUserId)
        .catch((error: unknown) => {
          if (getHttpErrorStatus(error) === 404) {
            return null;
          }

          throw error;
        });

      if (existingUser) {
        importedUsers.set(user.clerkUserId, existingUser.id);
        report.existingUsers += 1;
        report.identityLinks.push({
          clerkUserId: user.clerkUserId,
          workosUserId: existingUser.id,
          primaryEmail: existingUser.email ?? user.primaryEmail,
        });
        continue;
      }

      if (dryRun) {
        report.importedUsers += 1;
        report.identityLinks.push({
          clerkUserId: user.clerkUserId,
          workosUserId: `dry_run_${user.clerkUserId}`,
          primaryEmail: user.primaryEmail,
        });
        continue;
      }

      const createdUser = await workos.userManagement.createUser({
        email: user.primaryEmail,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        emailVerified:
          user.emailAddresses.find((emailAddress) => emailAddress.id === user.primaryEmailAddressId)
            ?.verificationStatus === "verified",
        externalId: user.clerkUserId,
        metadata: {
          clerkUserId: user.clerkUserId,
          migrationSource: "clerk",
          ...(user.secondaryEmails.length > 0
            ? { clerkSecondaryEmails: user.secondaryEmails.join("|") }
            : {}),
        },
        ...(passwordDigests.has(user.clerkUserId)
          ? {
              passwordHash: passwordDigests.get(user.clerkUserId)!,
              passwordHashType: "bcrypt" as const,
            }
          : {}),
      });

      importedUsers.set(user.clerkUserId, createdUser.id);
      report.importedUsers += 1;
      report.identityLinks.push({
        clerkUserId: user.clerkUserId,
        workosUserId: createdUser.id,
        primaryEmail: createdUser.email ?? user.primaryEmail,
      });

      await sleep(rateLimitMs);
    } catch (error) {
      report.errors.push({
        scope: "user",
        id: `${user.clerkUserId} (${user.primaryEmail})`,
        message: describeImportError(error),
      });
    }
  }

  if (importOrganizations) {
    for (const organization of bundle.organizations) {
      try {
        const existingOrganization = await workos.organizations
          .getOrganizationByExternalId(organization.clerkOrganizationId)
          .catch((error: unknown) => {
            if (getHttpErrorStatus(error) === 404) {
              return null;
            }

            throw error;
          });

        if (existingOrganization) {
          importedOrganizations.set(organization.clerkOrganizationId, existingOrganization.id);
          report.existingOrganizations += 1;
          continue;
        }

        if (dryRun) {
          importedOrganizations.set(
            organization.clerkOrganizationId,
            `dry_run_${organization.clerkOrganizationId}`,
          );
          report.importedOrganizations += 1;
          continue;
        }

        const createdOrganization = await workos.organizations.createOrganization({
          name: organization.name,
          externalId: organization.clerkOrganizationId,
          metadata: {
            clerkOrganizationId: organization.clerkOrganizationId,
            ...(organization.slug ? { clerkSlug: organization.slug } : {}),
          },
        });

        importedOrganizations.set(organization.clerkOrganizationId, createdOrganization.id);
        report.importedOrganizations += 1;

        await sleep(rateLimitMs);
      } catch (error) {
        report.errors.push({
          scope: "organization",
          id: organization.clerkOrganizationId,
          message: describeImportError(error),
        });
      }
    }

    for (const membership of bundle.memberships) {
      const workosOrganizationId = importedOrganizations.get(membership.clerkOrganizationId);
      const workosUserId = importedUsers.get(membership.clerkUserId);

      if (!workosOrganizationId) {
        report.skippedMemberships += 1;
        report.skipped.push({
          scope: "membership",
          id: membership.clerkMembershipId,
          reason: `Missing WorkOS organization for ${membership.clerkOrganizationId}.`,
        });
        continue;
      }

      if (!workosUserId) {
        report.skippedMemberships += 1;
        report.skipped.push({
          scope: "membership",
          id: membership.clerkMembershipId,
          reason: `Missing WorkOS user for ${membership.clerkUserId}.`,
        });
        continue;
      }

      try {
        if (!membershipCache.has(workosOrganizationId) && !dryRun) {
          membershipCache.set(
            workosOrganizationId,
            await loadExistingMembershipUserIds(workosOrganizationId),
          );
        }

        if (membershipCache.get(workosOrganizationId)?.has(workosUserId)) {
          report.existingMemberships += 1;
          continue;
        }

        const roleSlugs =
          membership.role && roleMap.has(membership.role) ? roleMap.get(membership.role)! : [];

        if (dryRun) {
          report.importedMemberships += 1;
          continue;
        }

        await workos.userManagement.createOrganizationMembership({
          organizationId: workosOrganizationId,
          userId: workosUserId,
          ...(roleSlugs.length > 0 ? { roleSlugs } : {}),
        });

        if (!membershipCache.has(workosOrganizationId)) {
          membershipCache.set(workosOrganizationId, new Set());
        }

        membershipCache.get(workosOrganizationId)!.add(workosUserId);
        report.importedMemberships += 1;

        await sleep(rateLimitMs);
      } catch (error) {
        report.errors.push({
          scope: "membership",
          id: membership.clerkMembershipId,
          message: describeImportError(error),
        });
      }
    }
  }

  await writeJsonFile(reportPath, report);

  console.log(`Wrote WorkOS import report to ${reportPath}`);
  console.log(
    `Users: imported=${report.importedUsers} existing=${report.existingUsers} skipped=${report.skippedUsers}`,
  );

  if (importOrganizations) {
    console.log(
      `Organizations: imported=${report.importedOrganizations} existing=${report.existingOrganizations}`,
    );
    console.log(
      `Memberships: imported=${report.importedMemberships} existing=${report.existingMemberships} skipped=${report.skippedMemberships}`,
    );
  }

  if (report.errors.length > 0) {
    printImportErrors(report);
    console.error(
      `Completed with ${report.errors.length} error(s). See ${reportPath} for details.`,
    );
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error("Failed to import users into WorkOS:", toErrorMessage(error));
  process.exit(1);
});
