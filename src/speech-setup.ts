/** Prepare an explicit model setup process; generation and diagnostics remain offline. */
export function speechSetupCommand(python: string, voice: string) {
  if (!/^kokoro:[A-Za-z0-9_]+$/.test(voice)) throw new Error('Setup voice must be kokoro:<voice_id>');
  const code = `import json, sys
from pathlib import Path
from auritus.tts.kokoro import KokoroBackend
from huggingface_hub import snapshot_download
voice = sys.argv[1].split(':', 1)[1]
backend = KokoroBackend()
mlx = backend._detect_mlx()
patterns = ['config.json', '*.safetensors', '*.npz'] if mlx else ['config.json', 'kokoro-v1_0.pth', 'voices/' + voice + '.pt']
model = snapshot_download(backend.model_id(), allow_patterns=patterns)
voices = snapshot_download('prince-canuma/Kokoro-82M', allow_patterns=['voices/' + voice + '.safetensors']) if mlx else model
model_dir = Path(model)
voices_dir = Path(voices)
weights = list(model_dir.glob('*.safetensors')) + list(model_dir.glob('*.npz')) if mlx else [model_dir / 'kokoro-v1_0.pth']
required = [model_dir / 'config.json', voices_dir / 'voices' / (voice + ('.safetensors' if mlx else '.pt'))]
if not weights or any(not p.is_file() or p.stat().st_size == 0 for p in required + weights):
    raise RuntimeError('Downloaded snapshot is missing required config, weights or selected voice')
print(json.dumps({'modelSnapshot': model, 'modelRevision': Path(model).name, 'voiceSnapshot': voices, 'voiceRevision': Path(voices).name}))`;
  const env = {...process.env};
  delete env.HF_HUB_OFFLINE; delete env.TRANSFORMERS_OFFLINE;
  return {command:python, args:['-c',code,voice], env};
}
