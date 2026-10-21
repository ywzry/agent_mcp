import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  ArtifactRef, CompactionState, QueuedInput, Run, Session, SessionEvent,
} from './types.js';

export interface SessionFile {
  version: 1;
  session: Session;
  runs: Run[];
  events: SessionEvent[];
  inbox: QueuedInput[];
  context: CompactionState | null;
  artifacts: ArtifactRef[];
}

interface LockFile { pid: number; started_at: string; label: string }

const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
/** Detects a second manager in this process even though the lock pid matches. */
const ownedDirs = new Set<string>();

/**
 * One JSON snapshot per session, replaced atomically. Event appends therefore
 * cannot leave a half-written session record after a crash. Artifact bytes live
 * beside the snapshots and are only referenced by id.
 */
export class Store {
  private lockPath: string | undefined;
  private artifactCache = new Map<string, Buffer>();
  private tmpCounter = 0;
  readonly warnings: string[] = [];

  constructor(readonly dir: string | undefined, label = 'agent-mcp') {
    if (!dir) return;
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    this.lockPath = join(dir, 'lock.json');
    this.acquireLock(label);
    ownedDirs.add(dir);
  }

  get persistent(): boolean { return this.dir !== undefined; }

  loadSessions(): SessionFile[] {
    if (!this.dir) return [];
    const sessionsDir = join(this.dir, 'sessions');
    const files: SessionFile[] = [];
    for (const entry of readdirSync(sessionsDir)) {
      if (!entry.endsWith('.json')) continue;
      const full = join(sessionsDir, entry);
      try {
        if (statSync(full).size > MAX_SESSION_FILE_BYTES) throw new Error('state file too large');
        const value = JSON.parse(readFileSync(full, 'utf8')) as SessionFile;
        if (value.version !== 1 || !value.session?.id || !Array.isArray(value.runs) ||
            !Array.isArray(value.session.history) || !Array.isArray(value.session.run_ids) ||
            value.session.run_ids.length === 0 || value.runs.length === 0 ||
            !value.session.run_ids.every((id: string) => value.runs.some(run => run.id === id)) ||
            !Array.isArray(value.events) || !Array.isArray(value.inbox) || !Array.isArray(value.artifacts))
          throw new Error('unrecognized session file');
        files.push(value);
      } catch (error) {
        const quarantine = `${full}.corrupt-${Date.now()}`;
        try { renameSync(full, quarantine); } catch { /* keep original if rename fails */ }
        this.warnings.push(`Skipped corrupt state file ${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return files.sort((a, b) => a.session.created_at.localeCompare(b.session.created_at));
  }

  saveSession(file: SessionFile): void {
    if (!this.dir) return;
    this.atomicWrite(join(this.dir, 'sessions', `${file.session.id}.json`), JSON.stringify(file));
  }

  saveArtifact(ref: ArtifactRef, data: Buffer): void {
    if (!this.dir) {
      this.artifactCache.set(ref.id, Buffer.from(data));
      return;
    }
    this.atomicWrite(join(this.dir, 'artifacts', `${ref.id}.bin`), data);
  }

  readArtifact(ref: ArtifactRef): Buffer {
    const cached = this.artifactCache.get(ref.id);
    if (cached) return cached;
    if (!this.dir) throw new Error('ARTIFACT_NOT_FOUND');
    try {
      const data = readFileSync(join(this.dir, 'artifacts', `${ref.id}.bin`));
      this.artifactCache.set(ref.id, data);
      return data;
    } catch {
      throw new Error('ARTIFACT_NOT_FOUND');
    }
  }

  /** Manual retention: delete terminal sessions whose last run finished before the cutoff. */
  pruneSessionsBefore(cutoff: string): { sessions: number; artifacts: number } {
    if (!this.dir) throw new Error('PERSISTENCE_DISABLED: state_dir is not configured');
    const when = Date.parse(cutoff);
    if (Number.isNaN(when)) throw new Error('INVALID_CUTOFF: use an ISO timestamp');
    let sessions = 0;
    let artifacts = 0;
    for (const file of this.loadSessions()) {
      const finished = file.runs.map(run => Date.parse(run.finished_at ?? '')).filter(value => !Number.isNaN(value));
      const terminal = file.runs.every(run => ['completed', 'failed', 'cancelled'].includes(run.status));
      if (!terminal || file.runs.length === 0 || finished.length !== file.runs.length) continue;
      if (Math.max(...finished) >= when) continue;
      for (const ref of file.artifacts) {
        try { unlinkSync(join(this.dir, 'artifacts', `${ref.id}.bin`)); artifacts++; } catch { /* already gone */ }
      }
      try { unlinkSync(join(this.dir, 'sessions', `${file.session.id}.json`)); sessions++; } catch { /* already gone */ }
    }
    return { sessions, artifacts };
  }

  /** Manual retention: remove artifacts older than the cutoff but keep sessions/events. */
  pruneArtifactsBefore(cutoff: string): { artifacts: number; sessions: number } {
    if (!this.dir) throw new Error('PERSISTENCE_DISABLED: state_dir is not configured');
    const when = Date.parse(cutoff);
    if (Number.isNaN(when)) throw new Error('INVALID_CUTOFF: use an ISO timestamp');
    let artifacts = 0;
    let sessions = 0;
    for (const file of this.loadSessions()) {
      const keep = file.artifacts.filter(ref => {
        const created = Date.parse(ref.created_at);
        return Number.isNaN(created) || created >= when;
      });
      if (keep.length === file.artifacts.length) continue;
      for (const ref of file.artifacts) {
        if (keep.some(item => item.id === ref.id)) continue;
        try { unlinkSync(join(this.dir, 'artifacts', `${ref.id}.bin`)); artifacts++; } catch { /* already gone */ }
      }
      file.artifacts = keep;
      this.saveSession(file);
      sessions++;
    }
    return { artifacts, sessions };
  }

  close(): void {
    if (this.lockPath && existsSync(this.lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as LockFile;
        if (lock.pid === process.pid) unlinkSync(this.lockPath);
      } catch { /* best effort */ }
    }
    if (this.dir) ownedDirs.delete(this.dir);
    this.artifactCache.clear();
  }

  private acquireLock(label: string): void {
    if (!this.lockPath || !this.dir) return;
    if (ownedDirs.has(this.dir))
      throw new Error(`STATE_DIR_IN_USE: this process already has an open manager for ${this.dir}`);
    const existing = this.readLock();
    if (existing && existing.pid !== process.pid && isAlive(existing.pid))
      throw new Error(`STATE_DIR_IN_USE: pid ${existing.pid} (${existing.label}) already owns ${this.dir}`);
    const lock: LockFile = { pid: process.pid, started_at: new Date().toISOString(), label };
    const tmp = `${this.lockPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lock));
    renameWithRetry(tmp, this.lockPath);
  }

  private readLock(): LockFile | undefined {
    if (!this.lockPath || !existsSync(this.lockPath)) return undefined;
    try { return JSON.parse(readFileSync(this.lockPath, 'utf8')) as LockFile; } catch { return undefined; }
  }

  private atomicWrite(target: string, value: string | Buffer): void {
    const tmp = `${target}.${process.pid}.${++this.tmpCounter}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, typeof value === 'string' ? Buffer.from(value) : value);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmp, target);
  }
}

/**
 * Windows antivirus/indexers can briefly hold a freshly written file and make
 * MoveFileEx fail with EPERM/EBUSY/EACCES. Retry a few times instead of
 * failing the whole Run at a state checkpoint.
 */
function renameWithRetry(source: string, target: string): void {
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOENT') throw error;
      last = error;
      sleepSync(Math.min(20 * (attempt + 1), 200));
    }
  }
  throw last;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
