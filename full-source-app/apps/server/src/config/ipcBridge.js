/**
 * IPC Bridge Configuration
 *
 * Centralized config for Electron IPC Bridge HTTP server.
 * Default port 9223 (next to CDP on 9222). On Windows, port 9223 may be held
 * by a zombie Electron from a prior crashed run — main.ts's startIpcBridge()
 * falls back to 9224..9230 and exports the chosen port via IPC_BRIDGE_PORT,
 * which we read here so the server's fetch targets the right port.
 */
const DEFAULT_PORT = 9223;
function readPortFromEnv() {
    const raw = process.env.IPC_BRIDGE_PORT;
    if (!raw)
        return DEFAULT_PORT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}
export const IPC_BRIDGE_PORT = readPortFromEnv();
export const IPC_BRIDGE_HOST = '127.0.0.1';
export const IPC_BRIDGE_URL = `http://${IPC_BRIDGE_HOST}:${IPC_BRIDGE_PORT}`;
