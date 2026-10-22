// Operator-only synthetic fixture for a private native Plasma session.
import readline from "node:readline";
import { createGptAccountLifecycle } from "./gpt-account-lifecycle.mjs";
const lifecycle = await createGptAccountLifecycle();
const input = readline.createInterface({ input: process.stdin });
process.once("SIGTERM", () => input.close());
let bridge;
try {
  await lifecycle.scan();
  bridge = await lifecycle.serve({ runtimeDirectory: process.env.XDG_RUNTIME_DIR });
  console.log("fixture-ready");
  for await (const line of input) {
    const command = JSON.parse(line);
    if (command.action === "login") await lifecycle.login();
    else if (command.action === "restart") {
      await bridge.close();
      await lifecycle.reload();
      bridge = await lifecycle.serve({ runtimeDirectory: process.env.XDG_RUNTIME_DIR });
    } else {
      lifecycle.setFailed(Boolean(command.failed));
      await lifecycle.scan();
    }
    console.log("fixture-updated");
  }
} finally { await bridge?.close(); await lifecycle.close(); }
