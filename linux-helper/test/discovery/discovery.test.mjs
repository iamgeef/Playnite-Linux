import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSteamGames } from "../../src/discovery/steam.js";
import { discoverLutrisGames } from "../../src/discovery/lutris.js";
import { discoverCatalog } from "../../src/discovery/index.js";
import { stableGameId } from "../../src/discovery/stableId.js";

async function makeSteamFixture() {
    const root = await mkdtemp(join(tmpdir(), "steam-root-"));
    const steamappsDir = join(root, "steamapps");
    await mkdir(steamappsDir, { recursive: true });

    await writeFile(
        join(steamappsDir, "libraryfolders.vdf"),
        `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root}"\n\t}\n}\n`
    );

    // StateFlags 4 = fully installed.
    await writeFile(
        join(steamappsDir, "appmanifest_1245620.acf"),
        `"AppState"\n{\n\t"appid"\t\t"1245620"\n\t"name"\t\t"Elden Ring"\n\t"StateFlags"\t\t"4"\n}\n`
    );
    // StateFlags 2 = update required / not fully installed -- must be excluded.
    await writeFile(
        join(steamappsDir, "appmanifest_999.acf"),
        `"AppState"\n{\n\t"appid"\t\t"999"\n\t"name"\t\t"Mid Download"\n\t"StateFlags"\t\t"2"\n}\n`
    );

    return root;
}

describe("discoverSteamGames", () => {
    test("finds fully-installed games from libraryfolders.vdf and appmanifests", async () => {
        const root = await makeSteamFixture();
        try {
            const calls = [];
            const { games, launchers } = await discoverSteamGames({
                steamRoots: [root],
                exec: async (command, args) => {
                    calls.push({ command, args });
                    return { stdout: "", stderr: "" };
                }
            });

            assert.equal(games.length, 1);
            assert.equal(games[0].name, "Elden Ring");
            assert.equal(games[0].source, "steam");
            assert.equal(games[0].steamAppId, 1245620);
            assert.equal(games[0].gameId, stableGameId("steam:1245620"));

            const launcher = launchers.get(games[0].gameId);
            await launcher(games[0]);
            assert.deepEqual(calls, [{ command: "steam", args: ["steam://rungameid/1245620"] }]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("returns no games for a Steam root that does not exist", async () => {
        const { games } = await discoverSteamGames({ steamRoots: ["/nonexistent/steam/root"] });
        assert.deepEqual(games, []);
    });

    test("does not duplicate an appid seen via multiple library paths", async () => {
        const root = await makeSteamFixture();
        try {
            const { games } = await discoverSteamGames({ steamRoots: [root, root] });
            assert.equal(games.length, 1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("discoverLutrisGames", () => {
    test("parses installed games from `lutris --list-games --json` output", async () => {
        const calls = [];
        const { games, launchers } = await discoverLutrisGames({
            listGames: async () => JSON.stringify([
                { id: 1, slug: "quake", name: "Quake", runner: "dosbox" }
            ]),
            exec: async (command, args) => {
                calls.push({ command, args });
                return { stdout: "", stderr: "" };
            }
        });

        assert.equal(games.length, 1);
        assert.equal(games[0].name, "Quake");
        assert.equal(games[0].source, "lutris");
        assert.equal(games[0].gameId, stableGameId("lutris:quake"));

        await launchers.get(games[0].gameId)(games[0]);
        assert.deepEqual(calls, [{ command: "lutris", args: ["lutris:rungame/quake"] }]);
    });

    test("treats a missing/non-JSON Lutris CLI as zero games rather than failing", async () => {
        const { games } = await discoverLutrisGames({
            listGames: async () => {
                throw new Error("spawn lutris ENOENT");
            }
        });
        assert.deepEqual(games, []);
    });

    test("skips malformed entries missing a slug or name", async () => {
        const { games } = await discoverLutrisGames({
            listGames: async () => JSON.stringify([{ id: 1 }, null, { slug: "ok", name: "Ok Game" }])
        });
        assert.equal(games.length, 1);
        assert.equal(games[0].name, "Ok Game");
    });
});

describe("discoverCatalog", () => {
    test("merges Steam and Lutris results into one LocalCatalog", async () => {
        const root = await makeSteamFixture();
        try {
            const catalog = await discoverCatalog({
                steam: { steamRoots: [root], exec: async () => ({ stdout: "", stderr: "" }) },
                lutris: {
                    listGames: async () => JSON.stringify([{ id: 1, slug: "quake", name: "Quake" }]),
                    exec: async () => ({ stdout: "", stderr: "" })
                }
            });

            const names = catalog.list().map((game) => game.name).sort();
            assert.deepEqual(names, ["Elden Ring", "Quake"]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("one source's failure does not prevent the other from contributing games", async () => {
        const root = await makeSteamFixture();
        try {
            const catalog = await discoverCatalog({
                steam: { steamRoots: [root], exec: async () => ({ stdout: "", stderr: "" }) },
                lutris: { listGames: async () => { throw new Error("no lutris here"); } }
            });

            assert.equal(catalog.list().length, 1);
            assert.equal(catalog.list()[0].source, "steam");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

import { isSteamTool } from "../../src/discovery/steamTools.js";

test("steam tools and runtimes are identified", () => {
    for (const name of ["Proton Hotfix", "Proton 9.0", "Steam Linux Runtime 3.0 (sniper)", "Steamworks Common Redistributables"]) {
        assert.equal(isSteamTool(1, name), true, name);
    }
    assert.equal(isSteamTool(1245620, "Elden Ring"), true === false);
});

import { parseShortcuts, shortcutLaunchId } from "../../src/discovery/shortcuts.js";

test("parses binary shortcuts.vdf entries", () => {
    const str = (k, v) => Buffer.concat([Buffer.from([1]), Buffer.from(`${k}\0${v}\0`)]);
    const int = (k, n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return Buffer.concat([Buffer.from([2]), Buffer.from(`${k}\0`), b]); };
    const entry = Buffer.concat([Buffer.from([0]), Buffer.from("0\0"), int("appid", 0xdeadbeef), str("AppName", "Zomboid"), Buffer.from([8])]);
    const buf = Buffer.concat([Buffer.from([0]), Buffer.from("shortcuts\0"), entry, Buffer.from([8, 8])]);
    assert.deepEqual(parseShortcuts(buf), [{ appid: 0xdeadbeef, name: "Zomboid", hidden: false }]);
    assert.equal(shortcutLaunchId(0xdeadbeef), ((0xdeadbeefn << 32n) | 0x02000000n).toString());
});
