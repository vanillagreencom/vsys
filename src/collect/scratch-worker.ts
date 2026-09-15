import {
  ScanCancelled,
  type ScanReply,
  type ScanRequest,
  scanScratch,
} from "./scratch-scan";

declare const self: Worker;

/**
 * The scan the main thread last asked for. A later request or a cancellation
 * retires it, which is what the running traversal reads to stop: the thread
 * returns to this queue at every rest in its duty cycle.
 */
let current = 0;

async function run(
  request: Extract<ScanRequest, { kind: "scan" }>,
): Promise<void> {
  const reply = (message: ScanReply) => {
    self.postMessage(message);
  };
  try {
    const scan = await scanScratch(
      request.config,
      request.time,
      request.budget,
      () => current !== request.id,
    );
    reply({ kind: "scan", id: request.id, scan });
  } catch (error) {
    if (error instanceof ScanCancelled) {
      reply({ kind: "cancelled", id: request.id });
      return;
    }
    reply({
      kind: "failed",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<ScanRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "cancel":
      current = 0;
      return;
    case "scan":
      current = request.id;
      void run(request);
      return;
    default: {
      const unhandled: never = request;
      throw new Error(
        `Scratch scan worker received an unknown request: ${JSON.stringify(unhandled)}`,
      );
    }
  }
};
