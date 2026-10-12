#!/usr/bin/env python3
"""Host-only byte archive of the already obtained clock; no API requests/derivation."""
import hashlib,json,os,stat,sys
from pathlib import Path

def archive_clock(source_file,destination):
 source=Path(source_file);folder=Path(destination);folder.mkdir(parents=True,exist_ok=False,mode=0o700);rows=[]
 for src,name,cap in [(source,'job-clock.json',128*1024),(source.with_suffix('.response.bin'),'job-clock.response.bin',1024*1024+1)]:
  row={'source_path':str(src),'archive_file':name,'status':'not_copied','rederived_or_requested':False};rows.append(row);fd=None
  try:
   fd=os.open(src,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW);meta=os.fstat(fd)
   if not stat.S_ISREG(meta.st_mode):raise ValueError('regular_file_required')
   if not 0<=meta.st_size<=cap:raise ValueError('original_clock_size_bound')
   chunks=[];total=0
   while True:
    raw=os.read(fd,min(65536,cap+1-total))
    if not raw:break
    chunks.append(raw);total+=len(raw)
    if total>cap:raise ValueError('original_clock_size_bound')
   after=os.fstat(fd);raw=b''.join(chunks)
   if total!=meta.st_size or (meta.st_dev,meta.st_ino,meta.st_size,meta.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('clock_file_changed_during_read')
   dst=folder/name
   with dst.open('xb') as f:f.write(raw)
   actual=dst.read_bytes();digest=hashlib.sha256(raw).hexdigest()
   if actual!=raw:raise ValueError('archive_byte_verification_failed')
   row.update(status='copied_original_bytes_verified',source_bytes=total,source_sha256=digest,archive_bytes=len(actual),archive_sha256=hashlib.sha256(actual).hexdigest())
  except FileNotFoundError:row.update(status='missing_original',reason='original_file_not_present_no_replacement_created')
  except (OSError,ValueError) as e:row.update(status='failed_original_read',reason=str(e) if isinstance(e,ValueError) else type(e).__name__)
  finally:
   if fd is not None:os.close(fd)
 report={'schema':'retained-original-public-job-clock-bytes-v1','files':rows,'complete_pair':all(r['status']=='copied_original_bytes_verified' for r in rows),'authoritative_clock_revalidated':False,'no_API_requests_or_secret_access':True,'no_adb_or_guest_commands':True,'missing_files_not_replaced':True,'byte_archive_is_not_case_or_authorization_proof':True}
 with (folder/'archive-report.json').open('x') as f:json.dump(report,f,indent=2);f.write('\n')
 return report

def main():
 r=archive_clock(sys.argv[1],sys.argv[2]);print(json.dumps({'complete_original_pair':r['complete_pair'],'archive':sys.argv[2],'no_API_or_guest_commands':True}));return 0 if r['complete_pair'] else 2
if __name__=='__main__':sys.exit(main())
