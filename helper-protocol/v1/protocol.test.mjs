import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { validateMessage, validateAs, validateLaunchWindow, SchemaValidationError } from "./validate.mjs";

const examplesDirectory = new URL("examples/", import.meta.url);

async function loadExample(name) {
    return JSON.parse(await readFile(new URL(name, examplesDirectory), "utf8"));
}

describe("helper protocol v1", () => {
    it("accepts the published example messages", async () => {
        for (const name of ["helper-hello.json", "catalog-snapshot.json", "launch-request.json", "launch-result.json"]) {
            validateMessage(await loadExample(name));
        }
    });

    it("supports Linux, Windows, and macOS helpers", async () => {
        const hello = await loadExample("helper-hello.json");
        for (const platform of ["linux", "windows", "macos"]) {
            validateMessage({ ...hello, platform });
        }
    });

    it("validates the optional steamAppId on catalog games", async () => {
        const snapshot = await loadExample("catalog-snapshot.json");
        const game = { ...snapshot.games[0], source: "steam" };
        validateMessage({ ...snapshot, games: [{ ...game, steamAppId: 1245620 }] });
        for (const bad of [0, -1, 1.5, "10"]) {
            assert.throws(() => validateMessage({ ...snapshot, games: [{ ...game, steamAppId: bad }] }));
        }
    });

    it("rejects unknown fields and arbitrary launch commands", async () => {
        const request = await loadExample("launch-request.json");
        assert.throws(() => validateAs("launchRequest", { ...request, command: "anything" }), /not allowed/);
        assert.throws(() => validateAs("launchRequest", { ...request, executablePath: "/tmp/game" }), /not allowed/);
        assert.throws(() => validateAs("launchRequest", { ...request, arguments: ["--unsafe"] }), /not allowed/);
    });

    it("requires bounded, valid launch request identifiers and timestamps", async () => {
        const request = await loadExample("launch-request.json");
        assert.throws(() => validateAs("launchRequest", { ...request, gameId: "not-a-uuid" }), /must be a UUID/);
        assert.throws(() => validateAs("launchRequest", { ...request, expiresAt: "not-a-date" }), /RFC 3339/);

        validateLaunchWindow(request, { now: Date.parse("2026-10-02T05:00:00Z") });
        assert.throws(() => validateLaunchWindow({
            ...request,
            expiresAt: "2026-10-02T05:02:00Z"
        }, { now: Date.parse("2026-10-02T05:00:00Z") }), /must not exceed 60000ms/);
        assert.throws(() => validateLaunchWindow({
            ...request,
            expiresAt: "2026-10-02T04:59:59Z"
        }, { now: Date.parse("2026-10-02T05:00:00Z") }), /must not be expired/);
    });

    it("requires a bounded error code for failed launches only", async () => {
        const result = await loadExample("launch-result.json");
        assert.throws(() => validateAs("launchResult", { ...result, errorCode: "run arbitrary command" }), /not an allowed value/);
        assert.throws(() => validateAs("launchResult", {
            ...result,
            status: "started",
            errorCode: "launch_failed"
        }), /must not match forbidden schema/);
    });

    it("raises a typed error for malformed messages", async () => {
        const request = await loadExample("launch-request.json");
        assert.throws(() => validateAs("launchRequest", { ...request, gameId: 123 }), SchemaValidationError);
    });
});
