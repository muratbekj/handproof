import { describe, expect, test } from "bun:test";
import { parseTokens } from "../src/prompts/args";

describe("parseTokens (PLAN Step 3)", () => {
  test('["accept"] → decision accept', () => {
    expect(parseTokens(["accept"])).toEqual({ decision: "accept", rest: "" });
  });

  test('["h_1", "Reject"] → id h_1 and decision reject', () => {
    expect(parseTokens(["h_1", "Reject"])).toEqual({ id: "h_1", decision: "reject", rest: "" });
  });

  test('["reject", "h_1"] → id h_1 and decision reject', () => {
    expect(parseTokens(["reject", "h_1"])).toEqual({ id: "h_1", decision: "reject", rest: "" });
  });

  test("[ undefined, undefined ] → rest empty", () => {
    expect(parseTokens([undefined, undefined])).toEqual({ rest: "" });
  });

  test('["add rate limiting"] → rest is the joined phrase', () => {
    expect(parseTokens(["add rate limiting"])).toEqual({ rest: "add rate limiting" });
  });

  test("first h_ token wins; second id goes to rest", () => {
    expect(parseTokens(["h_first", "h_second"])).toEqual({ id: "h_first", rest: "h_second" });
  });
});
