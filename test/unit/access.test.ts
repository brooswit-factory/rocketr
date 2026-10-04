import { describe, expect, test } from "bun:test";
import { allowAll } from "../../src/access.js";

describe("allowAll", () => {
  test("today's policy always allows", async () => {
    const decision = await allowAll({
      sourceIP: "203.0.113.5", headers: {}, targetUrl: "https://chat.example.com", credentialKeyHash: "abc", event: "connection",
    });
    expect(decision).toEqual({ allow: true });
  });
});
