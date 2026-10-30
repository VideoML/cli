#!/usr/bin/env -S node --import tsx

import { Command } from "commander";
import { existsSync, statSync, readdirSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import chokidar from "chokidar";
import { loadVideoFile, generateComposition, loadConfig, findProjectRoot, BabulusError, renderVideoFromScript, type CompositionSpec, type ScriptData, type TimelineData } from "@videoml/toolchain";
import { readFileSync } from "fs";

const program = new Command();
program.name("vml").description("VideoML CLI");

program
  .command("generate")
  .argument("[dsl]", "Path to .videoml.ts/.videoml.xml (or legacy .babulus.ts/.babulus.xml) file or directory")
  .option("--script-out <path>", "Output script JSON path")
  .option("--timeline-out <path>", "Output timeline JSON path")
  .option("--audio-out <path>", "Output audio path")
  .option("--out-dir <path>", "Intermediate output dir")
  .option("--usage-out <path>", "Usage ledger output path")
  .option("--no-usage", "Disable usage ledger")
  .option("--env <name>", "Set environment for provider selection")
  .option("--environment <name>", "Alias for --env")
  .option("--provider <name>", "Override voiceover.provider")
  .option("--sfx-provider <name>", "Override SFX provider")
  .option("--music-provider <name>", "Override music provider")
  .option("--seed <number>", "Override voiceover.seed", (v) => Number(v))
  .option("--fresh", "Force regeneration of all audio", false)
  .option("--watch", "Watch DSL file(s) and re-run generation", false)
  .option("--quiet", "Suppress normal progress output", false)
  .option("--project-dir <path>", "Project root directory (prefix for outputs)")
  .action(async (dslArg: string | undefined, opts) => {
    const envArg = opts.env ?? opts.environment;
    if (envArg) {
      process.env.VIDEOML_ENV = envArg;
    }

    const cwd = process.cwd();
    const projectDir = opts.projectDir ? resolve(cwd, opts.projectDir) : undefined;

    const dslPaths = resolveDslPaths(dslArg, cwd);
    if (opts.watch && (opts.scriptOut || opts.timelineOut || opts.audioOut || opts.outDir || opts.usageOut) && dslPaths.length !== 1) {
      throw new BabulusError("When using --watch with multiple DSLs, omit explicit output overrides.");
    }

    const runs = await loadCompositions(dslPaths);
    const totalComps = runs.reduce((sum, r) => sum + r.compositions.length, 0);
    if ((opts.scriptOut || opts.timelineOut || opts.audioOut || opts.outDir || opts.usageOut) && totalComps !== 1) {
      throw new BabulusError("Output overrides require a single composition.");
    }

    const config = loadConfig(projectDir, dslPaths[0]);

    const runOnce = async (dslSubset?: string[]) => {
      for (const run of runs) {
        if (dslSubset && !dslSubset.includes(run.path)) {
          continue;
        }
        for (const comp of run.compositions) {
          const { scriptOut, timelineOut, audioOut, outDir } = defaultsForComposition(comp.id, run.path, projectDir, opts);
          const logger = opts.quiet ? undefined : (msg: string) => {
            const ts = new Date().toLocaleTimeString();
            console.error(`[${ts}] ${comp.id}: ${msg}`);
          };
          await generateComposition({
            composition: comp,
            dslPath: run.path,
            scriptOut,
            timelineOut,
            audioOut,
            outDir,
            config,
            providerOverride: opts.provider ?? null,
            sfxProviderOverride: opts.sfxProvider ?? null,
            musicProviderOverride: opts.musicProvider ?? null,
            seedOverride: opts.seed ?? null,
            fresh: Boolean(opts.fresh),
            usagePath: opts.usage === false ? null : (opts.usageOut ?? undefined),
            log: logger,
            verboseLogs: !opts.quiet,
          });
        }
      }
    };

    if (!opts.watch) {
      await runOnce();
      return;
    }

    const configPath = findConfigPathForWatch(projectDir, dslPaths[0]);
    const dslDirs = Array.from(new Set(dslPaths.map((p) => dirname(p))));
    const watchDirs = [...dslDirs];
    if (configPath) {
      watchDirs.push(dirname(configPath));
    }

    const watcher = chokidar.watch(watchDirs, {
      ignoreInitial: true,
      usePolling: true,
      interval: 500,
      binaryInterval: 1000,
      ignored: ["**/node_modules/**", "**/.git/**", "**/.babulus/out/**", "**/.videoml/out/**", "**/dist/**"],
    });

    console.error("Watching for changes... (Ctrl+C to stop)\n");
    if (!opts.quiet) {
      console.error(`Watching directories:\n${watchDirs.map(d => `  - ${d}`).join('\n')}\n`);
    }

    watcher.on("all", async (_event, changedPath) => {
      const absChanged = resolve(cwd, changedPath);
      const rel = absChanged.startsWith(cwd) ? absChanged.slice(cwd.length + 1) : absChanged;

      if (
        !absChanged.endsWith(".ts") &&
        !absChanged.endsWith(".xml") &&
        !absChanged.endsWith(".yml") &&
        !absChanged.endsWith(".yaml")
      ) {
        return;
      }

      if (configPath && absChanged === configPath) {
        console.error(`\nCHANGE DETECTED (Config): ${rel}`);
        console.error("Regenerating all compositions...");
        await runOnce();
        console.error("\nWaiting for changes... (Ctrl+C to stop)\n");
        return;
      }

      const dslMatch = dslPaths.find((p) => p === absChanged);
      if (dslMatch) {
        console.error(`\nCHANGE DETECTED (DSL): ${rel}`);
        await runOnce([dslMatch]);
        console.error("\nWaiting for changes... (Ctrl+C to stop)\n");
        return;
      }

      const isInDslDir = dslDirs.some(dir => absChanged.startsWith(dir + sep));
      if (isInDslDir && (absChanged.endsWith(".ts") || absChanged.endsWith(".xml"))) {
        console.error(`\nCHANGE DETECTED (Shared): ${rel}`);
        console.error("Shared file changed; regenerating all compositions...");
        await runOnce();
        console.error("\nWaiting for changes... (Ctrl+C to stop)\n");
        return;
      }
    });
  });

program
  .command("render")
  .requiredOption("--script <path>", "Path to script.json")
  .requiredOption("--frames <dir>", "Output directory for PNG frames")
  .requiredOption("--out <path>", "Output MP4 path")
  .option("--timeline <path>", "Optional timeline.json for duration data")
  .option("--audio <path>", "Optional audio file path")
  .option("--title <text>", "Storyboard title")
  .option("--subtitle <text>", "Storyboard subtitle")
  .option("--start <number>", "Start frame", (value) => Number(value), 0)
  .option("--end <number>", "End frame (inclusive)")
  .option("--pattern <pattern>", "Frame filename pattern", "frame-%06d.png")
  .option("--scale <number>", "Device scale factor", (value) => Number(value), 1)
  .option("--workers <number>", "Parallel frame workers (set 1 to disable)", (value) => Number(value))
  .option("--browser-bundle <path>", "Path to browser bundle (defaults to BABULUS_BROWSER_BUNDLE or public/browser-components.js)")
  .option(
    "--ffmpeg-arg <arg>",
    "Extra ffmpeg argument (repeat for multiple)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option("--fps <number>", "Override fps")
  .option("--width <number>", "Override width")
  .option("--height <number>", "Override height")
  .option("--duration <number>", "Override duration frames")
  .option("--debug-layout", "Show layout bounds (dev-only helper)")
  .option("--no-clean", "Skip cleaning existing frames before rendering (default: clean)")
  .option("--ffmpeg <path>", "ffmpeg binary path", "ffmpeg")
  .action(async (opts) => {
    const scriptPath = resolve(process.cwd(), opts.script);
    const framesDir = resolve(process.cwd(), opts.frames);
    const outputPath = resolve(process.cwd(), opts.out);
    const audioPath = opts.audio ? resolve(process.cwd(), opts.audio) : null;
    const timelinePath = opts.timeline ? resolve(process.cwd(), opts.timeline) : null;

    const script = JSON.parse(readFileSync(scriptPath, "utf8")) as ScriptData;
    const timeline = timelinePath ? (JSON.parse(readFileSync(timelinePath, "utf8")) as TimelineData) : null;
    const endFrame = opts.end == null ? undefined : Number(opts.end);
    const fps = opts.fps == null ? undefined : Number(opts.fps);
    const width = opts.width == null ? undefined : Number(opts.width);
    const height = opts.height == null ? undefined : Number(opts.height);
    const duration = opts.duration == null ? undefined : Number(opts.duration);
    const startFrame = opts.start == null ? undefined : Number(opts.start);
    const workers = opts.workers == null ? undefined : Number(opts.workers);
    const scale = opts.scale == null ? undefined : Number(opts.scale);
    const browserBundlePath = opts.browserBundle ? resolve(process.cwd(), opts.browserBundle) : undefined;

    await renderVideoFromScript({
      script,
      timeline,
      title: opts.title,
      subtitle: opts.subtitle,
      debugLayout: !!opts.debugLayout,
      framesDir,
      outputPath,
      audioPath,
      framePattern: opts.pattern,
      startFrame,
      endFrame,
      deviceScaleFactor: scale,
      workers,
      browserBundlePath,
      ffmpegPath: opts.ffmpeg,
      ffmpegArgs: opts.ffmpegArg,
      fps,
      width,
      height,
      durationFrames: duration,
      cleanFrames: opts.clean !== false,
    });
    console.error(`write: ${outputPath}`);
  });

program
  .command("pipeline")
  .argument("[dsl]", "Path to .videoml.ts/.videoml.xml (or legacy .babulus.ts/.babulus.xml) file or directory")
  .option("--out <path>", "Output MP4 path")
  .option("--frames <dir>", "Output directory for PNG frames")
  .option("--project-dir <path>", "Project root directory (prefix for outputs)")
  .action(async (dslArg: string | undefined, opts) => {
    const cwd = process.cwd();
    const projectDir = opts.projectDir ? resolve(cwd, opts.projectDir) : undefined;
    const dslPaths = resolveDslPaths(dslArg, cwd);
    if (dslPaths.length !== 1) {
      throw new BabulusError("Pipeline expects a single DSL path.");
    }

    const dslPath = dslPaths[0];
    const spec = await loadVideoFile(dslPath);
    if (spec.compositions.length !== 1) {
      throw new BabulusError("Pipeline requires a single composition in the DSL.");
    }

    const comp = spec.compositions[0];
    const { scriptOut, timelineOut, audioOut, outDir } = defaultsForComposition(comp.id, dslPath, projectDir, {});
    const config = loadConfig(projectDir, dslPath);

    await generateComposition({
      composition: comp,
      dslPath,
      scriptOut,
      timelineOut,
      audioOut,
      outDir,
      config,
      fresh: false,
      verboseLogs: true,
    });

    const outputPath = opts.out
      ? resolve(cwd, opts.out)
      : join(publicRoot(projectDir), "videoml", `${comp.id}.mp4`);
    const framesDir = opts.frames
      ? resolve(cwd, opts.frames)
      : join(outDir, "frames");

    const script = JSON.parse(readFileSync(scriptOut, "utf8")) as ScriptData;
    const timeline = JSON.parse(readFileSync(timelineOut, "utf8")) as TimelineData;

    await renderVideoFromScript({
      script,
      timeline,
      framesDir,
      outputPath,
      audioPath: audioOut,
      framePattern: "frame-%06d.png",
      startFrame: 0,
      endFrame: undefined,
      deviceScaleFactor: 1,
      workers: undefined,
      browserBundlePath: undefined,
      ffmpegPath: "ffmpeg",
      ffmpegArgs: [],
      fps: undefined,
      width: undefined,
      height: undefined,
      durationFrames: undefined,
      cleanFrames: true,
    });

    console.error(`write: ${outputPath}`);
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof BabulusError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});

function resolveDslPaths(dslArg: string | undefined, cwd: string): string[] {
  if (dslArg) {
    const candidate = resolve(cwd, dslArg);
    if (!existsSync(candidate)) {
      throw new BabulusError(`Path does not exist: ${candidate}`);
    }
    if (statSync(candidate).isFile()) {
      return [candidate];
    }
    return findDslFiles(candidate);
  }
  const auto = discoverProjectDsls(cwd);
  if (auto.length === 0) {
    throw new BabulusError("No .videoml.ts/.videoml.xml or legacy .babulus.ts/.babulus.xml files found. Pass a file or directory path, or create one under ./content/");
  }
  if (auto.length > 1) {
    throw new BabulusError(`Multiple VideoML or legacy Babulus DSL files found (${auto.length}). Pass a specific file or directory path.`);
  }
  return [auto[0]];
}

function discoverProjectDsls(cwd: string): string[] {
  const contentDir = join(cwd, "content");
  if (existsSync(contentDir)) {
    return findDslFiles(contentDir);
  }
  return findDslFiles(cwd, false);
}

function findDslFiles(root: string, recursive = true): string[] {
  const out: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        out.push(...findDslFiles(full, true));
      }
      continue;
    }
    if (entry.isFile() && ([".videoml.ts", ".videoml.xml", ".babulus.ts", ".babulus.xml"].some((suffix) => entry.name.endsWith(suffix)))) {
      out.push(full);
    }
  }
  return out.sort();
}

async function loadCompositions(dslPaths: string[]): Promise<Array<{ path: string; compositions: CompositionSpec[] }>> {
  const runs: Array<{ path: string; compositions: CompositionSpec[] }> = [];
  for (const dslPath of dslPaths) {
    const spec = await loadVideoFile(dslPath);
    runs.push({ path: dslPath, compositions: spec.compositions });
  }
  return runs;
}

function defaultsForComposition(
  compId: string,
  dslPath: string,
  projectDir: string | undefined,
  opts: Record<string, unknown>,
): { scriptOut: string; timelineOut: string; audioOut: string; outDir: string } {
  const root = projectDir ?? findProjectRoot(dslPath);
  const scriptOut = typeof opts.scriptOut === "string"
    ? String(opts.scriptOut)
    : join(root, `src/videos/${compId}/${compId}.script.json`);
  const timelineOut = typeof opts.timelineOut === "string"
    ? String(opts.timelineOut)
    : join(root, `src/videos/${compId}/${compId}.timeline.json`);
  const audioOut = typeof opts.audioOut === "string"
    ? String(opts.audioOut)
    : join(root, `public/videoml/${compId}.wav`);
  const outDir = typeof opts.outDir === "string"
    ? String(opts.outDir)
    : join(root, `.videoml/out/${compId}`);
  return { scriptOut, timelineOut, audioOut, outDir };
}

function publicRoot(projectDir?: string): string {
  return projectDir ? join(projectDir, "public") : join(process.cwd(), "public");
}

function findConfigPathForWatch(projectDir: string | undefined, dslPath: string): string | null {
  try {
    const root = projectDir ?? findProjectRoot(dslPath);
    const videoml = join(root, ".videoml", "config.yml");
    if (existsSync(videoml)) {
      return videoml;
    }
    const babulus = join(root, ".babulus", "config.yml");
    if (existsSync(babulus)) {
      return babulus;
    }
  } catch {
    return null;
  }
  return null;
}
