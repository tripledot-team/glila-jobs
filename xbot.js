/* Glila X mirror: copies NEW posts of one X account to its Glila account.
   Rules: no replies, no reposts, no quotes of other accounts, no video/GIF.
   A quote of the account's own earlier post becomes a Glila quote of that same post.
   Every photo goes through the same face + person filter as the site. */
const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const {createClient}=require('@supabase/supabase-js');

const SB_URL=process.env.SUPABASE_URL||'https://otzrouieonprlkkscvie.supabase.co';
const KEY=process.env.SUPABASE_SERVICE_KEY;
const HANDLES=(process.env.X_HANDLES||'Osint613,visegrad24').split(',').map(x=>x.trim()).filter(Boolean);
const SITE='https://glila.bucherim.com';
if(!KEY){console.error('Missing SUPABASE_SERVICE_KEY secret');process.exit(1)}
const sb=createClient(SB_URL,KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const log=(...a)=>console.log(new Date().toISOString(),...a);
const rnd=()=>Math.random().toString(36).slice(2,8);

/* ---------- pure rules (also used by the tests) ---------- */
function decide(t,handle){
  const me=handle.toLowerCase();
  if(!t||!t.id_str)return{skip:'no id'};
  if(t.retweeted_status)return{skip:'repost'};
  if(t.in_reply_to_status_id_str||t.in_reply_to_screen_name&&t.in_reply_to_screen_name.toLowerCase()!==me)return{skip:'reply'};
  const q=t.quoted_status,qid=t.quoted_status_id_str||(q&&q.id_str)||null;
  if(qid){const qu=q&&q.user&&q.user.screen_name;if(!qu||qu.toLowerCase()!==me)return{skip:'quotes another account'}}
  const media=(t.extended_entities&&t.extended_entities.media)||(t.entities&&t.entities.media)||[];
  if(media.some(m=>m.type!=='photo'))return{skip:'video or gif'};
  return{ok:true,quoteOf:qid,photos:media.map(m=>m.media_url_https)};
}
function cleanText(t){
  let s=t.full_text||t.text||'';
  const ents=[...(t.entities&&t.entities.urls||[]),...(((t.extended_entities||t.entities||{}).media)||[])];
  ents.forEach(u=>{if(!u.url)return;s=s.split(u.url).join(u.expanded_url&&!/^https?:\/\/(x|twitter)\.com\//.test(u.expanded_url)&&!u.media_url_https?u.expanded_url:'')});
  s=s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  if(Array.isArray(t.display_text_range)&&!ents.length)s=Array.from(s).slice(t.display_text_range[0],t.display_text_range[1]).join('');
  return s.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
module.exports={decide,cleanText};
if(require.main!==module)return;

/* ---------- local server for the filter page ---------- */
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
function serve(){return new Promise(ok=>{const s=http.createServer((q,r)=>{const f=path.join(__dirname,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);return r.end()}r.writeHead(200,{'content-type':mime[path.extname(f)]||'application/octet-stream'});r.end(d)})}).listen(0,()=>ok(s))})}

async function runOne(HANDLE,br,port){
 try{
  /* 1) read the account's public timeline (same page X embeds use) */
  const feedPg=await br.newPage({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',locale:'en-US'});
  const urls=['https://syndication.twitter.com/srv/timeline-profile/screen-name/'+HANDLE,'https://syndication.twitter.com/srv/timeline-profile/screen-name/'+HANDLE+'?showReplies=false&dnt=true','https://cdn.syndication.twimg.com/srv/timeline-profile/screen-name/'+HANDLE];
  let raw=null;
  for(const u of urls){
   for(let k=0;k<2&&!raw;k++){
    try{
     const resp=await feedPg.goto(u,{waitUntil:'domcontentloaded',timeout:60000});
     raw=await feedPg.evaluate(()=>{const e=document.getElementById('__NEXT_DATA__');return e?e.textContent:null});
     if(!raw){const body=await feedPg.evaluate(()=>document.body?document.body.innerText.slice(0,200).replace(/\s+/g,' '):'');log('feed try',u,'status',resp&&resp.status(),'body:',body)}
    }catch(e){log('feed try',u,'error',e.message)}
    if(!raw)await new Promise(r=>setTimeout(r,4000));
   }
   if(raw){log('feed ok via',u);break}
  }
  if(!raw){log('feed not available (blocked or changed); nothing done');return}
  const entries=JSON.parse(raw).props.pageProps.timeline.entries||[];
  const tweets=entries.map(e=>e.content&&e.content.tweet).filter(Boolean);
  log('feed entries',tweets.length);
  const user=(tweets.find(t=>t.user)||{}).user||{};

  /* 2) the Glila account (created once, verified, with his profile picture) */
  let st=(await sb.from('forum_x_state').select('*').eq('handle',HANDLE.toLowerCase()).maybeSingle()).data;
  if(!st){
   const email=HANDLE.toLowerCase()+'.mirror@bucherim.com',pw=rnd()+rnd()+rnd()+rnd();
   const cu=await sb.auth.admin.createUser({email,password:pw,email_confirm:true,user_metadata:{username:HANDLE}});
   if(cu.error)throw cu.error;
   const uid=cu.data.user.id;
   await sb.from('profiles').upsert({id:uid,username:HANDLE,verified:true});
   if(user.profile_image_url_https){
    const u=user.profile_image_url_https.replace('_normal','_400x400');const buf=Buffer.from(await (await fetch(u)).arrayBuffer());
    const p=uid+'/avatar-'+Date.now()+'.jpg';const up=await sb.storage.from('forum').upload(p,buf,{contentType:'image/jpeg'});
    if(!up.error)await sb.from('profiles').update({avatar_url:sb.storage.from('forum').getPublicUrl(p).data.publicUrl}).eq('id',uid);else log('avatar upload failed',up.error.message)}
   st=(await sb.from('forum_x_state').insert({handle:HANDLE.toLowerCase(),user_id:uid,started_at:new Date().toISOString()}).select().single()).data;
   /* baseline: everything already there is old and is never posted */
   await sb.from('forum_x_seen').upsert(tweets.map(t=>({tweet_id:t.id_str,handle:HANDLE.toLowerCase(),post_id:null})),{onConflict:'tweet_id'});
   log('first run: account created, baseline of',tweets.length,'old posts saved. Nothing posted.');return}
  const started=new Date(st.started_at).getTime();

  /* 3) which Glila topic */
  let community=process.env.COMMUNITY;
  if(!community){const c=(await sb.from('forum_communities').select('slug').ilike('slug','%news%').limit(1)).data;community=c&&c[0]?c[0].slug:'general'}

  /* 4) new posts only, oldest first */
  const seen=new Set(((await sb.from('forum_x_seen').select('tweet_id').in('tweet_id',tweets.map(t=>t.id_str))).data||[]).map(r=>r.tweet_id));
  const fresh=tweets.filter(t=>!seen.has(t.id_str)&&new Date(t.created_at).getTime()>=started).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  log('new posts to look at',fresh.length);
  if(!fresh.length)return;
  const fp=await br.newPage();fp.on('pageerror',e=>log('[filter page]',e.message));
  await fp.goto('http://localhost:'+port+'/filter.html');await fp.waitForFunction('window.READY',null,{timeout:60000});

  for(const t of fresh){
   const mark=async post_id=>sb.from('forum_x_seen').upsert({tweet_id:t.id_str,handle:HANDLE.toLowerCase(),post_id},{onConflict:'tweet_id'});
   const d=decide(t,HANDLE);
   if(!d.ok){log('skip',t.id_str,d.skip);await mark(null);continue}
   try{
    const images=[],origs=[];
    for(const url of d.photos.slice(0,8)){
     const buf=Buffer.from(await (await fetch(url+(url.includes('?')?'':'?name=large'))).arrayBuffer());
     const mt=/\.png/.test(url)?'image/png':'image/jpeg';
     const r=await fp.evaluate(x=>window.coverImage(x),'data:'+mt+';base64,'+buf.toString('base64'));
     const ext=r.type==='image/webp'?'webp':'jpg';
     const p=st.user_id+'/'+Date.now()+'-'+rnd()+'.'+ext;
     let up=await sb.storage.from('forum').upload(p,Buffer.from(r.blob,'base64'),{contentType:r.type});if(up.error)throw up.error;
     images.push(sb.storage.from('forum').getPublicUrl(p).data.publicUrl);
     if(r.raw){const rp=st.user_id+'/'+Date.now()+'-'+rnd()+'.'+(r.rawType==='image/webp'?'webp':'jpg');const ru=await sb.storage.from('forum-review').upload(rp,Buffer.from(r.raw,'base64'),{contentType:r.rawType});origs.push(ru.error?null:rp)}else origs.push(null);
    }
    const text=cleanText(t);
    if(!text&&!images.length){log('skip',t.id_str,'empty');await mark(null);continue}
    let quote=null;
    if(d.quoteOf){const q=(await sb.from('forum_x_seen').select('post_id').eq('tweet_id',d.quoteOf).maybeSingle()).data;quote=q&&q.post_id||null}
    const flat=text.replace(/\s+/g,' ').trim();   /* X posts have no titles: the title is just the start of the text (Glila hides it when it repeats the text) */
    const cut=Array.from(flat);const title=(cut.length>110?cut.slice(0,110).join('').replace(/\s+\S*$/,'')+'…':flat)||'Photo';
    const body=text||null;
    const row={author:st.user_id,community,title,body,...(images.length?{images,image_url:images[0],orig_paths:origs}:{}),...(quote?{quote_post:quote}:{})};
    const ins=await sb.from('forum_posts').insert(row).select('id').single();
    if(ins.error&&/content_flagged/.test(ins.error.message||'')){
     const hold=await sb.from('forum_flagged').insert({user_id:st.user_id,kind:'post',payload:{community,title,body,...(images.length?{images,image_url:images[0],orig_paths:origs}:{})},preview:(title+'\n'+(body||'')).slice(0,500),reason:String(ins.error.message).replace(/^.*content_flagged:\s*/,'').slice(0,60)});
     if(hold.error)throw hold.error;await mark(null);log('held by word filter',t.id_str);continue}
    if(ins.error)throw ins.error;
    await mark(ins.data.id);log('posted',t.id_str,'->',ins.data.id,images.length,'photos',quote?'(quote)':'');
   }catch(e){log('failed',t.id_str,e.message||e)}
  }
 }catch(e){log('error',HANDLE,e.message||e);process.exitCode=1}
}
(async()=>{
 const srv=await serve(),port=srv.address().port;
 const br=await chromium.launch({args:['--use-angle=swiftshader','--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl']});
 try{for(const H of HANDLES){log('--- account',H);await runOne(H,br,port);await new Promise(r=>setTimeout(r,3000))}}
 finally{await br.close();srv.close()}
})();
