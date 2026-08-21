import { isIP } from "node:net";
export const BROWSER_OPERATIONS = [
    "open",
    "snapshot",
    "click",
    "fill",
    "press",
    "upload",
    "check",
    "screenshot",
    "logs",
    "close",
];
export class BrowserManager {
    #allowedOrigins;
    #artifactDirectory;
    #factory;
    #maximum;
    #sessions = new Map();
    constructor(options) {
        if (!Number.isInteger(options.maxSessions) || options.maxSessions < 1 || options.maxSessions > 8) {
            throw new Error("Browser session limit must be between 1 and 8");
        }
        this.#maximum = options.maxSessions;
        this.#artifactDirectory = options.artifactDirectory;
        this.#factory = options;
        this.#allowedOrigins = new Set((options.allowedOrigins ?? []).map((value) => validateBrowserUrl(value).origin));
    }
    async run(sessionId, command, approveExternalOrigin) {
        if (command.operation === "close") {
            const state = this.#sessions.get(sessionId);
            if (state === undefined)
                return { status: "not_started" };
            this.#sessions.delete(sessionId);
            return state.browser.close();
        }
        let approvedOrigin;
        if (command.operation === "open") {
            const target = validateBrowserUrl(required(command.url, "Browser open requires url"));
            command = { ...command, url: target.href };
            const state = this.#sessions.get(sessionId);
            if (!isLoopback(target) &&
                !this.#allowedOrigins.has(target.origin) &&
                !state?.approvedOrigins.has(target.origin)) {
                await approveExternalOrigin(target.origin);
                approvedOrigin = target.origin;
            }
        }
        const state = await this.#session(sessionId);
        if (approvedOrigin !== undefined) {
            state.approvedOrigins.add(approvedOrigin);
            state.browser.allowOrigin(approvedOrigin);
        }
        return state.browser.run(command);
    }
    async dispose() {
        const sessions = [...this.#sessions.values()];
        this.#sessions.clear();
        await Promise.allSettled(sessions.map((state) => state.browser.close()));
    }
    async #session(sessionId) {
        const current = this.#sessions.get(sessionId);
        if (current !== undefined)
            return current;
        if (this.#sessions.size >= this.#maximum) {
            throw new Error("Managed browser session limit reached; close an idle browser session");
        }
        const browser = await this.#factory.create({
            allowedOrigins: this.#allowedOrigins,
            artifactDirectory: this.#artifactDirectory,
            sessionId,
        });
        const state = { approvedOrigins: new Set(), browser };
        this.#sessions.set(sessionId, state);
        return state;
    }
}
export function validateBrowserUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch (cause) {
        throw new Error("Browser URL is invalid", { cause });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Browser navigation supports HTTP or HTTPS only");
    }
    if (url.username || url.password)
        throw new Error("Browser URLs must not contain credentials");
    return url;
}
export function isLoopback(url) {
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1")
        return true;
    return isIP(hostname) === 4 && hostname.startsWith("127.");
}
function required(value, message) {
    if (value === undefined)
        throw new Error(message);
    return value;
}
