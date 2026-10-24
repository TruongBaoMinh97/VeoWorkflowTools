/**
 * All HTTP calls to the Electron IPC bridge (127.0.0.1:9223) must send x-local-auth.
 */
import { IPC_BRIDGE_URL } from '../config/ipcBridge.js';
export function fetchIpcBridge(path, init) {
    const secret = process.env.LOCAL_AUTH_SECRET;
    if (!secret) {
        return Promise.reject(new Error('LOCAL_AUTH_SECRET is required for IPC bridge calls. When running the API server inside Electron, it is set automatically.'));
    }
    const url = path.startsWith('http')
        ? path
        : `${IPC_BRIDGE_URL}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = new Headers(init?.headers);
    headers.set('x-local-auth', secret);
    return fetch(url, { ...init, headers });
}
