import type { spawnText } from "../collect/io";

/** One drive the fake system bus holds, by the block device it backs. */
export interface FakeDrive {
  name: string;
  model: string;
  kind: "nvme" | "ata";
  /** The SmartGetAttributes reply's `data`, or a refusal in busctl's words. */
  attributes: unknown | { refuse: string };
}
const bytes = (path: string) => [...Buffer.from(path), 0];
/**
 * A stand-in for busctl against udisks, answering as `busctl --json=short`
 * prints: GetManagedObjects with each drive's whole disk and one partition,
 * and SmartGetAttributes per drive. It records each call it was asked.
 */
export function fakeBus(drives: FakeDrive[], calls: string[][] = []) {
  const objects: Record<string, unknown> = {};
  for (const d of drives) {
    const drive = `/org/freedesktop/UDisks2/drives/${d.name}_drive`;
    objects[drive] = {
      "org.freedesktop.UDisks2.Drive": { Model: { type: "s", data: d.model } },
      [d.kind === "nvme"
        ? "org.freedesktop.UDisks2.NVMe.Controller"
        : "org.freedesktop.UDisks2.Drive.Ata"]: {},
    };
    const block = (node: string) => ({
      Device: { type: "ay", data: bytes(`/dev/${node}`) },
      Drive: { type: "o", data: drive },
    });
    objects[`/org/freedesktop/UDisks2/block_devices/${d.name}`] = {
      "org.freedesktop.UDisks2.Block": block(d.name),
    };
    // A partition names the same drive and must not become a row of its own.
    objects[`/org/freedesktop/UDisks2/block_devices/${d.name}p1`] = {
      "org.freedesktop.UDisks2.Block": block(`${d.name}p1`),
      "org.freedesktop.UDisks2.Partition": {},
    };
  }
  const run: typeof spawnText = async (argv) => {
    calls.push(argv);
    if (argv.includes("GetManagedObjects"))
      return {
        out: JSON.stringify({ type: "a{oa{sa{sv}}}", data: [objects] }),
        error: "",
        status: 0,
      };
    const d = drives.find((x) =>
      argv.some((a) => a.endsWith(`/${x.name}_drive`)),
    );
    if (!d) throw new Error(`fakeBus: no drive for ${argv.join(" ")}`);
    const a = d.attributes as { refuse?: string };
    if (typeof a === "object" && a !== null && typeof a.refuse === "string")
      return { out: "", error: `Call failed: ${a.refuse}\n`, status: 1 };
    return {
      out: JSON.stringify({ type: "a{sv}", data: [d.attributes] }),
      error: "",
      status: 0,
    };
  };
  return run;
}
/** busctl's refusal where the machine has no system bus, as this host prints it. */
export const noBus: typeof spawnText = async () => ({
  out: "",
  error: "Failed to connect to bus: No such file or directory\n",
  status: 1,
});
