from pathlib import Path
import zipfile, struct
root=Path('_verify/zip-time')
root.mkdir(exist_ok=True)
for n in (4,7,9):
    info=zipfile.ZipInfo('fixture.txt')
    info.extra=struct.pack('<HH',10,n)+bytes(n)
    with zipfile.ZipFile(root/(str(n)+'.zip'),'w') as archive:
        archive.writestr(info,b'round3 timestamp fixture')
