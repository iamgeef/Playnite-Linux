import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { createHostedService } from "../src/server.js";
import { LinuxHelper, pairWithService, pairWithLocalService, verifyDeviceSession } from "../../linux-helper/src/helper.js";
import { LocalCatalog } from "../../linux-helper/src/catalog.js";

const KNOWN_GAME_ID = "29a5daa9-f6d6-4c68-8f9b-7e2b670ba3c3";
const BROKEN_GAME_ID = "9b2a6e3e-9a2b-4a36-9b0c-7a6d6a9d3a11";
const UNKNOWN_GAME_ID = "00000000-0000-4000-8000-000000000000";

function testCatalog() {
    const games = [
        { gameId: KNOWN_GAME_ID, name: "Known Game", source: "custom" },
        { gameId: BROKEN_GAME_ID, name: "Broken Game", source: "custom" }
    ];
    const launchers = new Map([
        [KNOWN_GAME_ID, async () => {}],
        [BROKEN_GAME_ID, async () => { throw new Error("boom"); }]
    ]);
    return new LocalCatalog(games, launchers);
}

async function startService() {
    const service = createHostedService();
    const port = await service.listen(0);
    return { service, serviceUrl: `http://127.0.0.1:${port}` };
}

async function pairAndConnectHelper(serviceUrl) {
    const pairingResponse = await fetch(new URL("/api/pairing-codes", serviceUrl), { method: "POST" });
    assert.equal(pairingResponse.status, 201);
    const { pairingCode } = await pairingResponse.json();

    const { deviceId, token } = await pairWithService(serviceUrl, pairingCode);
    assert.ok(deviceId);
    assert.ok(token);

    const events = [];
    const helper = new LinuxHelper({
        serviceUrl,
        token,
        catalog: testCatalog(),
        capabilities: ["custom"],
        onEvent: (event) => events.push(event)
    });
    await helper.connect();
    return { deviceId, token, helper, events };
}

async function waitForCatalog(serviceUrl, deviceId, { timeoutMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const response = await fetch(new URL(`/api/devices/${deviceId}/catalog`, serviceUrl));
        const body = await response.json();
        if (body.games.length > 0) {
            return body.games;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for catalog snapshot to arrive");
}

describe("hosted service <-> Linux helper end-to-end", () => {
    const cleanups = [];
    after(async () => {
        for (const cleanup of cleanups) {
            await cleanup();
        }
    });

    it("rejects a pairing code it never issued", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());

        const response = await fetch(new URL("/api/pair", serviceUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pairingCode: "does-not-exist" })
        });
        assert.equal(response.status, 400);
    });

    it("automatically pairs with a local service and refuses remote hosts", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());

        const credentials = await pairWithLocalService(serviceUrl);
        assert.ok(credentials.deviceId);
        assert.ok(credentials.token);
        assert.equal(service.registry.list().length, 1);
        assert.equal(await verifyDeviceSession(serviceUrl, credentials.deviceId, credentials.token), true);
        assert.equal(await verifyDeviceSession(serviceUrl, credentials.deviceId, "invalid-token"), false);

        await assert.rejects(
            pairWithLocalService("http://example.com"),
            /only allowed with an http loopback service/
        );
        await assert.rejects(
            pairWithLocalService("https://127.0.0.1:8787"),
            /only allowed with an http loopback service/
        );
    });

    it("pairs, receives a catalog snapshot, and relays a successful launch", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());

        const { deviceId, helper } = await pairAndConnectHelper(serviceUrl);
        cleanups.push(() => helper.close());

        const games = await waitForCatalog(serviceUrl, deviceId);
        assert.equal(games.length, 2);

        const devicesResponse = await fetch(new URL("/api/devices", serviceUrl));
        const { devices } = await devicesResponse.json();
        const device = devices.find((candidate) => candidate.deviceId === deviceId);
        assert.equal(device.platform, "linux");
        assert.deepEqual(device.capabilities, ["custom"]);
        assert.equal(device.connected, true);

        const launchResponse = await fetch(new URL(`/api/devices/${deviceId}/launch`, serviceUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: KNOWN_GAME_ID })
        });
        assert.equal(launchResponse.status, 200);
        const { result } = await launchResponse.json();
        assert.equal(result.status, "started");
        assert.equal(result.gameId, KNOWN_GAME_ID);
    });

    it("reports game_not_found for a game the helper does not have", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());
        const { deviceId, helper } = await pairAndConnectHelper(serviceUrl);
        cleanups.push(() => helper.close());
        await waitForCatalog(serviceUrl, deviceId);

        const response = await fetch(new URL(`/api/devices/${deviceId}/launch`, serviceUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: UNKNOWN_GAME_ID })
        });
        const { result } = await response.json();
        assert.equal(result.status, "failed");
        assert.equal(result.errorCode, "game_not_found");
    });

    it("reports launch_failed when the helper's launcher throws", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());
        const { deviceId, helper } = await pairAndConnectHelper(serviceUrl);
        cleanups.push(() => helper.close());
        await waitForCatalog(serviceUrl, deviceId);

        const response = await fetch(new URL(`/api/devices/${deviceId}/launch`, serviceUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: BROKEN_GAME_ID })
        });
        const { result } = await response.json();
        assert.equal(result.status, "failed");
        assert.equal(result.errorCode, "launch_failed");
    });

    it("refuses to launch on a disconnected device", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());
        const { deviceId, helper } = await pairAndConnectHelper(serviceUrl);
        await waitForCatalog(serviceUrl, deviceId);
        helper.close();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const response = await fetch(new URL(`/api/devices/${deviceId}/launch`, serviceUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: KNOWN_GAME_ID })
        });
        assert.equal(response.status, 409);
    });

    it("revokes a device, closes its connection, and refuses further launches and reconnects", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());
        const { deviceId, token, events } = await pairAndConnectHelper(serviceUrl);

        const revokeResponse = await fetch(new URL(`/api/devices/${deviceId}/revoke`, serviceUrl), { method: "POST" });
        assert.equal(revokeResponse.status, 200);

        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(events.some((event) => event.type === "disconnected" && event.code === 4001));

        const launchResponse = await fetch(new URL(`/api/devices/${deviceId}/launch`, serviceUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: KNOWN_GAME_ID })
        });
        assert.equal(launchResponse.status, 410);

        // A revoked token must not be able to open a brand-new connection either.
        const reconnectingHelper = new LinuxHelper({
            serviceUrl,
            token,
            catalog: testCatalog(),
            onEvent: () => {}
        });
        await assert.rejects(() => reconnectingHelper.connect());
    });

    it("does not allow one device's launch result to resolve another device's pending request", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());

        const first = await pairAndConnectHelper(serviceUrl);
        const second = await pairAndConnectHelper(serviceUrl);
        cleanups.push(() => first.helper.close());
        cleanups.push(() => second.helper.close());
        await waitForCatalog(serviceUrl, first.deviceId);
        await waitForCatalog(serviceUrl, second.deviceId);

        // Directly exercise the relay: a result from "second" must not satisfy a
        // request that the service only ever sent to "first".
        const { message, resultPromise } = service.relay.createRequest(first.deviceId, KNOWN_GAME_ID, { timeoutMs: 300 });
        service.relay.handleResult(second.deviceId, {
            type: "launch.result",
            protocolVersion: 1,
            requestId: message.requestId,
            gameId: KNOWN_GAME_ID,
            status: "started",
            completedAt: new Date().toISOString()
        });
        await assert.rejects(() => resultPromise, /timed out/);
    });

    it("serves the web UI from the same origin as the API", async () => {
        const { service, serviceUrl } = await startService();
        cleanups.push(() => service.close());

        const response = await fetch(new URL("/", serviceUrl));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/html/);
        const html = await response.text();
        assert.match(html, /Paused/);
        assert.match(html, /STEAM_WEB_API_KEY/);
    });
});
