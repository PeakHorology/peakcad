import { spawn } from "node:child_process";

process.env.STATIC_EXPORT = "true";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: true, env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

await run("npx", ["next", "build", "apps/web"]);
await run("node", ["scripts/verify-static-worker-assets.mjs"]);
