const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readMessage = (value: unknown) =>
  isRecord(value) && typeof value.message === "string" && value.message.trim().length > 0
    ? value.message
    : null;

const cleanMessage = (value: string) => {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const serverErrorLine = lines.find((line) => line.includes("Server Error Uncaught Error:"));

  if (serverErrorLine) {
    return serverErrorLine.replace(/^.*Server Error Uncaught Error:\s*/, "").trim();
  }

  const requestIndex = lines.findIndex((line) => line.startsWith("[Request ID:"));

  if (requestIndex > 0) {
    return lines.slice(0, requestIndex).join(" ").trim();
  }

  return value.trim();
};

export const getHumanErrorMessage = (error: unknown, fallback: string) => {
  const nestedMessage =
    (isRecord(error) ? (readMessage(error.body) ?? readMessage(error.data)) : null) ?? null;

  if (nestedMessage) {
    return cleanMessage(nestedMessage);
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return cleanMessage(error);
  }

  const directMessage = readMessage(error);

  if (directMessage) {
    return cleanMessage(directMessage);
  }

  return fallback;
};
