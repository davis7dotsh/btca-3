export interface ClerkExportedEmailAddress {
  id: string;
  email: string;
  verificationStatus: string | null;
}

export interface ClerkExportedUser {
  clerkUserId: string;
  externalId: string | null;
  primaryEmail: string | null;
  primaryEmailAddressId: string | null;
  emailAddresses: ClerkExportedEmailAddress[];
  secondaryEmails: string[];
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  imageUrl: string | null;
  hasPassword: boolean | null;
  createdAt: number;
  updatedAt: number;
  lastSignInAt: number | null;
}

export interface ClerkExportedOrganization {
  clerkOrganizationId: string;
  name: string;
  slug: string | null;
  membersCount: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClerkExportedMembership {
  clerkMembershipId: string;
  clerkOrganizationId: string;
  clerkUserId: string;
  role: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClerkMigrationBundle {
  generatedAt: string;
  source: "clerk";
  users: ClerkExportedUser[];
  organizations: ClerkExportedOrganization[];
  memberships: ClerkExportedMembership[];
}

export interface IdentityLinkRecord {
  clerkUserId: string;
  workosUserId: string;
  primaryEmail: string | null;
}

export interface WorkosImportReport {
  generatedAt: string;
  sourcePath: string;
  dryRun: boolean;
  importedUsers: number;
  existingUsers: number;
  skippedUsers: number;
  importedOrganizations: number;
  existingOrganizations: number;
  importedMemberships: number;
  existingMemberships: number;
  skippedMemberships: number;
  identityLinks: IdentityLinkRecord[];
  skipped: Array<{
    scope: "user" | "organization" | "membership";
    id: string;
    reason: string;
  }>;
  errors: Array<{
    scope: "user" | "organization" | "membership" | "identity-link";
    id: string;
    message: string;
  }>;
}

export interface IdentityLinkBackfillReport {
  generatedAt: string;
  dryRun: boolean;
  source: "import-report" | "workos-scan";
  attempted: number;
  upserted: number;
  skipped: number;
  errors: Array<{
    clerkUserId: string;
    workosUserId: string;
    message: string;
  }>;
}

export interface AutumnReconciliationReport {
  generatedAt: string;
  dryRun: boolean;
  source: "import-report" | "workos-scan";
  attempted: number;
  renamedCustomers: number;
  alreadyCanonical: number;
  missingLegacyCustomers: number;
  conflicts: number;
  skipped: Array<{
    clerkUserId: string;
    workosUserId: string;
    reason: string;
  }>;
  errors: Array<{
    clerkUserId: string;
    workosUserId: string;
    message: string;
  }>;
}
