import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { LinuxHelper } from "../src/helper.js";
import { LocalCatalog } from "../src/catalog.js";

const GAME_ID = "29a5daa9-f6d6-4c68-8f9b-7e2b670ba3c3";

function catalogWithOneGame() {
    const games = [{ gameId: GAME_ID, name: "Test Game", source: "custom" }];
    const launches = [];
    const launchers = new Map([[GAME_ID, async (game) => { launches.push(game.gameId); }]]);
    return { catalog: new LocalCatalog(games, launchers), launches };
}

/**
 * A minimal fake "hosted service" double. Unlike the real hosted-service, it
 * lets a test send arbitrary -- including deliberately malformed or
 * protocol-violating -- raw messages directly to the helper, to verify the
 * helper defends itself rather than trusting the server.
 */
async function startFakeService() {
    const wss = new WebSocketServer({ port: 0 });
    const connections = [];
    wss.on("connection", (socket) => connections.push(socket));
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = wss.address().port;
    return {
        serviceUrl: `http://127.0.0.1:${port}`,
        connections,
        sendRaw(raw) {
            connections.at(-1).send(raw);
        },
        close() {
            for (const client of wss.clients) {
                client.terminate();
            }
            return new Promise((resolve) => wss.close(resolve));
        }
    };
}

function launchRequest(overrides = {}) {
    const now = Date.now();
    return {
        type: "launch.request",
        protocolVersion: 1,
        requestId: randomUUID(),
        gameId: GAME_ID,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
        ...overrides
    };
}

describe("LocalCatalog", () => {
    it("reports game_not_found for an unregistered id", async () => {
        const { catalog } = catalogWithOneGame();
        const outcome = await catalog.launch(randomUUID());
        assert.deepEqual(outcome, { ok: false, errorCode: "game_not_found" });
    });

    it("reports launch_failed when the launcher throws", async () => {
        const games = [{ gameId: GAME_ID, name: "Test", source: "custom" }];
        const launchers = new Map([[GAME_ID, async () => { throw new Error("boom"); }]]);
        const catalog = new LocalCatalog(games, launchers);
        const outcome = await catalog.launch(GAME_ID);
        assert.deepEqual(outcome, { ok: false, errorCode: "launch_failed" });
    });

    it("reports unsupported_launch_type when no launcher is registered", async () => {
        const games = [{ gameId: GAME_ID, name: "Test", source: "custom" }];
        const catalog = new LocalCatalog(games, new Map());
        const outcome = await catalog.launch(GAME_ID);
        assert.deepEqual(outcome, { ok: false, errorCode: "unsupported_launch_type" });
    });

    it("launches successfully for a known, supported game", async () => {
        const { catalog, launches } = catalogWithOneGame();
        const outcome = await catalog.launch(GAME_ID);
        assert.deepEqual(outcome, { ok: true });
        assert.deepEqual(launches, [GAME_ID]);
    });
});

describe("LinuxHelper against an adversarial/fake service", () => {
    const cleanups = [];
    after(async () => {
        for (const cleanup of cleanups) {
            await cleanup();
        }
    });

    async function connectHelper() {
        const fakeService = await startFakeService();
        cleanups.push(() => fakeService.close());
        const { catalog, launches } = catalogWithOneGame();
        const events = [];
        const helper = new LinuxHelper({
            serviceUrl: fakeService.serviceUrl,
            token: "irrelevant-for-fake-service",
            catalog,
            onEvent: (event) => events.push(event)
        });
        await helper.connect();
        cleanups.push(() => helper.close());
        return { fakeService, helper, events, launches };
    }

    it("launches the requested game and reports a bounded, typed result", async () => {
        const { fakeService, events, launches } = await connectHelper();
        const request = launchRequest();
        fakeService.sendRaw(JSON.stringify(request));

        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(launches, [GAME_ID]);
        assert.ok(events.some((event) => event.type === "launch_attempted" && event.outcome.ok === true));
    });

    it("ignores a replayed launch request with the same requestId", async () => {
        const { fakeService, events, launches } = await connectHelper();
        const request = launchRequest();
        fakeService.sendRaw(JSON.stringify(request));
        await new Promise((resolve) => setTimeout(resolve, 50));
        fakeService.sendRaw(JSON.stringify(request));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(launches, [GAME_ID]);
        assert.equal(events.filter((event) => event.type === "duplicate_launch_request").length, 1);
    });

    it("rejects an already-expired launch request without launching", async () => {
        const { fakeService, events, launches } = await connectHelper();
        const request = launchRequest({
            issuedAt: new Date(Date.now() - 120_000).toISOString(),
            expiresAt: new Date(Date.now() - 60_000).toISOString()
        });
        fakeService.sendRaw(JSON.stringify(request));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(launches, []);
        assert.ok(events.some((event) => event.type === "rejected_launch_request"));
    });

    it("rejects a launch request issued too far in the future", async () => {
        const { fakeService, events, launches } = await connectHelper();
        const request = launchRequest({
            issuedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 11 * 60_000).toISOString()
        });
        fakeService.sendRaw(JSON.stringify(request));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(launches, []);
        assert.ok(events.some((event) => event.type === "rejected_launch_request"));
    });

    it("ignores a malformed, non-conformant message instead of crashing", async () => {
        const { fakeService, events, launches } = await connectHelper();
        fakeService.sendRaw(JSON.stringify({ type: "launch.request", protocolVersion: 1 }));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(launches, []);
        assert.ok(events.some((event) => event.type === "malformed_message"));
    });

    it("never launches a message claiming an unsupported protocol version", async () => {
        const { fakeService, events, launches } = await connectHelper();
        fakeService.sendRaw(JSON.stringify(launchRequest({ protocolVersion: 2 })));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(launches, []);
        // The v1 schema declares protocolVersion as a fixed const, so a v2 message
        // already fails schema validation (malformed_message) rather than reaching
        // the helper's explicit protocolVersion check below. Both checks reject it;
        // this asserts on whichever one the current schema causes to fire first.
        assert.ok(events.some((event) => event.type === "malformed_message" || event.type === "unsupported_protocol_version"));
    });

    it("never attempts to execute an arbitrary command carried on a launch request", async () => {
        const { fakeService, events, launches } = await connectHelper();
        // additionalProperties: false on launch.request means a raw command is
        // outright schema-invalid, not merely ignored -- confirm it is rejected.
        const maliciousRaw = JSON.stringify({ ...launchRequest(), command: "rm -rf /" });
        fakeService.sendRaw(maliciousRaw);
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(launches, []);
        assert.ok(events.some((event) => event.type === "malformed_message"));
    });
});
