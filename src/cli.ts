#!/usr/bin/env -S node --import tsx

import { Command } from "commander";
import { existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import chokidar from "chokidar";
import { loadVideoFile, generateComposition, GenerationSession, AuritusProvider, loadConfig, findProjectRoot, BabulusError, renderVideoFromScript, type CompositionSpec, type ScriptData, type TimelineData } from "@videoml/toolchain";
import { readFileSync } from "fs";
import { spawn } from "node:child_process";
import { speechSetupCommand } from "./speech-setup.js";

const program = new Command();
program.name("vml").description("VideoML CLI");


program.command("init").description("Create a new VideoML project configuration")
  .option("--project-dir <path>", "Project directory", ".")
  .action((opts) => {
    const dir = resolve(opts.projectDir, ".videoml"); const file = join(dir, "config.yml");
    if (existsSync(file) || existsSync(resolve(opts.projectDir, ".babulus", "config.yml"))) throw new BabulusError(`Project configuration already exists in ${opts.projectDir}`);
    mkdirSync(dir, {recursive:true});
    writeFileSync(file, "tts:\n  default_provider: auritus\nproviders:\n  auritus:\n    python: python3\n    voice: kokoro:af_heart\n    speed: 1\n    seed: 0\n", {flag:"wx"});
    console.log(`Created ${file}`);
  });
program.command("speech-setup").description("Explicitly download the local Kokoro model and selected voice")
  .option("--python <path>", "Python with Auritus and huggingface_hub installed")
  .option("--voice <voice>", "Voice")
  .option("--project-dir <path>", "Project root")
  .action(async opts => {
    const config = loadConfig(opts.projectDir); const providers = config.providers as Record<string, any> | undefined;
    const python = opts.python ?? providers?.auritus?.python ?? "python3";
    const setup = speechSetupCommand(python, opts.voice ?? providers?.auritus?.voice ?? "kokoro:af_heart");
    const child = spawn(setup.command, setup.args, {stdio:"inherit",env:setup.env});
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new BabulusError(`Model setup exited ${code}`))); });
    const check = new AuritusProvider(python, providers?.auritus?.voices_dir);
    try { const caps = await check.capabilities(opts.voice ?? providers?.auritus?.voice ?? "kokoro:af_heart"); if (!caps.ready || caps.backend !== "kokoro" || caps.extensions?.["auritus.simulation"]?.simulated === true) throw new BabulusError(`Model setup incomplete: ${caps.cacheDisabledReason ?? "backend not ready"}`); console.log(JSON.stringify(caps, null, 2)); }
    finally { await check.dispose(); }
  });
program.command("speech-diagnostics").description("Inspect installed local speech capabilities without downloading")
  .option("--python <path>", "Python executable")
  .option("--voice <voice>", "Voice")
  .option("--voices-dir <path>", "Voices directory")
  .option("--project-dir <path>", "Project root")
  .action(async opts => { const config=loadConfig(opts.projectDir); const providers=config.providers as Record<string, any> | undefined; const auritus=providers?.auritus ?? {}; const provider = new AuritusProvider(opts.python ?? auritus.python ?? "python3", opts.voicesDir ?? auritus.voices_dir); try { console.log(JSON.stringify(await provider.capabilities(opts.voice ?? auritus.voice ?? "kokoro:af_heart"), null, 2)); } finally { await provider.dispose(); } });

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

    let stopWatch: (() => void) | undefined;
    const runOnce = async (dslSubset?: string[]) => {
      const generationSession = new GenerationSession();
      const cancel = () => { generationSession.cancel(); stopWatch?.(); process.exitCode = 130; };
      process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
      let primaryError: unknown;
      try {
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
            generationSession,
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
      } catch (error) { primaryError = error; throw error; }
      finally {
        process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
        try { await generationSession.dispose(); } catch (error) { if (!primaryError) throw error; }
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

    stopWatch = () => { void watcher.close(); };
    console.error("Watching for changes... (Ctrl+C to stop)\n");
    if (!opts.quiet) {
      console.error(`Watching directories:\n${watchDirs.map(d => `  - ${d}`).join('\n')}\n`);
    }

    let watchQueue: Promise<void> = Promise.resolve();
    watcher.on("all", (_event, changedPath) => {
      watchQueue = watchQueue.then(async () => {
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
      }).catch(err => { console.error(err); });
    });
  });

program
  .command("render")
  .requiredOption("--script <path>", "Path to script.json")
  .requiredOption("--frames <dir>", "Output directory for PNG frames")
  .requiredOption("--out <path>", "Output MP4 path")
  .option("--timeline <path>", "Optional timeline.json for duration data")
  .option("--resolved-timing <path>", "Frozen resolved timing JSON")
  .option("--resolved-root <path>", "Root directory for frozen audio paths")
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
    if (opts.resolvedTiming && !opts.resolvedRoot) throw new BabulusError("--resolved-root is required with --resolved-timing");
    const resolvedTiming = opts.resolvedTiming ? JSON.parse(readFileSync(resolve(process.cwd(), opts.resolvedTiming), "utf8")) : null;
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
      assetBaseDir: dirname(scriptPath),
      timeline,
      resolvedTiming,
      resolvedTimingRoot: opts.resolvedRoot ? resolve(process.cwd(), opts.resolvedRoot) : undefined,
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

    const generated = await generateComposition({
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
    if (!generated.resolvedTimingPath) throw new BabulusError("Generation did not produce frozen timing");
    const resolvedTiming = JSON.parse(readFileSync(generated.resolvedTimingPath, "utf8"));

    await renderVideoFromScript({
      script,
      assetBaseDir: dirname(scriptOut),
      timeline,
      resolvedTiming,
      resolvedTimingRoot: outDir,
      framesDir,
      outputPath,
      audioPath: generated.frozenAudioPath,
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
