import { describe, expect, it, vi } from "vitest";
import { parseMigrationArgs, runDocuments } from "../src/scripts/lib/migration-runner.js";

describe("migration runner", () => {
  it("parses all required safety flags", () => {
    expect(parseMigrationArgs(["--dry-run", "--limit=25", "--start-after=abc", "--org-id=TEST"])).toEqual({
      dryRun: true,
      limit: 25,
      startAfter: "abc",
      orgId: "TEST"
    });
  });

  it("dry run changes nothing", async () => {
    const handler = vi.fn();
    const stats = await runDocuments({ name: "test", documents: [{ id: "1" }], dryRun: true, handler });
    expect(handler).not.toHaveBeenCalled();
    expect(stats.migrated).toBe(1);
  });

  it("preserves idempotent skips", async () => {
    const stats = await runDocuments({
      name: "test",
      documents: [{ id: "1" }, { id: "2" }],
      dryRun: false,
      handler: async (doc) => ({ status: doc.id === "1" ? "migrated" : "skipped" })
    });
    expect(stats).toMatchObject({ migrated: 1, skipped: 1, failed: 0 });
  });
});
