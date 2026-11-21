// Isolated WFP experiment. Never targets an installed browser or system-wide policy.
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class WfpLab {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Display { [MarshalAs(UnmanagedType.LPWStr)] public string name; [MarshalAs(UnmanagedType.LPWStr)] public string description; }
 [StructLayout(LayoutKind.Sequential)] struct Blob {public uint size;public IntPtr data;}
 [StructLayout(LayoutKind.Explicit,Size=16)] struct Value { [FieldOffset(0)] public uint type; [FieldOffset(8)] public ulong number; [FieldOffset(8)] public IntPtr pointer; }
 [StructLayout(LayoutKind.Sequential)] struct Sub {public Guid key;public Display display;public uint flags;public IntPtr provider;public Blob data;public ushort weight;}
 [StructLayout(LayoutKind.Sequential)] struct Condition {public Guid field;public uint match;public Value value;}
 [StructLayout(LayoutKind.Sequential)] struct Action {public uint type;public Guid key;}
 [StructLayout(LayoutKind.Explicit,Size=16)] struct Context {[FieldOffset(0)] public ulong value;}
 [StructLayout(LayoutKind.Sequential)] struct Filter {public Guid key;public Display display;public uint flags;public IntPtr provider;public Blob data;public Guid layer;public Guid sub;public Value weight;public uint count;public IntPtr conditions;public Action action;public Context context;public IntPtr reserved;public ulong id;public Value effective;}
 [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmEngineOpen0(string server,uint auth,IntPtr identity,IntPtr session,out IntPtr engine);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine,uint flags);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
 [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmSubLayerAdd0(IntPtr engine,ref Sub sub,IntPtr sd);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine,ref Guid key);
 [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmFilterAdd0(IntPtr engine,ref Filter filter,IntPtr sd,out ulong id);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine,ref Guid key);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterGetByKey0(IntPtr engine,ref Guid key,out IntPtr filter);
 [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmGetAppIdFromFileName0(string path,out IntPtr blob);
 [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr pointer);
 static Guid V4=new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"), V6=new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4"), App=new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971"), Addr=new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045"),Port=new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b"),Proto=new Guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");
 static void Check(uint code,string op){if(code!=0)throw new Exception(op+" 0x"+code.ToString("x8"));}
 static Condition C(Guid field,uint type,ulong num,IntPtr ptr){Value value=new Value();value.type=type;if(ptr!=IntPtr.Zero)value.pointer=ptr;else value.number=num;return new Condition{field=field,value=value};}
 static void Add(IntPtr engine,Guid key,Guid sub,Guid layer,IntPtr app,int port,bool permit){
  List<Condition> cs=new List<Condition>();cs.Add(C(App,12,0,app));
  if(permit){cs.Add(C(Proto,1,6,IntPtr.Zero));cs.Add(C(Addr,3,0x7f000001,IntPtr.Zero));cs.Add(C(Port,2,(ulong)port,IntPtr.Zero));}
  int size=Marshal.SizeOf(typeof(Condition));IntPtr buffer=Marshal.AllocHGlobal(size*cs.Count),weight=Marshal.AllocHGlobal(8);
  try{for(int i=0;i<cs.Count;i++)Marshal.StructureToPtr(cs[i],IntPtr.Add(buffer,i*size),false);Marshal.WriteInt64(weight,permit?100:1);
   Filter f=new Filter{key=key,display=new Display{name="BookFish isolated egress lab "+(permit?"exact proxy permit":"default deny")},flags=1,layer=layer,sub=sub,weight=new Value{type=4,pointer=weight},count=(uint)cs.Count,conditions=buffer,action=new Action{type=permit?0x1002u:0x1001u}};
   ulong id;Check(FwpmFilterAdd0(engine,ref f,IntPtr.Zero,out id),"add filter");Console.WriteLine("added "+key+" id="+id);
  }finally{Marshal.FreeHGlobal(buffer);Marshal.FreeHGlobal(weight);}
 }
 public static int Main(string[] args){IntPtr engine=IntPtr.Zero;bool tx=false;try{
  if(args.Length<2)throw new Exception("install|verify|remove manifest [proxyPort appPaths...]");
  string manifest=Path.GetFullPath(args[1]);if(!manifest.Contains("\\_verify\\wfp\\"))throw new Exception("Manifest outside lab");
  string operation=args[0];
  if(operation=="hold"){Console.WriteLine("ready");Console.Out.Flush();Thread.Sleep(Timeout.Infinite);return 0;}
  if(operation=="install"){
   int apps=args.Length-3;string[] portParts=args[2].Split(',');if(portParts.Length<1||portParts.Length>2||apps<1)throw new Exception("Bad scope");foreach(string part in portParts){int port=int.Parse(part);if(port<1024||port>65535)throw new Exception("Bad port");}
   foreach(string candidate in new ArraySegment<string>(args,3,apps)){string path=Path.GetFullPath(candidate);if(!path.StartsWith(Path.GetDirectoryName(manifest)+"\\",StringComparison.OrdinalIgnoreCase)||!File.Exists(path))throw new Exception("Target outside lab or missing");}
   if(File.Exists(manifest))throw new Exception("Refusing to replace existing manifest");
   List<string> keys=new List<string>();for(int i=0;i<1+(args[2].Split(',').Length+2)*apps;i++)keys.Add(Guid.NewGuid().ToString());File.WriteAllLines(manifest,keys.ToArray());
  }
  string[] lines=File.ReadAllLines(manifest);Guid sub=new Guid(lines[0]);Check(FwpmEngineOpen0(null,10,IntPtr.Zero,IntPtr.Zero,out engine),"open");
  if(operation=="install"){
   Check(FwpmTransactionBegin0(engine,0),"begin");tx=true;
   Sub s=new Sub{key=sub,display=new Display{name="BookFish isolated egress lab"},flags=1,weight=0x7000};Check(FwpmSubLayerAdd0(engine,ref s,IntPtr.Zero),"sublayer");
   for(int appIndex=0;appIndex<args.Length-3;appIndex++){IntPtr blob;Check(FwpmGetAppIdFromFileName0(Path.GetFullPath(args[appIndex+3]),out blob),"appid");try{string[] ports=args[2].Split(',');int offset=1+(ports.Length+2)*appIndex;for(int n=0;n<ports.Length;n++)Add(engine,new Guid(lines[offset+n]),sub,V4,blob,int.Parse(ports[n]),true);Add(engine,new Guid(lines[offset+ports.Length]),sub,V4,blob,0,false);Add(engine,new Guid(lines[offset+ports.Length+1]),sub,V6,blob,0,false);}finally{FwpmFreeMemory0(ref blob);}}
   Check(FwpmTransactionCommit0(engine),"commit");tx=false;
  }else if(operation=="verify"){
   int found=0;for(int i=1;i<lines.Length;i++){Guid key=new Guid(lines[i]);IntPtr value;uint code=FwpmFilterGetByKey0(engine,ref key,out value);Console.WriteLine("filter "+key+" result=0x"+code.ToString("x8"));if(code==0){found++;FwpmFreeMemory0(ref value);}}
   Console.WriteLine("found="+found+" expected="+(lines.Length-1));return found==lines.Length-1?0:2;
  }else if(operation=="remove"){
   Check(FwpmTransactionBegin0(engine,0),"begin cleanup");tx=true;
   for(int i=1;i<lines.Length;i++){Guid key=new Guid(lines[i]);uint code=FwpmFilterDeleteByKey0(engine,ref key);if(code!=0&&code!=0x80320003)Check(code,"delete filter");}
   uint subCode=FwpmSubLayerDeleteByKey0(engine,ref sub);if(subCode!=0&&subCode!=0x80320007)Check(subCode,"delete sublayer");Check(FwpmTransactionCommit0(engine),"commit cleanup");tx=false;Console.WriteLine("removed scoped filters and sublayer");
  }else throw new Exception("Unknown command");
  return 0;
 }catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}finally{if(engine!=IntPtr.Zero){if(tx)FwpmTransactionAbort0(engine);FwpmEngineClose0(engine);}}}
}
