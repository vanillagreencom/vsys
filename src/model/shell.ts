/**
 * Characters a POSIX shell reads as themselves. Everything else, a backslash
 * and a space included, changes meaning between the line on screen and the
 * words the shell hands to the program.
 */
const bare = /^[\w@%+=:,./-]+$/;
/**
 * One shell word, quoted when the shell would otherwise read it as something
 * else. Real systemd scope names carry backslash escapes, so an unquoted
 * `app-Hyprland-chromium\x2dpersonal-af7ff2b7.scope` reaches systemctl as
 * `app-Hyprland-chromiumx2dpersonal-af7ff2b7.scope` and names a different unit
 * or none; a configured path holding a space arrives as two arguments. Single
 * quotes suspend every other special character, so only a single quote in the
 * word itself has to leave and re-enter them.
 */
export function shellWord(word: string): string {
  return bare.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
/** An argv as the line a reader can paste and get the same argv back. */
export function shellLine(argv: string[]): string {
  return argv.map(shellWord).join(" ");
}
