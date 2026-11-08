import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LinuxHelper, pairWithService, pairWithLocalService, verifyDeviceSession } from "./helper.js";
import { LocalCatalog } from "./catalog.js";
import { discoverCatalog } from "./discovery/index.js";

const execFileAsync = promisify(execFile);

function defaultStateFile() {
    return process.env.PLAYNITE_HELPER_STATE_FILE ??
        `${process.env.HOME ?? "."}/.config/playnite-helper/device.json`;
}

/**
 * The sample catalog stands in for real discovery of installed Steam/Lutris/
 * Heroic/emulator games. Each launcher here just echoes a message instead of
 * starting a real game, so the prototype is safe to run without any games
 * installed. Replace with real discovery + launch integrations per platform.
 */
function sampleCatalog() {
    const games = [
        { gameId: "29a5daa9-f6d6-4c68-8f9b-7e2b670ba3c3", name: "Example Game", source: "custom" },
        { gameId: "9b2a6e3e-9a2b-4a36-9b0c-7a6d6a9d3a11", name: "Broken Game (always fails)", source: "custom" }
    ];
    const launchers = new Map([
        [games[0].gameId, async (game) => {
            await execFileAsync("/bin/echo", [`Launching ${game.name} (${game.gameId})`]);
        }],
        [games[1].gameId, async () => {
            throw new Error("simulated launch failure");
        }]
    ]);
    return new LocalCatalog(games, launchers);
}

async function commandPair([serviceUrl, pairingCode]) {
    if (!serviceUrl || !pairingCode) {
        throw new Error("usage: cli.js pair <serviceUrl> <pairingCode>");
    }
    const { deviceId, token } = await pairWithService(serviceUrl, pairingCode);
    const stateFile = await saveCredentials(serviceUrl, { deviceId, token });
    console.log(`Paired as device ${deviceId}. Saved credentials to ${stateFile}`);
}

async function saveCredentials(serviceUrl, { deviceId, token }) {
    const stateFile = defaultStateFile();
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ serviceUrl, deviceId, token }, null, 2), { mode: 0o600 });
    return stateFile;
}

async function commandRun({ localServiceUrl, rePair = false } = {}) {
    const stateFile = defaultStateFile();
    let state;
    if (!rePair) {
        try {
            state = JSON.parse(await readFile(stateFile, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT" || !localServiceUrl) {
                throw error;
            }
        }
    }

    if (!state && localServiceUrl) {
        console.log(`${rePair ? "Creating a new local pairing with" : "No saved device credentials. Pairing automatically with"} ${localServiceUrl}...`);
        const credentials = await pairWithLocalService(localServiceUrl);
        await saveCredentials(localServiceUrl, credentials);
        state = { serviceUrl: localServiceUrl, ...credentials };
        console.log(`Paired as device ${state.deviceId}. Saved credentials to ${stateFile}`);
    }

    if (localServiceUrl && state.serviceUrl !== localServiceUrl) {
        throw new Error(`saved credentials belong to ${state.serviceUrl}; use a separate PLAYNITE_HELPER_STATE_FILE or pair with the intended local service`);
    }
    if (localServiceUrl && !rePair && !(await verifyDeviceSession(state.serviceUrl, state.deviceId, state.token))) {
        throw new Error(`saved pairing for device ${state.deviceId} is no longer valid (the local service may have restarted or the device was revoked); run "node src/cli.js run-local --re-pair" to explicitly create a new pairing`);
    }
    if (!state) {
        throw new Error("no saved device credentials; use run-local to pair with a local service, or pair <serviceUrl> <pairingCode> first");
    }

    // PLAYNITE_HELPER_SAMPLE_CATALOG keeps the old echo-based fixture catalog
    // available for demos/tests on machines with no Steam or Lutris games
    // installed. Real runs discover whatever is actually installed.
    const catalog = process.env.PLAYNITE_HELPER_SAMPLE_CATALOG === "1"
        ? sampleCatalog()
        : await discoverCatalog();

    console.log(`Discovered ${catalog.list().length} game(s): ${catalog.list().map((g) => `${g.name} (${g.source})`).join(", ") || "none"}`);

    const helper = new LinuxHelper({
        serviceUrl: state.serviceUrl,
        token: state.token,
        catalog,
        onEvent: (event) => console.log(JSON.stringify(event))
    });
    await helper.connect();
    console.log(`Helper connected as device ${state.deviceId}. Waiting for launch requests (Ctrl+C to stop)...`);
    process.on("SIGINT", () => {
        helper.close();
        process.exit(0);
    });
}

const [, , command, ...args] = process.argv;

try {
    if (command === "pair") {
        await commandPair(args);
    } else if (command === "run") {
        await commandRun();
    } else if (command === "run-local") {
        const serviceUrlArg = args.find((arg) => !arg.startsWith("--"));
        const serviceUrl = new URL(serviceUrlArg ?? "http://127.0.0.1:8787").origin;
        await commandRun({ localServiceUrl: serviceUrl, rePair: args.includes("--re-pair") });
    } else {
        console.error("usage: cli.js <pair|run|run-local> ...");
        process.exitCode = 1;
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
