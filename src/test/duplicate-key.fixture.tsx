import { afterAll, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

/**
 * The suite `warnings.test.ts` runs in a child `bun test`: two tests that
 * warn, one that does not, and an `afterAll` that warns after the last test.
 * The name stays outside the runner's test pattern, so `bun test src/` never
 * runs the tests that must fail.
 */
async function rows(keys: string[]) {
  const ui = await testRender(
    <box>
      {keys.map((key) => (
        <text key={key}>{key}</text>
      ))}
    </box>,
    { width: 20, height: 4 },
  );
  try {
    await ui.renderOnce();
    return ui.captureCharFrame();
  } finally {
    await act(async () => {
      ui.renderer.destroy();
    });
  }
}

test("two rows sharing a key", async () => {
  expect(await rows(["/dev/x", "/dev/x"])).toContain("/dev/x");
});

test("rows with their own keys", async () => {
  expect(await rows(["/dev/x", "/dev/y"])).toContain("/dev/y");
});

// React reports some misuse through `console.warn` instead.
test("a warning written through console.warn", () => {
  console.warn("a stand-in for a React warning");
});

// No test follows this, so only the gate's end of run can report it.
afterAll(() => {
  console.error("a warning from the file's afterAll");
});
