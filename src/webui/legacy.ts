import type { WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';
import type { LibraryPanelState } from '../status.ts';
import type { Library } from '../library.ts';
import { moodPrefix } from './mood.ts';

export default {
  panels: {
    status: {
      async mount(ctx) {
        const en = ctx.language !== 'zh' && ctx.language !== 'zh-Hant';
        const say = (zh: string, english: string) => en ? english : zh;
        const sourceLabel = (status: string) => en ? status : ({ partial: '部分章节已缓存', cached: '目录内章节已缓存', needs_login: '需要登录', restricted: '站点拒绝访问或需要验证',
          missing: '章节或分页缺失', temporary: '获取或保存暂时失败', invalid_content: '页面结构或正文不匹配', limit: '达到缓存或请求限制', cancelled: '获取已取消', unsupported: '暂未适配' }[status] ?? status);
        const section = document.createElement('section');
        section.style.cssText = 'max-width:900px;display:grid;gap:16px;padding:8px;line-height:1.6';
        ctx.root.append(section);
        const heading = document.createElement('h2'); heading.textContent = say('书架与阅读进度', 'Library and reading progress'); section.append(heading);
        const status = document.createElement('p'); section.append(status);
        const notice = document.createElement('p'); notice.textContent = say('支持本地文件、已适配笔趣阁链接与有原文依据的阅读手账。自主阅读新配置默认开启，可在宿主配置中调整。心情和解释是模型自报；最近心情不是实时心理状态。正文会交给宿主模型。缓存不等于已读。', 'Supports local files, adapted Biquge links and an evidence-backed reading journal. Automatic reading defaults on for new configurations; use host configuration to adjust. Mood and interpretation are model reports, not live mental state. Text goes to the host model. Cached does not mean read.'); section.append(notice);
        const schedule = document.createElement('p'); schedule.setAttribute('aria-label', say('自主阅读状态', 'Automatic reading status')); section.append(schedule);
        const messages = document.createElement('p'); messages.setAttribute('role', 'status'); section.append(messages);
        const controls = document.createElement('div'); controls.dataset.bookfish = 'controls'; controls.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap'; section.append(controls);
        const notebook = document.createElement('section'); notebook.setAttribute('aria-label', say('阅读手账', 'Reading journal')); section.append(notebook);
        const shares = document.createElement('section'); shares.setAttribute('aria-label', say('阅读分享', 'Reading shares')); section.append(shares);
        const articles = document.createElement('section'); articles.setAttribute('aria-label', say('全书读后感', 'Full-book reviews')); section.append(articles);
        const articleDetail = document.createElement('section'); articleDetail.style.whiteSpace = 'pre-wrap'; section.append(articleDetail);
        const detail = document.createElement('section'); detail.setAttribute('aria-label', say('感想与原文依据', 'Episode and evidence')); section.append(detail);
        const shelf = document.createElement('div'); shelf.dataset.bookfish = 'shelf'; shelf.style.cssText = 'display:grid;gap:12px'; section.append(shelf);
        let disposed = false;
        let working = false;
        let request = 0;
        let shelfRevision = '';
        let state: LibraryPanelState | undefined;
        let journalBefore: number | undefined;
        let journalBook: string | undefined;
        let journalRevision = '';
        let shareRevision = '';
        let reviewRevision = '';
        const kindLabel = (kind: string) => en ? kind : ({ reading: '阅读当时记录', reflection: '现在重读的反思', revision: '后续修订（原记录保留）' }[kind] ?? kind);
        function line(parent: HTMLElement, label: string, value: string) {
          const p = document.createElement('p'); p.textContent = `${label}: ${value}`; parent.append(p);
        }
        function download(text: string, filename: string, mime = 'application/json') {
          const url = URL.createObjectURL(new Blob([text], { type: mime }));
          const link = document.createElement('a'); link.href = url; link.download = filename; section.append(link); link.click(); link.remove();
          ctx.timeout(() => URL.revokeObjectURL(url), 1000); ctx.own({ dispose: () => URL.revokeObjectURL(url) });
        }
        async function showReview(id: string) {
          const data = await ctx.invoke<ReturnType<Library['review']>>('review', [id]);
          if (disposed || ctx.signal.aborted || data.book.key !== journalBook) return;
          articleDetail.replaceChildren();
          line(articleDetail, `${data.review.title} · v${data.review.version}`, new Date(data.review.recordedAt).toLocaleString());
          const body = document.createElement('p'); body.textContent = data.review.text; articleDetail.append(body);
          button(say('导出这版读后感', 'Export this review'), async () => { download(`# ${data.review.title}\n\n${data.review.text}\n`, `bookfish-review-v${data.review.version}.md`, 'text/markdown;charset=utf-8'); }, articleDetail);
          const sources = document.createElement('details'); const summary = document.createElement('summary');
          summary.textContent = say('查看写作依据', 'View writing sources'); sources.append(summary); articleDetail.append(sources);
          line(sources, say('资料覆盖', 'Material coverage'), JSON.stringify(data.review.coverage));
          line(sources, say('感想编号', 'Episode ids'), data.review.episodeIds.join(', ') || say('无旧感想', 'No prior episodes'));
          for (const evidence of data.evidence) line(sources, `${evidence.chapter} · ${evidence.segmentId} [${evidence.start},${evidence.end})`, evidence.quote);
          line(sources, say('解释边界', 'Interpretation boundary'), say('引用校验不证明解释或心理状态；资料已提供不等于理解被独立验证。', 'Quote matching does not verify interpretation or mental state; offering material is not proof of understanding.'));
          button(say('导出写作依据（JSON）', 'Export writing sources (JSON)'), async () => { download(JSON.stringify(data, null, 2), `bookfish-review-v${data.review.version}.json`); }, sources);
        }
        const searchForm = document.createElement('form'); section.insertBefore(searchForm, shelf);
        const searchTitle = document.createElement('h3'); searchTitle.textContent = say('回查已读内容', 'Search confirmed reading'); searchForm.append(searchTitle);
        const inputs = ['关键词（空格分隔）', '人物或已记录别名', '章节'].map((label, i) => {
          const wrapper = document.createElement('label'); wrapper.textContent = en ? ['Keywords', 'Character / recorded alias', 'Chapter'][i] : label;
          const input = document.createElement('input'); input.type = 'text'; input.maxLength = 160; wrapper.append(input); searchForm.append(wrapper); return input;
        });
        const searchSubmit = document.createElement('button'); searchSubmit.type = 'submit'; searchSubmit.textContent = say('检索已读记录', 'Search confirmed records'); searchForm.append(searchSubmit);
        const searchResults = document.createElement('div'); searchForm.append(searchResults);
        let searchArgs: Record<string, unknown> | undefined;
        let searchCursor: string | undefined;
        async function searchPage(cursor?: string) {
          const bookKey = journalBook;
          if (!bookKey || !searchArgs) throw new Error(say('请先选择书籍并检索。', 'Select a book and search first.'));
          const result = await ctx.invoke<ReturnType<Library['search']>>('search', [{ ...searchArgs, bookKey, ...(cursor ? { cursor } : {}) }]);
          if (disposed || ctx.signal.aborted || journalBook !== bookKey) return;
          searchResults.replaceChildren(); searchCursor = result.nextCursor ?? undefined;
          line(searchResults, say('匹配', 'Matches'), `${result.total} · ${say('仅为字面检索；零匹配不证明没有相关内容', 'Lexical search; no matches does not prove absence')}`);
          for (const hit of result.items) {
            line(searchResults, `${hit.kind} · ${hit.id}`, hit.snippet);
            button(say('查看完整记录与已读原文', 'View complete records and confirmed source'), async () => {
              const args = hit.kind === 'episode' ? { episodeIds: [hit.id] } : hit.kind === 'receipt' ? { taskIds: [hit.id] } : { segmentIds: hit.segmentIds };
              const context = await ctx.invoke<ReturnType<Library['context']>>('context', [{ ...args, bookKey }]);
              if (disposed || ctx.signal.aborted || journalBook !== bookKey) return;
              detail.replaceChildren();
              for (const record of context.accounts) {
                line(detail, say('记录与时间', 'Record / time'), `${record.id} · ${kindLabel(String(record.kind))} · ${record.recordedAt}`);
                line(detail, say('感想', 'Interpretation'), String(record.interpretation));
                line(detail, say('当次自述理由', 'Stated reason'), record.reason === null ? say('未记录；不能确认当时理由', 'Not recorded; original reason unknown') : String(record.reason));
                for (const quote of record.evidence as Array<{ quote: string; segmentId: number; start: number; end: number }>) {
                  const block = document.createElement('blockquote'); block.textContent = quote.quote; detail.append(block);
                  line(detail, say('原文定位', 'Source anchor'), `${quote.segmentId} · [${quote.start}, ${quote.end})`);
                }
                button(say('查看原文依据与理由', 'View evidence and explanation'), () => showEpisode(String(record.id)), detail);
              }
              for (const receipt of context.receipts) {
                line(detail, say('理解回执', 'Understanding receipt'), String(receipt.understanding));
                line(detail, say('理由', 'Reason'), say('未单独记录；有感想链接时以对应记录为准', 'Not separately recorded; consult the linked episode if present'));
              }
              for (const source of context.sources) line(detail, `${say('已读原文', 'Confirmed source')} ${source.id}`, String(source.text));
              if (context.omittedCount || context.additionalRelatedRecords || context.additionalSourceSegments) line(detail, say('材料未全部载入', 'Incomplete context'), say('请按检索结果逐条查看完整记录；当前结果不代表完整判断历史。', 'Open individual search hits; this bundle is not the complete judgment history.'));
            }, searchResults);
          }
          if (searchCursor) button(say('下一页匹配', 'Next matches'), () => searchPage(searchCursor), searchResults);
        }
        searchForm.addEventListener('submit', event => {
          event.preventDefault();
          searchArgs = Object.fromEntries(inputs.map((input, i) => [['query', 'character', 'chapter'][i], input.value.trim()]).filter(([, value]) => value));
          void perform(() => searchPage());
        }, { signal: ctx.signal });
        async function showEpisode(id: string) {
          const result = await ctx.invoke<ReturnType<Library['episode']>>('episode', [id]);
          if (disposed || ctx.signal.aborted || result.episode.bookKey !== journalBook) return;
          detail.replaceChildren();
          const e = result.episode, content = e.content;
          line(detail, say('记录', 'Record'), `${e.id} · ${kindLabel(e.kind)} · ${new Date(e.recordedAt).toLocaleString()}`);
          line(detail, say('触发情节（模型提取）', 'Trigger (model account)'), content.trigger);
          line(detail, say('当次解释（模型自报）', 'Reported interpretation'), content.interpretation);
          line(detail, say('先前判断', 'Prior judgment'), content.priorJudgment ?? say('未记录', 'Not recorded'));
          line(detail, say('简短自述理由', 'Stated explanation'), content.reason ?? say('未记录；不能推断当时理由', 'Not recorded; do not infer an earlier reason'));
          line(detail, say('本条心情', 'Mood in this record'), content.mood ? `${content.mood.label}${content.mood.intensity ? ` (${content.mood.intensity}/5)` : ''}` : say('未报告心情', 'No mood reported'));
          for (const evidence of result.evidence) {
            const quote = document.createElement('blockquote'); quote.textContent = evidence.quote; detail.append(quote);
            line(detail, say('原文定位', 'Source anchor'), `${evidence.chapter} · ${say('段落', 'segment')} ${evidence.segmentId} · [${evidence.start}, ${evidence.end}) · ${say('版本', 'revision')} ${result.book.revision.slice(0, 12)} · SHA256 ${evidence.segmentHash}`);
            line(detail, say('来源', 'Source'), JSON.stringify(evidence.source));
          }
          line(detail, say('证据边界', 'Evidence boundary'), say('仅校验引用与原文字面一致；不证明解释、因果、人物身份或心情为真。', 'Exact text matching does not verify interpretation, cause, identity or mood.'));
          line(detail, say('人物与别名（模型提取）', 'Characters / aliases (model account)'), content.characters.map(c => `${c.name}${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}`).join(' · ') || '—');
          line(detail, say('未决问题', 'Open questions'), content.questions.join(' · ') || '—');
          if (e.revises) button(say('查看被修订原记录', 'View original record'), () => showEpisode(e.revises!), detail);
          for (const id of content.relatedEpisodeIds) button(`${say('关联记录', 'Related record')} ${id.slice(0, 8)}`, () => showEpisode(id), detail);
          for (const revision of result.revisions) button(`${say('查看后续修订', 'View revision')} ${new Date(revision.recordedAt).toLocaleString()}`, () => showEpisode(revision.id), detail);
        }
        function renderJournal(journal: LibraryPanelState['journal']) {
          const signature = JSON.stringify(journal);
          if (signature === journalRevision) return;
          journalRevision = signature; notebook.replaceChildren();
          const title = document.createElement('h3'); title.textContent = say('阅读足迹', 'Reading journal'); notebook.append(title);
          const metadata=document.createElement('details'), summary=document.createElement('summary');summary.textContent=say('记录范围与人物索引','Coverage and character index');metadata.append(summary);notebook.append(metadata);
          if (!journal) { line(metadata, say('手账', 'Journal'), say('选书后查看。', 'Select a book.')); return; }
          line(metadata, say('记录范围', 'Coverage'), `${journal.total} ${say('条记录', 'records')} · ${journal.rangesWithoutReadingEpisode} ${say('个已读段落未记录阅读当时的感想；不补造心情', 'confirmed ranges without a reading-time episode; no invented mood')}`);
          line(metadata, say('最近一次自报心情', 'Last reported mood'), journal.mood
            ? `${journal.mood.label} · ${new Date(journal.mood.recordedAt).toLocaleString()} · ${kindLabel(journal.mood.kind)} · ${say('不是实时心理状态', 'not a live mental state')}`
            : say('尚未报告心情', 'No mood has been reported'));
          if (journal.mood) button(say('查看心情依据', 'View mood evidence'), () => showEpisode(journal.mood!.episodeId), metadata);
          line(metadata, say('人物索引（模型提取）', 'Character index (model account)'), journal.characters.map(c => `${c.name}${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}`).join(' · ') || '—');
          for (const entry of journal.items) {
            const row = document.createElement('article'); notebook.append(row);
            line(row, entry.kind === 'reading' ? say('读到这里时','While reading') : say('后来又想到……','A later thought'), `${new Date(entry.recordedAt).toLocaleString()} · ${entry.chapters.join(' / ')}`);
            line(row, say('读到的情节', 'Plot'), entry.trigger); line(row, say('当时的感想', 'Her thought'), moodPrefix(entry.mood?.label)+entry.interpretation);
            button(say('聊聊这一段','Discuss this passage'), async () => { row.dispatchEvent(new CustomEvent('bookfish-discuss', { bubbles: true, detail: { id:entry.id, text:entry.interpretation } })); }, row);
            button(say('查看原文依据与理由', 'View evidence and explanation'), () => showEpisode(entry.id), row);
          }
          if (journal.nextBefore) button(say('更早的记录', 'Earlier records'), async () => { journalBefore = journal.nextBefore!; }, notebook);
          if (journalBefore !== undefined) button(say('返回最新记录', 'Latest records'), async () => { journalBefore = undefined; }, notebook);
        }
        function button(label: string, action: () => Promise<void>, parent: HTMLElement = controls) {
          const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
          el.addEventListener('click', () => { void perform(action); }, { signal: ctx.signal }); parent.append(el); return el;
        }
        async function perform(action: () => Promise<void>) {
          if (working) return;
          working = true; messages.textContent = say('正在处理…', 'Working…'); setDisabled(true);
          try { await action(); if (!disposed) messages.textContent = say('操作完成。', 'Done.'); }
          catch (error) { if (!disposed) messages.textContent = String(error); }
          finally { working = false; if (!disposed) { setDisabled(false); await refresh(); } }
        }
        function setDisabled(value: boolean) { section.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button,input').forEach((control) => { control.disabled = value || control.dataset.permanentDisabled === 'true'; }); }
        const pause = button(say('暂停阅读', 'Pause'), async () => { await ctx.invoke('pause', [!state?.status.library.paused]); });
        button(say('请求写一版全书读后感', 'Request a full-book review'), async () => { await ctx.invoke('request_review', []); });
        button(say('导出分享历史（归档）', 'Export share history (archive)'), async () => {
          const archive = await ctx.invoke<string>('export_shares', []);
          if (!disposed && !ctx.signal.aborted) download(archive, 'bookfish-share-history.json');
        });
        button(say('结束休息', 'End rest'), async () => { await ctx.invoke('resume_rest', []); });
        button(say('刷新', 'Refresh'), async () => { await refresh(); });
        button(say('导出完整备份', 'Export backup'), async () => {
          const task=await ctx.invoke<{id:string;size:number;chunkBytes:number}>('backup_begin',[]);const parts:Uint8Array[]=[];let offset=0;
          try{while(offset<task.size){if(disposed||ctx.signal.aborted)throw Error('Cancelled');const chunk=await ctx.invoke<{base64:string;nextOffset:number;done:boolean}>('backup_read',[task.id,offset]);if(chunk.nextOffset<=offset)throw Error('Backup transfer stalled');parts.push(Uint8Array.from(atob(chunk.base64),c=>c.charCodeAt(0)));offset=chunk.nextOffset;messages.textContent=say('备份下载 ','Downloading backup ')+Math.round(offset/task.size*100)+'%';}}finally{if(!ctx.signal.aborted)await ctx.invoke('transfer_cancel',[task.id]);}
          if (disposed || ctx.signal.aborted) return;
          const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'application/octet-stream' }));
          const link = document.createElement('a'); link.href = url; link.download = 'bookfish-backup.bfbak'; section.append(link); link.click(); link.remove();
          ctx.timeout(() => URL.revokeObjectURL(url), 1000);
          ctx.own({ dispose: () => URL.revokeObjectURL(url) });
        });
        const form = document.createElement('form'); form.style.cssText = 'display:grid;gap:8px;border-top:1px solid #8886;padding-top:12px'; section.append(form);
        function field(label: string, type: string) {
          const wrapper = document.createElement('label'); wrapper.textContent = label;
          const input = document.createElement('input'); input.type = type; wrapper.append(input); form.append(wrapper); return input;
        }
        const importStatus=document.createElement('section');importStatus.dataset.bookfish='import-status';importStatus.hidden=true;section.append(importStatus);
        const importText=document.createElement('p'),importProgress=document.createElement('progress'),cancelImport=document.createElement('button');importProgress.max=100;importProgress.setAttribute('aria-label',say('导入进度','Import progress'));cancelImport.type='button';cancelImport.textContent=say('取消导入','Cancel import');importStatus.append(importText,importProgress,cancelImport);
        let uploadId:string|undefined,selectedImportId:string|undefined,cancelledUpload=false;
        cancelImport.addEventListener('click',()=>{void(async()=>{if(!uploadId)return;cancelledUpload=true;cancelImport.disabled=true;try{await ctx.invoke('transfer_cancel',[uploadId]);importText.textContent=say('已取消导入，书架保持原样。','Import cancelled; bookshelf unchanged.');}catch(e){importText.textContent=String(e);}finally{await refreshImport();}})();},{signal:ctx.signal});
        async function refreshImport(){
          try{const job=await ctx.invoke<{id:string;state:string;stage:string;percent:number;error?:string;result?:{duplicate?:boolean;book?:{title:string;author:string}}}|null>('transfer_status',[]);if(disposed||ctx.signal.aborted||!job)return;
            uploadId=job.id;importStatus.hidden=false;importProgress.value=job.percent;if(job.state==='done'&&job.id===selectedImportId&&job.result?.book){metadataResult.hidden=false;metadataTitle.textContent=job.result.book.title;metadataAuthor.textContent=job.result.book.author||say('未识别到作者','Author not found');}
            const labels:Record<string,string>={normalize:say('正在整理正文','Normalizing text'),index:say('正在建立章节索引','Building chapter index'),validate:say('正在完整校验正文','Validating source'),commit:say('正在加入书架','Adding to bookshelf')};
            importText.textContent=job.state==='done'?(job.result?.duplicate?say('这个版本已在书架，进度已保留。','Revision already exists; progress preserved.'):say('导入完成，已加入书架。','Import complete; added to bookshelf.')):job.state==='failed'?say('导入失败：','Import failed: ')+job.error:job.state==='cancelled'?say('已取消导入。','Import cancelled.'):(labels[job.stage]??job.stage)+' · '+job.percent+'%';cancelImport.hidden=!['processing','committing'].includes(job.state);cancelImport.disabled=job.state!=='processing';
          }catch(e){if(!disposed)importText.textContent=say('暂时无法查询导入进度，可刷新页面重试。','Progress unavailable; refresh to retry.');}
        }
        async function uploadFile(selected:File,kind:'book'|'backup',meta:Record<string,unknown>){
          const task=await ctx.invoke<{id:string;chunkBytes:number}>('upload_begin',[{...meta,kind,size:selected.size}]);uploadId=task.id;cancelledUpload=false;if(kind==='book'){selectedImportId=task.id;importStatus.hidden=false;cancelImport.hidden=false;cancelImport.disabled=false;importText.textContent=say('正在上传正文…','Uploading source…');importProgress.value=0;}
          try{for(let offset=0;offset<selected.size;offset+=task.chunkBytes){if(disposed||ctx.signal.aborted||cancelledUpload)throw Error('Cancelled');const bytes=new Uint8Array(await selected.slice(offset,offset+task.chunkBytes).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const ack=await ctx.invoke<{offset:number}>('upload_chunk',[task.id,offset,btoa(binary)]);if(ack.offset!==offset+bytes.length)throw Error('Upload acknowledgement mismatch');messages.textContent=say('正在上传 ','Uploading ')+Math.round(ack.offset/selected.size*100)+'%';if(kind==='book'){importText.textContent=messages.textContent;importProgress.value=Math.round(ack.offset/selected.size*100);}}
            messages.textContent=say('正在校验正文与建立索引…','Validating text and building index…');if(cancelledUpload)throw Error('Cancelled');const started=await ctx.invoke<{state:string;result?:unknown}>('upload_finish',[task.id]);if(kind==='book')await refreshImport();return started.state==='done'?started.result:started;
          }catch(error){if(!ctx.signal.aborted)await ctx.invoke('transfer_cancel',[task.id]).catch(()=>{});throw error;}
        }
        const file = field(say('小说文件（UTF-8 TXT / Markdown，最大100 MiB）', 'Novel file (UTF-8 TXT / Markdown, up to 100 MiB)'), 'file'); file.accept = '.txt,.md'; file.required = true;
        const metadataResult=document.createElement('section');metadataResult.className='import-metadata';metadataResult.hidden=true;metadataResult.setAttribute('aria-label',say('小说识别结果','Detected book metadata'));form.append(metadataResult);
        const metadataTitle=document.createElement('p'),metadataAuthor=document.createElement('p');const titleLabel=document.createElement('strong');titleLabel.textContent=say('识别书名','Detected title');const authorLabel=document.createElement('strong');authorLabel.textContent=say('识别作者','Detected author');metadataResult.append(titleLabel,metadataTitle,authorLabel,metadataAuthor);
        const hint=document.createElement('small');hint.textContent=say('选择小说文件后导入，书名和作者将从文件开头或文件名自动识别；没有作者信息时显示未识别，不猜测。','Choose a novel file to import. Title and author are detected from its header or filename; missing authors remain unknown.');form.append(hint);
        const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = say('导入书架', 'Import');submit.disabled=true;submit.dataset.permanentDisabled='true'; form.append(submit);
        file.addEventListener('change', () => {selectedImportId=undefined;metadataResult.hidden=true;submit.disabled=!file.files?.[0];submit.dataset.permanentDisabled=String(!file.files?.[0]);}, { signal: ctx.signal });
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void perform(async () => {
            const selected = file.files?.[0];
            if (!selected || selected.size > 100 * 1024 * 1024) throw new Error(say('请选择不超过100 MiB的小说文件。','Select a novel up to 100 MiB.'));
            const result = await uploadFile(selected,'book',{filename:selected.name,autoMetadata:true}) as {duplicate:boolean};
            if (result.duplicate) throw new Error(say('这个版本已在书架，进度已保留。', 'This revision is already in the library; progress is preserved.'));
          });
        }, { signal: ctx.signal });
        const recovery = document.createElement('label'); recovery.textContent = say('恢复备份（仅允许空书架；备份包含小说正文）', 'Restore backup (empty library only; includes book text)'); section.append(recovery);
        const backupFile = document.createElement('input'); backupFile.type = 'file'; backupFile.accept = '.json,.bfbak'; recovery.append(backupFile);
        button(say('恢复到空书架', 'Restore to empty library'), async () => {
          const selected = backupFile.files?.[0];
          if (!selected || selected.size > 1024 * 1024 * 1024) throw new Error(say('请选择不超过1 GiB的备份。', 'Select a backup up to 1 GiB.'));
          if(selected.name.toLowerCase().endsWith('.json')){if(selected.size>25*1024*1024)throw Error('Legacy JSON backup must be at most 25 MiB; use .bfbak for large libraries');const text=await selected.text();if(!disposed&&!ctx.signal.aborted)await ctx.invoke('restore',[text]);}else await uploadFile(selected,'backup',{filename:selected.name});
        }, section);
        const remoteForm = document.createElement('form'); remoteForm.style.cssText = 'display:grid;gap:8px;border-top:1px solid #8886;padding-top:12px'; section.append(remoteForm);
        const urlLabel = document.createElement('label'); urlLabel.textContent = say('链接获取（目前仅支持笔趣阁）：', 'Link fetch (Biquge only): '); const siteLink = document.createElement('a'); siteLink.href = 'https://www.02345.cc/'; siteLink.target = '_blank'; siteLink.rel = 'noreferrer'; siteLink.textContent = 'www.02345.cc'; siteLink.className = 'source-site'; urlLabel.append(siteLink);
        const urlInput = document.createElement('input'); urlInput.type = 'url'; urlInput.required = true; urlInput.maxLength = 2000; urlInput.placeholder = 'https://www.02345.cc/…/'; urlLabel.append(urlInput); remoteForm.append(urlLabel);
        const example=document.createElement('small');example.textContent=say('网址示例（《西游记》目录）：https://www.02345.cc/xiyouji/','Example (Journey to the West): https://www.02345.cc/xiyouji/');remoteForm.append(example);
        const useExample=document.createElement('button');useExample.type='button';useExample.textContent=say('填入示例','Use example');useExample.onclick=()=>{urlInput.value='https://www.02345.cc/xiyouji/';urlInput.focus();};remoteForm.append(useExample);
        const sourceResult = document.createElement('div'); sourceResult.className = 'source-result';sourceResult.setAttribute('role','status');sourceResult.setAttribute('aria-live','polite'); remoteForm.append(sourceResult);
        const resolve = document.createElement('button'); resolve.type = 'submit'; resolve.textContent = say('检测链接能否获取正文', 'Check source readability'); remoteForm.append(resolve);
        const remoteHelp = document.createElement('p'); remoteHelp.textContent = say('会访问目录与首章的全部分页，其余章节按需获取。需登录、验证或缺章时会停止，不跳过。目录变化形成新版本；中间章节链接也从第一章开始。', 'Loads the complete catalog and all pages of the first chapter, then fetches on demand. Login, verification and missing pages stop retrieval. Changed catalogs create new revisions; a middle-chapter link still starts from chapter one.'); remoteForm.append(remoteHelp);
        remoteForm.addEventListener('submit', (event) => {
          event.preventDefault();if(resolve.disabled)return; void perform(async () => {resolve.disabled=true;useExample.disabled=true;urlInput.readOnly=true;resolve.textContent=say('正在检测…','Checking…');sourceResult.setAttribute('aria-busy','true');sourceResult.textContent=say('正在连接书源，读取目录与首章分页，请稍候。检测成功前不会加入书架。','Connecting and checking the catalog and first chapter pages. Nothing is imported until confirmed.');const progress=document.createElement('progress');progress.setAttribute('aria-label',say('链接检测进行中','Source check in progress'));sourceResult.append(progress); try { const preview = await ctx.invoke<{token:string;title:string;note:string}>('detect', [urlInput.value]); if (disposed || ctx.signal.aborted) return;sourceResult.replaceChildren();line(sourceResult,say('检测成功','Check succeeded'),preview.title+' · '+preview.note); button(say('确认加入书架', 'Add to library'), async () => { await ctx.invoke('accept_source', [preview.token]); sourceResult.textContent=say('已加入书架。','Added to library.'); }, sourceResult); } catch(error) { sourceResult.textContent = say('检测失败：无法获取正文，链接已保留；可重试或改用文件导入。', 'Check failed. URL preserved; retry or import a file.'); throw error; }finally{resolve.disabled=false;useExample.disabled=false;urlInput.readOnly=false;sourceResult.setAttribute('aria-busy','false');resolve.textContent=say('检测链接能否获取正文','Check source readability');} });
        }, { signal: ctx.signal });
        button(say('重试当前缺失章节', 'Retry current missing chapter'), async () => { await ctx.invoke('fetch', []); }, remoteForm);
        async function refresh() {
          const revision = ++request;
          try {
            const received = await ctx.invoke<LibraryPanelState>('get', []);
            if (disposed || ctx.signal.aborted || revision !== request) return;
            state = received;
            const lib = state.status.library; const current = lib.current;
            if (journalBook !== current?.key) { journalBook = current?.key; journalBefore = undefined; detail.replaceChildren(); articleDetail.replaceChildren(); journalRevision = ''; searchResults.replaceChildren(); searchArgs = undefined; searchCursor = undefined; }
            if (journalBefore !== undefined && current) {
              const page = await ctx.invoke<NonNullable<LibraryPanelState['journal']>>('journal', [{ bookKey: current.key, before: journalBefore, limit: 5 }]);
              if (disposed || ctx.signal.aborted || revision !== request) return;
              state.journal = page;
            }
            renderJournal(state.journal);
            if (JSON.stringify(state.reviews) !== reviewRevision) {
              reviewRevision = JSON.stringify(state.reviews); articles.replaceChildren();
              const title = document.createElement('h3'); title.textContent = say('全书读后感与版本', 'Full-book review versions'); articles.append(title);
              line(articles, say('完读判定', 'Completion'), state.reviews?.complete ? say('本版本全书已连续确认完成', 'This finished revision is continuously confirmed complete') : say('尚未完成，阶段感想不能作为全书读后感', 'Incomplete; a stage reaction is not a full-book review'));
              for (const job of state.reviews?.jobs.slice(-5).reverse() ?? []) {
                line(articles, say('任务', 'Job'), `${job.id} · ${job.status} · ${job.error ?? ''}`);
                if (job.status === 'pending') button(say('取消这次文章任务', 'Cancel this article job'), async () => { await ctx.invoke('cancel_review', [job.id]); }, articles);
              }
              for (const v of [...(state.reviews?.versions ?? [])].reverse()) button(`v${v.version} · ${v.title}`, () => showReview(v.id), articles);
            }
            const sharing = state.status.sharing;
            if (sharing && JSON.stringify(sharing) !== shareRevision) {
              shareRevision = JSON.stringify(sharing); shares.replaceChildren();
              const title = document.createElement('h3'); title.textContent = say('阅读分享候选与输出记录', 'Reading share candidates and output'); shares.append(title);
              line(shares, say('主动分享', 'Automatic shares'), `${sharing.enabled ? say('开启', 'On') : say('关闭', 'Off')} · ${sharing.reason} · ${say('尝试','attempts')} ${sharing.budget.attempts} · ${sharing.timezone}`);
              line(shares, say('输出边界', 'Output evidence'), say('工具报告已接收不等于已显示；只有你确认看见才标为已目击。最近20条；完整历史与预算不在书架备份中。', 'Tool acceptance is not proven display; only your confirmation marks it witnessed. Latest 20; history/budget are outside library backups.'));
              const labels: Record<string, string> = { candidate: '待选分享', reserved: '已预留尝试，输出未确认', accepted: '工具报告已接收（未证明显示）', unknown: '输出未知，不自动重试', unavailable: '输出不可用，保留手账', dropped: '已放弃或过期' };
              for (const item of sharing.items) {
                const row = document.createElement('article'); shares.append(row);
                line(row, item.visibleAt ? say('用户已目击', 'User witnessed') : en ? item.state : labels[item.state], `${item.text} · ${new Date(item.createdAt).toLocaleString()}`);
                line(row, say('详情', 'Details'), `${item.note}${item.receipt ? ` · ${item.receipt}` : ''}`);
                if (item.state === 'candidate') button(say('放弃这条分享', 'Dismiss this share'), async () => { await ctx.invoke('share_drop', [item.id]); }, row);
                if (['accepted', 'unknown', 'reserved'].includes(item.state) && !item.visibleAt) button(say('我已看到这条分享', 'I saw this share'), async () => { await ctx.invoke('share_visible', [item.id]); }, row);
              }
            }
            status.textContent = current
              ? `${current.title} · ${current.chapter} · ${(current.progress * 100).toFixed(1)}% ${current.source ? say('（章节进度）', '(chapters)') : ''} · ${say('已确认', 'Confirmed')} ${current.confirmedSegments}/${current.totalSegments} ${current.source ? say('个缓存段落', 'cached segments') : ''} · ${say('已提供正文', 'Provided text')} ${lib.providedChars}/${current.totalChars} ${current.source ? say('个缓存字符', 'cached characters') : ''} · ${lib.paused ? say('已暂停', 'Paused') : say('可继续', 'Ready')}${current.source?.error ? ` · ${sourceLabel(current.source.error.code)}: ${current.source.error.message}` : ''}`
              : say('尚未选择书籍。导入后点击“开始读这本”。', 'No book selected. Import and select a book.');
            pause.textContent = lib.paused ? say('继续阅读', 'Resume') : say('暂停阅读', 'Pause');
            const run = state.status.scheduler;
            const reasons: Record<string, string> = { routine:'按作息暂停阅读', stopped: '未运行', waiting_for_host_idle: '等待宿主报告空闲', disabled: '自主阅读未开启', paused: '已暂停', no_book: '尚未选书', complete: '已全部确认', resting: '正在休息', daily_goal: '今天的章节目标已完成',chapter_goal_unavailable:'本书章节未识别，无法按章安排', awaiting_model: '等待模型处理', chat_priority: '聊天优先，等待空闲30秒', waiting: '等待下次机会', failed: '运行失败' };
            schedule.textContent = `${say('自主阅读', 'Automatic reading')}: ${en ? run.reason : reasons[run.reason] ?? run.reason} · ${state.status.selectedMode} · ${say('今日提供', 'Supplied today')} ${run.budget.tasks} ${say('段', 'tasks')}, ${run.budget.chars} ${say('字符', 'characters')} · ${say('下次最早', 'Next earliest')} ${run.nextAt ? new Date(run.nextAt).toLocaleString() : '—'}${run.error ? ` · ${run.error}` : ''}`;
            const signature = JSON.stringify([state.books, current?.key]);
            if (signature === shelfRevision) { if (working) setDisabled(true); return; }
            shelfRevision = signature;
            shelf.replaceChildren();
            let group='';for (const book of [...state.books].sort((a,b)=>(a.key===current?.key?0:a.complete?2:1)-(b.key===current?.key?0:b.complete?2:1))) {
              const nextGroup=book.key===current?.key?say('正在读','Reading'):book.complete?say('已读完','Finished'):say('准备读','To read');if(group!==nextGroup){group=nextGroup;const heading=document.createElement('h3');heading.textContent=group;shelf.append(heading);}
              const card = document.createElement('article'); card.style.cssText = 'display:grid;gap:8px'; shelf.append(card);
              const name = document.createElement('strong'); name.textContent = `${book.title}${book.author ? ` · ${book.author}` : ''}`; card.append(name);button(say('查看这本书','View this book'),async()=>{card.dispatchEvent(new CustomEvent('bookfish-book',{bubbles:true,detail:{key:book.key}}));},card);const pages=document.createElement('p');pages.textContent=say('已读 ','Read ')+Math.ceil(book.confirmedChars/600)+(book.source&&book.source.cachedChapters!==book.source.totalChapters?say(' 页 · 正文未完整获取，无法计算总页数',' pages · Total unknown'):' / '+Math.ceil(book.totalChars/600)+say(' 页',' pages'));card.append(pages);const maintenance=document.createElement('details');const more=document.createElement('summary');more.textContent=say('书籍详情与管理','Book details and management');maintenance.append(more);card.append(maintenance);
              const description = document.createElement('p'); description.textContent = `${say('版本', 'Revision')} ${book.revision.slice(0, 8)} · ${book.totalChars} ${book.source ? say('缓存字符', 'cached characters') : say('字符', 'characters')} · ${(book.progress * 100).toFixed(1)}% · ${book.source ? `${say('已读章节', 'Confirmed chapters')} ${book.source.confirmedChapters}/${book.source.totalChapters} · ${say('已缓存', 'Cached')} ${book.source.cachedChapters}` : `${book.confirmedSegments}/${book.totalSegments}`}${book.complete ? say(' · 本版本全部正文已确认', ' · All text in this revision confirmed') : ''}`; maintenance.append(description);
              if (book.source) {
                const publication = book.source.publicationStatus === 'finished' ? say('站点标注完本', 'Source says finished') : book.source.publicationStatus === 'ongoing' ? say('站点标注连载', 'Source says ongoing') : say('完结状态未知', 'Publication status unknown');
                const origin = document.createElement('p'); origin.textContent = `${book.source.bookUrl} · ${sourceLabel(book.source.status)} · ${publication}${book.source.error ? ` · ${book.source.error.message}` : ''}`; maintenance.append(origin);
              }
              const meter = document.createElement('progress'); meter.max = 1; meter.value = book.progress; meter.setAttribute('aria-label', say('已确认阅读进度', 'Confirmed reading progress')); maintenance.append(meter);
              const select = button(current?.key === book.key ? say('当前书籍', 'Selected') : say('开始读这本', 'Select book'), async () => { await ctx.invoke('select', [book.key]); }, card);
              select.disabled = working || current?.key === book.key; select.dataset.permanentDisabled = String(current?.key === book.key);
              const approval = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; approval.append(check, document.createTextNode(say('确认删除此版本及其进度', 'Confirm removal of this revision and progress'))); maintenance.append(approval);
              button(say('删除', 'Remove'), async () => { if (!check.checked) throw new Error(say('请先勾选删除确认。', 'Check the removal confirmation first.')); await ctx.invoke('remove', [book.key]); }, maintenance);
            }
            if (working) setDisabled(true);
          } catch (error) { if (!disposed && !ctx.signal.aborted && revision === request) messages.textContent = String(error); }
        }
        section.append(searchForm);
        await refresh();await refreshImport();
        ctx.interval(() => { if (!working){void refresh();void refreshImport();} }, 2000);
        return { dispose() { disposed = true; request++; } };
      },
    },
  },
} satisfies WebUiClientBundle;
