/**
 * GHSA-wvxc-jp3v-5mg5 — DELETE /api/v1/batches/delete-completed dropped the
 * ownership predicate that every sibling batch operation keeps.
 *
 * `listBatches(apiKeyId?)` / `countBatches(apiKeyId?)` take the caller's key and
 * scope the SQL to `api_key_id = ?`, falling back to instance-wide only when the
 * caller is an authenticated dashboard session. `deleteCompletedBatches()` took
 * no such argument, so any valid inference key — including one with
 * `scopes: []` — deleted every completed batch on the instance and nulled the
 * content of the files those batches referenced.
 *
 * These tests pin the DB-level contract:
 *   - `{ apiKeyId }` sweeps only that key's completed batches;
 *   - `{ allTenants: true }` is the ONLY way to sweep the whole instance — an
 *     empty/missing apiKeyId throws instead of silently widening the sweep;
 *   - batches with `api_key_id IS NULL` are deliberately OUT of a key-scoped
 *     sweep (strict — diverges from the single-batch `scopeCheck` on purpose);
 *   - the sweep is atomic: a failure after the file soft-deletes rolls the file
 *     content back, so no batch row is left pointing at a nulled file;
 *   - a file soft-delete failure is logged, not swallowed, and the batch rows
 *     are still swept.
 *
 * Self-isolating: DATA_DIR is pointed at a fresh temp dir BEFORE any `@/lib/db/*`
 * module loads (dynamic imports below), so this file never touches ~/.omniroute
 * even when run without tests/_setup/isolateDataDir.ts.
 */
import { describe, it, after, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wvxc-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { createFile, getFile, getFileContent } = await import("../../src/lib/db/files.ts");
const { createBatch, getBatch, deleteCompletedBatches } =
  await import("../../src/lib/db/batches.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");

/** One completed batch owned by `apiKeyId`, with its input file. */
function seedCompletedBatch(apiKeyId: string | null, label: string) {
  const file = createFile({
    bytes: 8,
    filename: `${label}.jsonl`,
    purpose: "batch",
    content: Buffer.from(label),
    apiKeyId,
  });
  const batch = createBatch({
    endpoint: "/v1/chat/completions",
    completionWindow: "24h",
    inputFileId: file.id,
    status: "completed",
    apiKeyId,
  });
  return { file, batch };
}

describe("deleteCompletedBatches — ownership boundary (GHSA-wvxc-jp3v-5mg5)", () => {
  after(() => {
    resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("deletes only the caller's completed batches, never another key's", () => {
    const attacker = seedCompletedBatch("key_attacker_wvxc", "wvxc-attacker");
    const victim = seedCompletedBatch("key_victim_wvxc", "wvxc-victim");

    const result = deleteCompletedBatches({ apiKeyId: "key_attacker_wvxc" });

    assert.strictEqual(
      getBatch(attacker.batch.id),
      null,
      "the caller's own completed batch should be deleted"
    );
    assert.ok(
      getBatch(victim.batch.id),
      "another key's completed batch must survive — this is the vulnerability"
    );
    assert.ok(
      getFile(victim.file.id),
      "another key's file content must not be cleared by a foreign caller"
    );
    assert.strictEqual(result.deletedBatches, 1, "only one batch belonged to the caller");
  });

  it("leaves a batch that is not completed alone, even when the caller owns it", () => {
    const own = seedCompletedBatch("key_owner_wvxc", "wvxc-owner");
    const inProgressFile = createFile({
      bytes: 8,
      filename: "wvxc-inprogress.jsonl",
      purpose: "batch",
      content: Buffer.from("running"),
      apiKeyId: "key_owner_wvxc",
    });
    const inProgress = createBatch({
      endpoint: "/v1/chat/completions",
      completionWindow: "24h",
      inputFileId: inProgressFile.id,
      status: "in_progress",
      apiKeyId: "key_owner_wvxc",
    });

    deleteCompletedBatches({ apiKeyId: "key_owner_wvxc" });

    assert.strictEqual(getBatch(own.batch.id), null, "completed batch of the caller goes");
    assert.ok(getBatch(inProgress.id), "an in-progress batch is never swept");
  });

  it("keeps the instance-wide sweep only for the explicit allTenants scope", () => {
    const a = seedCompletedBatch("key_a_wvxc_global", "wvxc-global-a");
    const b = seedCompletedBatch("key_b_wvxc_global", "wvxc-global-b");

    deleteCompletedBatches({ allTenants: true });

    assert.strictEqual(getBatch(a.batch.id), null, "session sweep clears every key");
    assert.strictEqual(getBatch(b.batch.id), null, "session sweep clears every key");
  });

  it("throws on a missing/empty apiKeyId instead of silently sweeping the instance", () => {
    const survivor = seedCompletedBatch("key_survivor_wvxc", "wvxc-survivor");

    assert.throws(
      () => deleteCompletedBatches({ apiKeyId: "" }),
      /apiKeyId required unless allTenants/
    );
    assert.throws(
      // A caller that forgot the scope entirely (JS caller / `any` cast) must not
      // fall through to an instance-wide sweep either.
      () => (deleteCompletedBatches as unknown as (s?: unknown) => unknown)(),
      /apiKeyId required unless allTenants/
    );
    assert.throws(
      () =>
        (deleteCompletedBatches as unknown as (s: unknown) => unknown)({
          apiKeyId: null,
          allTenants: false,
        }),
      /apiKeyId required unless allTenants/
    );
    assert.throws(
      // A mixed scope must be rejected, never silently widened to the instance.
      () =>
        (deleteCompletedBatches as unknown as (s: unknown) => unknown)({
          apiKeyId: "key_survivor_wvxc",
          allTenants: true,
        }),
      /mutually exclusive/
    );

    assert.ok(getBatch(survivor.batch.id), "a rejected call must not delete anything");
    assert.strictEqual(
      getFileContent(survivor.file.id)?.toString(),
      "wvxc-survivor",
      "a rejected call must not null file content"
    );

    deleteCompletedBatches({ apiKeyId: "key_survivor_wvxc" });
  });

  it("STRICT: a batch with api_key_id NULL stays out of a key-scoped sweep (diverges from scopeCheck on purpose)", () => {
    const unowned = seedCompletedBatch(null, "wvxc-unowned");
    const own = seedCompletedBatch("key_strict_wvxc", "wvxc-strict-own");

    const scoped = deleteCompletedBatches({ apiKeyId: "key_strict_wvxc" });

    assert.strictEqual(scoped.deletedBatches, 1, "only the key's own batch is counted");
    assert.strictEqual(getBatch(own.batch.id), null, "the key's own batch goes");
    assert.ok(getBatch(unowned.batch.id), "the NULL-owned batch survives a key-scoped sweep");
    assert.ok(getFile(unowned.file.id), "the NULL-owned batch's file survives");
    assert.strictEqual(
      getFileContent(unowned.file.id)?.toString(),
      "wvxc-unowned",
      "the NULL-owned batch's file content is intact"
    );

    const instanceWide = deleteCompletedBatches({ allTenants: true });

    assert.ok(instanceWide.deletedBatches >= 1, "the allTenants sweep reaches unowned batches");
    assert.strictEqual(getBatch(unowned.batch.id), null, "allTenants removes the NULL-owned batch");
    assert.strictEqual(getFile(unowned.file.id), null, "allTenants soft-deletes its file too");
  });

  it("ATOMIC: a failure after the file soft-deletes rolls the file content back", () => {
    const db = getDbInstance();
    const own = seedCompletedBatch("key_atomic_wvxc", "wvxc-atomic");

    // Test-side failure injection: make the final `DELETE FROM batches` abort. The
    // file soft-deletes and the checkpoint DELETE run before it, so without a
    // transaction the batch row would survive pointing at a nulled file.
    db.exec(
      "CREATE TRIGGER wvxc_abort_batch_delete BEFORE DELETE ON batches BEGIN SELECT RAISE(ABORT, 'wvxc injected failure'); END"
    );
    try {
      assert.throws(
        () => deleteCompletedBatches({ apiKeyId: "key_atomic_wvxc" }),
        /wvxc injected failure/
      );
    } finally {
      db.exec("DROP TRIGGER IF EXISTS wvxc_abort_batch_delete");
    }

    const batch = getBatch(own.batch.id);
    assert.ok(batch, "the batch row is still there after the failed sweep");
    assert.ok(
      getFile(own.file.id),
      "the referenced file is not soft-deleted after the failed sweep"
    );
    assert.strictEqual(
      getFileContent(own.file.id)?.toString(),
      "wvxc-atomic",
      "the file content was rolled back — no batch row points at a nulled file"
    );

    // Sanity: without the injected failure the sweep completes normally.
    const result = deleteCompletedBatches({ apiKeyId: "key_atomic_wvxc" });
    assert.strictEqual(result.deletedBatches, 1);
    assert.strictEqual(result.deletedFiles, 1);
    assert.strictEqual(getFile(own.file.id), null);
  });

  it("logs (does not swallow) a file soft-delete failure and still sweeps the batch rows", () => {
    const db = getDbInstance();
    const own = seedCompletedBatch("key_filefail_wvxc", "wvxc-filefail");
    const warn = mock.method(console, "warn", () => {});

    db.exec(
      "CREATE TRIGGER wvxc_abort_file_update BEFORE UPDATE ON files BEGIN SELECT RAISE(ABORT, 'wvxc file failure'); END"
    );
    let result: { deletedBatches: number; deletedFiles: number };
    try {
      result = deleteCompletedBatches({ apiKeyId: "key_filefail_wvxc" });
    } finally {
      db.exec("DROP TRIGGER IF EXISTS wvxc_abort_file_update");
      warn.mock.restore();
    }

    assert.strictEqual(result.deletedBatches, 1, "batch rows are swept even when a file fails");
    assert.strictEqual(result.deletedFiles, 0, "a failed soft-delete is not counted");
    assert.strictEqual(getBatch(own.batch.id), null);
    const logged = warn.mock.calls
      .map((c) => c.arguments.map((a) => String(a)).join(" "))
      .find((line) => line.includes("deleteCompletedBatches: file soft-delete failed"));
    assert.ok(logged, "the failure is logged at warn level");
    assert.ok(logged!.includes(own.file.id), "the log line names the file id");
  });
});
