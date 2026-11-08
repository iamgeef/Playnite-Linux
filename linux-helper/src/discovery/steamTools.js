// Steam installs runtimes, compatibility tools and redistributables as apps;
// they are not games and should not appear in the library.
const TOOL_APP_IDS = new Set([
    228980, // Steamworks Common Redistributables
    1070560, // Steam Linux Runtime 1.0 (scout)
    1391110, // Steam Linux Runtime 2.0 (soldier)
    1628350, // Steam Linux Runtime 3.0 (sniper)
    1493710, // Proton Experimental
    2180100 // Proton Hotfix
]);

const TOOL_NAME_PATTERNS = [
    /^Steam Linux Runtime\b/i,
    /^Proton(\s|$)/i,
    /^Steamworks Common Redistributables$/i,
    /^Steam Controller Configs\b/i
];

export function isSteamTool(appid, name) {
    return TOOL_APP_IDS.has(Number(appid)) || TOOL_NAME_PATTERNS.some((pattern) => pattern.test(name ?? ""));
}
