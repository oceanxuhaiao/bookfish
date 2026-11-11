import {it,expect} from 'vitest';import {detectImportMetadata} from '../src/import-metadata.ts';
it('extracts explicit header labels before filename fallback without treating plot as authorship',()=>{
 expect(detectImportMetadata('上传文件.txt','书名：海边的信\n作者：小鱼\n第一章')).toEqual({title:'海边的信',author:'小鱼'});
 expect(detectImportMetadata('《西游记》作者：吴承恩.txt')).toEqual({title:'西游记',author:'吴承恩'});
 expect(detectImportMetadata('海风.txt','第一章\n小鱼看着作者留下的字迹。')).toEqual({title:'海风',author:''});
 expect(detectImportMetadata('story.md','Title: Ocean\nAuthor: Fish')).toEqual({title:'Ocean',author:'Fish'});
});
