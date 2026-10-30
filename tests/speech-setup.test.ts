import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { speechSetupCommand } from '../src/speech-setup.js';

test('MLX setup selects only root weights and the requested voice', () => {
  const root = mkdtempSync(join(tmpdir(), 'vml-setup-test-'));
  try {
    mkdirSync(join(root, 'auritus', 'tts'), {recursive:true});
    for (const p of ['auritus/__init__.py','auritus/tts/__init__.py']) writeFileSync(join(root,p),'');
    writeFileSync(join(root,'auritus/tts/kokoro.py'), `class KokoroBackend:\n def _detect_mlx(self): return True\n def model_id(self): return 'model'\n`);
    writeFileSync(join(root,'huggingface_hub.py'), `import json, os\nfrom pathlib import Path\nfrom types import SimpleNamespace\nclass HfApi:\n def model_info(self, repo): return SimpleNamespace(sha=os.environ.get('FIXTURE_REVISION','a'*40), siblings=[SimpleNamespace(rfilename=n) for n in (['config.json','voices/af_heart.safetensors'] if os.environ.get('NO_WEIGHTS') else ['config.json','model.safetensors','voices/af_heart.safetensors','nested/other.npz'])])\ndef snapshot_download(repo, allow_patterns, revision=None):\n p=Path(os.environ['FIXTURE_ROOT'])/((os.environ.get('DEFAULT_REVISION','a'*40) if revision is None else os.environ.get('DOWNLOADED_REVISION','a'*40)) if repo=='model' else 'voice-revision'); p.mkdir(exist_ok=True)\n with open(os.environ['FIXTURE_LOG'],'a') as f: f.write(json.dumps([repo,allow_patterns,revision])+'\\n')\n for name in allow_patterns:\n  q=p/name; q.parent.mkdir(parents=True,exist_ok=True); q.write_bytes(b'x')\n return str(p)\n`);
    const cmd = speechSetupCommand(process.env.VIDEOML_TEST_PYTHON ?? 'python3','kokoro:af_heart');
    const result = spawnSync(cmd.command,cmd.args,{encoding:'utf8',env:{...cmd.env,PYTHONPATH:root,FIXTURE_ROOT:root,FIXTURE_LOG:join(root,'calls')}});
    assert.equal(result.status,0,result.stderr);
    const calls=readFileSync(join(root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(calls,[['model',['config.json','model.safetensors'],'a'.repeat(40)],['model',[],null],['prince-canuma/Kokoro-82M',['voices/af_heart.safetensors'],null]]);
    assert.equal(result.stdout.includes('"modelRevision": "'+'a'.repeat(40)+'"'),true);
    const mismatch = spawnSync(cmd.command,cmd.args,{encoding:'utf8',env:{...cmd.env,PYTHONPATH:root,FIXTURE_ROOT:root,FIXTURE_LOG:join(root,'calls'),FIXTURE_REVISION:'new-revision'}});
    assert.notEqual(mismatch.status,0); assert.match(mismatch.stderr,/immutable revision/);
    const wrongSnapshot = spawnSync(cmd.command,cmd.args,{encoding:'utf8',env:{...cmd.env,PYTHONPATH:root,FIXTURE_ROOT:root,FIXTURE_LOG:join(root,'calls'),DOWNLOADED_REVISION:'b'.repeat(40)}});
    assert.notEqual(wrongSnapshot.status,0); assert.match(wrongSnapshot.stderr,/Downloaded model revision differs/);
    const changedDefault = spawnSync(cmd.command,cmd.args,{encoding:'utf8',env:{...cmd.env,PYTHONPATH:root,FIXTURE_ROOT:root,FIXTURE_LOG:join(root,'calls'),DEFAULT_REVISION:'b'.repeat(40)}});
    assert.notEqual(changedDefault.status,0); assert.match(changedDefault.stderr,/default revision changed/);
    const missing = spawnSync(cmd.command,cmd.args,{encoding:'utf8',env:{...cmd.env,PYTHONPATH:root,FIXTURE_ROOT:root,FIXTURE_LOG:join(root,'calls'),NO_WEIGHTS:'1'}});
    assert.notEqual(missing.status,0); assert.match(missing.stderr,/no root-level weights/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
