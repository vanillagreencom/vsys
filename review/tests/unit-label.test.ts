// Cloud defect review 8, finding: unitLabel decodes each \xNN escape as one
// Latin-1 character, so a unit name with a non-ASCII character reads as
// mojibake.
// Run from the repository root: bun test review/tests/unit-label.test.ts
import { expect, test } from "bun:test";
import { unitLabel } from "../../src/model/naming";

// systemd escapes every byte outside [A-Za-z0-9:_.\] one byte at a time
// (unit_name_escape), so `systemd-escape 'café'` prints `caf\xc3\xa9`, the two
// UTF-8 bytes of é.
test("a UTF-8 character systemd escaped byte by byte decodes to that character", () => {
  expect(unitLabel("app-niri-caf\\xc3\\xa9-1234.scope")).toBe("café");
  expect(unitLabel("run-r\\xc3\\xa9sum\\xc3\\xa9.service")).toBe("run résumé");
});
