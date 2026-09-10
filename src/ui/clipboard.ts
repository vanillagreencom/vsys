/**
 * Where the clipboard escape goes. The running program hands over
 * `process.stdout`; a test hands over a stream it can read back.
 */
export interface Output {
  write(chunk: string): unknown;
}
/**
 * OSC 52 asks the terminal emulator to put text on the system clipboard, which
 * works over SSH and inside tmux where no clipboard program is reachable. The
 * renderer's own OSC 52 call writes through the native core, where no test can
 * read what was sent, so vsys builds the sequence and writes it itself.
 *
 * The payload is base64, so no character in the copied text can close this
 * sequence or begin another one. A terminal that does not implement OSC 52
 * discards it silently and the text on screen stays the only copy, which is
 * why a copy has no failure to report.
 */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}
