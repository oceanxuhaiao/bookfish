import type {WebUiPanelContext} from 'cortico/web/shared/client-panel.ts';
import type {Library} from '../library.ts';
/** Human reading is a read-only data plane: it never selects a book or confirms pet progress. */
export function readerPanel(ctx:WebUiPanelContext,parent:HTMLElement,back:()=>void){
  const en=ctx.language!=='zh'&&ctx.language!=='zh-Hant',say=(zh:string,enText:string)=>en?enText:zh;
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',into=parent)=>{const n=document.createElement(tag);n.textContent=text;into.append(n);return n;};
  const top=node('div');top.className='reader-toolbar';
  const btn=(text:string,fn:()=>void,into:HTMLElement=top)=>{const b=node('button',text,into);b.type='button';b.onclick=fn;return b;};
  btn(say('← 书籍详情','← Book details'),back);
  const directory=node('details');directory.className='reader-directory';node('summary',say('目录','Contents'),directory);const list=node('div','',directory);
  const font=node('select','',top);font.setAttribute('aria-label',say('正文字号','Text size'));for(const size of [18,20,24,28]){const o=node('option',size+' px',font);o.value=String(size);}font.value=String(ctx.memo?.get('reader-font',20)??20);
  const theme=node('select','',top);theme.setAttribute('aria-label',say('阅读背景','Reading background'));for(const [value,label]of [['paper','纸张'],['green','护眼'],['night','夜间']]){const o=node('option',en?value:label,theme);o.value=value;}theme.value=ctx.memo?.get('reader-theme','paper')??'paper';
  const notice=node('p');notice.setAttribute('role','status');const article=node('article');article.className='reader-text';article.tabIndex=-1;
  const foot=node('div');foot.className='reader-toolbar';const prev=btn(say('上一节','Previous section'),()=>void load(Math.max(0,position-8)),foot);const next=btn(say('下一节','Next section'),()=>void load(nextPosition!),foot);
  const apply=()=>{parent.dataset.theme=theme.value;article.style.fontSize=font.value+'px';};apply();font.onchange=()=>{apply();ctx.memo?.set('reader-font',Number(font.value));};theme.onchange=()=>{apply();ctx.memo?.set('reader-theme',theme.value);};
  let key='',position=0,nextPosition:number|null=null,epoch=0,loading=false;
  async function load(segment:number,chapterOffset=0){if(loading)return;loading=true;const request=++epoch;notice.textContent=say('正在载入正文…','Loading text…');prev.disabled=next.disabled=true;
    try{const data=await ctx.invoke<ReturnType<Library['reader']>>('reader',[{bookKey:key,segment,chapterOffset}]);if(ctx.signal.aborted||request!==epoch)return;
      position=data.segment;nextPosition=data.next;ctx.memo?.set('reader-position:'+key,position);article.replaceChildren();node('small',data.title,article);node('h2',data.chapter,article);
      const text=data.segments.map(s=>s.text).join('').replace(/^#{1,6}\s+[^\n]*\n/,'');for(const p of text.split(/\n+/))if(p.trim())node('p',p,article);
      list.replaceChildren();for(const c of data.chapters)btn(c.title,()=>{directory.open=false;void load(c.segment);},list);
      if(chapterOffset>0)btn(say('较早目录','Earlier contents'),()=>void load(position,Math.max(0,chapterOffset-100)),list);
      if(data.nextChapterOffset!==null)btn(say('更多目录','More contents'),()=>void load(position,data.nextChapterOffset!),list);
      notice.textContent=say('你的阅读不会改变大肥鱼的进度。','Your reading does not change her progress.')+(data.cachedOnly?say(' 网文仅展示已缓存正文。',' Only cached online chapters are available.'):'');prev.disabled=data.previous===null;next.disabled=data.next===null;article.focus();
    }catch(error){notice.textContent=say('正文载入失败，可重试：','Could not load text. Retry: ')+String(error);article.replaceChildren();btn(say('重试载入','Retry'),()=>void load(segment,chapterOffset),article);}finally{loading=false;}
  }
  return {async open(bookKey:string){key=bookKey;const saved=ctx.memo?.get<number>('reader-position:'+key,0)??0;await load(Number.isSafeInteger(saved)&&saved>=0?saved:0);}};
}
