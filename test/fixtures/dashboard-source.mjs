import { readFile } from "node:fs/promises";

// Match the dashboard's script dependencies for isolated VM rendering tests.
export async function readDashboardSource() {
  const sources = await Promise.all(["provider-colors.js", "connections.js", "usage-periods.js", "gpt-account-quota.js", "app.js"].map((file) =>
    readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")));
  return sources.join("\n");
}
