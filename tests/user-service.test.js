import { describe, expect, it, vi } from "vitest";
import { UserService } from "../src/services/user.service.js";

describe("UserService.list", () => {
  it("avoids a composite-index orderBy and sorts the small user result in memory", async () => {
    const store = {
      find: vi.fn().mockResolvedValue({
        items: [
          { userId: "older", createdAt: new Date("2026-01-01T00:00:00Z") },
          { userId: "newer", createdAt: { _seconds: 1_800_000_000 } }
        ],
        pagination: { nextCursor: null, hasMore: false }
      })
    };
    const service = new UserService({ store, audit: {} });

    const result = await service.list("ORG_RX", { limit: 100 });

    expect(store.find).toHaveBeenCalledWith("users", {
      filters: [["orgId", "==", "ORG_RX"]],
      limit: 100,
      cursor: undefined,
      search: undefined,
      searchFields: ["name", "email", "phone", "role"]
    });
    expect(result.items.map((user) => user.userId)).toEqual(["newer", "older"]);
  });
});
