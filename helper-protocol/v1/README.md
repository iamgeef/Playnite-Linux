# Helper protocol v1

`schema.json` defines the JSON message contract shared by the hosted service and local game helpers. The `platform` and `capabilities` fields allow Linux, Windows, and macOS helpers to identify themselves without putting operating-system-specific process execution in the service.

## Connection and identity

The helper initiates an authenticated TLS WebSocket connection to the service. The service binds the paired device identity to the authenticated connection; clients must not select a device by including an arbitrary device ID in a message. Pairing credentials must be revocable and scoped to one helper.

## Launch flow

1. The helper reports its platform and supported capabilities.
2. The helper publishes a catalog snapshot. A `gameId` is local to the paired helper and resolves only to a game the helper discovered or the user explicitly registered.
3. Following an authenticated, intentional user action in the web app, the service sends a `launch.request` to the selected paired helper.
4. The helper accepts a request only if it is addressed to its authenticated session, its time window has not expired, its `requestId` has not already been processed, and the game is still in its local catalog.
5. The helper launches the locally registered game and returns a `launch.result`.

Launch requests intentionally contain no executable path, shell command, or process arguments. Helpers must not add support for executing arbitrary command text from the service. V1 requests expire no more than 60 seconds after issuance; helpers should reject requests issued more than 60 seconds in the future and retain processed request IDs for at least 10 minutes. The transport/session layer must authenticate the sender and protect messages in transit; schema validation alone is not authorization.

## Compatibility

`protocolVersion` is a breaking-contract version. Additive changes require a new compatible schema revision and explicit capability negotiation before use. A helper should reject unsupported protocol versions rather than attempting to interpret them.

Run the contract tests with `node --test helper-protocol/v1/protocol.test.mjs`.

Catalog games may carry an optional integer `steamAppId` (Steam games only), which lets the web UI load public cover art.
