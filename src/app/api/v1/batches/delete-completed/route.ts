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

  // Only an authenticated dashboard session sweeps the whole instance. Every
  // other caller is an inference key and only sweeps its own completed batches,
  // like the list/count siblings do — otherwise an ordinary key would delete
  // every tenant's completed batches and null out their file contents
  // (GHSA-wvxc-jp3v-5mg5). A caller that is neither gets 401; there is no
  // fallback that silently widens the sweep.
  let sweepScope: DeleteCompletedBatchesScope;
  if (scope.isSessionAuth) {
    sweepScope = { allTenants: true };
  } else if (scope.apiKeyId) {
    sweepScope = { apiKeyId: scope.apiKeyId };
  } else {
    return NextResponse.json(
      { error: { message: "Authentication required", type: "invalid_request_error" } },
      { status: 401, headers: CORS_HEADERS }
    );
  }
  const mode: "instance" | "api_key" = scope.isSessionAuth ? "instance" : "api_key";

  let result: ReturnType<typeof deleteCompletedBatches>;
  try {
    result = deleteCompletedBatches(sweepScope);
  } catch (err) {
    log.error("BATCHES", "delete-completed sweep failed", {
      route: LOG_ROUTE,
      mode,
      apiKeyId: scope.apiKeyId,
      error: err instanceof Error ? err.message : String(err),
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
  if (mode === "instance") {
    log.warn("BATCHES", "instance-wide completed-batch sweep", audit);
  } else {
    log.info("BATCHES", "completed-batch sweep", audit);
  }

  return NextResponse.json(
    { deleted: true, deletedBatches: result.deletedBatches, deletedFiles: result.deletedFiles },
    { headers: CORS_HEADERS }
  );
}
