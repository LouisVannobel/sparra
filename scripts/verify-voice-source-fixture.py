"""Verify one fixed native producer fixture; never execute its member code."""
import base64
import hashlib
import io
import json
import sys
import tarfile

def fail():
    raise ValueError('Invalid native Voice source fixture')

def main():
    if sys.version_info[:3]!=(3,13,15):
        fail()
    incoming=sys.stdin.buffer.read(1048577)
    if len(incoming)>1048576:
        fail()
    envelope=json.loads(incoming)
    archive=base64.b64decode(envelope['archive'],validate=True)
    manifest=envelope['manifest']
    if len(archive)!=356375 or hashlib.sha256(archive).hexdigest()!='c72058bb8854ea8da6b03e218fb43b7ef2610a602551f702141e85aba8183d79':
        fail()
    expected={}
    total=0
    for row in manifest['members']:
        path=row['path']
        if not isinstance(path,str) or path.startswith('/') or '\\' in path or any(part in ('','.','..') for part in path.split('/')) or path in expected:
            fail()
        if not isinstance(row['size'],int) or not 0<=row['size']<=1048576:
            fail()
        total+=row['size']
        expected[path]=row
    if len(expected)!=52 or total!=1719663:
        fail()
    result=[]
    seen=set()
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as source:
        for member in source:
            if member.name in seen or member.name not in expected or not member.isreg() or member.pax_headers or member.size!=expected[member.name]['size']:
                fail()
            seen.add(member.name)
            stream=source.extractfile(member)
            data=stream.read(member.size+1)
            if len(data)!=member.size or hashlib.sha256(data).hexdigest()!=expected[member.name]['sha256']:
                fail()
            blob=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
            if blob!=expected[member.name]['git_blob']:
                fail()
            result.append({'path':member.name,'bytes':base64.b64encode(data).decode('ascii')})
    if seen!=set(expected):
        fail()
    print(json.dumps({'commit':manifest['commit'],'tree':manifest['tree'],'members':result},separators=(',',':')))

try:
    main()
except (ValueError,KeyError,TypeError,tarfile.TarError,OSError):
    sys.exit(1)
