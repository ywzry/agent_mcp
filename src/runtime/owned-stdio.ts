import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, type Stream } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';

/** The SDK closes only its direct child. Keep tree ownership until termination is verified. */
export function ownedStdio(params: StdioServerParameters): OwnedStdio {
  return process.platform === 'win32' ? new WindowsStdio(params) : new PosixStdio(params);
}

export interface OwnedStdio extends Transport {
  readonly stderr: Stream | null;
  stop(): Promise<boolean>;
}

class WindowsStdio extends StdioClientTransport implements OwnedStdio {
  private starting?: Promise<void>;
  private stopping?: Promise<boolean>;
  private ownedPid: number | null = null;
  override start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('BACKEND_CLOSED'));
    this.starting = super.start().then(() => { this.ownedPid = this.pid; });
    return this.starting;
  }
  stop(): Promise<boolean> {
    return this.stopping ??= this.stopTree();
  }
  private async stopTree(): Promise<boolean> {
    await this.starting?.catch(() => {});
    const pid = this.ownedPid;
    if (pid === null) return true; // spawn failed before a process existed
    // The SDK observed this root exit already. Its descendants might survive;
    // do not target a saved PID that the OS could have reassigned.
    if (this.pid !== pid) return false;
    // Do this before SDK close: killing the root first loses the Windows tree.
    const killed = await new Promise<boolean>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); resolve(false); }, 2000);
      killer.once('error', () => { clearTimeout(timer); resolve(false); });
      killer.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
    });
    const gone = await waitGone(() => processExists(pid));
    await super.close();
    return killed && gone;
  }
  override async close(): Promise<void> { await this.stop(); }
}

/** POSIX needs a new process group; the SDK's stdio spawn does not create one. */
class PosixStdio implements OwnedStdio {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  readonly stderr = new PassThrough();
  private child?: ChildProcessWithoutNullStreams;
  private stopping?: Promise<boolean>;
  private buffer = new ReadBuffer();
  constructor(private params: StdioServerParameters) {}
  async start(): Promise<void> {
    if (this.child || this.stopping) throw new Error('BACKEND_CLOSED_OR_STARTED');
    const child = this.child = spawn(this.params.command, this.params.args ?? [], {
      env: this.params.env, cwd: this.params.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.pipe(this.stderr);
    child.on('error', error => this.onerror?.(error));
    child.stdin.on('error', error => this.onerror?.(error));
    child.stdout.on('error', error => this.onerror?.(error));
    child.once('close', () => this.onclose?.());
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error as Error); void this.close(); }
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.stopping) throw new Error('BACKEND_CLOSED');
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
    });
  }
  stop(): Promise<boolean> {
    return this.stopping ??= (async () => {
      const pid = this.child?.pid;
      if (!pid) return true;
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
      // Check the group, not just the root: inherited pipes or descendants may outlive it.
      const gone = await waitGone(() => processExists(-pid));
      this.child?.stdin.destroy(); this.child?.stdout.destroy(); this.child?.stderr.destroy();
      this.buffer.clear();
      return gone;
    })();
  }
  async close(): Promise<void> { await this.stop(); }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function waitGone(exists: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (exists()) { if (Date.now() >= deadline) return false; await delay(10); }
  return true;
}
