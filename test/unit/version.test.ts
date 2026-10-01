import { describe, expect, test } from "bun:test";
import { VERSION } from "../../src/app.js";
import pkg from "../../package.json";

describe("version", () => {
  test("package.json version matches VERSION in src/app.ts", () => {
    expect(pkg.version).toBe(VERSION);
  });
});
