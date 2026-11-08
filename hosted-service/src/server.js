import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { DeviceRegistry } from "./deviceRegistry.js";
import { LaunchRelay } from "./launchRelay.js";
import { SteamLibrary } from "./steamLibrary.js";
import { validateMessage, validateAs, PROTOCOL_VERSION } from "../../helper-protocol/v1/validate.mjs";

const webUiIndexPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-ui", "index.html");

function sendJson(response, statusCode, body) {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    response.end(payload);
}

async function readJsonBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }
    if (chunks.length === 0) {
        return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractBearerToken(request) {
    const header = request.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) {
        return null;
    }
    return header.slice("Bearer ".length).trim();
}

/**
 * Local prototype of the hosted service: pairing/device REST API plus a
 * WebSocket endpoint that authenticated helpers connect to outbound. This is
 * intentionally not production-grade (no TLS termination, no persistence,
 * no rate limiting) -- see hosted-service/README.md for the known gaps.
 */
export function createHostedService(options = {}) {
    const registry = new DeviceRegistry();
    const relay = new LaunchRelay();
    const steamLibrary = new SteamLibrary(options.steam);

    async function handleApiRequest(request, response, url) {
        if (request.method === "GET" && url.pathname === "/api/library/steam") {
            try {
                const result = await steamLibrary.getOwnedGames({ refresh: url.searchParams.get("refresh") === "1" });
                sendJson(response, 200, result);
            } catch (error) {
                sendJson(response, 502, { error: "steam_api_failed", message: error.message });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/pairing-codes") {
            sendJson(response, 201, registry.createPairingCode());
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/pair") {
            const body = await readJsonBody(request);
            const result = registry.redeemPairingCode(body.pairingCode);
            if (!result) {
                sendJson(response, 400, { error: "invalid_or_expired_pairing_code" });
                return;
            }
            sendJson(response, 201, result);
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/devices") {
            sendJson(response, 200, { devices: registry.list() });
            return;
        }

        const deviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)(\/(revoke|launch|catalog|session))?$/);
        if (deviceMatch) {
            const [, deviceId, , action] = deviceMatch;
            const device = registry.get(deviceId);

            if (!device) {
                sendJson(response, 404, { error: "device_not_found" });
                return;
            }

            if (request.method === "GET" && action === "session") {
                const token = extractBearerToken(request);
                const authenticated = token ? registry.authenticate(token) : null;
                if (!authenticated || authenticated.deviceId !== deviceId) {
                    sendJson(response, 401, { error: "invalid_device_credentials" });
                    return;
                }
                sendJson(response, 200, { valid: true });
                return;
            }

            if (request.method === "POST" && action === "revoke") {
                relay.cancelForDevice(deviceId, "device revoked");
                registry.revoke(deviceId);
                sendJson(response, 200, { revoked: true });
                return;
            }

            if (request.method === "GET" && action === "catalog") {
                sendJson(response, 200, { games: device.lastCatalog ?? [] });
                return;
            }

            if (request.method === "POST" && action === "launch") {
                if (device.revoked) {
                    sendJson(response, 410, { error: "device_revoked" });
                    return;
                }
                if (!device.connection) {
                    sendJson(response, 409, { error: "device_not_connected" });
                    return;
                }

                const body = await readJsonBody(request);
                if (typeof body.gameId !== "string") {
                    sendJson(response, 400, { error: "gameId_required" });
                    return;
                }

                const { message, resultPromise } = relay.createRequest(deviceId, body.gameId);
                validateAs("launchRequest", message);
                device.connection.send(JSON.stringify(message));

                try {
                    const result = await resultPromise;
                    sendJson(response, 200, { result });
                } catch (error) {
                    sendJson(response, 504, { error: "launch_request_failed", message: error.message });
                }
                return;
            }
        }

        sendJson(response, 404, { error: "not_found" });
    }

    async function handleStaticRequest(request, response, url) {
        // Serving the web UI from the same origin as the API avoids CORS
        // entirely for this prototype; it is intentionally just one static
        // file with no build step.
        if (request.method !== "GET" || url.pathname !== "/") {
            return false;
        }
        const html = await readFile(webUiIndexPath, "utf8");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
        response.end(html);
        return true;
    }

    const httpServer = createHttpServer((request, response) => {
        const url = new URL(request.url, "http://localhost");
        handleStaticRequest(request, response, url)
            .then((handled) => handled ? undefined : handleApiRequest(request, response, url))
            .catch((error) => {
                sendJson(response, 400, { error: "bad_request", message: error.message });
            });
    });

    const webSocketServer = new WebSocketServer({ noServer: true });

    // Authenticate at the HTTP Upgrade stage, before the WebSocket handshake
    // completes. Accepting the socket and only then closing it (after "open"
    // has already fired client-side) leaves the client unable to distinguish
    // a successful connection from an immediately-revoked one.
    httpServer.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname !== "/helper") {
            socket.destroy();
            return;
        }

        const token = extractBearerToken(request);
        const authenticated = token ? registry.authenticate(token) : null;
        if (!authenticated) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }

        webSocketServer.handleUpgrade(request, socket, head, (connection) => {
            webSocketServer.emit("connection", connection, request, authenticated);
        });
    });

    webSocketServer.on("connection", (connection, request, authenticated) => {
        const { deviceId } = authenticated;
        registry.setConnection(deviceId, connection);

        connection.on("message", (data) => {
            let message;
            try {
                message = JSON.parse(data.toString("utf8"));
                validateMessage(message);
            } catch {
                connection.close(4002, "protocol violation");
                return;
            }

            if (message.protocolVersion !== PROTOCOL_VERSION) {
                connection.close(4003, "unsupported protocol version");
                return;
            }

            switch (message.type) {
                case "helper.hello":
                    registry.recordHello(deviceId, { platform: message.platform, capabilities: message.capabilities });
                    break;
                case "catalog.snapshot":
                    registry.recordCatalog(deviceId, message.games);
                    break;
                case "launch.result":
                    relay.handleResult(deviceId, message);
                    break;
                default:
                    // helper.hello/catalog.snapshot/launch.result are the only message
                    // types a helper is allowed to send; launch.request is service -> helper only.
                    connection.close(4002, "unexpected message type from helper");
            }
        });

        connection.on("close", () => {
            registry.setConnection(deviceId, null);
            relay.cancelForDevice(deviceId, "helper disconnected");
        });
    });

    return {
        httpServer,
        registry,
        relay,
        steamLibrary,
        listen(port = 0) {
            return new Promise((resolve) => {
                httpServer.listen(port, "127.0.0.1", () => resolve(httpServer.address().port));
            });
        },
        close() {
            // wss.close() alone only stops accepting new connections and waits for
            // existing clients to disconnect on their own, which can hang shutdown
            // indefinitely. Force-terminate any still-open helper connections too.
            for (const client of webSocketServer.clients) {
                client.terminate();
            }
            return new Promise((resolve) => {
                webSocketServer.close(() => httpServer.close(() => resolve()));
            });
        }
    };
}
