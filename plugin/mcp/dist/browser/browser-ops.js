import { validateBrowserUrl, isLoopback } from "./browser-manager.js";
// Tool-case logic for browser operations: role enforcement, external-origin
// approval semantics, close-receipt capture and verify-time attestations.
export const INTERACTIVE_BROWSER_OPERATIONS = new Set(["click", "fill", "press", "upload"]);
const SHA256 = /^[0-9a-f]{64}$/u;
export async function browserRun(context) {
    const operation = String(context.command.operation ?? "");
    if (INTERACTIVE_BROWSER_OPERATIONS.has(operation) && context.registration?.role !== "executor") {
        throw new Error("Interactive browser actions require an orchestrator-authorized executor session");
    }
    let command = {
        ...context.command,
        operation: operation,
    };
    if (operation === "open" && typeof command.url === "string") {
        const target = validateBrowserUrl(command.url);
        const preApproved = process.env.ZCODE_CYCLE_BROWSER_ALLOWED_ORIGINS
            ?.split(",")
            .some((origin) => origin.trim() === target.origin);
        if (context.command.approve_origin !== true && !isLoopback(target) && !preApproved) {
            return { origin: target.origin, status: "origin-approval-required" };
        }
        command = { ...command, url: target.href };
    }
    const result = await context.manager.run(context.sessionId, command, async () => { });
    if (operation === "close" && typeof result === "object" && result !== null) {
        await context.registry.recordClose(context.sessionId, result).catch(() => undefined);
    }
    return result;
}
export async function attestForVerification(args, registry) {
    const sessionIds = Array.isArray(args.browser_session_ids)
        ? args.browser_session_ids.map(String)
        : [];
    if (sessionIds.length === 0)
        return [];
    const candidateDigest = typeof args.candidate_digest === "string" ? args.candidate_digest : "";
    if (!SHA256.test(candidateDigest)) {
        throw new Error("browser attestation requires the frozen candidate_digest from the freeze receipt");
    }
    return registry.attest(sessionIds, candidateDigest);
}
