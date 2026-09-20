import { appendFile } from "node:fs/promises";

export interface AuditFields {
  [key: string]: string | number | boolean | null | undefined;
}

export function writeAudit(event: string, fields: AuditFields = {}): void {
  const path = process.env.DEVRELAY_AUDIT_LOG;
  if (!path) return;

  const payload = JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...fields
  });

  void appendFile(path, `${payload}\n`, "utf8").catch(() => {
    // Audit logging must never break command execution.
  });
}
