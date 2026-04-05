import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const parseArgs = (argv = process.argv.slice(2)) => {
  const args = new Map<string, string | boolean>();

  for (const value of argv) {
    if (!value.startsWith("--")) {
      continue;
    }

    const normalized = value.slice(2);
    const separatorIndex = normalized.indexOf("=");

    if (separatorIndex === -1) {
      args.set(normalized, true);
      continue;
    }

    const key = normalized.slice(0, separatorIndex);
    const rawValue = normalized.slice(separatorIndex + 1);
    args.set(key, rawValue);
  }

  return args;
};

const originalEnvKeys = new Set(Object.keys(process.env));

const parseEnvLine = (line: string) => {
  const trimmed = line.trim();

  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }

  const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const separatorIndex = normalized.indexOf("=");

  if (separatorIndex === -1) {
    return null;
  }

  const key = normalized.slice(0, separatorIndex).trim();
  let value = normalized.slice(separatorIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    const commentIndex = value.indexOf(" #");

    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trim();
    }
  }

  return key.length > 0 ? { key, value } : null;
};

const loadEnvFile = async (
  filePath: string,
  { overrideLoadedValues }: { overrideLoadedValues: boolean },
) => {
  try {
    await access(filePath);
  } catch {
    return;
  }

  const contents = await readFile(filePath, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);

    if (!parsed) {
      continue;
    }

    if (originalEnvKeys.has(parsed.key)) {
      continue;
    }

    if (!overrideLoadedValues && process.env[parsed.key] !== undefined) {
      continue;
    }

    process.env[parsed.key] = parsed.value;
  }
};

const initializeEnv = async () => {
  const cwd = process.cwd();
  await loadEnvFile(path.join(cwd, ".env"), { overrideLoadedValues: false });
  await loadEnvFile(path.join(cwd, ".env.local"), { overrideLoadedValues: true });
};

await initializeEnv();

export const getStringArg = (
  args: ReadonlyMap<string, string | boolean>,
  key: string,
  fallback?: string,
) => {
  const value = args.get(key);

  if (typeof value === "string") {
    return value;
  }

  return fallback;
};

export const hasFlag = (args: ReadonlyMap<string, string | boolean>, key: string) =>
  args.get(key) === true;

export const getNumberArg = (
  args: ReadonlyMap<string, string | boolean>,
  key: string,
  fallback: number,
) => {
  const value = getStringArg(args, key);

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected --${key} to be a number, received "${value}".`);
  }

  return parsed;
};

export const requireEnv = (key: string) => {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
};

export const defaultTimestamp = () => new Date().toISOString().replaceAll(":", "-");

export const resolveFromCwd = (filePath: string) => path.resolve(process.cwd(), filePath);

export const ensureParentDirectory = async (filePath: string) => {
  await mkdir(path.dirname(resolveFromCwd(filePath)), { recursive: true });
};

export const writeJsonFile = async (filePath: string, value: unknown) => {
  await ensureParentDirectory(filePath);
  await writeFile(resolveFromCwd(filePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export const readJsonFile = async <T>(filePath: string) =>
  JSON.parse(await readFile(resolveFromCwd(filePath), "utf8")) as T;

export const sleep = async (ms: number) => {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const getHttpErrorStatus = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }

  const { status } = error;
  return typeof status === "number" ? status : null;
};

export const getLegacyClerkUserIdFromWorkosUser = (user: {
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
}) => {
  if (typeof user.externalId === "string" && user.externalId.length > 0) {
    return user.externalId;
  }

  const metadataClerkUserId = user.metadata?.clerkUserId;

  return typeof metadataClerkUserId === "string" && metadataClerkUserId.length > 0
    ? metadataClerkUserId
    : null;
};

export const printUsageAndExit = (usage: string) => {
  console.log(usage);
  process.exit(0);
};

export const parseJsonObjectFile = async (filePath: string) => {
  const parsed = await readJsonFile<unknown>(filePath);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected ${filePath} to contain a JSON object.`);
  }

  return parsed;
};

const parseCsvRow = (line: string) => {
  const values: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (insideQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }

      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
};

export const readCsvRecords = async (filePath: string) => {
  const contents = await readFile(resolveFromCwd(filePath), "utf8");
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const [headerLine, ...dataLines] = lines;
  const headers = parseCsvRow(headerLine);

  return dataLines.map((line) => {
    const values = parseCsvRow(line);

    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
};
