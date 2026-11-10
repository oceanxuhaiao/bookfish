/** Bounded, explicit labels only; never infer authors from story prose. */
export function detectImportMetadata(filename:string,prefix=''){
 const clean=(s:string,n:number)=>Array.from(s.replace(/[\x00-\x1f\x7f]/g,' ').trim()).slice(0,n).join('');
 const stem=filename.replace(/\.(txt|md)$/i,'').trim();
 const named=stem.match(/^《([^》]+)》(?:[ _-]*(?:作者[：:]?\s*)?(.+))?$/u);
 let title=clean(named?.[1]??stem,200)||'未命名小说',author=clean(named?.[2]??'',100);
 const lines=prefix.replace(/^\uFEFF/,'').split(/\r?\n/).slice(0,60);
 for(const line of lines){const text=line.trim();const t=text.match(/^(?:书名|Title)\s*[：:]\s*(.{1,200})$/iu);if(t){title=clean(t[1].replace(/^《(.+)》$/u,'$1'),200);break;}}
 for(const line of lines){const a=line.trim().match(/^(?:作者|Author)\s*[：:]\s*(.{1,100})$/iu);if(a){author=clean(a[1],100);break;}}
 if(!lines.some(l=>/^(?:书名|Title)\s*[：:]/iu.test(l.trim()))){const t=lines.slice(0,8).map(l=>l.trim()).find(l=>/^《[^》]{1,200}》$/.test(l));if(t)title=clean(t.slice(1,-1),200);}
 return {title,author};
}
