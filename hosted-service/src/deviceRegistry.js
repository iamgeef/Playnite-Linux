import { randomUUID, randomBytes } from "node:crypto";

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

function generatePairingCode() {
    // Short, user-typeable code for the local prototype. A production service
    // would want higher entropy and rate limiting on guesses.
    return randomBytes(4).toString("hex");
}

function generateDeviceToken() {
    return randomBytes(32).toString("base64url");
}

/**
 * Tracks pairing codes and paired devices for one hosted-service account.
 * This is an in-memory prototype: a real implementation needs persistent,
 * per-account storage and audit logging of pairing/revocation events.
 */
export class DeviceRegistry {
    #pairingCodes = new Map(); // code -> { expiresAt }
    #devices = new Map(); // deviceId -> { token, platform, capabilities, revoked, connection }
    #tokenToDeviceId = new Map(); // token -> deviceId

    createPairingCode() {
        const code = generatePairingCode();
        this.#pairingCodes.set(code, { expiresAt: Date.now() + PAIRING_CODE_TTL_MS });
        return { pairingCode: code, expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString() };
    }

    /** Redeem a pairing code for a brand-new device identity and token. Codes are single-use. */
    redeemPairingCode(code) {
        const entry = this.#pairingCodes.get(code);
        this.#pairingCodes.delete(code);
        if (!entry || entry.expiresAt < Date.now()) {
            return null;
        }
        const deviceId = randomUUID();
        const token = generateDeviceToken();
        this.#devices.set(deviceId, {
            token,
            platform: null,
            capabilities: [],
            revoked: false,
            connection: null,
            lastCatalog: null,
            pairedAt: new Date().toISOString()
        });
        this.#tokenToDeviceId.set(token, deviceId);
        return { deviceId, token };
    }

    /** Resolve an existing device token to its device record, if the device has not been revoked. */
    authenticate(token) {
        const deviceId = this.#tokenToDeviceId.get(token);
        if (!deviceId) {
            return null;
        }
        const device = this.#devices.get(deviceId);
        if (!device || device.revoked) {
            return null;
        }
        return { deviceId, device };
    }

    setConnection(deviceId, connection) {
        const device = this.#devices.get(deviceId);
        if (device) {
            device.connection = connection;
        }
    }

    recordHello(deviceId, { platform, capabilities }) {
        const device = this.#devices.get(deviceId);
        if (device) {
            device.platform = platform;
            device.capabilities = capabilities;
        }
    }

    recordCatalog(deviceId, games) {
        const device = this.#devices.get(deviceId);
        if (device) {
            device.lastCatalog = games;
        }
    }

    get(deviceId) {
        return this.#devices.get(deviceId) ?? null;
    }

    list() {
        return [...this.#devices.entries()].map(([deviceId, device]) => ({
            deviceId,
            platform: device.platform,
            capabilities: device.capabilities,
            connected: device.connection !== null,
            revoked: device.revoked,
            pairedAt: device.pairedAt,
            catalogSize: device.lastCatalog?.length ?? 0
        }));
    }

    /** Revoke a device: invalidate its token and close any live connection. Revocation cannot be undone by design. */
    revoke(deviceId) {
        const device = this.#devices.get(deviceId);
        if (!device) {
            return false;
        }
        device.revoked = true;
        this.#tokenToDeviceId.delete(device.token);
        if (device.connection) {
            device.connection.close(4001, "device revoked");
            device.connection = null;
        }
        return true;
    }
}
