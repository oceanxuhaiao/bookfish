import {settingsPanel} from './settings.ts';
import type { WebUiClientBundle,WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { LibraryPanelState } from '../status.ts';
import type { Library } from '../library.ts';
import legacy from './legacy.ts';
import { style } from './style.ts';
import { moodPrefix } from './mood.ts';
import {readerPanel} from './reader.ts';
import {mountRuntimeCard} from './runtime.ts';
import {coverDesign} from './cover.ts';
import type { NovelFetchStatus, NovelResumeView, NovelSearchJobView, NovelTaskView } from '../novel-fetch.ts';
import { groupCandidatesByBook, type CandidateMatch, type NovelSearchCandidate } from '../novel-match.ts';
import { QQ_GROUP_QR } from './qq-group.ts';

const supportPanel={ async mount(ctx:WebUiPanelContext) {
  const en=ctx.language!=='zh'&&ctx.language!=='zh-Hant';const say=(zh:string,english:string)=>en?english:zh;
  const root=document.createElement('section');root.className='bf';ctx.root.append(root);
  const css=document.createElement('style');css.textContent=style;root.append(css);
  const page=document.createElement('section');page.dataset.page='support';root.append(page);
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',parent:HTMLElement=page)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
  el('h2',say('反馈与支持','Feedback & support'));
  el('p',say('遇到问题、想提建议，或想找同好聊聊，可以从下面任选一种方式。提问题时请附上扩展版本、报错文字和复现步骤。','Found a problem, have a suggestion, or want to talk with other readers? Use any option below. Please include the extension version, error text and steps to reproduce.'));
  const grid=el('div','');grid.className='support-grid';
  const actions=el('div','',grid);actions.className='support-actions';
  const issues=el('section','',actions);issues.className='card support-card';el('h3','GitHub Issues',issues);el('p',say('报告 bug、功能建议或安装问题。','Report bugs, feature requests or installation problems.'),issues);
  for(const [href,label] of [['https://github.com/oceanxuhaiao/bookfish/issues',say('打开 GitHub Issues →','Open GitHub Issues →')],['https://github.com/oceanxuhaiao/bookfish',say('项目仓库：oceanxuhaiao/bookfish','Repository: oceanxuhaiao/bookfish')]]){const a=document.createElement('a');a.href=href;a.target='_blank';a.rel='noreferrer';a.textContent=label;a.className='support-link';issues.append(a);}
  const author=el('section','',actions);author.className='card support-card';el('h3',say('作者','Author'),author);
  const a=document.createElement('a');a.href='https://github.com/oceanxuhaiao';a.target='_blank';a.rel='noreferrer';a.textContent='oceanxuhaiao';a.className='support-link';author.append(a);
  el('p',say('Bookfish 扩展与运行时由 oceanxuhaiao 维护；运行时上游归属见项目 README。','Bookfish and the runtime are maintained by oceanxuhaiao; runtime upstream attribution is in the repository README.'),author);
  const sponsor=el('section','',actions);sponsor.className='card support-card';el('h3',say('支持作者（自愿）','Support the author (optional)'),sponsor);
  el('p',say('如果 Bookfish 对你有帮助，可以请作者吃个菠萝 🍍。赞助完全自愿，不解锁功能，不改变 MIT/AGPL 许可，也不构成购买引擎或运行时。','If Bookfish helps you, you can buy the author a pineapple 🍍. Support is voluntary; it unlocks nothing, does not change the MIT/AGPL licenses, and is not a purchase of the engine or runtime.'),sponsor);
  const sponsorLink=document.createElement('a');sponsorLink.href='https://afdian.com/a/book-fish';sponsorLink.target='_blank';sponsorLink.rel='noreferrer';sponsorLink.textContent=say('前往爱发电支持 →','Support on Afdian →');sponsorLink.className='support-link';sponsor.append(sponsorLink);
  const community=el('section','',grid);community.className='card support-card support-community';
  const communityText=el('div','',community);communityText.className='support-community-text';
  el('h3',say('QQ 群','QQ group'),communityText);
  const row=el('p','',communityText);row.className='support-number';row.append(document.createTextNode(say('群号：1135570183','Group: 1135570183')));
  const copy=document.createElement('button');copy.type='button';copy.textContent=say('复制群号','Copy number');copy.className='support-copy';copy.addEventListener('click',()=>{void navigator.clipboard?.writeText('1135570183').then(()=>{copy.textContent=say('已复制','Copied');}).catch(()=>{copy.textContent=say('请手动复制','Copy manually');});},{signal:ctx.signal});row.append(copy);
  el('small',say('扫码加入 QQ 群；群号也可直接搜索。','Scan to join, or search the group number.'),communityText).className='support-note';
  const qr=document.createElement('img');qr.src=QQ_GROUP_QR;qr.alt=say('QQ群 1135570183 入群二维码','QQ group 1135570183 join QR code');qr.width=250;qr.height=325;qr.className='qq-group-code';qr.loading='lazy';community.append(qr);
  return { dispose(){ root.remove(); } };
} };

const readingPanel={ async mount(ctx:WebUiPanelContext) {
  const en = ctx.language !== 'zh' && ctx.language !== 'zh-Hant';
  const say = (zh:string, english:string) => en ? english : zh;
  let getRevision=0;
  let state:LibraryPanelState|undefined, update: (()=>Promise<void>)|undefined, disposed=false;
  const root=document.createElement('section');root.className='bf';ctx.root.append(root);
  const css=document.createElement('style');css.textContent=style;root.append(css);
  const body=document.createElement('div');root.append(body);
  const handle=await legacy.panels.status.mount({...ctx,root:body,invoke:async <T,>(method:string,args?:unknown[])=>{
    const sequence=method==='get'?++getRevision:0;const result=await ctx.invoke<T>(method,args);if(method==='get'&&sequence===getRevision&&!disposed&&!ctx.signal.aborted){state=result as LibraryPanelState;await update?.();}return result;
  }});
  const old=body.firstElementChild as HTMLElement;old.style.cssText='';
  const heading=old.querySelector('h2')!;heading.hidden=true;heading.textContent=say('🐟 看书吧！大肥鱼','🐟 Bookfish');
  const nav=document.createElement('nav');nav.hidden=true;nav.setAttribute('aria-label',say('阅读导航','Reading navigation'));heading.after(nav);
  const messages=old.querySelector('[role=status]') as HTMLElement;messages.className='messages';nav.after(messages);
  const pages:Record<string,HTMLElement>={};for(const id of ['home','shelf','trail','support','bookDetail','reader']){const el=document.createElement('section');el.dataset.page=id;old.append(el);pages[id]=el;}
  function page(id:string){for(const[key,el]of Object.entries(pages))el.hidden=key!==id;for(const b of nav.querySelectorAll('button'))b.setAttribute('aria-current',(b.dataset.page===id||id==='bookDetail'&&b.dataset.page==='shelf')?'page':'false');}
  ['正在读','书架','阅读足迹','反馈'].forEach((label,i)=>{const b=document.createElement('button');const id=['home','shelf','trail','support'][i];b.textContent=en?['Reading','Bookshelf','Journal','Support'][i]:label;b.dataset.page=id;b.onclick=()=>{if(id==='support')buildSupport();page(id);};nav.append(b);});
  function el<K extends keyof HTMLElementTagNameMap>(tag:K,text='',parent:HTMLElement=pages.home){const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;}
  let supportBuilt=false;
  function buildSupport(){if(supportBuilt)return;supportBuilt=true;const support=pages.support;
  el('h2',say('反馈与支持','Feedback & support'),support);
  el('p',say('遇到问题、想提建议，或想找同好聊聊，可以从下面任选一种方式。提问题时请附上扩展版本、报错文字和复现步骤。','Found a problem, have a suggestion, or want to talk with other readers? Use any option below. Please include the extension version, error text and steps to reproduce.'),support);
  const supportGrid=el('div','',support);supportGrid.className='support-grid';
  const issues=el('section','',supportGrid);issues.className='card support-card';
  el('h3',say('GitHub Issues','GitHub Issues'),issues);
  el('p',say('报告 bug、功能建议或安装问题。','Report bugs, feature requests or installation problems.'),issues);
  const issuesLink=document.createElement('a');issuesLink.href='https://github.com/oceanxuhaiao/bookfish/issues';issuesLink.target='_blank';issuesLink.rel='noreferrer';issuesLink.textContent=say('打开 GitHub Issues →','Open GitHub Issues →');issuesLink.className='support-link';issues.append(issuesLink);
  const repoLink=document.createElement('a');repoLink.href='https://github.com/oceanxuhaiao/bookfish';repoLink.target='_blank';repoLink.rel='noreferrer';repoLink.textContent=say('项目仓库：oceanxuhaiao/bookfish','Repository: oceanxuhaiao/bookfish');repoLink.className='support-link';issues.append(repoLink);
  const qq=el('section','',supportGrid);qq.className='card support-card';
  el('h3',say('QQ 群','QQ group'),qq);
  const numberRow=el('p','',qq);numberRow.className='support-number';numberRow.append(document.createTextNode(say('群号：1135570183','Group: 1135570183')));
  const copy=document.createElement('button');copy.type='button';copy.textContent=say('复制群号','Copy number');copy.className='support-copy';copy.addEventListener('click',()=>{void navigator.clipboard?.writeText('1135570183').then(()=>{copy.textContent=say('已复制','Copied');}).catch(()=>{copy.textContent=say('请手动复制','Copy manually');});},{signal:ctx.signal});numberRow.append(copy);
  const qr=document.createElement('img');qr.src=QQ_GROUP_QR;qr.alt=say('QQ群 1135570183 入群二维码','QQ group 1135570183 join QR code');qr.width=250;qr.height=325;qr.className='qq-group-code';qr.loading='lazy';qq.append(qr);
  el('small',say('扫码加入 QQ 群；群号也可直接搜索。','Scan to join, or search the group number.'),qq).className='support-note';
  const author=el('section','',supportGrid);author.className='card support-card';
  el('h3',say('作者','Author'),author);
  const authorLink=document.createElement('a');authorLink.href='https://github.com/oceanxuhaiao';authorLink.target='_blank';authorLink.rel='noreferrer';authorLink.textContent='oceanxuhaiao';authorLink.className='support-link';author.append(authorLink);
  el('p',say('Bookfish 扩展与运行时由 oceanxuhaiao 维护；运行时上游归属见项目 README。','Bookfish and the runtime are maintained by oceanxuhaiao; runtime upstream attribution is in the repository README.'),author);}
  let busy=false;
  async function perform(action:()=>Promise<unknown>){if(busy||disposed||ctx.signal.aborted)return;busy=true;messages.textContent=say('正在处理…','Working…');try{await action();if(!disposed&&!ctx.signal.aborted){messages.textContent=pages.bookDetail.hidden?say('操作完成。','Done.'):'';const sequence=++getRevision;const fresh=await ctx.invoke<LibraryPanelState>('get',[]);if(sequence===getRevision){state=fresh;await update?.();}}}catch(e){if(!disposed)messages.textContent=String(e).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/,'');}finally{busy=false;await update?.();}}
  function button(parent:HTMLElement,label:string,fn:()=>Promise<unknown>){const b=el('button',label,parent);b.type='button';b.addEventListener('click',()=>void perform(fn),{signal:ctx.signal});return b;}
  function details(parent:HTMLElement,label:string){const d=el('details','',parent);el('summary',label,d);return d;}
  const advanced=details(pages.shelf,say('书架数据管理','Bookshelf data management'));
  const forms=[...old.querySelectorAll('form')];const importForm=forms[0],remoteForm=forms[1],searchForm=forms[2];
  const shelf=old.querySelector('[data-bookfish=shelf]') as HTMLElement;
  const notebook=old.querySelector('section[aria-label="'+say('阅读手账','Reading journal')+'"]') as HTMLElement;
  const articles=old.querySelector('section[aria-label="'+say('全书读后感','Full-book reviews')+'"]') as HTMLElement;
  const articleDetail=articles.nextElementSibling as HTMLElement;
  const episodeDetail=old.querySelector('section[aria-label="'+say('感想与原文依据','Episode and evidence')+'"]') as HTMLElement;
  const controls=old.querySelector('[data-bookfish=controls]') as HTMLElement;
  const recommend=el('section','',pages.shelf);recommend.className='card';recommend.id='bf-recommend-panel';recommend.hidden=true;recommend.setAttribute('aria-label',say('推荐一本书','Recommend a book'));
  const recommendHead=el('div','',recommend);recommendHead.className='shelf-header';el('h3',say('推荐一本书','Recommend a book'),recommendHead);const closeRecommend=el('button',say('收起','Close'),recommendHead);closeRecommend.type='button';
  el('p',say('选择导入方式，把小说交给她慢慢读。','Choose how to add a novel for her to read at her own pace.'),recommend);
  const methodPicker=el('div','',recommend);methodPicker.className='import-method';
  const methodLabel=el('label',say('导入方式','Import method'),methodPicker);
  const methodSelect=document.createElement('select');methodSelect.setAttribute('aria-label',say('导入方式','Import method'));
  for(const [value,label] of [['file',say('文件导入','Import a file')],['link',say('链接获取','Fetch from a link')],['title',say('书名或作者获取','Fetch by title or author')]] as Array<[string,string]>){const option=el('option',label,methodSelect);option.value=value;}
  methodLabel.append(methodSelect);
  const methodPanel=el('div','',recommend);methodPanel.className='import-method-panel';
  const filePanel=el('div','',methodPanel);filePanel.append(importForm);
  const linkPanel=el('div','',methodPanel);linkPanel.append(remoteForm);linkPanel.hidden=true;
  const importStatus=old.querySelector('[data-bookfish=import-status]');if(importStatus)pages.shelf.prepend(importStatus);
  pages.shelf.append(shelf);shelf.hidden=true;
  const novel=el('section','',methodPanel);novel.className='card';novel.id='bf-novel-fetch';novel.hidden=true;
  el('h3',say('按书名或作者获取','Fetch by title or author'),novel);
  el('p',say('书名或作者至少填一个，也可同时填写。先核对作者、书源和最新章节，再获取全本。只有通过目录连续性、缺章、页数探针与版本一致性校验的结果才会加入书架。','Enter a title, an author, or both. Confirm author, source and latest chapter before fetching. Only downloads that pass catalog, chapter, page-probe and edition checks enter the shelf.'),novel);
  const novelGate=el('p',say('按书名或作者获取前，需要先安装小说获取引擎。点下方“一键安装小说引擎”，或导入离线运行时包；安装完成后搜索会自动启用。文件导入和链接获取不受影响。','Before fetching by title or author, install the novel fetch engine. Use “Install novel engine” below, or import an offline runtime ZIP; search enables automatically when ready. File import and link fetching are unaffected.'),novel);novelGate.className='novel-engine-gate';novelGate.hidden=true;novelGate.setAttribute('role','status');
  const novelForm=document.createElement('form');novelForm.className='novel-form';novel.append(novelForm);
  const runtimeHost=document.createElement('div');runtimeHost.className='runtime-guide';runtimeHost.hidden=true;novelForm.before(runtimeHost);
  let runtimeCard:{dispose:()=>void;refresh:()=>Promise<void>}|undefined;
  function showRuntimeGuide(show:boolean){
    runtimeHost.hidden=!show;
    if(show&&!runtimeCard)runtimeCard=mountRuntimeCard(runtimeHost,ctx,{compact:true,onReady:()=>{void perform(async()=>{await pollNovel();});}});
    if(!show&&runtimeCard){runtimeCard.dispose();runtimeCard=undefined;runtimeHost.replaceChildren();}
  }
  const novelTitleLabel=document.createElement('label');novelTitleLabel.textContent=say('书名（可只填书名或只填作者）','Title (title or author alone is fine)');const novelTitleInput=document.createElement('input');novelTitleInput.type='text';novelTitleInput.maxLength=200;novelTitleInput.placeholder=say('例如 三国演义','e.g. Romance of the Three Kingdoms');novelTitleLabel.append(novelTitleInput);novelForm.append(novelTitleLabel);
  const novelAuthorLabel=document.createElement('label');novelAuthorLabel.textContent=say('作者（可只填作者）','Author (author alone is fine)');const novelAuthorInput=document.createElement('input');novelAuthorInput.type='text';novelAuthorInput.maxLength=100;novelAuthorInput.placeholder=say('例如 罗贯中','e.g. Luo Guanzhong');novelAuthorLabel.append(novelAuthorInput);novelForm.append(novelAuthorLabel);
  const novelHint=el('small',say('至少填写书名或作者之一；同时填写时会先按书名搜索，找不到精确匹配再按作者搜索。','At least one field is required. With both fields, title is searched first and author is added when no exact match is found.'),novelForm);
  const novelSubmit=document.createElement('button');novelSubmit.type='submit';novelSubmit.className='primary';novelSubmit.textContent=say('搜索候选版本','Search versions');novelForm.append(novelSubmit);
  const novelProgress=document.createElement('progress');novelProgress.className='novel-search-progress';novelProgress.setAttribute('aria-label',say('搜索进度','Search progress'));novelProgress.hidden=true;novelForm.append(novelProgress);
  const novelProgressText=el('small','',novelForm);novelProgressText.hidden=true;
  function selectImportMethod(method:string,focus=false){
    filePanel.hidden=method!=='file';linkPanel.hidden=method!=='link';novel.hidden=method!=='title';
    if(method==='title')void pollNovel();
    if(!focus)return;
    if(method==='file')(importForm.querySelector('input[type=file]') as HTMLInputElement|null)?.focus();
    else if(method==='link')(remoteForm.querySelector('input') as HTMLInputElement|null)?.focus();
    else if(!novelGate.hidden)runtimeHost.querySelector<HTMLButtonElement>('button')?.focus();
    else novelTitleInput.focus();
  }
  selectImportMethod('file');
  methodSelect.addEventListener('change',()=>selectImportMethod(methodSelect.value,true),{signal:ctx.signal});
  const novelNote=el('p','',novel);novelNote.setAttribute('role','status');novelNote.setAttribute('aria-live','polite');
  const novelResume=el('div','',novel);novelResume.className='novel-resume';
  const novelList=el('div','',novel);novelList.className='novel-candidates';
  const novelTasks=el('div','',novel);novelTasks.className='novel-task-list';
  const serial=el('section','',recommend);serial.className='card';serial.id='bf-serial-follow';
  const serialHead=el('h3',say('作为连载追更','Follow a serial'),serial);const serialExperimental=el('span',say('实验功能','Experimental'),serialHead);serialExperimental.className='badge experimental';
  el('p',say('先读取完整目录，确认来源、连载状态和章数，再建立一个可增量追加的连载条目。它与“下载当前版本”不同：只追加新章，不清空已读进度。','Read the full catalog first, confirm source, status and chapter count, then create an incremental serial entry. Unlike “download this version”, it only appends new chapters and never resets reading progress.'),serial);
  const serialUrlLabel=document.createElement('label');serialUrlLabel.textContent=say('连载目录链接','Serial catalog URL');const serialUrl=document.createElement('input');serialUrl.type='url';serialUrl.placeholder='https://www.02345.cc/bookname/';serialUrl.maxLength=2000;serialUrlLabel.append(serialUrl);serial.append(serialUrlLabel);
  const serialPreviewButton=button(serial,say('读取完整目录','Read full catalog'),async()=>{serialPreviewBox.replaceChildren();serialNote.textContent=say('正在读取目录页…','Reading the catalog…');const preview=await ctx.invoke<SerialPreview>('serial_preview',[{url:serialUrl.value.trim(),sourceId:'biquge-02345-v1'}]);if(disposed||ctx.signal.aborted)return;renderSerialPreview(preview);});
  const serialNote=el('p','',serial);serialNote.setAttribute('role','status');serialNote.setAttribute('aria-live','polite');
  const serialPreviewBox=el('div','',serial);
  let serialPreviewToken:string|undefined;
  type SerialPreview={token:string;title:string;author:string;publicationStatus:string;totalChapters:number;authorization:string;authorizationNote:string;note:string};
  function renderSerialPreview(preview:SerialPreview){
    serialPreviewToken=preview.token;serialPreviewBox.replaceChildren();
    el('strong',preview.title+' · '+(preview.author||say('作者未知','Unknown author')),serialPreviewBox);
    el('small',(preview.publicationStatus==='finished'?say('已完结','Finished'):preview.publicationStatus==='ongoing'?say('连载中','Ongoing'):say('状态未知','Status unknown'))+say(' · 目录 ',' · catalog ')+preview.totalChapters+say(' 章',' chapters'),serialPreviewBox);
    if(preview.authorization!=='allowed')el('small',say('来源用途授权未确认：只在本机缓存阅读，不视为已获授权，也不对外分发。','Source permission is unconfirmed: cached locally for reading only, not treated as authorized or redistributed.'),serialPreviewBox);
    el('small',preview.note,serialPreviewBox);
    button(serialPreviewBox,say('建立连载追更','Create serial subscription'),async()=>{const result=await ctx.invoke<{bookKey:string;jobId:string}>('serial_subscribe',[serialPreviewToken,{intervalMinutes:60,enabled:true}]);serialNote.textContent=say('正在获取第一批正文…','Fetching the first batch…');await pollSerialJob(result.jobId);serialPreviewBox.replaceChildren();await perform(async()=>{});});
  }
  async function pollSerialJob(jobId:string){
    for(let attempt=0;attempt<160&&!disposed&&!ctx.signal.aborted;attempt++){
      const job=await ctx.invoke<{jobId:string;status:string;stage:string;target:number;added:number;discovered:number;message:string|null}>('serial_job',[jobId]);
      if(job){serialNote.textContent=job.stage+(job.target?` · ${job.added}/${job.target}`:'')+(job.message?' · '+job.message:'');if(['succeeded','failed','cancelled','interrupted','conflict'].includes(job.status)){if(job.status==='succeeded'||job.status==='failed')await perform(async()=>{});return job;}}
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    return null;
  }

  let novelPollTimer:ReturnType<typeof setTimeout>|undefined;const novelSeenComplete=new Set<string>();let novelRefreshPending=false;
  const novelStateLabel:Record<string,string>={queued:say('排队中','Queued'),fetching:say('正在获取','Fetching'),validating:say('正在校验','Validating'),complete:say('已加入书架','Added to shelf'),failed:say('获取失败','Failed'),cancelled:say('已取消','Cancelled')};
  const issueText:Record<string,string>={
    catalog_duplicate_number:say('书源目录存在重复章节编号','Duplicate chapter numbers in the source catalog'),
    catalog_number_regression:say('书源目录章节编号回退','Chapter numbers go backwards in the source catalog'),
    catalog_number_order_mismatch:say('目录顺序与章节编号偏移不一致，可能混入其它版本','Catalog order and chapter numbers drift apart; likely a mixed edition'),
    catalog_duplicate_title:say('书源目录存在重复章节标题','Duplicate chapter titles in the source catalog'),
    catalog_order_gap:say('书源目录序号不连续','Catalog order is not contiguous'),
    catalog_changed:say('下载前后目录发生变化','Catalog changed during download'),
    missing_chapter:say('缺少章节','A chapter is missing'),
    unexpected_chapter_file:say('出现了目录外的章节文件','A file has no catalog entry'),
    empty_chapter:say('章节正文为空','A chapter is empty'),
    source_empty_chapter:say('书源该章没有正文，仅保留标题','The source chapter has no body; only its heading is kept'),
    short_chapter:say('章节正文明显过短','A chapter is unusually short'),
    placeholder_chapter:say('章节是占位页','A chapter is a placeholder'),
    duplicate_chapter_body:say('多个章节正文重复','Several chapters share the same body'),
    missing_page_marker:say('章节只取到第一页','A chapter stopped at its first page'),
    truncated_chapter_tail:say('章节在句中截断','A chapter ends mid-sentence'),
    page_probe_missing_page:say('页数探针发现漏页','Page probe found a missing source page'),
    page_probe_short:say('页数探针发现正文明显偏短','Page probe found a materially shorter body'),
    page_probe_unavailable:say('页数探针无法读取源站','Page probe could not read the source'),
  };
  function candidateLabel(candidate:NovelSearchCandidate&{match:CandidateMatch}){
    const onlyTitle=!novelAuthorInput.value.trim(),onlyAuthor=!novelTitleInput.value.trim();
    return candidate.match==='exact'?(onlyTitle?say('书名匹配','Title matches'):onlyAuthor?say('作者匹配','Author matches'):say('书名、作者匹配','Title and author match')):candidate.match==='title'?say('书名相同，作者不匹配，已停用','Same title, different author; disabled'):candidate.match==='author'?say('作者匹配但书名不同，已停用','Author matches but title differs; disabled'):say('不匹配，已停用','No match; disabled');
  }
  async function fetchCandidate(candidate:NovelSearchCandidate&{match:CandidateMatch}){
    if(candidate.match!=='exact')throw Error(say('候选不匹配当前搜索条件，不能获取。','This candidate does not match the current search.'));
    await ctx.invoke('novel_fetch',[candidate]);
    novelNote.textContent=say('已加入获取队列，只有全部校验通过才会入架；失败时可换用其他书源。','Queued. Nothing enters the shelf unless every check passes; if it fails, try another source.');
    startNovelPoll();
  }
  function candidateCard(candidate:NovelSearchCandidate&{match:CandidateMatch},alternatives:Array<NovelSearchCandidate&{match:CandidateMatch}>=[]){
    const card=document.createElement('article');card.className='novel-candidate';novelList.append(card);
    el('strong',candidate.title,card);el('small',(candidate.author||say('作者未知','Unknown author'))+' · '+candidate.source.name+(candidate.latestChapter?' · '+candidate.latestChapter:''),card);
    el('small',candidateLabel(candidate),card);
    const fetch=button(card,say('获取全本','Fetch full book'),()=>fetchCandidate(candidate));
    if(candidate.match!=='exact')fetch.disabled=true;
    if(alternatives.length){
      const more=document.createElement('details');card.append(more);
      const summary=document.createElement('summary');summary.textContent=say('其他书源（','Other sources (')+alternatives.length+')';more.append(summary);
      for(const alternative of alternatives){
        const row=document.createElement('div');row.className='novel-alternative';more.append(row);
        el('small',alternative.source.name+(alternative.latestChapter?' · '+alternative.latestChapter:''),row);
        const use=button(row,say('用此源获取','Fetch from this source'),()=>fetchCandidate(alternative));
        if(alternative.match!=='exact')use.disabled=true;
      }
    }
  }
  function renderCandidateGroups(candidates:Array<NovelSearchCandidate&{match:CandidateMatch}>){
    const rank=(match:CandidateMatch)=>match==='exact'?0:match==='title'?1:match==='author'?2:3;
    const groups=groupCandidatesByBook(candidates);
    groups.sort((a,b)=>rank(a[0]!.match)-rank(b[0]!.match));
    for(const group of groups)candidateCard(group[0]!,group.slice(1));
  }
  async function resumeUnfinished(entry:NovelResumeView){
    const candidate={title:entry.title,author:entry.author,source:{id:entry.source.id,name:entry.source.name},url:entry.url,revision:entry.revision,latestChapter:'',lastUpdateTime:''};
    await ctx.invoke('novel_fetch',[candidate]);
    novelNote.textContent=say('已继续下载，只补齐缺失章节；完成后仍会重新校验。','Resumed; only missing chapters are fetched and every check still runs.');
    startNovelPoll();
  }
  function renderResumable(status:NovelFetchStatus){
    novelResume.replaceChildren();
    const rows=status.resumable??[];if(!rows.length)return;
    const history=document.createElement('details');history.className='novel-resume-history';novelResume.append(history);
    el('summary',say('未完成或待重新校验的下载（','Unfinished or unverified downloads (')+rows.length+'）',history);
    for(const entry of rows){
      const card=document.createElement('article');card.className='novel-task';history.append(card);
      const completeDownload=entry.catalogChapters>0&&entry.downloadedChapters>=entry.catalogChapters;
      el('strong',entry.title+' · '+entry.author,card);
      el('small',entry.source.name+(completeDownload?say(' · 下载已完成，校验未通过',' · download complete; checks failed'):say(' · 已下载 ',' · downloaded ')+entry.downloadedChapters+(entry.catalogChapters?'/'+entry.catalogChapters:'')+say(' 章',' chapters')),card);
      if(entry.catalogChapters){const bar=document.createElement('progress');bar.max=entry.catalogChapters;bar.value=Math.min(entry.downloadedChapters,entry.catalogChapters);bar.setAttribute('aria-label',say('续传进度','Resume progress'));card.append(bar);}
      button(card,completeDownload?say('重新校验','Recheck'):say('继续下载','Continue download'),()=>resumeUnfinished(entry));
    }
  }
  function renderNovelTasks(status:NovelFetchStatus|undefined){
    if(!status)return;
    renderResumable(status);
    const enabled=status.available;
    novelGate.hidden=enabled;
    showRuntimeGuide(!enabled);
    for(const node of novelForm.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button'))node.disabled=!enabled;
    novelNote.textContent=enabled?say('引擎可用。先搜索，选择明确匹配的版本。','Engine ready. Search first and choose an exact match.'):say('小说引擎未安装：','Novel engine unavailable: ')+(status.reason??'')+say('。可在下方安装或导入离线运行时包；已导入书籍仍可阅读。',' You can install below or import an offline runtime ZIP; shelf books remain readable.');
    novelTasks.replaceChildren();
    for(const task of status.tasks.slice(0,3)){
      const card=document.createElement('article');card.className='novel-task';novelTasks.append(card);
      el('strong',task.title+' · '+task.author,card);
      el('small',(task.origin==='autonomous'?say('大肥鱼自选 · ','Her own pick · '):say('你发起 · ','Manual · '))+(novelStateLabel[task.state]??task.state)+(task.catalogChapters?say(' · 章节 ',' · chapters ')+task.downloadedChapters+'/'+task.catalogChapters:''),card);
      const bar=document.createElement('progress');bar.max=100;bar.value=task.percent;bar.setAttribute('aria-label',say('获取进度','Fetch progress'));card.append(bar);
      const uniqueIssues=[...new Set(task.issues.map(issue=>issue.code))];
      if(task.issueCount)el('p',say('校验问题：','Checks failed: ')+uniqueIssues.slice(0,5).map(code=>issueText[code]??code).join('；')+(task.issueCount>uniqueIssues.length?' …':''),card);
      if(uniqueIssues.some(code=>code.startsWith('catalog_')))el('small',say('这是书源目录本身的章节编号/顺序问题，不是你的操作或网络故障；本扩展为避免缺章和混版没有下载，可以换一个书源再试。','The source catalog itself has duplicate or inconsistent chapter numbering. Bookfish refused to download to avoid missing or mixed editions; try another source.'),card);
      if(task.warningCount){const uniqueWarnings=[...new Set(task.warnings.map(issue=>issue.code))];const tail=uniqueWarnings.includes('truncated_chapter_tail');el('small',(tail?say('书源该章末尾本身残缺，没有补齐或编造文字；已保留并记录警告：','The source chapter itself ends mid-sentence; no text was invented. Recorded warning: '):say('已记录的警告：','Recorded warnings: '))+uniqueWarnings.map(code=>issueText[code]??code).join('；'),card);}
      if(task.error&&task.state!=='complete'){const timeout=task.error.match(/Download timed out after (\d+) minutes/u);const detail=timeout?say(`下载超时（约${timeout[1]}分钟），未加入书架；可重试或换一个书源。`,`Download timed out after ${timeout[1]} minutes; nothing entered the shelf. Retry or use another source.`):task.error.includes('Catalog gate')?say('书源目录未通过校验，未下载任何章节。','The source catalog failed validation; nothing was downloaded.'):task.error.includes('Integrity gate')?say('下载内容未通过完整性校验，未加入书架。','The download failed integrity checks and was not added.'):task.error;el('small',detail,card);}
      if(task.state==='complete'){const present=!!state?.books.some(book=>book.key===task.bookKey);el('p',present?(task.warningCount?say('已加入书架；目录有少量编号警告，已记录。','Added to the shelf with a few recorded catalog-number warnings.'):say('已加入书架，可在书架查看并阅读。','Added to the shelf; open it in Bookshelf.')):say('这次获取的书已从书架删除。','This fetched book has been removed from the shelf.'),card);}
      if(['queued','fetching','validating'].includes(task.state)){const cancel=document.createElement('button');cancel.type='button';cancel.textContent=say('取消获取','Cancel fetch');cancel.onclick=()=>void perform(async()=>{await ctx.invoke('novel_cancel',[task.id]);await pollNovel();});card.append(cancel);}
    }
  }
  async function pollNovel(){
    if(disposed||ctx.signal.aborted)return;
    try{const status=await ctx.invoke<NovelFetchStatus>('novel_status',[]);if(disposed||ctx.signal.aborted)return;if(state)state.novel=status;renderNovelTasks(status);
      const active=status.tasks.some(task=>['queued','fetching','validating'].includes(task.state));
      const completed=status.tasks.filter(task=>task.state==='complete'&&task.bookKey&&!novelSeenComplete.has(task.id));
      if(completed.length&&!novelRefreshPending){novelList.replaceChildren();for(const task of completed)novelSeenComplete.add(task.id);novelRefreshPending=true;try{const fresh=await ctx.invoke<LibraryPanelState>('get',[]);if(!disposed&&!ctx.signal.aborted){state=fresh;await update?.();}}finally{novelRefreshPending=false;}}
      if(active)startNovelPoll();
    }catch(error){novelNote.textContent=String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/,'');}
  }
  function startNovelPoll(){if(disposed||novelPollTimer!==undefined)return;novelPollTimer=setTimeout(()=>{novelPollTimer=undefined;void pollNovel();},1800);}
  // While the engine is missing, refresh the compact install card so progress
  // started in another tab becomes visible; its onReady callback refreshes the
  // novel status exactly once when the engine becomes usable.
  ctx.interval(()=>{if(!disposed&&state?.novel&&!state.novel.available)void runtimeCard?.refresh();},4000);
  novelForm.addEventListener('submit',(event)=>{event.preventDefault();void perform(async()=>{const title=novelTitleInput.value.trim(),author=novelAuthorInput.value.trim();if(!title&&!author)throw Error(say('请至少填写书名或作者。','Enter a title or an author.'));novelList.replaceChildren();novelSubmit.disabled=true;novelProgress.hidden=false;novelProgress.max=100;novelProgress.value=0;novelProgressText.hidden=false;novelProgressText.textContent=say('正在准备搜索…','Preparing search…');novelNote.textContent=say('正在搜索候选版本…','Searching versions…');try{const job=await ctx.invoke<NovelSearchJobView>('novel_search_start',[{title,author}]);for(;;){if(disposed||ctx.signal.aborted)return;const status=await ctx.invoke<NovelSearchJobView>('novel_search_status',[job.id]);if(disposed||ctx.signal.aborted)return;novelProgress.value=status.total?Math.round(status.completed/status.total*100):0;novelProgressText.textContent=say('已检查 ','Checked ')+status.completed+'/'+status.total+say(' 个书源',' sources')+(status.source?' · '+status.source.name:'')+(status.total>6?'（同名同作者无精确结果，正在追加作者搜索）':'');if(status.state==='failed')throw Error(status.error??say('搜索失败','Search failed'));if(status.state==='complete'){const candidates=status.candidates??[];if(!candidates.length){novelNote.textContent=say('没有找到候选，请检查书名/作者或换一个书源后重试。','No candidates found. Check the title/author and try again.');return;}novelProgress.value=100;novelNote.textContent=say('找到 ','Found ')+candidates.length+say(' 个候选；同书名同作者的其他书源已折叠在“其他书源”里。',' candidates; other sources for the same title/author are folded under “Other sources”.');renderCandidateGroups(candidates);return;}await new Promise(resolveDelay=>setTimeout(resolveDelay,350));}}finally{novelSubmit.disabled=false;novelProgress.hidden=true;novelProgressText.hidden=true;}});},{signal:ctx.signal});

  notebook.className='notebook';pages.trail.append(notebook,episodeDetail,searchForm);
  const reviews=details(pages.home,say('这本书的读后感','Reviews of this book'));reviews.append(articles,articleDetail);
  const current=el('article','',pages.home);current.className='card';pages.home.prepend(current);
  const readingState=el('div','',current);readingState.className='reading-state';readingState.setAttribute('role','status');readingState.setAttribute('aria-live','polite');const stateLabel=el('strong','',readingState),stateDetail=el('span','',readingState);
  const title=el('h2','',current),chapter=el('p','',current),meter=el('progress','',current),pageText=el('p','',current);const meterLabel=el('small','',current);meter.after(meterLabel);meter.max=1;meter.setAttribute('aria-label',say('已确认阅读进度','Confirmed reading progress'));
  current.append(controls);controls.className='controls';
  const help=details(current,say('页数怎么算？','How are pages counted?'));el('small',say('每600个正文码点折算一页，与字号无关。仅计已确认内容；网文全书尚未缓存时不显示总页数。','600 source code points per page, independent of font size. Only confirmed text counts; uncached remote totals remain unknown.'),help);
  const log=el('section','',current);el('h3',say('她什么时候读到这里','Reading timeline'),log);const zone=el('small','',log);const timeline=el('div','',log);timeline.className='timeline';timeline.tabIndex=0;timeline.setAttribute('role','region');timeline.setAttribute('aria-label',say('阅读时间轴，可上下滚动','Scrollable reading timeline'));
  const mood=el('article','',pages.home);mood.className='card';el('h3',say('最近的心情','Latest mood'),mood);const moodText=el('p','',mood);moodText.className='mood';const moodTime=el('small','',mood);
  const thought=el('article','',pages.home);thought.className='card';el('h3',say('她读到这里时……','Her latest thought'),thought);const thoughtText=el('p','',thought);thoughtText.className='thought';pages.home.append(reviews);
  const chat=el('section','',pages.trail);chat.className='card';chat.hidden=true;const context=el('p','',chat);const question=el('textarea','',chat);question.setAttribute('aria-label',say('你想和她聊什么？','What would you like to discuss?'));let discussionEpisode:string|undefined;
  const conversation=el('div','',chat);conversation.className='conversation';chat.prepend(conversation);let conversationSignature='';
  el('small',say('本次运行的近期讨论会显示在这里；重启后清空，不写入阅读手账。','Recent replies in this run appear here; cleared on restart, not saved as journal entries.'),chat);
  button(chat,say('发送给大肥鱼','Send to companion'),async()=>{if(!discussionEpisode)throw Error('Select a thought first');await ctx.invoke('discuss',[{episodeId:discussionEpisode,text:question.value}]);question.value='';context.textContent=say('已发送。大肥鱼会在桌面用几条短句回复，记录会同步到这里。未读内容只能明确猜测。','Sent. She will reply on the desktop in short bubbles; the transcript mirrors here. Unread plot may only be explicitly guessed.');});
  async function discuss(id:string,text:string,key=state?.status.library.current?.key){discussionEpisode=id;conversationSignature='';context.textContent=(state?.books.find(b=>b.key===key)?.title??'')+' · '+Array.from(text).slice(0,150).join('');chat.hidden=false;page('trail');trailKey=key;trailChoice.value=key??'';const different=key!==state?.status.library.current?.key;notebook.hidden=different;episodeDetail.hidden=different;searchForm.hidden=different;otherTrail.hidden=!different;if(different&&key)await showOtherTrail(key);await update?.();question.focus();}
  root.addEventListener('bookfish-discuss',event=>{const data=(event as CustomEvent<{id:string;text:string}>).detail;void perform(()=>discuss(data.id,data.text));},{signal:ctx.signal});
  const bookDetail=el('section','',pages.bookDetail);bookDetail.className='card';bookDetail.hidden=true;
  let browsingBook:string|undefined;
  const humanReader=readerPanel(ctx,pages.reader,()=>page('bookDetail'));
  async function showBook(key:string){browsingBook=key;const data=await ctx.invoke<{book:LibraryPanelState['books'][number];journal:NonNullable<LibraryPanelState['journal']>;reviews:NonNullable<LibraryPanelState['reviews']>}>('book',[key]);if(disposed||ctx.signal.aborted||browsingBook!==key)return;
    bookDetail.replaceChildren();bookDetail.hidden=false;page('bookDetail');button(bookDetail,say('← 返回书架','← Bookshelf'),async()=>page('shelf'));
    const detailHead=el('div','',bookDetail);detailHead.className='detail-head';
    const detailCover=el('div','',detailHead);paintCover(detailCover,data.book);
    const detailInfo=el('div','',detailHead);detailInfo.className='detail-info';
    el('h2',data.book.title,detailInfo);el('small',data.book.author||say('作者未识别','Author unknown'),detailInfo);
    el('p',say('已读 '+Math.ceil(data.book.confirmedChars/600)+' 页','Read '+Math.ceil(data.book.confirmedChars/600)+' pages'),detailInfo);
    const detailActions=el('div','',detailInfo);detailActions.className='detail-actions';
    button(detailActions,say('阅读正文','Read the novel'),async()=>{page('reader');await humanReader.open(key);}).className='primary';
    if(state?.status.library.current?.key===key)button(detailActions,say('回到正在读','Back to reading'),async()=>page('home'));
    if(!data.book.complete)button(detailActions,say('现在开始读这本','Start reading this book now'),async()=>{if(state?.status.library.current?.key!==key)await ctx.invoke('select',[key]);page('home');await requestReading(key);}).className='bf-start-reading';
    button(detailActions,say('查看阅读足迹','View reading journal'),async()=>{trailKey=key;trailChoice.value=key;const different=key!==state?.status.library.current?.key;notebook.hidden=different;episodeDetail.hidden=different;searchForm.hidden=different;otherTrail.hidden=!different;page('trail');if(different)await showOtherTrail(key);});
    const remove=el('button',say('移除这本书','Remove this book'),detailActions);remove.type='button';remove.className='danger';remove.dataset.action='remove-book';
    remove.addEventListener('click',()=>{void (async()=>{
      if(busy||disposed||ctx.signal.aborted)return;
      const confirmed=await ctx.ui.confirm({title:say('移除《'+data.book.title+'》？','Remove “'+data.book.title+'”?'),body:say('正文、确认进度、阅读手账、读后感及对应分享文本都会删除，且无法撤销。','The text, confirmed progress, reading journal, reviews and related share text will be deleted. This cannot be undone.'),danger:true});
      if(!confirmed||disposed||ctx.signal.aborted)return;
      await perform(async()=>{await ctx.invoke('remove',[key]);browsingBook=undefined;page('shelf');ctx.ui.toast(say('已移除《'+data.book.title+'》','Removed “'+data.book.title+'”'));});
    })()},{signal:ctx.signal});
    const history=details(bookDetail,say('最近感想','Recent thoughts'));
    for(const item of data.journal.items){el('p',moodPrefix(item.mood?.label)+item.interpretation,history);button(history,say('聊聊这一段','Discuss this passage'),async()=>discuss(item.id,item.interpretation,key));}
    const manage=details(bookDetail,say('书籍来源与管理','Source and management'));el('p',data.book.source?data.book.source.bookUrl:say('本地导入','Local file'),manage);el('small',say('版本 ','Revision ')+data.book.revision.slice(0,8),manage);
    const serialInfo=data.book.serial;
    if(serialInfo){
      const section=details(bookDetail,say('连载追更','Serial following'));section.open=true;const serialBadge=el('span',say('实验功能','Experimental'),section.querySelector('summary')!);serialBadge.className='badge experimental';
      const readinessLabel:Record<string,string>={backlog:say('有未读正文','Unread text available'),waiting_content:say('等待正文','Waiting for text'),caught_up:say('已追平，等待更新','Caught up; waiting for updates'),finished:say('已完结','Finished'),conflict:say('目录冲突，已停止自动同步','Catalog conflict; automatic checks stopped')};
      const publication=serialInfo.publicationEvidence.status==='finished'?say('已完结','Finished'):serialInfo.publicationEvidence.status==='ongoing'?say('连载中','Ongoing'):say('状态未知','Unknown');
      el('p',publication+' · '+say('已读 ','Read ')+serialInfo.confirmedChapters+'/'+serialInfo.discoveredChapters+say(' 章 · 可读 ',' chapters · readable ')+serialInfo.cachedChapters+say(' 章 · ',' chapters · ')+(readinessLabel[data.book.readiness]??data.book.readiness),section);
      el('small',say('自动检查：','Automatic checks: ')+(serialInfo.subscription.enabled?say('已开启，每 ','on, every ')+serialInfo.subscription.intervalMinutes+say(' 分钟',' minutes'):say('已关闭','off'))+(serialInfo.subscription.lastSuccessfulCheckAt?say(' · 最近成功 ',' · last success ')+new Date(serialInfo.subscription.lastSuccessfulCheckAt).toLocaleString():say(' · 尚无成功检查',' · no successful check yet')),section);
      if(serialInfo.authorization!=='allowed')el('small',say('来源用途授权未确认；只缓存本机阅读，不宣称正版接入。','Source permission is unconfirmed; local reading cache only, not a licensed integration.'),section);
      if(serialInfo.lastCheck)el('small',say('最近检查：','Last check: ')+serialInfo.lastCheck.status+' · '+serialInfo.lastCheck.message,section);
      button(section,say('检查更新','Check for updates'),async()=>{const started=await ctx.invoke<{jobId:string;duplicate:boolean}>('serial_check',[key]);await pollSerialJob(started.jobId);});
      button(section,serialInfo.subscription.enabled?say('关闭自动追更','Disable automatic checks'):say('开启自动追更','Enable automatic checks'),async()=>{await ctx.invoke('serial_set_subscription',[key,!serialInfo.subscription.enabled,serialInfo.subscription.intervalMinutes]);await perform(async()=>{});if(browsingBook===key)await showBook(key);});
      if(state?.serial.active?.bookKey===key)button(section,say('取消本次同步','Cancel this sync'),async()=>{await ctx.invoke('serial_cancel',[state!.serial.active!.jobId]);await perform(async()=>{});if(browsingBook===key)await showBook(key);});
    }
    el('h3',say('读后感','Book reviews'),bookDetail);
    if(!data.reviews.versions.length)el('p',data.book.complete?say('还没有写读后感。','No review yet.'):say('读完后，她会在这里留下读后感。','Her review will appear here after completion.'),bookDetail);
    const article=el('section','',bookDetail);article.style.whiteSpace='pre-wrap';
    for(const version of [...data.reviews.versions].reverse())button(bookDetail,'v'+version.version+' · '+version.title,async()=>{const saved=await ctx.invoke<ReturnType<Library['review']>>('review',[version.id]);if(disposed||browsingBook!==key)return;article.replaceChildren();el('h3',saved.review.title,article);el('p',saved.review.text,article);const sources=details(article,say('查看写作依据','View writing sources'));for(const quote of saved.evidence)el('blockquote',quote.quote,sources);});
  }
  root.addEventListener('bookfish-book',event=>{const data=(event as CustomEvent<{key:string}>).detail;void perform(()=>showBook(data.key));},{signal:ctx.signal});
  const trailChoice=el('select','',pages.trail);trailChoice.setAttribute('aria-label',say('选择足迹书籍','Choose journal book'));pages.trail.prepend(trailChoice);
  const otherTrail=el('section','',pages.trail);otherTrail.hidden=true;let trailKey:string|undefined,trailSignature='';
  async function showOtherTrail(key:string,before?:number){const data=await ctx.invoke<NonNullable<LibraryPanelState['journal']>>('journal',[{bookKey:key,before,limit:5}]);if(disposed||ctx.signal.aborted||trailKey!==key)return;otherTrail.replaceChildren();
    for(const item of data.items){const card=el('article','',otherTrail);card.className='card';el('small',new Date(item.recordedAt).toLocaleString()+' · '+item.chapters.join(' / '),card);el('p',moodPrefix(item.mood?.label)+item.interpretation,card);button(card,say('聊聊这一段','Discuss this passage'),async()=>discuss(item.id,item.interpretation,key));const evidence=details(card,say('查看原文依据与理由','View evidence and explanation'));button(evidence,say('载入原文依据','Load evidence'),async()=>{const record=await ctx.invoke<ReturnType<Library['episode']>>('episode',[item.id]);if(disposed||trailKey!==key)return;for(const quote of record.evidence)el('blockquote',quote.quote,evidence);el('p',record.episode.content.reason??say('未记录当时理由。','No reason recorded.'),evidence);});}
    if(!data.items.length)el('p',say('这本书还没有感想足迹。','No journal entries for this book.'),otherTrail);
    if(data.nextBefore)button(otherTrail,say('更早的记录','Earlier records'),()=>showOtherTrail(key,data.nextBefore!));if(before!==undefined)button(otherTrail,say('返回最新记录','Latest records'),()=>showOtherTrail(key));
  }
  trailChoice.addEventListener('change',()=>{trailKey=trailChoice.value;const different=trailKey!==state?.status.library.current?.key;notebook.hidden=different;episodeDetail.hidden=different;searchForm.hidden=different;otherTrail.hidden=!different;if(different)void perform(()=>showOtherTrail(trailKey!));},{signal:ctx.signal});
  const discussLatest=button(thought,say('聊聊这一段','Discuss this passage'),async()=>{const e=state?.journal?.items[0];if(e)await discuss(e.id,e.interpretation);});button(thought,say('查看阅读足迹 →','View journal →'),async()=>page('trail'));
  for(const b of [...controls.querySelectorAll('button')]){const t=b.textContent;if(t===say('暂停阅读','Pause')||t===say('继续阅读','Resume')||t===say('结束休息','End rest'))continue;if(t===say('请求写一版全书读后感','Request a full-book review'))reviews.append(b);else advanced.append(b);}
  for(const child of [...old.children]){if(child===heading||child===nav||child===messages||Object.values(pages).includes(child as HTMLElement))continue;advanced.append(child);}
  let timelineEpoch=0;let before:number|undefined,timelineKey='',timelineRevision='';
  async function loadTimeline(append=false){const epoch=append?timelineEpoch:++timelineEpoch;const key=state?.status.library.current?.key;if(!key){timeline.replaceChildren();return;}const data=await ctx.invoke<ReturnType<Library['timeline']>>('timeline',[{bookKey:key,...(append&&before!==undefined?{before}:{})}]);if(disposed||ctx.signal.aborted||epoch!==timelineEpoch||key!==state?.status.library.current?.key)return;
    if(!append)timeline.replaceChildren();else timeline.querySelector('button')?.remove();before=data.nextBefore??undefined;
    const entries=[...data.items.map(item=>({type:'reading' as const,at:item.confirmedAt??0,item})),...data.rests.map(rest=>({type:'rest' as const,at:rest.startedAt,rest}))].sort((a,b)=>b.at-a.at||(a.type==='rest'?-1:1));
    for(const event of entries){if(event.type==='rest'){const r=event.rest,row=el('article','',timeline);el('time',new Date(r.startedAt).toLocaleString(ctx.language,{timeZone:state.status.sharing.timezone}),row);el('p',say('☕ 休息一会儿','☕ Taking a break'),row);el('small',r.state==='scheduled'?say('预计继续：','Expected to resume: ')+new Date(r.plannedUntil).toLocaleTimeString(ctx.language,{timeZone:state.status.sharing.timezone}):r.state==='ended'?say('这次休息已结束','This break ended'):r.state==='skipped'?say('这次休息已提前结束','This break ended early'):say('程序停止，这次休息已中断','This break was interrupted when the app stopped'),row);continue;}const item=event.item;const row=el('article','',timeline);el('time',item.confirmedAt===null?say('时间未记录（旧记录）','Time unavailable (legacy record)'):new Date(item.confirmedAt).toLocaleString(ctx.language,{timeZone:state.status.sharing.timezone}),row);const first=item.summary.match(/^.*?[。！？.!?]/u)?.[0]??item.summary;const chars=Array.from(first);const brief=chars.slice(0,55).join('')+(chars.length>55?'…':'');el('p',brief,row);el('small',item.mood?say('🐟 大肥鱼当时的阅读心情：','🐟 Her reading mood at the time: ')+moodPrefix(item.mood.label)+item.mood.label:say('大肥鱼当时未记录阅读心情','No reading mood recorded at the time'),row);if(Array.from(item.summary).length>Array.from(brief).length){const full=details(row,say('展开剧情摘要','Full plot summary'));el('p',item.summary,full);}}
    if(!entries.length&&!append)el('p',say('还没有确认读过的内容。','No confirmed reading yet.'),timeline);if(before!==undefined)button(timeline,say('加载更早阅读','Load earlier reading'),()=>loadTimeline(true));
  }

  function paintCover(parent:HTMLElement,book:LibraryPanelState['books'][number]){const design=coverDesign(book);parent.classList.add('book-cover');parent.dataset.palette=String(design.palette);parent.replaceChildren();const mark=document.createElement('span');mark.className='cover-mark';mark.textContent=design.mark;mark.setAttribute('aria-hidden','true');const copy=document.createElement('span');copy.className='cover-copy';const title=document.createElement('span');title.className='cover-title';title.textContent=design.title||say('未命名','Untitled');const rule=document.createElement('span');rule.className='cover-rule';rule.setAttribute('aria-hidden','true');const author=document.createElement('span');author.className='cover-author';author.textContent=design.author||say('作者未识别','Author unknown');copy.append(title,rule,author);const foot=document.createElement('span');foot.className='cover-foot';foot.textContent=design.sourceHost??(design.hasSource?say('网络书源','Online source'):say('本地导入','Local file'));parent.append(mark,copy,foot);}
  const hero=el('div','',current);hero.className='reading-hero';current.prepend(hero);current.prepend(readingState);const heroCover=button(hero,say('查看当前书籍详情','View current book'),async()=>{if(state?.status.library.current)await showBook(state.status.library.current.key);});heroCover.className='cover-button';heroCover.setAttribute('aria-label',say('查看当前书籍详情','View current book'));const heroInfo=el('div','',hero);heroInfo.append(title,chapter,meter,meterLabel);const heroFooter=el('div','',heroInfo);heroFooter.className='hero-footer';heroFooter.append(pageText);const heroActions=el('div','',heroFooter);heroActions.className='hero-actions';const viewBookButton=button(heroActions,say('查看这本书 ↗','View this book ↗'),async()=>{if(state?.status.library.current)await showBook(state.status.library.current.key);});const emptyRecommend=button(heroActions,say('＋ 推荐一本书','＋ Recommend a book'),async()=>{page('shelf');addBook.click();});emptyRecommend.className='primary';emptyRecommend.hidden=true;heroActions.append(help);
  let manualUiError='';
  async function requestReading(key:string){manualUiError='';readNow.disabled=true;readNotice.textContent=say('正在发送阅读请求…','Sending a reading request…');try{return await ctx.invoke('read_now',[key]);}catch(error){manualUiError=String(error).replace(/^(?:(?:WebUiInvokeError|Error):\s*)+/,'');readNotice.textContent=manualUiError;throw error;}}
  for(const b of controls.querySelectorAll('button'))if(b.textContent===say('暂停阅读','Pause')||b.textContent===say('继续阅读','Resume'))b.remove();
  const pauseReading=button(heroActions,say('暂停阅读','Pause reading'),async()=>{await ctx.invoke('pause',[true]);});
  const readActions=el('div','',current);hero.after(readActions);readActions.className='read-now';const readNow=button(readActions,say('继续读','Read a passage now'),async()=>{const key=state?.status.library.current?.key;if(key)await requestReading(key);});readNow.className='primary';heroActions.append(readNow,pauseReading);const readNotice=el('p','',readActions);readNotice.setAttribute('role','status');readNotice.setAttribute('aria-live','polite');const goalStatus=el('small','',readActions),restStatus=el('p','',readActions);restStatus.setAttribute('role','status');
  const shelfToolbar=el('div','',pages.shelf);shelfToolbar.className='shelf-toolbar';pages.shelf.prepend(shelfToolbar);const search=el('input','',shelfToolbar);search.type='search';search.placeholder=say('搜索书名或作者','Search title or author');search.setAttribute('aria-label',say('搜索书架','Search bookshelf'));const filter=el('select','',shelfToolbar);filter.setAttribute('aria-label',say('书架筛选','Filter bookshelf'));for(const[value,label]of [['all',say('全部','All')],['unfinished',say('未读完','Unfinished')],['finished',say('已读完','Finished')]]){const option=el('option',label,filter);option.value=value;}const sort=el('select','',shelfToolbar);sort.setAttribute('aria-label',say('书架排序','Sort bookshelf'));for(const[value,label]of [['added',say('最近入架','Recently added')],['title',say('书名排序','Title')]]){const option=el('option',label,sort);option.value=value;}
  const coverGrid=el('div','',pages.shelf);coverGrid.className='cover-grid';recommend.after(coverGrid);
  const addBook=el('button',say('＋ 推荐一本书','＋ Recommend a book'),shelfToolbar);addBook.type='button';addBook.className='primary';addBook.setAttribute('aria-controls',recommend.id);addBook.setAttribute('aria-expanded','false');
  const selectionPanel=el('section','',pages.shelf);selectionPanel.className='selection-panel';selectionPanel.hidden=true;coverGrid.after(selectionPanel);const selectionNotice=el('p','',current);selectionNotice.className='selection-notice';selectionNotice.hidden=true;readingState.after(selectionNotice);
  const selectionStateLabel:Record<string,string>={proposed:say('准备找书','Preparing'),searching:say('正在找','Searching'),awaiting_choice:say('等你选版本','Awaiting a version choice'),acquiring:say('正在获取并校验','Acquiring and verifying'),fulfilled:say('已入架，排队中','Shelved and queued'),reading:say('自选书在读','Reading her pick'),completed:say('自选书已读完','Her pick is finished'),deferred:say('已暂停','Paused'),failed:say('这本没成功','This work failed'),cancelled:say('已取消','Cancelled'),abandoned:say('已放弃','Abandoned')};
  function selectionCard(intent:NonNullable<LibraryPanelState['selection']>['intents'][number],parent:HTMLElement=selectionPanel):HTMLElement{const card=el('article','',parent);card.className='selection-intent';const head=el('div','',card);head.className='selection-head';el('strong','《'+intent.title+'》'+(intent.author?' · '+intent.author:''),head);el('span',selectionStateLabel[intent.status]??intent.status,head).className='selection-badge';el('blockquote',intent.reason,card);if(intent.source)el('small',say('来源：','Source: ')+intent.source,card);if(intent.task){const bar=el('progress','',card);bar.max=100;bar.value=intent.task.percent;bar.setAttribute('aria-label',say('获取进度','Acquisition progress'));el('small',intent.task.stage+' · '+intent.task.downloaded+'/'+intent.task.total+(intent.task.warningCount?say(' · '+intent.task.warningCount+' 条警告',' · '+intent.task.warningCount+' warnings'):''),card);if(intent.task.error)el('small',intent.task.error,card).className='selection-error';}if(intent.failure)el('small',intent.failure.message,card).className='selection-error';
    if(intent.status==='awaiting_choice'&&intent.candidates?.length){el('small',say('核对来源和版本后选择一个：','Choose one after checking source and edition:'),card);for(const candidate of intent.candidates){const choose=button(card,(candidate.available?'':'⏳ ')+candidate.source,async()=>ctx.invoke('selection_acquire_candidate',[candidate.candidateId]));choose.disabled=!candidate.available;}}
    if(['proposed','searching','acquiring'].includes(intent.status))button(card,say('取消这次找书','Cancel this search'),async()=>{if(!await ctx.ui.confirm({title:say('取消自选书获取？','Cancel this acquisition?'),body:say('已入架的书不会删除；取消不会自动换书或续传。','Shelved books stay; cancelling never auto-switches or resumes.'),danger:true}))return;await ctx.invoke('selection_cancel',[intent.id]);});
    if(intent.bookKey&&['fulfilled','reading'].includes(intent.status)){button(card,say('查看这本书','View this book'),async()=>showBook(intent.bookKey!));button(card,say('放弃这本自选书','Abandon this pick'),async()=>{if(!await ctx.ui.confirm({title:say('放弃这本自选书？','Abandon this self-selected book?'),body:say('只会结束“没读完不找下一本”的承诺，不删除书、不改变阅读进度。','This only ends the “no next pick until finished” promise; the book and progress stay.'),danger:true}))return;await ctx.invoke('selection_abandon',[intent.id]);});}
    return card;}
  function renderSelection(){if(!state)return;const selection=state.selection;const signature=JSON.stringify(selection);if(signature===selectionSignature)return;selectionSignature=signature;
    const activeIntents=selection?.intents.filter(intent=>!['failed','abandoned','cancelled'].includes(intent.status))??[];
    const pastIntents=selection?.intents.filter(intent=>['failed','abandoned','cancelled'].includes(intent.status))??[];
    selectionPanel.hidden=!selection||(!activeIntents.length&&!pastIntents.length&&!selection.queue.length&&!selection.notice);selectionPanel.replaceChildren();if(!selection)return;
    el('h3',say('她想读的','She wants to read'),selectionPanel);
    if(selection.commitment)el('p',say('自选书《'+selection.commitment.title+'》还没读完，暂不找下一本；排队、暂停、临时切书和重启都不解除。','Her pick “'+selection.commitment.title+'” is unfinished, so she will not look for another yet. Queuing, pausing, switching books or restarting do not release this gate.'),selectionPanel).className='selection-gate';
    else if(selection.notice&&!selection.commitment)el('p',selection.notice,selectionPanel).className='selection-gate';
    if(selection.round&&(selection.round.status==='open'||selection.round.status==='paused'))el('small',say('本轮已尝试 ','Tried this round: ')+selection.round.attempts+'/3'+(selection.round.status==='paused'?say(' · 因全局原因暂停',' · paused for a global reason'):''),selectionPanel);
    for(const intent of activeIntents)selectionCard(intent);
    if(pastIntents.length){const history=document.createElement('details');history.className='selection-history';const summary=el('summary',say('未成功的想读记录（','Unsuccessful reading wishes (')+pastIntents.length+'）',history);summary.setAttribute('aria-label',say('展开查看未成功的想读记录','Show unsuccessful reading wishes'));selectionPanel.append(history);for(const intent of pastIntents)selectionCard(intent,history);}
    if(selection.queue.length){el('h3',say('接下来读','Next to read'),selectionPanel);for(const item of selection.queue){const card=el('article','',selectionPanel);card.className='selection-queue';const head=el('div','',card);head.className='selection-head';el('strong','《'+item.title+'》',head);el('span',item.status==='active'?say('正在读','Reading'):item.status==='done'?say('已完成','Done'):item.status==='cancelled'?say('已移出','Removed'):say('排队中','Queued'),head).className='selection-badge';if(item.notBefore)el('small',say('最早安排：','Not before: ')+new Date(item.notBefore).toLocaleString(),card);if(item.bookExists&&item.status==='queued')button(card,say('现在切换到这本','Switch to this book'),async()=>ctx.invoke('select',[item.bookKey]));if(item.bookExists&&item.status==='queued'&&!item.bookComplete)button(card,say('放弃这本自选书','Abandon this pick'),async()=>{const intent=selection.intents.find(entry=>entry.bookKey===item.bookKey);if(!intent)return;if(!await ctx.ui.confirm({title:say('放弃这本自选书？','Abandon this self-selected book?'),body:say('只会结束承诺，不删除书或进度。','This only ends the promise; the book and progress stay.'),danger:true}))return;await ctx.invoke('selection_abandon',[intent.id]);});}}
    if(!activeIntents.length&&!pastIntents.length&&!selection.queue.length)el('p',say('她还没有自己提出想读的书。开启“让她自己找书（实验功能）”后，她会在合适的时候提出。','She has not proposed a book yet. Enable “Let her find her own books (Experimental)” and she may propose one when appropriate.'),selectionPanel);}
  let selectionSignature='';
  addBook.addEventListener('click',()=>{recommend.hidden=false;addBook.setAttribute('aria-expanded','true');methodSelect.value='file';selectImportMethod('file',true);recommend.scrollIntoView?.({block:'nearest'});},{signal:ctx.signal});closeRecommend.addEventListener('click',()=>{recommend.hidden=true;addBook.setAttribute('aria-expanded','false');addBook.focus();},{signal:ctx.signal});
  pages.shelf.append(advanced);let shelfSignature='';
  function renderShelf(){if(!state)return;const signature=JSON.stringify([state.books,state.status.library.current?.key,search.value,filter.value,sort.value]);if(signature===shelfSignature)return;shelfSignature=signature;coverGrid.replaceChildren();const q=search.value.trim().toLocaleLowerCase();const books=[...state.books].reverse().filter(b=>(!q||(b.title+' '+b.author).toLocaleLowerCase().includes(q))&&(filter.value==='all'||(filter.value==='finished'?b.complete:!b.complete)));if(sort.value==='title')books.sort((a,b)=>a.title.localeCompare(b.title,en?undefined:'zh-Hans-CN',{numeric:true,sensitivity:'base'})||a.key.localeCompare(b.key));for(const b of books){const card=el('article','',coverGrid);const open=button(card,say('查看这本书：','View book: ')+b.title,async()=>showBook(b.key));open.className='cover-button';open.setAttribute('aria-label',say('查看这本书：','View book: ')+b.title);open.textContent='';const cover=el('span','',open);paintCover(cover,b);el('strong',b.title,card);el('small',b.key===state.status.library.current?.key?say('正在读','Reading'):b.serial?(b.readiness==='caught_up'?say('已追平','Caught up'):b.readiness==='waiting_content'?say('等待正文','Waiting for text'):b.readiness==='conflict'?say('目录冲突','Catalog conflict'):b.readiness==='finished'?say('已完结','Finished'):say('连载中','Serial')):b.complete?say('已读完','Finished'):b.confirmedChars?say('读过一些','Started'):say('未开始','Not started'),card);const more=details(card,'⋯');button(more,say('书籍详情与管理','Book details and management'),async()=>showBook(b.key));}if(!books.length)el('p',say('没有符合条件的书。','No matching books.'),coverGrid);}
  search.addEventListener('input',renderShelf,{signal:ctx.signal});filter.addEventListener('change',renderShelf,{signal:ctx.signal});sort.addEventListener('change',renderShelf,{signal:ctx.signal});

  update=async()=>{if(!state||disposed||ctx.signal.aborted)return;const c=state.status.library.current;const empty=!c;hero.classList.toggle('is-empty',empty);viewBookButton.hidden=empty;emptyRecommend.hidden=!empty;readActions.hidden=empty;readNow.hidden=empty;pauseReading.hidden=empty;reviews.hidden=empty;log.hidden=empty;renderShelf();renderSelection();renderNovelTasks(state.novel);const selection=state.selection;selectionNotice.hidden=!selection?.notice;selectionNotice.textContent=selection?.notice??'';if(state.novel.tasks.some(task=>['queued','fetching','validating'].includes(task.state)))startNovelPoll();heroCover.replaceChildren();if(c){const cover=el('span','',heroCover);paintCover(cover,c);}heroCover.hidden=!c;
    const messagesForEpisode=state.discussions.filter(d=>d.episodeId===discussionEpisode);const latest=messagesForEpisode.at(-1);if(latest?.delivery==='spoken'&&latest.segments.length)context.textContent=say('大肥鱼在桌面上回了你，记录同步在这里。','She replied on the desktop; the transcript is mirrored here.');else if(latest?.delivery==='unavailable')context.textContent=say('这次桌宠没有说出来，扩展里只记录原因。','This reply was not spoken on the desktop; only the reason is recorded here.');const replySignature=JSON.stringify(messagesForEpisode);if(replySignature!==conversationSignature){conversationSignature=replySignature;conversation.replaceChildren();for(const item of messagesForEpisode){const you=el('p','你：'+item.question,conversation);you.className='chat-line you';if(item.delivery==='spoken'){for(const segment of item.segments){const line=el('p','🐟：'+segment,conversation);line.className='chat-line pet';}}else if(item.delivery==='unavailable'){const line=el('p','🐟：'+(item.reason?say('没有说出来：','Not spoken: ')+item.reason:say('桌宠输出不可用，这次没有说出来。','Desktop output was unavailable; nothing was spoken.')),conversation);line.className='chat-line pet unavailable';}else{const line=el('p',item.expired?say('🐟：这次请求已过期，请重新提问。','🐟 Request expired; ask again.'):say('🐟：正在想……','🐟 Thinking…'),conversation);line.className='chat-line pet';}}}
    const booksSignature=JSON.stringify([state.books.map(b=>[b.key,b.title]),c?.key]);if(booksSignature!==trailSignature){trailSignature=booksSignature;trailChoice.replaceChildren();for(const book of state.books){const option=el('option',book.title,trailChoice);option.value=book.key;}trailKey=c?.key;trailChoice.value=trailKey??'';notebook.hidden=false;episodeDetail.hidden=false;searchForm.hidden=false;otherTrail.hidden=true;}
    title.textContent=c?c.title+(c.author?' · '+c.author:''):say('送她一本书吧','Recommend a book');chapter.textContent=c?.chapter??say('书架还是空的。点下面的按钮，选择文件、链接或书名/作者，把第一本小说交给她。','The shelf is empty. Use the button below to add a file, a link, or fetch by title/author.');meter.hidden=!c;if(c)meter.value=c.source?c.chapterProgress:c.progress;meterLabel.textContent=c?.source?say('本章已读 '+Math.round(c.chapterProgress*100)+'%','Chapter '+Math.round(c.chapterProgress*100)+'%'):'';
    const known=c&&(!c.source||c.source.cachedChapters===c.source.totalChapters&&c.source.publicationStatus==='finished');pageText.textContent=c?say('已读 '+Math.ceil(c.confirmedChars/600)+' 页','Read '+Math.ceil(c.confirmedChars/600)+' pages')+(known?' / '+Math.ceil(c.totalChars/600)+say(' 页',' pages'):say(' · 正文未完整获取，无法计算总页数',' · Total pages unknown')):'';pageText.hidden=!c;
    zone.textContent=say('现实确认时间 · 最新在上 · ','Confirmation time · Newest first · ')+state.status.sharing.timezone;
    for(const b of controls.querySelectorAll('button')){if(b.textContent===say('结束休息','End rest'))b.hidden=state.status.scheduler.reason!=='resting';else b.hidden=!c;}
    const run=state.status.scheduler,manual=run.manual?.bookKey===c?.key?run.manual:null;
    const inFlight=!!run.active||run.cognitionRunning||!!state.status.library.pending;
    let stateKind='waiting',label=say('等待阅读','Waiting to read'),detail=say('她现在没有在读书，会在空闲时按自己的节奏继续。','She is not reading now; she will continue at her own pace while idle.');
    if(run.routine){stateKind='routine';label=run.routine.kind==='sleep'?say('睡觉中','Sleeping'):say('用餐中','Having a meal');detail=say('现在没有在读书，作息结束后才能继续。','Not reading now; reading can resume after her routine.');}
    else if(!c){label=say('还没有在读的书','No book selected');detail=say('到书架选一本书交给她。','Choose a book for her in the bookshelf.');}
    else if(c.complete){stateKind='complete';label=say('已读完','Finished');detail=say('这本书已经读完，可以再推荐一本。','This book is finished; recommend another one.');}
    else if(c.readiness==='caught_up'){stateKind='waiting';label=say('已追平，等待更新','Caught up; waiting for updates');detail=say('已经读到当前目录末尾，会按计划检查新章；这不是全书完读。','Read to the end of the current catalog. She will check for updates on schedule; this is not full-book completion.');}
    else if(c.readiness==='waiting_content'){stateKind='waiting';label=say('发现新章，等待正文','New chapters found; waiting for text');detail=say('目录已经有更新，但正文尚未完整同步；不会跳章或假装已读。','The catalog has updates, but the text is not fully synchronized yet; no chapter is skipped or faked.');}
    else if(c.readiness==='conflict'){stateKind='error';label=say('连载目录冲突','Serial catalog conflict');detail=say('旧章身份或顺序发生变化，自动同步已停止；已读正文仍然保留。','An accepted chapter changed identity or order, so automatic checks stopped; confirmed text is preserved.');}
    else if(state.status.library.paused){label=say('已暂停','Paused');detail=say('她现在没有在读书，点击“继续读”可恢复。','Not reading now; click Continue reading to resume.');}
    else if(state.status.library.pending){stateKind='reading';label=say('正在阅读','Reading now');detail=say('她已拿到这一段正文，读完确认后更新进度。','She has received this passage; progress updates after confirmation.');}
    else if(inFlight){stateKind='queued';label=say('等待开始阅读','Reading queued');detail=say('阅读已经安排，正在等待她处理，还没有开始读正文。','Reading is queued; she has not started the passage yet.');}
    else if(run.habits.rest){stateKind='resting';label=say('休息中','Taking a break');detail=say('她现在没有在读书，休息后继续。','Not reading now; she will continue after her break.');}
    else if(!run.enabled){label=say('自主阅读已关闭','Automatic reading off');detail=say('她现在没有在读书，仍可点击“继续读”。','Not reading now; you can still click Continue reading.');}
    else if(run.goal.reached){label=say('今日目标已完成','Daily goal reached');detail=say('现在没有在读书，自主阅读明天继续。','Not reading now; automatic reading resumes tomorrow.');}
    else if(run.reason==='chat_priority'){label=say('优先陪你聊天','Chatting first');detail=say('她现在没有在读书，空闲后再继续。','Not reading now; she will continue when idle.');}
    else if(run.reason==='error'||run.error){stateKind='error';label=say('阅读暂时受阻','Reading interrupted');detail=say('她现在没有在读书，请查看下方提示。','Not reading now; check the message below.');}
    readingState.dataset.state=stateKind;stateLabel.textContent=label;stateDetail.textContent=detail;
    readNow.hidden=!c||c.complete;readNow.disabled=inFlight||busy||!!run.routine||(!!c&&c.readiness!=='backlog');readNow.textContent=say('继续读','Continue reading');
    pauseReading.hidden=!c||c.complete;pauseReading.disabled=busy||!inFlight&&!state.status.library.pending||!!run.routine||state.status.library.paused;
    for(const b of bookDetail.querySelectorAll<HTMLButtonElement>('.bf-start-reading'))b.disabled=inFlight||!!run.routine;
    goalStatus.hidden=!run.goal.target;goalStatus.textContent=say('今日章节目标：','Today’s chapter goal: ')+run.goal.completed+' / '+run.goal.target+say(' 章',' chapters')+(run.goal.reached?say(' · 已完成',' · Complete'):'');
    restStatus.hidden=!!run.routine||!run.habits.rest;restStatus.textContent=run.habits.rest?say('☕ 正在休息，预计 ','☕ Taking a break, expected to resume at ')+new Date(run.habits.rest.plannedUntil).toLocaleTimeString(ctx.language,{timeZone:state.status.sharing.timezone}):'';
    if(run.routine)readNotice.textContent=say('她正在','She is ')+run.routine.label+(run.routine.until?say('，预计 '+run.routine.until+' 后可以继续读。','; reading is available after '+run.routine.until+'.'):say('，当前作息覆盖全天，请调整配置。','; this schedule blocks all day.'))+' · '+run.routine.timezone;
    else if(manualUiError)readNotice.textContent=manualUiError;
    else if(!c)readNotice.textContent=say('先到书架选一本书，就可以让她继续读。','Choose a book in the bookshelf to read a passage now.');
    else if(c.complete)readNotice.textContent=say('这本书已经读完了。','This book is finished.');
    else if(c.readiness==='caught_up')readNotice.textContent=say('已追平，等待作者更新；不会把当前目录当成全书完读。','Caught up; waiting for the author. The current catalog is not treated as full-book completion.');
    else if(c.readiness==='waiting_content')readNotice.textContent=say('目录已发现新章，正文还没同步完；同步完成后会按原节奏继续读。','New chapters are in the catalog but their text is not synchronized yet; reading resumes at the normal pace after it is. ');
    else if(manual?.state==='queued')readNotice.textContent=say('阅读请求已发送，正在等待大肥鱼响应；已有聊天进行时会排队。','Request sent. Waiting for her response; an ongoing conversation may delay it.');
    else if(manual?.state==='reading'||run.active&&state.status.library.pending)readNotice.textContent=say('大肥鱼正在读这一段，确认后会更新进度。','She is reading this passage. Progress updates after confirmation.');
    else if(manual?.state==='completed')readNotice.textContent=say('这一段已读完，进度和阅读足迹已更新。','This passage is finished. Progress and the timeline have updated.');
    else if(manual&&['failed','deferred','expired','cancelled'].includes(manual.state))readNotice.textContent=manual.message??say('这次阅读已取消，可以重新请求。','This request was cancelled; you can try again.');
    else if(run.active)readNotice.textContent=say('已安排阅读，正在等待大肥鱼响应。','Reading is queued; waiting for her response.');
    else if(state.status.library.paused)readNotice.textContent=say('阅读已暂停。点击“继续读”即可恢复并发起一次阅读。','Reading is paused. Resume and read a passage when ready.');
    else if(run.goal.target>0&&c&&!c.chapterGoalSupported)readNotice.textContent=say('本书未识别到章节，无法按章限制进度。可更换带章节标题的文件，或取消每日目标；也可以主动读一段。','No chapter headings were recognized. Choose a chaptered file, remove the daily goal, or explicitly read one passage.');
    else if(run.goal.reached)readNotice.textContent=say('今天的 '+run.goal.target+' 章目标已完成，自主阅读明天继续；也可以主动再读一段。','Today’s chapter goal is complete. Automatic reading resumes tomorrow; you can request another passage.');
    else if(!run.enabled)readNotice.textContent=say('自主阅读已关闭，仍可点击“继续读”主动发起一次阅读。','Automatic reading is off. You can still request one passage now.');
    else if(run.habits.rest)readNotice.textContent=say('她正在休息，预计 ','She is taking a break, until ')+new Date(run.habits.rest.plannedUntil).toLocaleTimeString(ctx.language,{timeZone:state.status.sharing.timezone})+say(' 继续。也可以主动请她继续读。','. You can also request a passage now.');
    else readNotice.textContent=say('已选中这本书。她会在空闲时按自己的节奏读，也可以点击“继续读”。','This book is selected. She will read while idle, or you can request a passage now.');
    const m=state.journal?.mood;moodText.textContent=m?moodPrefix(m.label)+m.label:say('尚未报告心情','No mood reported');moodTime.textContent=m?say('上次阅读记录 · ','Recorded at · ')+new Date(m.recordedAt).toLocaleString():'';const e=state.journal?.items[0];thoughtText.textContent=e?moodPrefix(e.mood?.label)+Array.from(e.interpretation).slice(0,150).join('')+(Array.from(e.interpretation).length>150?'…':''):say('等她遇到想说的情节，感想会留在这里。','Her thoughts will appear here.');discussLatest.disabled=!e;
    if(timelineKey!==c?.key){manualUiError='';timelineKey=c?.key??'';before=undefined;timelineRevision='';}const signature=JSON.stringify([c?.key,c?.confirmedSegments,run.habits.restRevision]);if(signature!==timelineRevision){await loadTimeline();timelineRevision=signature;}
    for(const b of reviews.querySelectorAll('button'))if(b.textContent===say('请求写一版全书读后感','Request a full-book review'))b.hidden=!c?.complete;
  };
  const initialPanel=ctx.panelId==='shelf'?'shelf':ctx.panelId==='trail'?'trail':ctx.panelId==='support'?'support':'home';if(initialPanel==='support')buildSupport();page(initialPanel);await update();
  return {dispose(){disposed=true;if(novelPollTimer!==undefined){clearTimeout(novelPollTimer);novelPollTimer=undefined;}handle.dispose();}};
} } satisfies WebUiClientBundle['panels'][string];
export default {panels:{status:readingPanel,shelf:readingPanel,trail:readingPanel,support:supportPanel,settings:settingsPanel}} satisfies WebUiClientBundle;
