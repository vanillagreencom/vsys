import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";

/**
 * `build.test.ts` compiles this beside the program, the way the binary is
 * built, and runs it: a component that throws while rendering, under the root
 * the dashboard mounts, and the frame its error boundary leaves.
 */
function Broken(): never {
  throw new Error("render-error-probe");
}

const ui = await createTestRenderer({ width: 120, height: 20 });
try {
  createRoot(ui.renderer).render(<Broken />);
  for (let pass = 0; pass < 20; pass++) {
    await Bun.sleep(0);
    await ui.renderOnce();
  }
  console.log(JSON.stringify({ frame: ui.captureCharFrame() }));
} finally {
  ui.renderer.destroy();
}
