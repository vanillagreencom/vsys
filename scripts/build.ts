/**
 * Both shipped builds, from one list of entry points. Bun's bundler does not
 * follow a worker URL, so every thread the program starts is an entry point
 * of its own beside the program, and a build that leaves one out ships a
 * program whose first sample fails.
 *
 * Usage: bun scripts/build.ts dist
 *        bun scripts/build.ts compile OUTFILE
 */
const entrypoints = [
  "src/main.ts",
  "src/collect/process-worker.ts",
  "src/collect/scratch-worker.ts",
];

/** The bundle `bun dist/main.js` runs, with its packages left to install. */
export async function buildDist(): Promise<void> {
  report(
    await Bun.build({
      entrypoints,
      target: "bun",
      packages: "external",
      outdir: "dist",
    }),
  );
}

/**
 * The standalone binary the release and the vsys-git package ship. React
 * picks its build from NODE_ENV, and the binary embeds the one chosen here:
 * the development build draws a retained day in more than half a refresh.
 */
export async function buildBinary(outfile: string): Promise<void> {
  report(
    await Bun.build({
      entrypoints,
      compile: { outfile },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    }),
  );
}

function report(result: Bun.BuildOutput): void {
  if (!result.success)
    throw new AggregateError(result.logs, "build: result=failed");
  for (const output of result.outputs)
    console.log(`build: wrote ${output.path}`);
}

if (import.meta.main) {
  const [mode, outfile] = process.argv.slice(2);
  if (mode === "dist") await buildDist();
  else if (mode === "compile" && outfile) await buildBinary(outfile);
  else {
    console.error(`build: usage=invalid mode=${mode ?? ""}`);
    process.exit(2);
  }
}
