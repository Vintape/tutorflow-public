#!/usr/bin/env python3
"""Run synthetic candidate code only inside an offline bubblewrap filesystem."""
import json,os,re,shutil,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
HERE=ROOT/'tests/fixtures/agent-pilot/implementation'
DEPS=ROOT/'node_modules'
modules=['payments.ts','title.ts','button.tsx','distinct.ts','lesson.ts','cost.ts']
def sandbox(work,args):
 return subprocess.run(['bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--setenv','PATH','/usr/bin','--setenv','HOME','/tmp','--ro-bind','/usr','/usr','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64','--ro-bind',str(DEPS),'/deps','--bind',str(work),'/work','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/work','--',*args],capture_output=True,text=True,timeout=30)
assert DEPS.is_dir(), 'Harness dependency path unavailable'
records=[]
for model in ['luna','terra']:
 source=HERE/model
 with tempfile.TemporaryDirectory(prefix='agent-implementation-') as directory:
  work=Path(directory)
  (work/'node_modules').symlink_to('/deps',target_is_directory=True)
  (work/'package.json').write_text('{"type":"module"}')
  for name in modules:
   text=(source/(name+'.txt')).read_text();assert len(text)<65536; (work/name).write_text(text)
  (work/'judge.mjs').write_text((HERE/'judge.mjs').read_text())
  probe=sandbox(work,['/usr/bin/node','--version']);assert probe.returncode==0, 'Harness sandbox not available'
  started=time.perf_counter()
  check=sandbox(work,['/usr/bin/node','/deps/typescript/bin/tsc','--strict','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--jsx','react','--esModuleInterop','--types','node,react','--outDir','out',*modules])
  if check.returncode and not re.search(r'error TS[0-9]+:',check.stdout):
   raise RuntimeError('Compiler harness could not run; do not score this as a candidate failure')
  bad=set(re.findall(r'^(\w+)\.tsx?\(',check.stdout,re.M))
  run=sandbox(work,['/usr/bin/node','judge.mjs'])
  answers=json.loads(run.stdout.strip()) if run.returncode==0 else {name.split('.')[0]:False for name in modules}
  for name in bad: answers[name]=False
  test=(source/'payment.test.mjs.txt').read_text();assert len(test)<65536;(work/'payment.test.mjs').write_text(test)
  variants={'correct':"export function activeTotal(rows){let n=0;for(const r of rows){if(r.voidedAt!==null)continue;if(!Number.isSafeInteger(r.amount)||!Number.isSafeInteger(n+r.amount))throw new RangeError();n+=r.amount;}return n;}", 'sum_voided':"export const activeTotal=rows=>rows.reduce((s,r)=>s+r.amount,0);", 'absolute':"export const activeTotal=rows=>rows.filter(r=>r.voidedAt===null).reduce((s,r)=>s+Math.abs(r.amount),0);", 'drop_odd':"export const activeTotal=rows=>rows.filter(r=>r.voidedAt===null&&r.amount%2===0).reduce((s,r)=>s+r.amount,0);"}
  mutation={}
  for name,code in variants.items():
   (work/'payments-under-test.mjs').write_text(code);out=sandbox(work,['/usr/bin/node','payment.test.mjs']);mutation[name]=out.returncode==0
  answers['generated_tests']=mutation['correct'] and not any(v for k,v in mutation.items() if k!='correct')
  doc=(source/'GUIDE.md.txt').read_text().lower()
  answers['documentation']=all(re.search(pattern,doc) for pattern in ['static','private','interview','(postpon|later|defer)','(unmeasur|not measured|not claim|unknown|no .*sav)','postgres','canvas'])
  record={'model':model,'typecheck_passed':check.returncode==0,'tasks':answers,'accepted':sum(answers.values()),'total':8,'mutation_results':mutation,'verification_seconds':round(time.perf_counter()-started,3),'answer_bytes':sum(p.stat().st_size for p in source.iterdir() if p.is_file())}
  records.append(record)
print(json.dumps(records,indent=2))
raise SystemExit(0 if all(r['accepted']==8 and r['typecheck_passed'] for r in records) else 1)
