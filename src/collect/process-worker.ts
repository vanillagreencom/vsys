import type { ProcessMessage, ProcessReply } from "./process-thread";
import { ProcessCollector } from "./procs";

declare const self: Worker;

/**
 * One collector for the life of this thread, set up by the host's first
 * message, and one reading per request after it. The host sends a request
 * only after the last one settled, and stops this thread by ending it.
 */
let collector: ProcessCollector | undefined;
self.onmessage = (event: MessageEvent<ProcessMessage>) => {
  const message = event.data;
  switch (message.kind) {
    case "setup":
      collector = new ProcessCollector(
        message.config,
        message.ticksPerSecond,
        message.pageSize,
      );
      return;
    case "collect": {
      let reply: ProcessReply;
      try {
        if (!collector)
          throw new Error("Process thread was asked to read before its setup");
        reply = {
          kind: "collected",
          id: message.id,
          reading: collector.read(message.request),
        };
      } catch (error) {
        reply = {
          kind: "failed",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      self.postMessage(JSON.stringify(reply));
      return;
    }
    default: {
      const unhandled: never = message;
      throw new Error(
        `Process thread received an unknown message: ${JSON.stringify(unhandled)}`,
      );
    }
  }
};
