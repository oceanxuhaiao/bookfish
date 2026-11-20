using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
class SocketProbe {
 static int Main(string[] args){try{string host=args[1];int port=int.Parse(args[2]);IPAddress ip=IPAddress.Parse(host);if(args[0]=="udp"){using(Socket s=new Socket(ip.AddressFamily,SocketType.Dgram,ProtocolType.Udp)){s.SendTo(Encoding.ASCII.GetBytes("bookfish-lab"),new IPEndPoint(ip,port));Console.WriteLine("sent");}}else{using(Socket s=new Socket(ip.AddressFamily,SocketType.Stream,ProtocolType.Tcp)){var pending=s.BeginConnect(new IPEndPoint(ip,port),null,null);if(!pending.AsyncWaitHandle.WaitOne(3000))throw new TimeoutException();s.EndConnect(pending);Console.WriteLine("connected");}}return 0;}catch(SocketException e){Console.WriteLine("blocked-or-failed "+e.SocketErrorCode);return 2;}catch(Exception e){Console.WriteLine("failed "+e.GetType().Name);return 3;}}
}
