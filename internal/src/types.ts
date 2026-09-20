export type ShellMode = "auto" | "cmd" | "powershell" | "pwsh" | "direct";

export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: ShellMode;
}

export interface OutputEvent {
  cursor: number;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: string;
}

export interface ProcessSnapshot {
  id: string;
  pid: number;
  command: string;
  cwd?: string;
  shell: ShellMode;
  terminal: boolean;
  columns: number | null;
  rows: number | null;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string | null;
}
