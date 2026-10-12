"""UNIT ONLY deterministic local process: never invokes adb/emulator, never device truth."""
import hashlib,json,shutil,sys
from pathlib import Path

def main():
 root=Path(sys.argv[1]);args=sys.argv[2:];config=json.loads((root/'adapter.json').read_text());state=json.loads((root/'state.json').read_text())
 if args==['get-state']:
  print('offline' if config.get('offline_after_control') and state['instrumentations']>=1 else 'device');return 0
 if args[:3]==['shell','am','instrument']:
  case='control' if 'com.shikuang.control16k.WebViewControl16kInstrumentedTest' in args else 'app';state.update(instrumentations=state['instrumentations']+1,current_case=case);(root/'state.json').write_text(json.dumps(state))
  sys.stdout.write(config.get(case+'_terminal','OK (1 test)\nINSTRUMENTATION_CODE: -1\n'));return 0
 if args[:4]==['exec-out','content','read','--uri']:
  name=args[4].removeprefix('content://androidx.test.services.storage.outputfiles/')
  if '/' in name or '\\' in name or name in ('.','..'):return 9
  if state.get('current_case')=='control' and name==config.get('offline_harvest_file'):sys.stderr.write('error: device offline\n');return 1
  p=root/(state.get('current_case')+'-media')/name
  if not p.is_file():sys.stderr.write('UNIT_ONLY missing synthetic output\n');return 1
  sys.stdout.buffer.write(p.read_bytes());return 0
 if args[:3]==['shell','stat','-c']:
  x=config['remote'][args[4]];print(x['bytes']);return 0
 if args[:2]==['shell','sha256sum']:
  x=config['remote'][args[2]];print(x['sha256']+'  '+args[2]);return 0
 if args[:1]==['pull']:
  # Deliberately nonproduction bytes; metadata-consistent local transfers only.
  p=root/'binary'/config['remote'][args[1]]['unit_binary'];Path(args[2]).write_bytes(p.read_bytes());print('UNIT_ONLY actual local copied symbolic bytes');return 0
 key=json.dumps(args,separators=(',',':'));value=config['responses'].get(key)
 if value is None:sys.stderr.write('UNIT_ONLY unsupported fixed command\n');return 8
 sys.stdout.buffer.write((root/value).read_bytes());return 0
if __name__=='__main__':sys.exit(main())
