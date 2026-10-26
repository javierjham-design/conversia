const fs=require('fs'),path=require('path');
const roots=process.argv.slice(2);
const re=/\b(\w+)\.(\w+)\.(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|update|updateMany|delete|deleteMany|count|aggregate|groupBy|upsert)\s*\(/g;
function walk(d,out){for(const f of fs.readdirSync(d)){const p=path.join(d,f);const s=fs.statSync(p);if(s.isDirectory()){if(f==='node_modules'||f==='dist')continue;walk(p,out)}else if(/\.ts$/.test(f)&&!/\.(spec|test)\.ts$/.test(f))out.push(p)}return out}
for(const r of roots)for(const file of walk(r,[])){const src=fs.readFileSync(file,'utf8');let m;re.lastIndex=0;
while((m=re.exec(src))){const client=m[1];
if(!/^(tx|t|db|prisma|client|admin|adminPrisma|adminDb|p)$/i.test(client) && !/tx|prisma/i.test(client))continue;
let i=re.lastIndex,depth=1;while(i<src.length&&depth>0){const c=src[i];if(c==='(')depth++;else if(c===')')depth--;i++}
const arg=src.slice(re.lastIndex,i-1);
if(/organizationId|orgId|organization\s*:|organization_id/.test(arg))continue;
const line=src.slice(0,m.index).split('\n').length;
console.log(`${path.relative(process.cwd(),file).replace(/\\/g,'/')}:${line} ${client}.${m[2]}.${m[3]} ${arg.replace(/\s+/g,' ').slice(0,150)}`)}}
