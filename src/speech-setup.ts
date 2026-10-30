/** Prepare an explicit model setup process; generation and diagnostics remain offline. */
export function speechSetupCommand(python: string, voice: string) {
  if (!/^kokoro:[A-Za-z0-9_]+$/.test(voice)) throw new Error('Setup voice must be kokoro:<voice_id>');
  const code = `import json, re, sys
from pathlib import Path
from auritus.tts.kokoro import KokoroBackend
from huggingface_hub import HfApi, snapshot_download
voice = sys.argv[1].split(':', 1)[1]
backend = KokoroBackend()
mlx = backend._detect_mlx()
model_id = backend.model_id()
if mlx:
    info = HfApi().model_info(model_id)
    if not isinstance(info.sha, str) or not re.fullmatch(r'[0-9a-f]{40}', info.sha):
        raise RuntimeError('Model repository did not provide an immutable revision')
    weights = sorted(item.rfilename for item in info.siblings
                     if '/' not in item.rfilename and item.rfilename.endswith(('.safetensors', '.npz')))
    if not weights:
        raise RuntimeError('Model repository contains no root-level weights')
    patterns = ['config.json'] + weights
else:
    info = None
    patterns = ['config.json', 'kokoro-v1_0.pth', 'voices/' + voice + '.pt']
model = snapshot_download(model_id, allow_patterns=patterns, revision=info.sha) if mlx else snapshot_download(model_id, allow_patterns=patterns)
if info is not None and Path(model).name != info.sha:
    raise RuntimeError('Downloaded model revision differs from requested immutable revision')
if mlx and Path(snapshot_download(model_id, allow_patterns=[])).name != info.sha:
    raise RuntimeError('Model default revision changed during setup; retry explicitly')
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
