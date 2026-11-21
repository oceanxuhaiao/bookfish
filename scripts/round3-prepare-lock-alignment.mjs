import{readFileSync,writeFileSync,mkdirSync}from'node:fs';
const p=JSON.parse(readFileSync('_verify/r3-lock-parity.json','utf8'));
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const overrides={};
for(const row of p.npmOnly){const at=row.lastIndexOf('@'),name=row.slice(0,at),version=row.slice(at+1),major=version.split('.')[0];if(name.startsWith('@rollup/'))continue;const candidate=p.pnpmOnly.filter(x=>x.startsWith(name+'@')&&x.slice(name.length+1).split('.')[0]===major);if(candidate.length===1)overrides[name+'@'+version]=candidate[0].slice(name.length+1);}
mkdirSync('_verify/lock-alignment',{recursive:true});writeFileSync('_verify/lock-alignment/package.json',JSON.stringify({...pkg,overrides},null,2));writeFileSync('_verify/lock-alignment/package-lock.json',readFileSync('package-lock.json'));console.log(JSON.stringify(overrides));
