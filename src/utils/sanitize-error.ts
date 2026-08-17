const REDACTED_URL = "[redacted-url]";
const REDACTED_VALUE = "REDACTED";

export function sanitizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : typeof error === "string" && error.trim().length > 0
        ? error.trim()
        : "unknown error";

  return raw
    .replace(/\b(?:wss?|https?):\/\/\S+/gi, REDACTED_URL)
    .replace(
      /\b(token|secret|api[_-]?key|signature|sig|authorization|auth|password|passwd|key)=\S+/gi,
      (_match, prefix: string) => `${prefix}=${REDACTED_VALUE}`,
    )
    .replace(/\s+/g, " ")
    .slice(0, 200);
}
