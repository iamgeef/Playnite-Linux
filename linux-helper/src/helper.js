import { randomUUID } from "node:crypto";
import { validateMessage, validateAs, validateLaunchWindow, PROTOCOL_VERSION } from "../../helper-protocol/v1/validate.mjs";

const PROCESSED_REQUEST_RETENTION_MS = 10 * 60 * 1000;

/** Pair with the hosted service using a short-lived pairing code, returning a device token to persist. */
export async function pairWithService(serviceUrl, pairingCode) {
    const response = await fetch(new URL("/api/pair", serviceUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode })
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(`pairing failed: ${body.error ?? response.status}`);
    }
    return response.json();
}

/**
 * Pair without manually copying a code when both processes use the same
 * machine's loopback service. This deliberately refuses non-loopback URLs:
 * remote services must retain the explicit user-approved pairing-code flow.
 */
export async function pairWithLocalService(serviceUrl = "http://127.0.0.1:8787") {
    const service = new URL(serviceUrl);
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
    if (service.protocol !== "http:" || !loopbackHosts.has(service.hostname)) {
        throw new Error("automatic pairing is only allowed with an http loopback service; use the pairing-code flow for hosted services");
    }

    let codeResponse;
    try {
        codeResponse = await fetch(new URL("/api/pairing-codes", service), { method: "POST" });
    } catch {
        throw new Error(`could not reach local hosted service at ${service.origin}`);
    }
    if (!codeResponse.ok) {
        throw new Error(`could not create a local pairing code: HTTP ${codeResponse.status}`);
    }

    const { pairingCode } = await codeResponse.json();
    if (typeof pairingCode !== "string" || pairingCode.length === 0) {
        throw new Error("local hosted service returned an invalid pairing code");
    }
    return pairWithService(service.origin, pairingCode);
}

export async function verifyDeviceSession(serviceUrl, deviceId, token) {
    let response;
    try {
        response = await fetch(new URL(`/api/devices/${encodeURIComponent(deviceId)}/session`, serviceUrl), {
            headers: { Authorization: `Bearer ${token}` }
        });
    } catch {
        throw new Error(`could not reach hosted service at ${serviceUrl}`);
    }
    if (response.status === 401 || response.status === 404) {
        return false;
    }
    if (!response.ok) {
        throw new Error(`could not verify saved device credentials: HTTP ${response.status}`);
    }
    return true;
}

/**
 * Local prototype of the Linux helper's service connection: an authenticated
 * outbound WebSocket that announces capabilities, publishes a local game
 * catalog snapshot, and executes only typed, bounded, expiring launch
 * requests against games the helper itself already knows about.
 */
export class LinuxHelper {
    #serviceUrl;
    #token;
    #catalog;
    #capabilities;
    #socket = null;
    #processedRequests = new Map(); // requestId -> processedAt, for replay protection
    #onEvent;

    constructor({ serviceUrl, token, catalog, capabilities = ["custom"], onEvent = () => {} }) {
        this.#serviceUrl = serviceUrl;
        this.#token = token;
        this.#catalog = catalog;
        this.#capabilities = capabilities;
        this.#onEvent = onEvent;
    }

    connect() {
        const wsUrl = new URL("/helper", this.#serviceUrl);
        wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

        return new Promise((resolve, reject) => {
            const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${this.#token}` } });
            this.#socket = socket;

            socket.addEventListener("open", () => {
                this.#send({
                    type: "helper.hello",
                    protocolVersion: PROTOCOL_VERSION,
                    messageId: randomUUID(),
                    helperVersion: "0.1.0",
                    platform: "linux",
                    capabilities: this.#capabilities,
                    sentAt: new Date().toISOString()
                });
                this.#send({
                    type: "catalog.snapshot",
                    protocolVersion: PROTOCOL_VERSION,
                    messageId: randomUUID(),
                    sentAt: new Date().toISOString(),
                    games: this.#catalog.list()
                });
                this.#onEvent({ type: "connected" });
                resolve();
            });

            socket.addEventListener("message", (event) => this.#handleMessage(event.data));

            socket.addEventListener("close", (event) => {
                this.#onEvent({ type: "disconnected", code: event.code, reason: event.reason });
            });

            socket.addEventListener("error", (event) => {
                const error = event.error ?? new Error(event.message || "websocket connection failed");
                this.#onEvent({ type: "error", error: { name: error.name, message: error.message } });
                reject(error);
            });
        });
    }

    close() {
        this.#socket?.close(1000, "helper shutting down");
    }

    #send(message) {
        this.#socket.send(JSON.stringify(message));
    }

    async #handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
            validateMessage(message);
        } catch {
            // Malformed or non-conformant message: drop it rather than acting on
            // partially-parsed data. A real helper should also log and consider
            // closing the connection after repeated violations.
            this.#onEvent({ type: "malformed_message" });
            return;
        }

        if (message.protocolVersion !== PROTOCOL_VERSION) {
            // The current v1 schema fixes protocolVersion as a const, so a message
            // with a different version is already rejected by validateMessage above
            // as malformed. This check is defense-in-depth for a future schema
            // revision that validates the envelope before the version-specific body.
            this.#onEvent({ type: "unsupported_protocol_version", version: message.protocolVersion });
            return;
        }

        if (message.type !== "launch.request") {
            // launch.request is the only message type the service is allowed to
            // send to a helper; anything else is a protocol violation.
            this.#onEvent({ type: "unexpected_message_type", messageType: message.type });
            return;
        }

        await this.#handleLaunchRequest(message);
    }

    async #handleLaunchRequest(request) {
        this.#forgetExpiredProcessedRequests();

        try {
            validateAs("launchRequest", request);
            validateLaunchWindow(request);
        } catch (error) {
            this.#onEvent({ type: "rejected_launch_request", requestId: request.requestId, reason: error.message });
            return;
        }

        if (this.#processedRequests.has(request.requestId)) {
            // Replayed request: do not launch the game a second time.
            this.#onEvent({ type: "duplicate_launch_request", requestId: request.requestId });
            return;
        }
        this.#processedRequests.set(request.requestId, Date.now());

        const outcome = await this.#catalog.launch(request.gameId);
        this.#onEvent({ type: "launch_attempted", requestId: request.requestId, gameId: request.gameId, outcome });

        const result = {
            type: "launch.result",
            protocolVersion: PROTOCOL_VERSION,
            requestId: request.requestId,
            gameId: request.gameId,
            status: outcome.ok ? "started" : "failed",
            completedAt: new Date().toISOString()
        };
        if (!outcome.ok) {
            result.errorCode = outcome.errorCode;
        }

        validateAs("launchResult", result);
        this.#send(result);
    }

    #forgetExpiredProcessedRequests() {
        const cutoff = Date.now() - PROCESSED_REQUEST_RETENTION_MS;
        for (const [requestId, processedAt] of this.#processedRequests) {
            if (processedAt < cutoff) {
                this.#processedRequests.delete(requestId);
            }
        }
    }
}
