import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/utils/phone.js";
import { createId, isPermanentId } from "../src/utils/ids.js";

describe("phone normalization and permanent IDs", () => {
  it.each([
    ["+91 98765-43210", "919876543210"],
    ["09876543210", "919876543210"],
    ["(98765) 43210", "919876543210"],
    ["919876543210", "919876543210"]
  ])("normalizes Indian number %s", (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it("rejects invalid local numbers", () => expect(normalizePhone("12345")).toBeNull());

  it("creates sortable permanent identifiers", () => {
    const id = createId("contact");
    expect(id).toMatch(/^CNT_/);
    expect(isPermanentId(id, "contact")).toBe(true);
  });
});
