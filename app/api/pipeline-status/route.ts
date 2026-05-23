import { NextRequest } from "next/server";
import { getJob, subscribeToJob } from "@/lib/pipeline/runner";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");

  if (!id) {
    return new Response("Missing id parameter", { status: 400 });
  }

  const job = getJob(id);
  if (!job) {
    return new Response("Job not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try { controller.enqueue(chunk); } catch { closed = true; }
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      // Send initial state — include result so a reconnect mid-run gets back the images
      // that already streamed in, instead of an empty grid.
      const initialData = JSON.stringify({
        type: "init",
        job: {
          id: job.id,
          status: job.status,
          currentStep: job.currentStep,
          steps: job.steps,
          params: job.params,
          pilotIndices: job.pilotIndices,
          resumedFromPilotId: job.resumedFromPilotId,
          result: job.result,
        },
      });
      safeEnqueue(encoder.encode(`data: ${initialData}\n\n`));

      // Subscribe to updates
      const unsubscribe = subscribeToJob(id, (event) => {
        const data = JSON.stringify({ type: "step", event });
        safeEnqueue(encoder.encode(`data: ${data}\n\n`));

        // Close stream when job is done
        const currentJob = getJob(id);
        if (currentJob && (currentJob.status === "completed" || currentJob.status === "failed")) {
          const finalData = JSON.stringify({
            type: "done",
            job: {
              id: currentJob.id,
              status: currentJob.status,
              steps: currentJob.steps,
              result: currentJob.result,
              error: currentJob.error,
              params: currentJob.params,
              pilotIndices: currentJob.pilotIndices,
              resumedFromPilotId: currentJob.resumedFromPilotId,
            },
          });
          safeEnqueue(encoder.encode(`data: ${finalData}\n\n`));

          setTimeout(() => {
            unsubscribe();
            safeClose();
          }, 500);
        }
      });

      // Cleanup on abort
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        safeClose();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
