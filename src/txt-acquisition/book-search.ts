/** Search labels are untrusted hints, never book identity evidence. */
import * as cheerio from 'cheerio';
export const BOOK_SEARCH_ORIGIN='https://cn.bing.com';
export interface BookSearchHit { title:string; url:string; host:string; snippet:string; suggestedTitle?:string }
export function bookSearchUrl(title:string,author:string):string {
  title=title.trim();author=author.trim();
  if((!title&&!author)||title.length>200||author.length>100)throw Error('请至少填写书名或作者；书名最多200字，作者最多100字。');
  const url=new URL('/search',BOOK_SEARCH_ORIGIN);url.searchParams.set('q',[title,author,'小说 TXT 下载'].filter(Boolean).join(' '));return url.href;
}
export function parseBookSearch(html:string):{hits:BookSearchHit[];blocked:boolean} {
  const $=cheerio.load(html),hits:BookSearchHit[]=[],seen=new Set<string>();
  $('li.b_algo').slice(0,30).each((_i,node)=>{
    const a=$(node).find('h2 a').first(),title=a.text().replace(/\s+/gu,' ').trim().slice(0,240);let raw=a.attr('href');if(!title||!raw)return;
    try{
      let url=new URL(raw,BOOK_SEARCH_ORIGIN);
      if(/(^|\.)bing\.com$/iu.test(url.hostname)&&url.pathname==='/ck/a'){
        const encoded=url.searchParams.get('u');if(!encoded?.startsWith('a1'))return;
        raw=Buffer.from(encoded.slice(2),'base64url').toString('utf8');url=new URL(raw);
      }
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2000||/(^|\.)bing\.com$/iu.test(url.hostname))return;
      url.hash='';if(seen.has(url.href))return;seen.add(url.href);
      const suggestedTitle=/《([^》]{1,80})》/u.exec(title)?.[1]?.trim();
      hits.push({title,url:url.href,host:url.hostname,snippet:$(node).find('.b_caption p').first().text().replace(/\s+/gu,' ').trim().slice(0,400),...(suggestedTitle?{suggestedTitle}:{})});
    }catch{/* Invalid links are ignored; targets are validated again before opening. */}
  });
  return {hits:hits.slice(0,12),blocked:!hits.length&&($('#b_captcha,.b_captcha,[id*=captcha]').length>0||/验证.{0,12}(机器人|身份)|verify.{0,20}(human|identity)/iu.test($('body').text()))};
}
