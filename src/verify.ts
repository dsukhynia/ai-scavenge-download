/**
 * Verification: the safety net between "replay finished" and "deliver the file".
 *
 * The failure this exists to catch is not the crash — it is the run that
 * completes happily and hands over an HTML error page, a login redirect, or
 * last month's document. Anything that fails a check is quarantined rather
 * than delivered, and `next_due_at` is not advanced.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { Expect } from "./recipe.js";

/**
 * Sniff the real type from magic bytes. Deliberately not the Content-Type
 * header: a misconfigured portal serving an HTML "session expired" page as
 * application/pdf is exactly the case this must catch.
 */
export function sniffContentType(buf: Buffer): string {
  const head = buf.subarray(0, 8);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head.subarray(0, 4).toString("latin1") === "PK\x03\x04") {
    // xlsx/docx are zips; a real deployment would peek at the archive members.
    return "application/zip";
  }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const text = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "text/html";
  return "application/octet-stream";
}

export interface DownloadInfo {
  path: string;
  suggestedFilename: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export async function inspect(
  filePath: string,
  suggestedFilename: string,
): Promise<DownloadInfo> {
  const buf = await readFile(filePath);
  const { size } = await stat(filePath);
  return {
    path: filePath,
    suggestedFilename,
    bytes: size,
    sha256: createHash("sha256").update(buf).digest("hex"),
    contentType: sniffContentType(buf),
  };
}

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  /** Byte-identical to the previous accepted run for this site. */
  duplicate: boolean;
}

export function verify(
  info: DownloadInfo,
  expect: Expect,
  previousSha256?: string,
): VerifyResult {
  const failures: string[] = [];

  if (info.contentType !== expect.content_type) {
    failures.push(
      `content type: expected ${expect.content_type}, sniffed ${info.contentType}`,
    );
  }
  if (info.bytes < expect.min_bytes) {
    failures.push(`size: ${info.bytes} bytes is below minimum ${expect.min_bytes}`);
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(expect.filename_pattern);
  } catch (err) {
    failures.push(`filename_pattern is not a valid regex: ${String(err)}`);
    return { ok: false, failures, duplicate: false };
  }
  if (!pattern.test(info.suggestedFilename)) {
    failures.push(
      `filename: "${info.suggestedFilename}" does not match /${expect.filename_pattern}/`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    duplicate: previousSha256 !== undefined && previousSha256 === info.sha256,
  };
}
