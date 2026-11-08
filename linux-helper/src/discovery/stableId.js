import { createHash } from "node:crypto";

// A fixed, private namespace UUID for this helper's discovery-derived game
// ids. Using UUIDv5 (name-based, SHA-1) means the same Steam appid or Lutris
// slug always maps to the same gameId across helper restarts and rescans,
// without the helper needing to persist an id-allocation table.
const NAMESPACE = "6ba7b815-9dad-11d1-80b4-00c04fd430c8";

function uuidToBytes(uuid) {
    const hex = uuid.replace(/-/g, "");
    const bytes = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function bytesToUuid(bytes) {
    const hex = bytes.toString("hex");
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32)
    ].join("-");
}

/**
 * Deterministic UUIDv5 derived from a namespace UUID and a name string.
 * Used to turn a stable external identifier (e.g. "steam:1245620") into a
 * gameId that stays constant across rescans without persisting a mapping.
 */
export function stableGameId(name) {
    const hash = createHash("sha1")
        .update(uuidToBytes(NAMESPACE))
        .update(name, "utf8")
        .digest();

    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
    return bytesToUuid(bytes);
}
