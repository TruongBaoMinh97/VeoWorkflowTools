/**
 * spawnFfmpeg — shared child-process wrapper for the bundled ffmpeg binary.
 *
 * stderr is buffered rather than inherited so a failure surfaces the tail of
 * ffmpeg's own diagnostics (the useful part) instead of an opaque exit code.
 */
import { spawn } from 'node:child_process';
const STDERR_TAIL_CHARS = 800;
export function spawnFfmpeg(binary, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stderr = [];
        proc.stderr?.on('data', (chunk) => stderr.push(chunk));
        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            }
            else {
                const tail = Buffer.concat(stderr).toString('utf8').slice(-STDERR_TAIL_CHARS);
                reject(new Error(`ffmpeg exited with code ${code}:\n${tail}`));
            }
        });
        proc.on('error', (err) => reject(new Error(`Failed to spawn ffmpeg (${binary}): ${err.message}`)));
    });
}
