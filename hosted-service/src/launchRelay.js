import { randomUUID } from "node:crypto";

const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_LIFETIME_MS = 30_000;

/**
 * Tracks in-flight launch requests sent to helpers and resolves them when a
 * matching launch.result arrives (or times out). Also remembers recently
 * completed request IDs so a duplicate/replayed launch.result cannot be used
 * to resolve a second, unrelated waiter.
 */
export class LaunchRelay {
    #pending = new Map(); // requestId -> { resolve, reject, deviceId, timer }
    #seenRequestIds = new Set();

    /** Build a protocol-conformant launch.request for gameId and register a waiter for its result. */
    createRequest(deviceId, gameId, { lifetimeMs = DEFAULT_REQUEST_LIFETIME_MS, timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS } = {}) {
        const requestId = randomUUID();
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + lifetimeMs);
        const message = {
            type: "launch.request",
            protocolVersion: 1,
            requestId,
            gameId,
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString()
        };

        const resultPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(requestId);
                reject(new Error("launch request timed out waiting for helper response"));
            }, timeoutMs);
            timer.unref?.();
            this.#pending.set(requestId, { resolve, reject, deviceId, timer });
        });

        return { message, resultPromise };
    }

    /** Resolve a pending request when its matching launch.result arrives from the paired helper. */
    handleResult(deviceId, result) {
        if (this.#seenRequestIds.has(result.requestId)) {
            // Replayed or duplicate result for an already-settled request: ignore it.
            return;
        }

        const pending = this.#pending.get(result.requestId);
        if (!pending || pending.deviceId !== deviceId) {
            // Unknown request, or a result arriving from a device that was not asked
            // to perform it. Never resolve someone else's pending request.
            return;
        }

        clearTimeout(pending.timer);
        this.#pending.delete(result.requestId);
        this.#seenRequestIds.add(result.requestId);
        pending.resolve(result);
    }

    /** Reject every request outstanding against a device, e.g. on disconnect or revocation. */
    cancelForDevice(deviceId, reason) {
        for (const [requestId, pending] of this.#pending) {
            if (pending.deviceId === deviceId) {
                clearTimeout(pending.timer);
                this.#pending.delete(requestId);
                pending.reject(new Error(reason));
            }
        }
    }
}
