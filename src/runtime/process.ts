import { spawn } from 'node:child_process';

export interface CommandResult {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
  /** True when the 2s reaper fallback fired before the child close event. */
  cleanup_unconfirmed: boolean;
}

export interface CommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs through a shell because tasks need real test commands. Cancellation
 * waits for the process tree to exit before resolving.
 */
export function runCommand(options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const isWindows = process.platform === 'win32';
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), NO_COLOR: '1', CI: '1' };
    let child;
    try {
      child = spawn(options.command, {
        cwd: options.cwd, env, shell: true, windowsHide: true,
        detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let cleanupUnconfirmed = false;

    const collect = (chunk: Buffer, stream: 'out' | 'err') => {
      if (bytes >= options.maxBytes) { truncated = true; return; }
      const remaining = options.maxBytes - bytes;
      const slice = chunk.subarray(0, Math.max(0, remaining));
      if (slice.length < chunk.length) truncated = true;
      bytes += slice.length;
      const text = slice.toString('utf8');
      if (stream === 'out') stdout += text; else stderr += text;
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        exit_code: code, signal, stdout, stderr, timed_out: timedOut,
        truncated, duration_ms: Date.now() - started, cleanup_unconfirmed: cleanupUnconfirmed,
      });
    };

    const killTree = () => {
      if (!child.pid) return;
      if (isWindows) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      killTree();
      // A hung taskkill/process reaper must not hold the session slot forever.
      // Mark this explicitly rather than pretending the tree was confirmed dead.
      setTimeout(() => {
        cleanupUnconfirmed = true;
        finish(null, 'SIGKILL');
      }, 2000).unref();
    };
    const onAbort = () => stop();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref?.();

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
}
