import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseKeyValues } from "./vdf.js";
import { parseShortcuts, shortcutLaunchId } from "./shortcuts.js";
import { isSteamTool } from "./steamTools.js";
import { stableGameId } from "./stableId.js";

const execFileAsync = promisify(execFile);

const STATE_FLAG_FULLY_INSTALLED = 4;

function defaultSteamRoots() {
    const home = process.env.HOME ?? "";
    return [
        join(home, ".local/share/Steam"),
        join(home, ".steam/steam"),
        join(home, ".steam/root"),
        join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam")
    ];
}

async function readLibraryPaths(steamRoot) {
    const vdfPath = join(steamRoot, "steamapps", "libraryfolders.vdf");
    let text;
    try {
        text = await readFile(vdfPath, "utf8");
    } catch {
        return [];
    }

    const parsed = parseKeyValues(text);
    // Both the legacy flat format ("0" "path" "1" "path" ...) and the modern
    // nested format ("0" { "path" "..." } ...) surface every library root as
    // a "path" key once flattened by parseKeyValues.
    return parsed.allValues("path");
}

async function readAppManifests(steamappsDir) {
    let entries;
    try {
        entries = await readdir(steamappsDir);
    } catch {
        return [];
    }

    const manifests = [];
    for (const entry of entries) {
        if (!/^appmanifest_\d+\.acf$/.test(entry)) {
            continue;
        }
        try {
            const text = await readFile(join(steamappsDir, entry), "utf8");
            const parsed = parseKeyValues(text);
            const appid = parsed.get("appid");
            const name = parsed.get("name");
            const stateFlags = Number.parseInt(parsed.get("StateFlags") ?? "0", 10);
            if (!appid || !name || isSteamTool(appid, name)) {
                continue;
            }
            // Bit 4 ("fully installed") excludes manifests for games that are
            // only partially downloaded, updating, or marked for removal.
            if ((stateFlags & STATE_FLAG_FULLY_INSTALLED) === 0) {
                continue;
            }
            manifests.push({ appid, name });
        } catch {
            // Skip unreadable/corrupt manifests rather than failing discovery entirely.
        }
    }
    return manifests;
}

function steamLaunchCommand(steamRoot) {
    const isFlatpak = steamRoot.includes("/.var/app/com.valvesoftware.Steam/");
    return isFlatpak
        ? { command: "flatpak", baseArgs: ["run", "com.valvesoftware.Steam"] }
        : { command: "steam", baseArgs: [] };
}

/**
 * Discover installed, fully-downloaded Steam games across every Steam
 * library folder reachable from the known Steam install locations (native,
 * .steam symlink, and Flatpak). Each discovered game is paired with a
 * launcher that invokes Steam's own `steam://rungameid/<appid>` handler --
 * the helper never launches the game's executable directly.
 *
 * @param {{steamRoots?: string[], exec?: typeof execFileAsync}} [options]
 * @returns {Promise<{games: {gameId: string, name: string, source: "steam"}[], launchers: Map<string, (game: object) => Promise<void>>}>}
 */
export async function discoverSteamGames(options = {}) {
    const steamRoots = options.steamRoots ?? defaultSteamRoots();
    const exec = options.exec ?? execFileAsync;

    const games = [];
    const launchers = new Map();
    const seenAppIds = new Set();

    for (const steamRoot of steamRoots) {
        const libraryPaths = new Set([steamRoot, ...(await readLibraryPaths(steamRoot))]);
        const { command, baseArgs } = steamLaunchCommand(steamRoot);

        for (const libraryPath of libraryPaths) {
            const manifests = await readAppManifests(join(libraryPath, "steamapps"));
            for (const { appid, name } of manifests) {
                if (seenAppIds.has(appid)) {
                    continue;
                }
                seenAppIds.add(appid);

                const gameId = stableGameId(`steam:${appid}`);
                games.push({ gameId, name, source: "steam", steamAppId: Number.parseInt(appid, 10) });
                launchers.set(gameId, async () => {
                    await exec(command, [...baseArgs, `steam://rungameid/${appid}`]);
                });
            }
        }
    }

    for (const steamRoot of steamRoots) {
        const { command, baseArgs } = steamLaunchCommand(steamRoot);
        let userIds = [];
        try {
            userIds = await readdir(join(steamRoot, "userdata"));
        } catch {
            continue;
        }
        for (const userId of userIds) {
            let shortcuts;
            try {
                shortcuts = parseShortcuts(await readFile(join(steamRoot, "userdata", userId, "config", "shortcuts.vdf")));
            } catch {
                continue;
            }
            for (const { appid, name, hidden } of shortcuts) {
                const gameId = stableGameId(`steam-shortcut:${appid}`);
                if (hidden || launchers.has(gameId)) continue;
                games.push({ gameId, name, source: "custom" });
                launchers.set(gameId, async () => {
                    await exec(command, [...baseArgs, `steam://rungameid/${shortcutLaunchId(appid)}`]);
                });
            }
        }
    }

    return { games, launchers };
}
