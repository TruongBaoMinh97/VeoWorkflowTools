import { IntegrationError } from '../../contracts/integration.js';
import { fetchIpcBridge } from '../../lib/ipcBridgeFetch.js';

/**
 * Single server-to-Electron transport. Browser and profile adapters should use
 * this class instead of knowing the IPC port, secret or HTTP details.
 */
export class ElectronBrowserBridge {
    constructor(fetchBridge = fetchIpcBridge) {
        this.fetchBridge = fetchBridge;
    }

    async requestJson(path, init) {
        let response;
        try {
            response = await this.fetchBridge(path, init);
        }
        catch (cause) {
            throw new IntegrationError(
                'BROWSER_BRIDGE_UNREACHABLE',
                `Cannot reach the Electron browser bridge: ${cause instanceof Error ? cause.message : String(cause)}`,
                { retryable: true, cause },
            );
        }

        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.ok === false) {
            throw new IntegrationError(
                'BROWSER_BRIDGE_REQUEST_FAILED',
                body?.error ?? `Electron browser bridge returned HTTP ${response.status}`,
                {
                    retryable: response.status >= 500,
                    details: { status: response.status, body },
                },
            );
        }
        return body;
    }
}

export const electronBrowserBridge = new ElectronBrowserBridge();
