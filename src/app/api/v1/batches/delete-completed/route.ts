import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { deleteCompletedBatches, type DeleteCompletedBatchesScope } from "@/lib/db/batches";
import { NextResponse } from "next/server";
import { getApiKeyRequestScope } from "@/app/api/v1/_helpers/apiKeyScope";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import * as log from "@/sse/utils/logger";

const LOG_ROUTE = "batches/delete-completed";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function DELETE(request: Request) {
  const scope = await getApiKeyRequestScope(request);
  if (scope.rejection) return scope.rejection;

  // Fail closed on an unresolvable credential: a presented key that the DB does
  // not know (deleted, rotated, mistyped) must never fall through to the session
  // branch and widen a destructive sweep to the whole instance.
  if (scope.apiKey && !scope.apiKeyId) {
    log.warn("BATCHES", "delete-completed: presented API key did not resolve", {
      route: LOG_ROUTE,
      isSessionAuth: scope.isSessionAuth,
    });
    return NextResponse.json(
      { error: { message: "Invalid API key", type: "invalid_request_error" } },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  // A presented API key always scopes the sweep to that key — even when the
  // request also carries a dashboard session cookie — exactly like the
  // list/count siblings (`apiKeyId || undefined`), so a leaked or over-shared
  // key can never widen a destructive sweep. Only a dashboard session WITHOUT a
  // key sweeps the whole instance; otherwise an ordinary key would delete every
  // tenant's completed batches and null out their file contents
  // (GHSA-wvxc-jp3v-5mg5). A caller that is neither gets 401; there is no
  // fallback that silently widens the sweep.
  let sweepScope: DeleteCompletedBatchesScope;
  let mode: "instance" | "api_key";
  if (scope.apiKeyId) {
    sweepScope = { apiKeyId: scope.apiKeyId };
    mode = "api_key";
  } else if (scope.isSessionAuth) {
    sweepScope = { allTenants: true };
    mode = "instance";
  } else {
    return NextResponse.json(
      { error: { message: "Authentication required", type: "invalid_request_error" } },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  let result: ReturnType<typeof deleteCompletedBatches>;
  try {
    result = deleteCompletedBatches(sweepScope);
  } catch (err) {
    log.error("BATCHES", "delete-completed sweep failed", {
      route: LOG_ROUTE,
      mode,
      apiKeyId: scope.apiKeyId,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    });
    return NextResponse.json(buildErrorBody(500, "Failed to delete completed batches"), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }

  const audit = {
    route: LOG_ROUTE,
    mode,
    apiKeyId: scope.apiKeyId,
    deletedBatches: result.deletedBatches,
    deletedFiles: result.deletedFiles,
  };
  // A bulk delete is an audit event, not routine chatter: an instance-wide sweep
  // and any key-scoped sweep that actually removed rows log at warn so the trail
  // survives APP_LOG_LEVEL=warn; a no-op key-scoped sweep stays at info so a
  // caller looping on the endpoint cannot flood the warn log.
  if (mode === "instance") {
    log.warn("BATCHES", "instance-wide completed-batch sweep", audit);
  } else if (result.deletedBatches > 0) {
    log.warn("BATCHES", "completed-batch sweep", audit);
  } else {
    log.info("BATCHES", "completed-batch sweep (no-op)", audit);
  }

  return NextResponse.json(
    { deleted: true, deletedBatches: result.deletedBatches, deletedFiles: result.deletedFiles },
    { headers: CORS_HEADERS }
  );
}
