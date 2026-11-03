const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require(process.env.PW||'playwright');
const root=__dirname,mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.bin':'application/octet-stream'};
const srv=http.createServer((q,r)=>{const f=path.join(root,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);return r.end()}r.writeHead(200,{'content-type':mime[path.extname(f)]||'application/octet-stream'});r.end(d)})}).listen(0,async()=>{
 const port=srv.address().port;const br=await chromium.launch({args:['--use-angle=swiftshader','--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl']});const pg=await br.newPage();pg.on('pageerror',e=>console.log('[err]',e.message));pg.on('console',m=>console.log('[page]',m.text().slice(0,200)));
 await pg.goto('http://localhost:'+port+'/filter.html');await pg.waitForFunction('window.READY');
 const img='data:image/png;base64,'+fs.readFileSync(process.argv[2]).toString('base64');
 const t=Date.now();const r=await pg.evaluate(d=>window.coverImage(d),img);console.log('covers:',r.faces,r.type,'ms',Date.now()-t);
 fs.writeFileSync(process.argv[3],Buffer.from(r.blob,'base64'));await br.close();srv.close()});
