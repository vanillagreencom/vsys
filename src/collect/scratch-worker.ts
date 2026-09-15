import { type ScanReply, type ScanRequest, scanScratch } from "./scratch-scan";

declare const self: Worker;

/**
 * One scan per message. The host sends the next only after the last settled,
 * and stops a scan it no longer wants by ending this thread.
 */
self.onmessage = (event: MessageEvent<ScanRequest>) => {
  const request = event.data;
  const reply = (message: ScanReply) => {
    self.postMessage(message);
  };
  void scanScratch(request.config, request.time, request.budget).then(
    (scan) => {
      reply({ kind: "scan", id: request.id, scan });
    },
    (error: unknown) => {
      reply({
        kind: "failed",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
};
