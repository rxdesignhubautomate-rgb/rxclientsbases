import { getContainer } from "../container.js";

const flags = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
  const [key, ...rest] = arg.slice(2).split("=");
  return [key, rest.join("=")];
}));
if (!flags.email || !flags.password || !flags.name) {
  throw new Error("Usage: npm run seed:admin -- --email=owner@example.com --password=strong-password --name=Owner [--org-id=RXDH]");
}
const c = getContainer();
const orgId = flags["org-id"] || c.env.ORG_ID;
let firebaseUser;
try {
  firebaseUser = await c.auth.getUserByEmail(flags.email);
} catch (error) {
  if (error.code !== "auth/user-not-found") throw error;
  firebaseUser = await c.auth.createUser({ email: flags.email, password: flags.password, displayName: flags.name, emailVerified: false });
}
await c.auth.setCustomUserClaims(firebaseUser.uid, { orgId, role: "OWNER" });
const existing = await c.store.find("users", { filters: [["firebaseUid", "==", firebaseUser.uid]], limit: 1 });
const crmUser = existing.items[0] || await c.users.create(orgId, {
  firebaseUid: firebaseUser.uid,
  name: flags.name,
  email: flags.email,
  role: "OWNER",
  active: true,
  permissions: ["*"]
}, { userId: "BOOTSTRAP" });
console.log(JSON.stringify({ success: true, userId: crmUser.userId, firebaseUid: firebaseUser.uid, orgId }, null, 2));
