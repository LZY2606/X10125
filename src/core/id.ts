import { randomUUID } from "node:crypto";

export function runId(): string {
  return `run_${randomUUID()}`;
}

export function planId(): string {
  return `plan_${randomUUID()}`;
}
