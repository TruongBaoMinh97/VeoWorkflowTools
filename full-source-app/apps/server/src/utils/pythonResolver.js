import path from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '../lib/logger.js';
const electronProcess = process;
/**
 * Resolve Python binary across packaged Electron + dev modes.
 * Tries platform-specific bundled paths first, then any venv layout, then
 * falls back to system Python.
 */
export function resolvePythonBinary() {
    const resourcesPath = electronProcess.resourcesPath || '';
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const packagedPaths = [];
    if (isWindows) {
        packagedPaths.push(path.join(resourcesPath, 'server', 'binaries', 'python', 'win32-x64', 'python.exe'), path.join(process.cwd(), 'apps', 'server', 'binaries', 'python', 'win32-x64', 'python.exe'), path.join(resourcesPath, 'server', 'python', 'venv', 'Scripts', 'python.exe'), path.join(process.cwd(), 'python', 'venv', 'Scripts', 'python.exe'), path.join(resourcesPath, 'app', 'python', 'venv', 'Scripts', 'python.exe'), path.join(resourcesPath, 'python', 'venv', 'Scripts', 'python.exe'));
    }
    else if (isMac) {
        const primaryArch = `darwin-${arch}`;
        const fallbackArch = arch === 'arm64' ? 'darwin-x64' : 'darwin-arm64';
        packagedPaths.push(path.join(resourcesPath, 'server', 'binaries', 'python', primaryArch, 'bin', 'python3'), path.join(process.cwd(), 'apps', 'server', 'binaries', 'python', primaryArch, 'bin', 'python3'), path.join(resourcesPath, 'server', 'binaries', 'python', fallbackArch, 'bin', 'python3'), path.join(process.cwd(), 'apps', 'server', 'binaries', 'python', fallbackArch, 'bin', 'python3'), path.join(resourcesPath, 'server', 'python', 'venv', 'bin', 'python'), path.join(process.cwd(), 'python', 'venv', 'bin', 'python'), path.join(resourcesPath, 'app', 'python', 'venv', 'bin', 'python'), path.join(resourcesPath, 'python', 'venv', 'bin', 'python'));
    }
    else {
        packagedPaths.push(path.join(resourcesPath, 'server', 'python', 'venv', 'bin', 'python'), path.join(process.cwd(), 'python', 'venv', 'bin', 'python'), path.join(resourcesPath, 'app', 'python', 'venv', 'bin', 'python'), path.join(resourcesPath, 'python', 'venv', 'bin', 'python'));
    }
    for (const pythonPath of packagedPaths) {
        if (existsSync(pythonPath)) {
            logger.info(`[Python] Found at: ${pythonPath}`);
            return pythonPath;
        }
    }
    // Fallback to system Python (development)
    try {
        const whichCmd = process.platform === 'win32' ? 'where python' : 'which python3';
        const out = execSync(whichCmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (out) {
            const first = out.split(/\r?\n/)[0];
            if (first && first.length > 0 && existsSync(first)) {
                logger.info(`[Python] Using system Python: ${first}`);
                return first;
            }
        }
    }
    catch {
        // not found
    }
    return null;
}
/**
 * Resolve a Python script bundled with the server.
 */
export function resolvePythonScript(scriptName) {
    const resourcesPath = electronProcess.resourcesPath || '';
    const scriptPaths = [
        path.join(resourcesPath, 'server', 'python', scriptName),
        path.join(process.cwd(), 'python', scriptName),
        path.join(resourcesPath, 'app', 'python', scriptName),
        path.join(resourcesPath, 'python', scriptName),
        path.join(process.cwd(), 'apps', 'server', 'python', scriptName),
    ];
    for (const scriptPath of scriptPaths) {
        if (existsSync(scriptPath)) {
            return scriptPath;
        }
    }
    return null;
}
