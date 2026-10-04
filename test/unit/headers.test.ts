import { describe, expect, test } from "bun:test";
import { connectionCredentials, DEFAULT_BATCH_MS, DEFAULT_LOOKBACK_SEC, DEFAULT_POLL_MS, isHeaderError, MAX_LOOKBACK_SEC, parseConnectionHeaders, POLL_FLOOR_MS } from "../../src/headers.js";

const base = { "x-rocketr-url": "https://chat.example.com", "x-rocketr-user-id": "u1", "x-rocketr-token": "tok1" };

describe("parseConnectionHeaders", () => {
  test("the three required headers with no optional ones get compiled-in defaults", () => {
    const parsed = parseConnectionHeaders(base);
    expect(isHeaderError(parsed)).toBe(false);
    if (isHeaderError(parsed)) throw new Error("unreachable");
    expect(parsed).toEqual({
      url: "https://chat.example.com", userId: "u1", token: "tok1",
      notify: "mentions", batchMs: DEFAULT_BATCH_MS, pollMs: DEFAULT_POLL_MS, lookbackSec: DEFAULT_LOOKBACK_SEC,
    });
  });

  test("a trailing slash on the URL is stripped", () => {
    const parsed = parseConnectionHeaders({ ...base, "x-rocketr-url": "https://chat.example.com/" });
    expect(isHeaderError(parsed)).toBe(false);
    if (!isHeaderError(parsed)) expect(parsed.url).toBe("https://chat.example.com");
  });

  test.each(["x-rocketr-url", "x-rocketr-user-id", "x-rocketr-token"])("missing %s is a header error", (field) => {
    const headers = { ...base };
    delete (headers as Record<string, string>)[field];
    const parsed = parseConnectionHeaders(headers);
    expect(isHeaderError(parsed)).toBe(true);
    if (isHeaderError(parsed)) expect(parsed.field).toBe(field);
  });

  test("http:// is refused — https only", () => {
    const parsed = parseConnectionHeaders({ ...base, "x-rocketr-url": "http://chat.example.com" });
    expect(isHeaderError(parsed)).toBe(true);
  });

  test("an invalid x-rocketr-notify is a header error", () => {
    const parsed = parseConnectionHeaders({ ...base, "x-rocketr-notify": "everything" });
    expect(isHeaderError(parsed)).toBe(true);
  });

  test("x-rocketr-poll-ms below the floor is clamped UP to the floor, not refused", () => {
    const parsed = parseConnectionHeaders({ ...base, "x-rocketr-poll-ms": "1" });
    expect(isHeaderError(parsed)).toBe(false);
    if (!isHeaderError(parsed)) expect(parsed.pollMs).toBe(POLL_FLOOR_MS);
  });

  test("x-rocketr-lookback-sec is clamped to the max, not refused", () => {
    const parsed = parseConnectionHeaders({ ...base, "x-rocketr-lookback-sec": String(MAX_LOOKBACK_SEC * 10) });
    expect(isHeaderError(parsed)).toBe(false);
    if (!isHeaderError(parsed)) expect(parsed.lookbackSec).toBe(MAX_LOOKBACK_SEC);
  });

  test("x-rocketr-lookback-sec: 0 is accepted (today's no-replay behavior)", () => {
    const parsed = parseConnectionHeaders({ ...base, "x-rocketr-lookback-sec": "0" });
    expect(isHeaderError(parsed)).toBe(false);
    if (!isHeaderError(parsed)) expect(parsed.lookbackSec).toBe(0);
  });

  test("a negative or non-numeric batch/poll/lookback value is a header error", () => {
    expect(isHeaderError(parseConnectionHeaders({ ...base, "x-rocketr-batch-ms": "-1" }))).toBe(true);
    expect(isHeaderError(parseConnectionHeaders({ ...base, "x-rocketr-poll-ms": "nope" }))).toBe(true);
  });
});

describe("connectionCredentials", () => {
  test("normalizes the same way parseConnectionHeaders does, so the key always matches", () => {
    expect(connectionCredentials({ ...base, "x-rocketr-url": "https://chat.example.com/" })).toEqual({
      url: "https://chat.example.com", userId: "u1", token: "tok1",
    });
  });
});
