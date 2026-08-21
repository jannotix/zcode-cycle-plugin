import { LocalControlPlane } from "./client.js";
// One-shot control plane access for hook scripts: a separate process cannot
// reach the MCP server's in-memory state, so it speaks IPC directly.
const usage = "usage: cli.js audit < observation-json-on-stdin | cli.js health";
const plane = new LocalControlPlane({
    ...(process.env.ZCODE_CYCLE_BINARY ? { binaryPath: process.env.ZCODE_CYCLE_BINARY } : {}),
    ...(process.env.ZCODE_CYCLE_DATA_DIR ? { dataDirectory: process.env.ZCODE_CYCLE_DATA_DIR } : {}),
    stopOwnedProcessOnDispose: false,
});
function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
    });
}
async function run() {
    const [command] = process.argv.slice(2);
    if (command === "health") {
        process.stdout.write(`${JSON.stringify(await plane.health())}\n`);
        return;
    }
    if (command === "audit") {
        const observation = JSON.parse(await readStdin());
        const receipt = await plane.audit(observation);
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
        return;
    }
    throw new Error(usage);
}
run()
    .then(() => plane.dispose())
    .then(() => process.exit(0))
    .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
