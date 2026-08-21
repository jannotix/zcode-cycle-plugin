import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
export class BrowserEvidenceRegistry {
    #artifactDirectory;
    #records = new Map();
    constructor(artifactDirectory) {
        this.#artifactDirectory = resolve(artifactDirectory);
    }
    async recordClose(sessionId, value) {
        const result = parseCloseReceipt(value);
        const receiptJson = await this.#readContained(result.receiptPath);
        if (digest(receiptJson) !== result.receiptDigest) {
            throw new Error("Managed browser receipt digest does not match its persisted bytes");
        }
        this.#records.set(sessionId, {
            invalidated: false,
            receiptDigest: result.receiptDigest,
            receiptJson,
        });
    }
    invalidate(sessionId) {
        const record = this.#records.get(sessionId);
        if (record !== undefined)
            this.#records.set(sessionId, { ...record, invalidated: true });
    }
    forget(sessionId) {
        this.#records.delete(sessionId);
    }
    async attest(sessionIds, candidateDigest) {
        if (!SHA256.test(candidateDigest))
            throw new Error("Candidate digest is invalid");
        const attestations = [];
        for (const sessionId of [...new Set(sessionIds)]) {
            if (!sessionId || sessionId.length > 256)
                continue;
            const current = this.#records.get(sessionId);
            if (current?.invalidated === true)
                continue;
            const records = current === undefined ? await this.#discover(sessionId) : [current];
            for (const record of records) {
                if (attestations.length === 32)
                    return attestations;
                attestations.push({
                    candidate_digest: candidateDigest,
                    receipt_digest: record.receiptDigest,
                    receipt_json: record.receiptJson,
                    session_id: sessionId,
                });
            }
        }
        return attestations;
    }
    async #discover(sessionId) {
        const identity = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
        const directory = join(this.#artifactDirectory, "evidence", identity);
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch (error) {
            if (isMissing(error))
                return [];
            throw error;
        }
        const records = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name))
                continue;
            try {
                const receiptJson = await this.#readContained(join(directory, entry.name, "session.json"));
                records.push({ invalidated: false, receiptDigest: digest(receiptJson), receiptJson });
            }
            catch (error) {
                if (!isMissing(error))
                    throw error;
            }
        }
        return records;
    }
    async #readContained(path) {
        const root = await realpath(join(this.#artifactDirectory, "evidence"));
        const resolved = await realpath(path);
        const scoped = relative(root, resolved);
        if (!scoped || isAbsolute(scoped) || scoped === ".." || scoped.startsWith(`..\\`) || scoped.startsWith("../")) {
            throw new Error("Managed browser receipt is outside the managed browser evidence directory");
        }
        const handle = await open(resolved, "r");
        try {
            const before = await handle.stat();
            if (!before.isFile() || before.size < 1 || before.size > MAX_RECEIPT_BYTES) {
                throw new Error("Managed browser receipt is not a bounded regular file");
            }
            const receiptJson = await handle.readFile({ encoding: "utf8" });
            const after = await handle.stat();
            if (after.size !== before.size || Buffer.byteLength(receiptJson) !== before.size) {
                throw new Error("Managed browser receipt changed while it was read");
            }
            return receiptJson;
        }
        finally {
            await handle.close();
        }
    }
}
function parseCloseReceipt(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Managed browser close returned a malformed receipt");
    }
    const result = value;
    if (result.status !== "closed" ||
        typeof result.receiptDigest !== "string" ||
        !SHA256.test(result.receiptDigest) ||
        typeof result.receiptPath !== "string" ||
        !result.receiptPath) {
        throw new Error("Managed browser close returned a malformed receipt");
    }
    return result;
}
function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
