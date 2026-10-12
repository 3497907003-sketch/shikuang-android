"""One persistent guest-uncertainty classifier; host termination is not guest exit."""
HOST_INTERRUPTION_STATUSES=('timeout','output_limit','spawn_error')
TRANSPORT_MARKERS=(b'device offline',b'no devices/emulators found',b'error: closed')

def interruption_reason(receipt,out,err):
 status=receipt.get('status')
 if status in HOST_INTERRUPTION_STATUSES:return 'host_'+status
 raw=out+err
 for marker in TRANSPORT_MARKERS:
  if marker in raw.lower():return 'transport_'+marker.decode('ascii').replace(' ','_').replace(':','')
 return None

def instrumentation_uncertain(receipt,out,err):
 return bool(interruption_reason(receipt,out,err) or any(x in out+err for x in (b'INSTRUMENTATION_ABORTED',b'Process crashed')))
