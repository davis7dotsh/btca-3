const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readMessage = (value: unknown) =>
  isRecord(value) && typeof value.message === "string" && value.message.trim().length > 0
    ? value.message
    : null;

export const getHumanErrorMessage = (error: unknown, fallback: string) => {
  const nestedMessage =
    (isRecord(error) ? (readMessage(error.body) ?? readMessage(error.data)) : null) ?? null;

  if (nestedMessage) {
    return nestedMessage;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  const directMessage = readMessage(error);

  if (directMessage) {
    return directMessage;
  }

  return fallback;
};
