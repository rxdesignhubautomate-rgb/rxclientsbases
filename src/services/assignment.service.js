import { COLLECTIONS } from "../config/constants.js";
import { now } from "../utils/dates.js";

export class AssignmentService {
  constructor(store) {
    this.store = store;
  }

  async nextSalesUser(orgId) {
    const users = await this.store.find(COLLECTIONS.users, {
      filters: [["orgId", "==", orgId], ["role", "in", ["SALES", "SALES_MANAGER"]], ["active", "==", true]],
      orderBy: ["createdAt", "asc"],
      limit: 100
    });
    if (!users.items.length) return null;
    const key = `assignment_${orgId}`;
    return this.store.runTransaction(async (tx) => {
      const state = await tx.get(COLLECTIONS.systemSettings, key);
      const counter = Number(state?.counter || 0);
      const user = users.items[counter % users.items.length];
      tx.set(COLLECTIONS.systemSettings, key, {
        orgId,
        type: "ROUND_ROBIN_ASSIGNMENT",
        counter: counter + 1,
        lastAssignedUserId: user.userId || user.id,
        updatedAt: now()
      }, { merge: true });
      return user.userId || user.id;
    });
  }
}
