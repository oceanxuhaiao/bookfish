"""Local real HTTP/3 canary; no system certificate store changes."""
import sys, asyncio, json, datetime, ipaddress, pathlib, base64, hashlib
sys.path.insert(0,str(pathlib.Path('_verify/wfp/pythonlibs').resolve()))
from aioquic.asyncio import serve, QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration
from aioquic.h3.connection import H3Connection, H3_ALPN
from aioquic.h3.events import HeadersReceived
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
root=pathlib.Path(sys.argv[1]); root.mkdir(parents=True,exist_ok=True)
key=ec.generate_private_key(ec.SECP256R1()); name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'BookFish HTTP3 lab')]); now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=1)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),False).sign(key,hashes.SHA256())
(root/'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM)); (root/'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
spki=base64.b64encode(hashlib.sha256(key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)).digest()).decode()
class Protocol(QuicConnectionProtocol):
 def __init__(self,*a,**kw): super().__init__(*a,**kw); self.http=H3Connection(self._quic)
 def quic_event_received(self,event):
  for e in self.http.handle_event(event):
   if isinstance(e,HeadersReceived):
    print(json.dumps({'kind':'actual-h3-request','stream':e.stream_id}),flush=True)
    self.http.send_headers(e.stream_id,[(b':status',b'200'),(b'content-type',b'text/plain'),(b'access-control-allow-origin',b'*')]);self.http.send_data(e.stream_id,b'BOOKFISH_REAL_HTTP3_OK',end_stream=True);self.transmit()
async def main():
 config=QuicConfiguration(is_client=False,alpn_protocols=H3_ALPN); config.load_cert_chain(str(root/'cert.pem'),str(root/'key.pem'))
 server=await serve('127.0.0.1',0,configuration=config,create_protocol=Protocol)
 print(json.dumps({'kind':'ready','port':server._transport.get_extra_info('sockname')[1],'spki':spki}),flush=True)
 await asyncio.Future()
asyncio.run(main())
