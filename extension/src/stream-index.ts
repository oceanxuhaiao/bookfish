import type { Segment } from './books.ts';
/** Reproduce parser v1 from repeatable bounded chunks, including unusually long lines. */
export function* streamIndex(chunks:()=>Iterable<string>):Generator<Segment>{
  function* blocks(){
    let start=0,offset=0,units=0,first=-1,last=0,head='',body='',bodyUnits=0,bodyLast=0;
    let hashes=0,mode=0,markdown=false,newlines=false,chapter='正文';
    const reset=()=>{units=0;first=-1;last=0;head='';body='';bodyUnits=0;bodyLast=0;hashes=0;mode=0;markdown=false;};
    const classify=()=>{
      const length=first<0?0:last-first,line=head.slice(0,Math.min(length,200));
      if(markdown){chapter=body.slice(0,Math.min(bodyLast,200));}
      else if(length<=200&&/^第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇]/u.test(line)){chapter=line;}
    };
    for(const chunk of chunks())for(const c of chunk){
      if(c==='\n'){if(!newlines)classify();newlines=true;offset++;continue;}
      if(newlines){yield {start,end:offset,chapter};start=offset;reset();newlines=false;}
      const space=/\s/u.test(c);
      if(!space&&first<0)first=units;
      if(first>=0&&head.length<201)head+=c;
      if(!space)last=units+c.length;
      if(mode===0){if(!space){if(c==='#'){hashes=1;mode=1;}else mode=4;}}
      else if(mode===1){if(c==='#'&&hashes<6)hashes++;else if(space)mode=2;else mode=4;}
      else if(mode===2&&!space){markdown=true;mode=3;}
      if(mode===3){if(body.length<201)body+=c;bodyUnits+=c.length;if(!space)bodyLast=bodyUnits;}
      units+=c.length;offset++;
    }
    if(offset>start){if(!newlines)classify();yield {start,end:offset,chapter};}
  }
  const input=chunks()[Symbol.iterator]();let chars:string[]=[],at=0;
  const take=(n:number)=>{let text='';while(n){if(at===chars.length){const next=input.next();if(next.done)throw Error('Truncated canonical source');chars=Array.from(next.value);at=0;if(!chars.length)continue;}const count=Math.min(n,chars.length-at);text+=chars.slice(at,at+count).join('');at+=count;n-=count;}return text;};
  let pending:Segment|undefined,index=0,offset=0;
  try{for(const block of blocks()){
    let left=block.end-block.start;
    while(left){
      if(pending&&(pending.chapter!==block.chapter||pending.end-pending.start===1200)){yield pending;pending=undefined;}
      const count=Math.min(left,pending?1200-(pending.end-pending.start):1200),text=take(count);
      if(pending){pending.text+=text;pending.end+=count;}else pending={id:index++,chapter:block.chapter,start:offset,end:offset+count,text};
      offset+=count;left-=count;
    }
  }
  if(pending)yield pending;
  }finally{input.return?.();}
}
