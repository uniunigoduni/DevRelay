import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { OutputBuffer } from "./output-buffer.js";
import type { CommandSpec, ProcessSnapshot, ShellMode } from "./types.js";

const DEFAULT_PROCESS_BUFFER_CHARS = 1_048_576;
const DEFAULT_EXEC_OUTPUT_CHARS = 524_288;
const COMPLETED_RETENTION_MS = 10 * 60 * 1000;

interface SessionInternal extends ProcessSnapshot {
  child: ChildProcessWithoutNullStreams;
  buffer: OutputBuffer;
  activity: EventEmitter;
  exitPromise: Promise<void>;
  cleanupTimer?: NodeJS.Timeout;
}

interface Invocation {
  file: string;
  args: string[];
  shell: ShellMode;
}

export interface ExecuteOptions {
  stdin?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface ReadOptions {
  cursor?: number;
  maxChars?: number;
  waitMs?: number;
}

export class ProcessManager {
  private readonly sessions = new Map<string, SessionInternal>();

  async execute(spec: CommandSpec, options: ExecuteOptions = {}) {
    const maxOutputChars = options.maxOutputChars ?? DEFAULT_EXEC_OUTPUT_CHARS;
    const session = await this.spawnSession(spec, maxOutputChars, false);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (options.stdin !== undefined) session.child.stdin.end(options.stdin);
    else session.child.stdin.end();

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        void this.killTree(session.pid, true);
      }, options.timeoutMs);
      timer.unref();
    }

    await session.exitPromise;
    if (timer) clearTimeout(timer);

    const output = session.buffer.read(0, maxOutputChars);
    const stdout = output.events.filter((event) => event.stream === "stdout").map((event) => event.text).join("");
    const stderr = output.events.filter((event) => event.stream === "stderr").map((event) => event.text).join("");

    return {
      ok: session.exitCode === 0 && !timedOut,
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut,
      stdout,
      stderr,
      truncated: output.truncated,
      startedAt: session.startedAt,
      endedAt: session.endedAt
    };
  }

  async start(spec: CommandSpec, maxBufferChars = DEFAULT_PROCESS_BUFFER_CHARS): Promise<ProcessSnapshot> {
    const session = await this.spawnSession(spec, maxBufferChars, true);
    this.sessions.set(session.id, session);
    return this.snapshot(session);
  }

  async read(id: string, options: ReadOptions = {}) {
    const session = this.requireSession(id);
    let result = session.buffer.read(options.cursor ?? 0, options.maxChars ?? 65_536);

    if (result.events.length === 0 && session.running && (options.waitMs ?? 0) > 0) {
      await this.waitForActivity(session, options.waitMs!);
      result = session.buffer.read(options.cursor ?? 0, options.maxChars ?? 65_536);
    }

    return {
      ...result,
      process: this.snapshot(session)
    };
  }

  async write(id: string, data: string, end = false) {
    const session = this.requireSession(id);
    if (!session.running) throw new Error(`Process ${id} is not running.`);

    await new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null) => error ? reject(error) : resolve();
      if (end) session.child.stdin.end(data, callback);
      else session.child.stdin.write(data, callback);
    });

    return { bytes: Buffer.byteLength(data), ended: end };
  }

  async stop(id: string, force = true): Promise<ProcessSnapshot> {
    const session = this.requireSession(id);
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);

    if (session.running) {
      await this.killTree(session.pid, force);
      await Promise.race([session.exitPromise, this.sleep(3000)]);
    }

    const snapshot = this.snapshot(session);
    this.sessions.delete(id);
    return snapshot;
  }

  list(): ProcessSnapshot[] {
    return [...this.sessions.values()].map((session) => this.snapshot(session));
  }

  async stopAll(force = true): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map(async (id) => {
      try {
        await this.stop(id, force);
      } catch {
        // Best-effort shutdown.
      }
    }));
  }

  private async spawnSession(spec: CommandSpec, maxBufferChars: number, retain: boolean): Promise<SessionInternal> {
    const invocation = this.resolveInvocation(spec);
    const child = spawn(invocation.file, invocation.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const buffer = new OutputBuffer(maxBufferChars);
    const activity = new EventEmitter();
    const startedAt = new Date().toISOString();
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });

    const session: SessionInternal = {
      id: `p_${randomUUID()}`,
      pid: child.pid!,
      command: spec.command,
      cwd: spec.cwd,
      shell: invocation.shell,
      running: true,
      exitCode: null,
      signal: null,
      startedAt,
      endedAt: null,
      child,
      buffer,
      activity,
      exitPromise
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      buffer.push("stdout", text);
      activity.emit("activity");
    });
    child.stderr.on("data", (text: string) => {
      buffer.push("stderr", text);
      activity.emit("activity");
    });

    let finalized = false;
    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finalized) return;
      finalized = true;
      session.running = false;
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = new Date().toISOString();
      activity.emit("activity");
      resolveExit();

      if (retain) {
        session.cleanupTimer = setTimeout(() => this.sessions.delete(session.id), COMPLETED_RETENTION_MS);
        session.cleanupTimer.unref();
      }
    };

    child.once("exit", finalize);
    child.once("error", (error) => {
      buffer.push("stderr", `[DevRelay process error] ${error.message}\n`);
      finalize(child.exitCode, child.signalCode);
    });

    return session;
  }

  private resolveInvocation(spec: CommandSpec): Invocation {
    const shell = spec.shell ?? "auto";
    if (shell === "direct") return { file: spec.command, args: spec.args ?? [], shell };
    if (spec.args?.length) throw new Error("args is supported only when shell is 'direct'.");

    if (shell === "powershell") {
      return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", spec.command], shell };
    }
    if (shell === "pwsh") {
      return { file: "pwsh.exe", args: ["-NoLogo", "-NoProfile", "-Command", spec.command], shell };
    }
    if (shell === "cmd") {
      return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", spec.command], shell };
    }

    if (process.platform === "win32") {
      return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", spec.command], shell };
    }

    return { file: process.env.SHELL ?? "/bin/sh", args: ["-lc", spec.command], shell };
  }

  private async killTree(pid: number, force: boolean): Promise<void> {
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const args = ["/PID", String(pid), "/T"];
        if (force) args.push("/F");
        const killer = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      });
      return;
    }

    const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(-pid, signal);
    } catch {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }

  private requireSession(id: string): SessionInternal {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown process: ${id}`);
    return session;
  }

  private snapshot(session: SessionInternal): ProcessSnapshot {
    return {
      id: session.id,
      pid: session.pid,
      command: session.command,
      cwd: session.cwd,
      shell: session.shell,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      startedAt: session.startedAt,
      endedAt: session.endedAt
    };
  }

  private waitForActivity(session: SessionInternal, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, waitMs);
      timer.unref();
      session.activity.once("activity", done);

      function done() {
        clearTimeout(timer);
        session.activity.off("activity", done);
        resolve();
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
