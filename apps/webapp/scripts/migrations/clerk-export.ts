import {
  defaultTimestamp,
  getNumberArg,
  getStringArg,
  hasFlag,
  parseArgs,
  printUsageAndExit,
  requireEnv,
  toErrorMessage,
  writeJsonFile,
} from "./lib.ts";
import type {
  ClerkExportedMembership,
  ClerkExportedOrganization,
  ClerkExportedUser,
  ClerkMigrationBundle,
} from "./types.ts";

type ClerkEmailAddress = {
  id: string;
  email_address: string;
  verification?: {
    status?: string;
  } | null;
};

type ClerkUserResponse = {
  id: string;
  external_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
  password_enabled?: boolean | null;
  created_at: number;
  updated_at: number;
  last_sign_in_at?: number | null;
};

type ClerkOrganizationResponse = {
  id: string;
  name: string;
  slug?: string | null;
  members_count?: number | null;
  created_at: number;
  updated_at: number;
};

type ClerkMembershipResponse = {
  id: string;
  organization?: {
    id?: string;
  } | null;
  public_user_data?: {
    user_id?: string;
  } | null;
  role?: string | null;
  created_at: number;
  updated_at: number;
};

type ClerkListResponse<T> = {
  data: T[];
  total_count?: number;
  totalCount?: number;
};

const usage = `Usage:
  node --experimental-strip-types ./scripts/migrations/clerk-export.ts [options]

Options:
  --out=PATH                  Output JSON path
  --include-organizations     Export organizations and memberships too
  --limit=NUMBER              Page size for Clerk API pagination (default: 100)
  --help                      Show this message

Environment:
  CLERK_SECRET_KEY            Required Clerk backend secret
  CLERK_API_URL               Optional, defaults to https://api.clerk.com/v1
`;

const args = parseArgs();

if (hasFlag(args, "help")) {
  printUsageAndExit(usage);
}

const clerkSecretKey = requireEnv("CLERK_SECRET_KEY");
const clerkApiUrl = process.env.CLERK_API_URL ?? "https://api.clerk.com/v1";
const limit = getNumberArg(args, "limit", 100);
const includeOrganizations = hasFlag(args, "include-organizations");
const outPath =
  getStringArg(args, "out") ?? `./tmp/clerk-export-${defaultTimestamp().replaceAll(".", "-")}.json`;

const requestClerk = async <T>(pathname: string, searchParams: URLSearchParams) => {
  const url = new URL(pathname, clerkApiUrl.endsWith("/") ? clerkApiUrl : `${clerkApiUrl}/`);

  for (const [key, value] of searchParams.entries()) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${clerkSecretKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Clerk request failed (${response.status}) for ${url.pathname}.`);
  }

  return (await response.json()) as T;
};

const getListData = <T>(response: ClerkListResponse<T> | T[]) => {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response.data)) {
    return response.data;
  }

  throw new Error("Unexpected Clerk list response shape.");
};

const paginateClerk = async <T>(pathname: string, extraParams?: Record<string, string>) => {
  const items: T[] = [];
  let offset = 0;

  while (true) {
    const searchParams = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      ...extraParams,
    });

    const response = await requestClerk<ClerkListResponse<T> | T[]>(pathname, searchParams);
    const pageItems = getListData(response);
    items.push(...pageItems);

    if (pageItems.length < limit) {
      break;
    }

    offset += pageItems.length;
  }

  return items;
};

const normalizeUser = (user: ClerkUserResponse): ClerkExportedUser => {
  const emailAddresses =
    user.email_addresses?.map((emailAddress) => ({
      id: emailAddress.id,
      email: emailAddress.email_address,
      verificationStatus: emailAddress.verification?.status ?? null,
    })) ?? [];
  const primaryEmailAddress =
    emailAddresses.find((emailAddress) => emailAddress.id === user.primary_email_address_id) ??
    emailAddresses[0] ??
    null;

  return {
    clerkUserId: user.id,
    externalId: user.external_id ?? null,
    primaryEmail: primaryEmailAddress?.email ?? null,
    primaryEmailAddressId: primaryEmailAddress?.id ?? user.primary_email_address_id ?? null,
    emailAddresses,
    secondaryEmails: emailAddresses
      .filter((emailAddress) => emailAddress.id !== primaryEmailAddress?.id)
      .map((emailAddress) => emailAddress.email),
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
    imageUrl: user.image_url ?? null,
    hasPassword: user.password_enabled ?? null,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastSignInAt: user.last_sign_in_at ?? null,
  };
};

const normalizeOrganization = (
  organization: ClerkOrganizationResponse,
): ClerkExportedOrganization => ({
  clerkOrganizationId: organization.id,
  name: organization.name,
  slug: organization.slug ?? null,
  membersCount: organization.members_count ?? null,
  createdAt: organization.created_at,
  updatedAt: organization.updated_at,
});

const normalizeMembership = (membership: ClerkMembershipResponse): ClerkExportedMembership => ({
  clerkMembershipId: membership.id,
  clerkOrganizationId: membership.organization?.id ?? "",
  clerkUserId: membership.public_user_data?.user_id ?? "",
  role: membership.role ?? null,
  createdAt: membership.created_at,
  updatedAt: membership.updated_at,
});

const main = async () => {
  console.log(`Exporting Clerk users from ${clerkApiUrl} ...`);
  const users = (
    await paginateClerk<ClerkUserResponse>("users", {
      order_by: "-created_at",
    })
  ).map(normalizeUser);

  const organizations: ClerkExportedOrganization[] = [];
  const memberships: ClerkExportedMembership[] = [];

  if (includeOrganizations) {
    console.log("Exporting Clerk organizations ...");
    const exportedOrganizations = (
      await paginateClerk<ClerkOrganizationResponse>("organizations", {
        order_by: "-created_at",
        include_members_count: "true",
      })
    ).map(normalizeOrganization);

    organizations.push(...exportedOrganizations);

    for (const organization of exportedOrganizations) {
      console.log(`Exporting memberships for ${organization.clerkOrganizationId} ...`);

      const organizationMemberships = (
        await paginateClerk<ClerkMembershipResponse>(
          `organizations/${organization.clerkOrganizationId}/memberships`,
        )
      )
        .map(normalizeMembership)
        .filter(
          (membership) =>
            membership.clerkOrganizationId.length > 0 && membership.clerkUserId.length > 0,
        );

      memberships.push(...organizationMemberships);
    }
  }

  const bundle: ClerkMigrationBundle = {
    generatedAt: new Date().toISOString(),
    source: "clerk",
    users,
    organizations,
    memberships,
  };

  await writeJsonFile(outPath, bundle);

  console.log(`Wrote ${users.length} users to ${outPath}`);

  if (includeOrganizations) {
    console.log(
      `Included ${organizations.length} organizations and ${memberships.length} memberships.`,
    );
  }
};

main().catch((error) => {
  console.error("Failed to export Clerk data:", toErrorMessage(error));
  process.exit(1);
});
