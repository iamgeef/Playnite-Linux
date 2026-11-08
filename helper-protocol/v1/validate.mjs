// Shared JSON Schema validator for the Playnite helper protocol v1 contract.
//
// This is a small, dependency-free validator covering only the schema features
// used by schema.json (oneOf/allOf/if-then-else/not, object/array/string/integer
// constraints, const/enum, $ref into #/$defs). It is shared by the hosted-service
// and linux-helper prototypes so both enforce exactly the same message contract.
import { readFile } from "node:fs/promises";

const schemaUrl = new URL("schema.json", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

export class SchemaValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "SchemaValidationError";
    }
}

function resolveReference(reference) {
    if (!/^#\/\$defs\/[A-Za-z]+$/.test(reference)) {
        throw new SchemaValidationError(`Unsupported $ref: ${reference}`);
    }
    const definition = schema.$defs[reference.slice("#/$defs/".length)];
    if (!definition) {
        throw new SchemaValidationError(`Unknown $ref target: ${reference}`);
    }
    return definition;
}

function fail(path, message) {
    throw new SchemaValidationError(`${path} ${message}`);
}

function matches(candidateSchema, value) {
    try {
        validateAgainst(candidateSchema, value);
        return true;
    } catch (error) {
        if (error instanceof SchemaValidationError) {
            return false;
        }
        throw error;
    }
}

function validateAgainst(currentSchema, value, path = "$") {
    if (currentSchema.$ref) {
        validateAgainst(resolveReference(currentSchema.$ref), value, path);
        return;
    }

    if (currentSchema.oneOf) {
        const matchingSchemas = currentSchema.oneOf.filter((item) => matches(item, value));
        if (matchingSchemas.length !== 1) {
            fail(path, `must match exactly one schema (matched ${matchingSchemas.length})`);
        }
    }

    if (currentSchema.allOf) {
        for (const item of currentSchema.allOf) {
            validateAgainst(item, value, path);
        }
    }

    if (currentSchema.if) {
        const branch = matches(currentSchema.if, value) ? currentSchema.then : currentSchema.else;
        if (branch) {
            validateAgainst(branch, value, path);
        }
    }

    if (currentSchema.not && matches(currentSchema.not, value)) {
        fail(path, "must not match forbidden schema");
    }

    if (currentSchema.type === "object") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            fail(path, "must be an object");
        }
    } else if (currentSchema.type === "array") {
        if (!Array.isArray(value)) {
            fail(path, "must be an array");
        }
        if (currentSchema.maxItems !== undefined && value.length > currentSchema.maxItems) {
            fail(path, "has too many items");
        }
        if (currentSchema.uniqueItems) {
            const uniqueCount = new Set(value.map((item) => JSON.stringify(item))).size;
            if (uniqueCount !== value.length) {
                fail(path, "items must be unique");
            }
        }
        if (currentSchema.items) {
            value.forEach((item, index) => validateAgainst(currentSchema.items, item, `${path}[${index}]`));
        }
    } else if (currentSchema.type === "string") {
        if (typeof value !== "string") {
            fail(path, "must be a string");
        }
        if (currentSchema.minLength !== undefined && value.length < currentSchema.minLength) {
            fail(path, "is too short");
        }
        if (currentSchema.maxLength !== undefined && value.length > currentSchema.maxLength) {
            fail(path, "is too long");
        }
        if (currentSchema.pattern && !new RegExp(currentSchema.pattern).test(value)) {
            fail(path, "has an invalid format");
        }
        if (currentSchema.format === "uuid" &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
            fail(path, "must be a UUID");
        }
        if (currentSchema.format === "date-time") {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
                fail(path, "must be an RFC 3339 date-time");
            }
            if (!Number.isFinite(Date.parse(value))) {
                fail(path, "must be a valid date-time");
            }
        }
    } else if (currentSchema.type === "integer") {
        if (!Number.isInteger(value)) {
            fail(path, "must be an integer");
        }
        if (currentSchema.minimum !== undefined && value < currentSchema.minimum) {
            fail(path, `must be >= ${currentSchema.minimum}`);
        }
        if (currentSchema.maximum !== undefined && value > currentSchema.maximum) {
            fail(path, `must be <= ${currentSchema.maximum}`);
        }
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const key of currentSchema.required ?? []) {
            if (!Object.hasOwn(value, key)) {
                fail(`${path}.${key}`, "is required");
            }
        }
        if (currentSchema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!Object.hasOwn(currentSchema.properties ?? {}, key)) {
                    fail(`${path}.${key}`, "is not allowed");
                }
            }
        }
        for (const [key, propertySchema] of Object.entries(currentSchema.properties ?? {})) {
            if (Object.hasOwn(value, key)) {
                validateAgainst(propertySchema, value[key], `${path}.${key}`);
            }
        }
    }

    if (Object.hasOwn(currentSchema, "const") && value !== currentSchema.const) {
        fail(path, `must equal ${JSON.stringify(currentSchema.const)}`);
    }
    if (currentSchema.enum && !currentSchema.enum.includes(value)) {
        fail(path, "is not an allowed value");
    }
}

/** Validate a decoded message against the full v1 message union (oneOf helper.hello / catalog.snapshot / launch.request / launch.result). */
export function validateMessage(value) {
    validateAgainst(schema, value);
}

/** Validate a decoded message against one named $defs schema (e.g. "launchRequest"), for targeted checks. */
export function validateAs(defName, value) {
    const definition = schema.$defs[defName];
    if (!definition) {
        throw new SchemaValidationError(`Unknown schema definition: ${defName}`);
    }
    validateAgainst(definition, value, "$");
}

/** Launch requests must be issued recently and expire within the protocol's bounded window. */
export function validateLaunchWindow(message, { now = Date.now(), maxLifetimeMs = 60_000, maxClockSkewMs = 60_000 } = {}) {
    const issuedAt = Date.parse(message.issuedAt);
    const expiresAt = Date.parse(message.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
        throw new SchemaValidationError("launch request must have valid issuedAt/expiresAt timestamps");
    }
    if (issuedAt > now + maxClockSkewMs) {
        throw new SchemaValidationError("launch request must not be issued in the future");
    }
    if (expiresAt <= now) {
        throw new SchemaValidationError("launch request must not be expired");
    }
    if (expiresAt <= issuedAt) {
        throw new SchemaValidationError("launch request must expire after issuance");
    }
    if (expiresAt - issuedAt > maxLifetimeMs) {
        throw new SchemaValidationError(`launch request lifetime must not exceed ${maxLifetimeMs}ms`);
    }
}

export const PROTOCOL_VERSION = 1;
export const schemaDocument = schema;
