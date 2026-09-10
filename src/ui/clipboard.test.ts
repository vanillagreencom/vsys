import { expect, test } from "bun:test";
import { osc52 } from "./clipboard";

const esc = "\u001b";
const bel = "\u0007";
const start = `${esc}]52;c;`;
const payload = (sequence: string) =>
  Buffer.from(sequence.slice(start.length, -1), "base64").toString("utf8");

test("the clipboard escape carries the command the terminal has to decode", () => {
  const text = "systemctl --user kill --signal=TERM a.scope";
  const sequence = osc52(text);
  expect(sequence.startsWith(start)).toBe(true);
  expect(sequence.endsWith(bel)).toBe(true);
  expect(payload(sequence)).toBe(text);
});

test("a command carrying the sequence's own terminators cannot close it early", () => {
  // A process names its own cgroup and argv, and both reach a copied command,
  // so copied text can hold the bytes that end this sequence. Written raw,
  // everything after the planted terminator would reach the terminal as its
  // own instructions rather than as clipboard content.
  const text = `a${bel}${start}rm -rf /${bel}b`;
  const sequence = osc52(text);
  expect([...sequence].filter((ch) => ch === bel).length).toBe(1);
  expect(sequence.indexOf(bel)).toBe(sequence.length - 1);
  expect([...sequence].filter((ch) => ch === esc).length).toBe(1);
  expect(sequence.indexOf(esc)).toBe(0);
  expect(payload(sequence)).toBe(text);
});
