const { useState, useEffect, useCallback, useRef, useMemo } = React;
const { createRoot } = ReactDOM;

// ── Firebase ──────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:"AIzaSyDLRqQ8WRohNDWz_6UgafI7Kn2f8U0KL3c",
  authDomain:"kwt-news.firebaseapp.com",
  databaseURL:"https://kwt-news-default-rtdb.firebaseio.com",
  projectId:"kwt-news",
  storageBucket:"kwt-news.firebasestorage.app",
  messagingSenderId:"604704031845",
  appId:"1:604704031845:web:b835af9ab1872ddd1d728c",
  measurementId:"G-J161YE3FDP"
};
const app = firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
window.__newsCache = window.__newsCache || { list:[], dashRecent:[], catCounts:{}, stats:null, ts:0 };
try{
  db.enablePersistence({synchronizeTabs:true}).catch(err=>console.warn('[Firestore] persistence:',err?.code||err));
}catch(e){ console.warn('[Firestore] persistence threw:',e); }

// Best-effort epoch (seconds) from whatever date-ish field a doc has. Used for
// client-side newest-first sort so docs without `timestamp` still appear.
window.__docTime = (n)=>{
  const t = n && (n.timestamp||n.createdAt||n.publishedAt||n.date||n.time||n.updatedAt);
  if(!t) return 0;
  if(typeof t==='object' && typeof t.seconds==='number') return t.seconds;
  if(typeof t==='number') return t>1e12? Math.floor(t/1000): t;
  const s=new Date(t).getTime();
  return isNaN(s)? 0: Math.floor(s/1000);
};

// Force a total Firestore resync: tear down the SDK, wipe the IndexedDB cache,
// then hard-reload. Used when the local cache is stuck on a stale doc count
// (e.g. rules were blocking reads earlier, so only 1 doc made it into cache).
window.__forceResync = async ()=>{
  try{
    // Best-effort sign-out so we refetch with fresh auth too.
    try{ await auth.signOut(); }catch(_){}
    try{ await db.terminate(); }catch(_){}
    try{ await db.clearPersistence(); }catch(_){}
    // Also clear localStorage cache hints (except admin cloud creds).
    try{
      const keep = {};
      ['cloudinary_api_key','cloudinary_api_secret','admin_token'].forEach(k=>{ const v=localStorage.getItem(k); if(v!=null) keep[k]=v; });
      localStorage.clear();
      Object.entries(keep).forEach(([k,v])=>localStorage.setItem(k,v));
    }catch(_){}
    try{ sessionStorage.clear(); }catch(_){}
  }catch(e){ console.warn('[resync] error:',e); }
  location.reload();
};

const CLOUDINARY = { cloudName:'debp1kjtm', uploadPreset:'sql_admin', folder:'sql_users', uploadUrl:'https://api.cloudinary.com/v1_1/debp1kjtm/auto/upload' };

// ── Cloudinary asset delete ───────────────────────────────────
// Extract public_id + resource type from a Cloudinary secure URL, or use stored fields.
// Signed destroy requires api_key+api_secret stored in localStorage (admin-only; enter once via Settings).
const cloudinaryPublicIdFromUrl = (url) => {
  if(!url || typeof url!=='string' || !url.includes('res.cloudinary.com')) return null;
  try{
    const m = url.match(/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:[^/]+\/)*(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
    if(!m) return null;
    return { resourceType: m[1], publicId: m[2] };
  }catch{ return null; }
};
const _sha1Hex = async (msg) => {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
};
const cloudinaryDestroy = async (publicId, resourceType='image') => {
  const apiKey    = localStorage.getItem('cld_api_key')    || '';
  const apiSecret = localStorage.getItem('cld_api_secret') || '';
  if(!publicId || !apiKey || !apiSecret) return false;
  const ts = Math.floor(Date.now()/1000);
  const signature = await _sha1Hex(`public_id=${publicId}&timestamp=${ts}${apiSecret}`);
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/${resourceType}/destroy`;
  const body = new FormData();
  body.append('public_id', publicId);
  body.append('api_key', apiKey);
  body.append('timestamp', String(ts));
  body.append('signature', signature);
  try{
    const res = await fetch(url, {method:'POST', body});
    const data = await res.json();
    return data.result==='ok' || data.result==='not found';
  }catch(e){ console.warn('Cloudinary destroy error:', e); return false; }
};
// Delete video + thumbnail from Cloudinary if credentials available.
const deleteCloudinaryAssetsFor = async (article) => {
  const jobs = [];
  if(article.videoPublicId)  jobs.push(cloudinaryDestroy(article.videoPublicId, 'video'));
  else if(article.videoUrl){ const p=cloudinaryPublicIdFromUrl(article.videoUrl);    if(p) jobs.push(cloudinaryDestroy(p.publicId, p.resourceType)); }
  if(article.imagePublicId) jobs.push(cloudinaryDestroy(article.imagePublicId, 'image'));
  else {
    for(const f of ['thumbnail','imageUrl']){
      const p = cloudinaryPublicIdFromUrl(article[f]);
      if(p) jobs.push(cloudinaryDestroy(p.publicId, p.resourceType));
    }
  }
  if(!jobs.length) return;
  try{ await Promise.all(jobs); }catch{}
};
const AD_POSITIONS = ['top_banner','in_feed','sidebar_top','sidebar_bottom','footer'];

// ── AI Config (Puter.js — no API key needed) ──────────────────
const AI_CFG = {
  pixabayKey: '55334487-7e1fe11afb323913a5edf0ad7',
  pollinationsKey: 'pk_zbSQRgAuG5TdrCfD',
};

// Ordered best→fallback; Puter.js tries each until one succeeds
const PUTER_MODELS = [
  {id:'claude-3-7-sonnet',         label:'Claude 3.7 Sonnet'},
  {id:'claude-3-5-sonnet',         label:'Claude 3.5 Sonnet'},
  {id:'gpt-4o',                    label:'GPT-4o'},
  {id:'gemini-2.0-flash',          label:'Gemini 2.0 Flash'},
  {id:'gemini-1.5-pro',            label:'Gemini 1.5 Pro'},
  {id:'deepseek-chat',             label:'DeepSeek Chat'},
  {id:'gpt-4o-mini',               label:'GPT-4o Mini'},
  {id:'claude-3-5-haiku',          label:'Claude 3.5 Haiku'},
  {id:'llama-3.1-70b-instruct',    label:'Llama 3.1 70B'},
  {id:'gemini-1.5-flash',          label:'Gemini 1.5 Flash'},
  {id:'mistral-large',             label:'Mistral Large'},
  {id:'deepseek-reasoner',         label:'DeepSeek Reasoner'},
];

const callAI = async (userPrompt) => {
  for(const {id, label} of PUTER_MODELS){
    try{
      const res = await Promise.race([
        puter.ai.chat(userPrompt, {model: id}),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),45000))
      ]);
      let text = '';
      if(typeof res==='string') text=res;
      else if(typeof res?.message?.content==='string') text=res.message.content;
      else if(Array.isArray(res?.message?.content))
        text=res.message.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      else if(res?.text) text=res.text;
      if(text.trim()){ console.log(`✅ AI: ${label}`); return text; }
    }catch(e){ console.warn(`⚠️ ${label}: ${e.message}`); continue; }
  }
  throw new Error('All AI models unavailable. Please try again.');
};
const callGemini = callAI;

const parseJsonFromText = text => {
  if(!text) return null;
  // 1. Direct parse
  try{ return JSON.parse(text.trim()); }catch(e){}
  // 2. Strip markdown fences
  const stripped = text.replace(/```(?:json)?\s*/gi,'').replace(/```/g,'').trim();
  try{ return JSON.parse(stripped); }catch(e){}
  // 3. Brace-matching: find first { and walk to its matching }
  const start = text.indexOf('{');
  if(start === -1) return null;
  let depth=0;
  for(let i=start;i<text.length;i++){
    if(text[i]==='{') depth++;
    else if(text[i]==='}'){depth--;if(depth===0){try{return JSON.parse(text.slice(start,i+1));}catch(e){}break;}}
  }
  return null;
};

const fetchPixabay = async q => {
  const url = `https://pixabay.com/api/?key=${AI_CFG.pixabayKey}&q=${encodeURIComponent(q)}&image_type=photo&per_page=5&safesearch=true&orientation=horizontal&min_width=800`;
  const res = await fetch(url);
  const data = await res.json();
  return data.hits?.[0]?.largeImageURL || data.hits?.[0]?.webformatURL || null;
};

const pollinationsUrl = prompt => {
  const enc = encodeURIComponent(prompt+', news photography, professional, 4k');
  return `https://image.pollinations.ai/prompt/${enc}?width=1280&height=720&model=flux&enhance=true&nologo=true`;
};

// ── Helpers ────────────────────────────────────────────────────
const fmt = n=>(n||0).toLocaleString();
const timeAgo = d=>{
  if(!d)return'—';
  const s=Math.floor((Date.now()-(d instanceof Date?d:d.toDate?.()||new Date(d)))/1000);
  if(s<60)return'Just now';if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';
};
const fmtDate=d=>{
  if(!d)return'—';
  const dt=d instanceof Date?d:d.toDate?.()||new Date(d);
  return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
};
const posLabel=p=>({top_banner:'Top Banner',in_feed:'In Feed',sidebar_top:'Sidebar Top',sidebar_bottom:'Sidebar Bottom',footer:'Footer'}[p]||p);
const ctr=a=>a.impressions?(((a.clicks||0)/a.impressions)*100).toFixed(1)+'%':'0%';

// ── SVG Icons ─────────────────────────────────────────────────
const Ic = ({n,s=18,c='currentColor'}) => {
  const p = {
    grid:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    news:<><path d="M4 6h16M4 10h16M4 14h10"/><rect x="2" y="3" width="20" height="18" rx="2"/></>,
    ads:<><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></>,
    chat:<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>,
    users:<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    bell:<><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>,
    cog:<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    out:<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>,
    plus:<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
    edit:<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
    trash:<><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></>,
    search:<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>,
    eye:<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
    eyeoff:<><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>,
    send:<><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>,
    upload:<><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></>,
    x:<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    ban:<><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></>,
    ok:<><polyline points="20 6 9 17 4 12"/></>,
    warn:<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    img:<><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></>,
    star:<><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></>,
    refresh:<><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-8.07"/></>,
    tag:<><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></>,
    menu:<><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>,
    phone:<><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.6 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.82a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></>,
    mail:<><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></>,
    bot:<><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8" cy="16" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1" fill="currentColor" stroke="none"/></>,
    sparkle:<><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3z"/></>,
    download:<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>,
    play:<><polygon points="5 3 19 12 5 21 5 3"/></>,
    video:<><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></>,
  };
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p[n]}</svg>;
};

// ── Toast ──────────────────────────────────────────────────────
const ToastList = ({list}) => (
  <div style={{position:'fixed',bottom:80,right:16,zIndex:999,display:'flex',flexDirection:'column',gap:8}}>
    {list.map(t=>(
      <div key={t.id} className="fade-up" style={{padding:'11px 16px',borderRadius:12,fontSize:13,fontWeight:600,display:'flex',alignItems:'center',gap:10,boxShadow:'0 8px 32px rgba(0,0,0,.5)',background:t.type==='ok'?'#065f46':t.type==='error'?'#7f1d1d':'#1e3a5f',border:`1px solid ${t.type==='ok'?'#34d399':t.type==='error'?'#f87171':'#60a5fa'}`,color:'#fff',minWidth:200,maxWidth:280}}>
        <Ic n={t.type==='ok'?'ok':t.type==='error'?'x':'bell'} s={14}/>
        {t.msg}
      </div>
    ))}
  </div>
);

const useToast = () => {
  const [list,setList] = useState([]);
  const add = useCallback((msg,type='ok')=>{
    const id=Date.now();
    setList(p=>[...p,{id,msg,type}]);
    setTimeout(()=>setList(p=>p.filter(t=>t.id!==id)),3200);
  },[]);
  const Toast = ()=><ToastList list={list}/>;
  return {add,Toast};
};

// ── Confirm ────────────────────────────────────────────────────
const Confirm = ({msg,onYes,onNo}) => (
  <div className="modal-bg scale-in" onClick={onNo}>
    <div className="card" style={{width:'100%',maxWidth:360,padding:24,margin:16,borderRadius:16}} onClick={e=>e.stopPropagation()}>
      <div style={{display:'flex',gap:14,alignItems:'flex-start',marginBottom:20}}>
        <div style={{width:40,height:40,borderRadius:12,background:'rgba(248,113,113,.1)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
          <Ic n="warn" s={18} c="var(--danger)"/>
        </div>
        <div>
          <p style={{fontWeight:700,fontSize:15,marginBottom:4}}>Confirm Delete</p>
          <p style={{color:'var(--muted)',fontSize:13,lineHeight:1.5}}>{msg}</p>
        </div>
      </div>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <button className="btn btn-ghost" onClick={onNo}>Cancel</button>
        <button className="btn btn-red" style={{fontWeight:700,padding:'9px 18px'}} onClick={onYes}>Delete</button>
      </div>
    </div>
  </div>
);

// ── Media Upload (Image + Video) ──────────────────────────────
const ImgUpload = ({value, onChange, label='Image', accept='both'}) => {
  const [busy, setBusy]       = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileType, setFileType] = useState(''); // 'image' | 'video'
  const [err, setErr]         = useState('');
  const ref = useRef();

  // Detect if saved URL is a video
  const isVideoUrl = v => v && (
    v.includes('/video/upload') ||
    /\.(mp4|mov|avi|webm|mkv|m4v)(\?|$)/i.test(v)
  );

  const upload = file => {
    if (!file) return;
    setErr('');

    // Decide resource type from MIME
    const isVideo = file.type.startsWith('video/');
    setFileType(isVideo ? 'video' : 'image');

    // Max size guard — 100 MB for video, 10 MB for image
    const maxMB = isVideo ? 100 : 10;
    if (file.size > maxMB * 1024 * 1024) {
      setErr(`File too large. Max ${maxMB} MB allowed.`);
      return;
    }

    // Use /auto/upload — Cloudinary detects image vs video automatically
    const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/auto/upload`;

    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CLOUDINARY.uploadPreset);
    fd.append('folder', 'sql_users'); // ✅ folder specify karo

    // Use XHR for real upload progress
    const xhr = new XMLHttpRequest();
    setBusy(true);
    setProgress(0);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      setBusy(false);
      try {
        const json = JSON.parse(xhr.responseText);
        if (json.error) { setErr('Cloudinary: ' + json.error.message); return; }
        onChange(json.secure_url);
        setProgress(0);
      } catch(e) { setErr('Upload failed. Try again.'); }
    };

    xhr.onerror = () => { setBusy(false); setErr('Network error. Check connection.'); };

    xhr.open('POST', endpoint);
    xhr.send(fd);
  };

  const handleDrop = e => {
    e.preventDefault();
    e.currentTarget.style.borderColor = value ? 'var(--success)' : 'var(--border2)';
    upload(e.dataTransfer.files[0]);
  };

  const clear = e => { e.stopPropagation(); onChange(''); setFileType(''); setErr(''); };

  // Accept string for file input
  const acceptStr = accept === 'image' ? 'image/*' : accept === 'video' ? 'video/*' : 'image/*,video/*';

  const currentIsVideo = isVideoUrl(value) || fileType === 'video';

  return (
    <div>
      {label && (
        <p style={{fontSize:11,fontWeight:700,color:'var(--muted)',letterSpacing:'.06em',marginBottom:8}}>
          {label.toUpperCase()}
        </p>
      )}

      <div
        style={{
          border:`2px dashed ${err ? 'var(--danger)' : value ? 'var(--success)' : 'var(--border2)'}`,
          borderRadius:12, padding:16, cursor: busy ? 'default' : 'pointer',
          background:'var(--surface2)', transition:'border .2s, background .2s'
        }}
        onClick={() => { if(!busy) ref.current?.click(); }}
        onDragOver={e => { e.preventDefault(); if(!busy) e.currentTarget.style.borderColor='var(--accent)'; }}
        onDragLeave={e => { e.currentTarget.style.borderColor = err?'var(--danger)':value?'var(--success)':'var(--border2)'; }}
        onDrop={handleDrop}
      >
        <input ref={ref} type="file" accept={acceptStr} style={{display:'none'}}
          onChange={e => upload(e.target.files[0])}/>

        {/* ── Uploading State ── */}
        {busy ? (
          <div style={{padding:'8px 0'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
              <div className="spinner" style={{flexShrink:0}}/>
              <div style={{flex:1}}>
                <p style={{fontSize:13,fontWeight:600,color:'var(--text)'}}>
                  Uploading {fileType === 'video' ? 'video' : 'image'}…
                </p>
                <p style={{fontSize:11,color:'var(--muted)',marginTop:2}}>Please wait, don't close this page</p>
              </div>
              <span style={{fontSize:14,fontWeight:800,color:'var(--accent)',flexShrink:0}}>{progress}%</span>
            </div>
            {/* Progress bar */}
            <div style={{height:6,background:'var(--border)',borderRadius:999,overflow:'hidden'}}>
              <div style={{
                height:'100%', borderRadius:999,
                background: fileType==='video'
                  ? 'linear-gradient(90deg,var(--info),var(--accent))'
                  : 'linear-gradient(90deg,var(--accent),var(--success))',
                width: progress+'%',
                transition:'width .3s ease'
              }}/>
            </div>
            {fileType === 'video' && (
              <p style={{fontSize:10,color:'var(--dim)',marginTop:6,textAlign:'center'}}>
                🎬 Videos may take a moment — please be patient
              </p>
            )}
          </div>

        ) : value ? (
          /* ── Uploaded State ── */
          <div>
            {currentIsVideo ? (
              /* Video preview */
              <div style={{marginBottom:10,borderRadius:10,overflow:'hidden',background:'#000',position:'relative'}}>
                <video
                  src={value} controls preload="metadata"
                  style={{width:'100%',maxHeight:200,display:'block',borderRadius:10}}
                />
                <span style={{position:'absolute',top:8,left:8,background:'rgba(0,0,0,.7)',
                  color:'#fff',fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:6,
                  letterSpacing:'.04em'}}>
                  🎬 VIDEO
                </span>
              </div>
            ) : (
              /* Image preview */
              <div style={{marginBottom:10,borderRadius:10,overflow:'hidden'}}>
                <img src={value} style={{width:'100%',maxHeight:180,objectFit:'cover',display:'block',borderRadius:10}} alt="preview"/>
              </div>
            )}
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:12,color:'var(--success)',fontWeight:700,marginBottom:1}}>
                  ✅ {currentIsVideo ? 'Video' : 'Image'} uploaded successfully
                </p>
                <p style={{fontSize:10,color:'var(--dim)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {value.split('/').pop().split('?')[0]}
                </p>
              </div>
              <button
                onClick={clear}
                style={{flexShrink:0,background:'rgba(248,113,113,.12)',border:'1px solid rgba(248,113,113,.25)',
                  borderRadius:8,padding:'6px 10px',cursor:'pointer',color:'var(--danger)',
                  fontSize:11,fontWeight:700,display:'flex',alignItems:'center',gap:4}}
              >
                <Ic n="x" s={12}/> Remove
              </button>
            </div>
          </div>

        ) : (
          /* ── Empty State ── */
          <div style={{textAlign:'center',padding:'12px 0'}}>
            <div style={{display:'flex',justifyContent:'center',gap:12,marginBottom:10}}>
              <div style={{width:36,height:36,borderRadius:10,background:'var(--border)',
                display:'flex',alignItems:'center',justifyContent:'center'}}>
                <Ic n="img" s={18} c="var(--muted)"/>
              </div>
              {accept !== 'image' && (
                <div style={{width:36,height:36,borderRadius:10,background:'var(--border)',
                  display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                  </svg>
                </div>
              )}
            </div>
            <p style={{fontSize:13,fontWeight:600,color:'var(--text)',marginBottom:4}}>
              Tap to upload or drag &amp; drop
            </p>
            <p style={{fontSize:11,color:'var(--dim)'}}>
              {accept==='image' ? 'JPG, PNG, WebP — max 10 MB'
                : accept==='video' ? 'MP4, MOV, WebM — max 100 MB'
                : '🖼 Images (JPG/PNG) · 🎬 Videos (MP4/MOV)'}
            </p>
          </div>
        )}
      </div>

      {/* Error message */}
      {err && (
        <div style={{marginTop:8,padding:'8px 12px',background:'rgba(248,113,113,.1)',
          border:'1px solid rgba(248,113,113,.2)',borderRadius:8,
          fontSize:12,color:'var(--danger)',display:'flex',alignItems:'center',gap:6}}>
          <Ic n="warn" s={13}/> {err}
        </div>
      )}
    </div>
  );
};

// ── Field ──────────────────────────────────────────────────────
const Field = ({label,children,required})=>(
  <div>
    <p style={{fontSize:11,fontWeight:700,color:'var(--muted)',letterSpacing:'.06em',marginBottom:8}}>
      {label.toUpperCase()}{required&&<span style={{color:'var(--accent)',marginLeft:4}}>*</span>}
    </p>
    {children}
  </div>
);

// ── LOGIN PAGE ─────────────────────────────────────────────────
const Login = ({onLogin}) => {
  const [email,setEmail] = useState('');
  const [pass,setPass] = useState('');
  const [err,setErr] = useState('');
  const [busy,setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault(); setErr(''); setBusy(true);
    try{
      const c=await auth.signInWithEmailAndPassword(email,pass);
      onLogin(c.user);
    }catch(e){setErr('Incorrect email or password');}
    finally{setBusy(false);}
  };

  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px 16px',background:'radial-gradient(ellipse at 30% 40%, #0d2040 0%, var(--bg) 65%)'}}>
      <div style={{width:'100%',maxWidth:380}} className="fade-up">
        {/* Logo */}
        <div style={{textAlign:'center',marginBottom:36}}>
          <div style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:64,height:64,borderRadius:20,background:'var(--accent)',marginBottom:16,boxShadow:'0 8px 32px rgba(245,166,35,.35)'}}>
            <span style={{fontFamily:'Outfit',fontWeight:900,fontSize:18,color:'#050c18',letterSpacing:'-.02em'}}>KWT</span>
          </div>
          <h1 style={{fontFamily:'Outfit',fontSize:28,fontWeight:800,letterSpacing:'-.03em',marginBottom:4}}>KWT News</h1>
          <p style={{color:'var(--muted)',fontSize:14}}>Admin Dashboard</p>
        </div>

        {/* Card */}
        <div className="card" style={{padding:28,borderRadius:20}}>
          {err&&(
            <div style={{padding:'10px 14px',background:'rgba(248,113,113,.08)',border:'1px solid rgba(248,113,113,.2)',borderRadius:10,color:'var(--danger)',fontSize:13,marginBottom:18,display:'flex',alignItems:'center',gap:8}}>
              <Ic n="warn" s={14}/>{err}
            </div>
          )}
          <form onSubmit={submit}>
            <div style={{display:'flex',flexDirection:'column',gap:16}}>
              <Field label="Email" required>
                <input className="inp" type="email" placeholder="you@gmail.com" value={email} onChange={e=>setEmail(e.target.value)} required/>
              </Field>
              <Field label="Password" required>
                <input className="inp" type="password" placeholder="••••••••" value={pass} onChange={e=>setPass(e.target.value)} required/>
              </Field>
              <button className="btn btn-accent" type="submit" disabled={busy} style={{width:'100%',padding:'13px',fontSize:15,marginTop:4,borderRadius:12}}>
                {busy?<span className="spinner" style={{width:18,height:18}}></span>:'Sign In'}
              </button>
            </div>
          </form>
        </div>
        <p style={{textAlign:'center',fontSize:11,color:'var(--dim)',marginTop:20}}>KWT News © 2026</p>
      </div>
    </div>
  );
};

// ── DASHBOARD ─────────────────────────────────────────────────
const Dashboard = () => {
  const C = window.__newsCache;
  const [stats,setStats] = useState(C.stats||{news:0,users:0,comments:0,imp:0,clicks:0,breaking:0});
  const [catCounts,setCatCounts] = useState(C.catCounts||{});
  const [recent,setRecent] = useState(C.dashRecent||[]);
  const [loading,setLoading] = useState(!(C.dashRecent&&C.dashRecent.length));
  const [statsLoaded,setStatsLoaded] = useState(false);

  useEffect(()=>{
    const u=[]; const t0=Date.now();
    // Unordered fetch + client-side sort. We can't use server-side
    // orderBy('timestamp') because Firestore silently drops docs missing that
    // field — which hides legacy auto-posted items. Client-side sort via
    // __docTime() falls back through createdAt/publishedAt/date/updatedAt so
    // every doc stays visible.
    u.push(db.collection('news').limit(500).onSnapshot(s=>{
      const docs = s.docs.map(d=>({id:d.id,...d.data()}))
                         .sort((a,b)=> window.__docTime(b) - window.__docTime(a));
      const cc={}; let brk=0;
      docs.forEach(dt=>{ if(dt.category) cc[dt.category]=(cc[dt.category]||0)+1; if(dt.isBreaking) brk++; });
      const rec = docs.slice(0,6);
      window.__newsCache.catCounts = cc;
      window.__newsCache.dashRecent = rec;
      window.__newsCache.stats = {...(window.__newsCache.stats||{}), news:docs.length, breaking:brk};
      window.__newsCache.ts = Date.now();
      setCatCounts(cc);
      setRecent(rec);
      setStats(p=>({...p,news:docs.length,breaking:brk}));
      const elapsed = Date.now()-t0;
      setTimeout(()=>setLoading(false), Math.max(0, 150-elapsed));
    },err=>{
      console.warn('[dashboard news] snapshot error:', err?.code||err?.message||err);
      setTimeout(()=>setLoading(false), 150);
    }));

    // Users, Comments, Ads: one-time get() — persistence makes repeat reads cache-served
    db.collection('users').limit(5000).get().then(s=>setStats(p=>({...p,users:s.size}))).catch(()=>{});
    db.collection('comments').limit(5000).get().then(s=>setStats(p=>({...p,comments:s.size}))).catch(()=>{});
    db.collection('ads').limit(100).get().then(s=>{
      let i=0,c=0; s.docs.forEach(d=>{i+=d.data().impressions||0;c+=d.data().clicks||0;});
      setStats(p=>({...p,imp:i,clicks:c})); setStatsLoaded(true);
    }).catch(()=>setStatsLoaded(true));

    return ()=>u.forEach(f=>f());
  },[]);

  const cards=[
    {label:'News',val:fmt(stats.news),sub:`${stats.breaking} breaking`,icon:'news',clr:'#F5A623'},
    {label:'Users',val:fmt(stats.users),sub:'registered',icon:'users',clr:'#60a5fa'},
    {label:'Comments',val:fmt(stats.comments),sub:'total',icon:'chat',clr:'#a78bfa'},
    {label:'Ad Views',val:fmt(stats.imp),sub:`${fmt(stats.clicks)} clicks`,icon:'eye',clr:'#34d399'},
  ];

  return (
    <div className="fade-up">
      <div style={{marginBottom:24}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
          <div className="pulse" style={{width:7,height:7,borderRadius:'50%',background:'var(--success)',flexShrink:0}}></div>
          <span style={{fontSize:11,fontWeight:700,color:'var(--success)',letterSpacing:'.06em'}}>LIVE</span>
        </div>
        <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>Dashboard</h1>
      </div>

      {/* Stats grid */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:20}}>
        {cards.map((c,i)=>(
          <div key={i} className="stat" style={{borderLeft:`3px solid ${c.clr}`}}>
            <div style={{fontSize:26,fontWeight:800,color:c.clr,letterSpacing:'-.03em',marginBottom:2}}>{c.val}</div>
            <div style={{fontSize:13,fontWeight:600,marginBottom:1}}>{c.label}</div>
            <div style={{fontSize:11,color:'var(--dim)'}}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Category breakdown */}
      <div className="card" style={{marginBottom:20}}>
        <div style={{padding:'14px 16px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:8}}>
          <Ic n="tag" s={15} c="var(--accent)"/>
          <span style={{fontWeight:700,fontSize:14}}>Posts by Category</span>
        </div>
        <div style={{padding:'14px 16px',display:'flex',gap:10,flexWrap:'wrap'}}>
          {CATEGORIES.map(cat=>(
            <div key={cat.value} style={{flex:'1 1 90px',padding:'12px 14px',borderRadius:12,background:'var(--surface2)',border:`1px solid var(--border)`,textAlign:'center',minWidth:80}}>
              <p style={{fontSize:20,marginBottom:2}}>{cat.label.split(' ')[0]}</p>
              <p style={{fontSize:20,fontWeight:800,color:cat.color,letterSpacing:'-.02em'}}>{catCounts[cat.value]||0}</p>
              <p style={{fontSize:10,color:'var(--dim)',lineHeight:1.3,marginTop:2}}>{cat.label.replace(/^\S+\s/,'')}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Recent news */}
      <div className="card">
        <div style={{padding:'14px 16px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:8}}>
          <Ic n="news" s={15} c="var(--accent)"/>
          <span style={{fontWeight:700,fontSize:14}}>Recent News</span>
        </div>
        {loading?[1,2,3,4,5,6].map(i=>(
          <div key={i} style={{padding:'14px 16px',borderBottom:'1px solid var(--border)',display:'flex',gap:12}}>
            <div className="shimmer" style={{width:44,height:44,borderRadius:10,flexShrink:0}}></div>
            <div style={{flex:1}}>
              <div className="shimmer" style={{height:13,borderRadius:6,width:'70%',marginBottom:8}}></div>
              <div className="shimmer" style={{height:10,borderRadius:6,width:'40%'}}></div>
            </div>
          </div>
        )):recent.map(n=>{
          const catInfo = CATEGORIES.find(c=>c.value===n.category);
          return (
            <div key={n.id} className="row" style={{padding:'13px 16px',borderBottom:'1px solid rgba(26,45,74,.5)',display:'flex',alignItems:'center',gap:12}}>
              <div style={{width:44,height:44,borderRadius:10,background:'var(--surface2)',overflow:'hidden',flexShrink:0}}>
                {n.imageUrl&&<img src={n.imageUrl} style={{width:'100%',height:'100%',objectFit:'cover'}} loading="lazy"/>}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:3}}>{n.title||'Untitled'}</p>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:11,color:'var(--dim)'}}>{fmtDate(n.timestamp)}</span>
                  {n.category&&<span style={{fontSize:10,color:catInfo?.color||'var(--muted)',background:'var(--surface2)',padding:'1px 7px',borderRadius:999,border:`1px solid ${catInfo?.color||'var(--border)'}33`}}>{catInfo?.label||n.category}</span>}
                </div>
              </div>
              {n.isBreaking&&<span className="badge" style={{background:'rgba(248,113,113,.12)',color:'var(--danger)',border:'1px solid rgba(248,113,113,.2)',fontSize:9}}>BREAKING</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── NEWS FORM (Full-Screen Page) ───────────────────────────────
// All categories — used in form dropdown + filter chips
const CATEGORIES = [
  {value:'kuwait',    label:'🇰🇼 Kuwait',       color:'#34d399'},
  {value:'world',     label:'🌍 World',          color:'#60a5fa'},
  {value:'kuwait-jobs',    label:'💼 Kuwait Jobs',   color:'#a78bfa'},
  {value:'kuwait-offers',  label:'🛍️ Kuwait Offers', color:'#f472b6'},
  {value:'funny-news-meme',label:'😂 Funny & Memes', color:'#fbbf24'},
];

const BLANK = {title:'',summary:'',content:'',imageUrl:'',thumbnail:'',category:'kuwait',source:'KWT News',sourceLogo:'',readTime:'3 min read',isBreaking:false,mediaType:'image',published:true,hidden:false,status:'published'};

// ── Logo Picker ────────────────────────────────────────────────
const LogoPicker = ({value, onSelect}) => {
  const [open,setOpen] = useState(false);
  const [tab,setTab] = useState('select');
  const [logos,setLogos] = useState([]);
  const [loading,setLoading] = useState(false);
  const [search,setSearch] = useState('');
  const [newName,setNewName] = useState('');
  const [newUrl,setNewUrl] = useState('');
  const [saving,setSaving] = useState(false);

  const loadLogos = async()=>{
    setLoading(true);
    try{
      const snap = await db.collection('logos').orderBy('name').get();
      setLogos(snap.docs.map(d=>({id:d.id,...d.data()})));
    }catch(e){}
    setLoading(false);
  };

  useEffect(()=>{ if(open) loadLogos(); },[open]);

  const addLogo = async()=>{
    if(!newUrl||!newName.trim()) return;
    setSaving(true);
    try{
      await db.collection('logos').add({url:newUrl,name:newName.trim(),createdAt:firebase.firestore.FieldValue.serverTimestamp()});
      setNewName(''); setNewUrl(''); setTab('select'); loadLogos();
    }catch(e){
      console.error('[addLogo]',e);
      alert('Failed to add logo: '+(e.message||e));
    }finally{
      setSaving(false);
    }
  };

  const deleteLogo = async(id,e)=>{
    e.stopPropagation();
    try{
      await db.collection('logos').doc(id).delete();
      setLogos(p=>p.filter(l=>l.id!==id));
    }catch(err){
      console.error('[deleteLogo]',err);
      alert('Failed to delete logo: '+(err.message||err));
    }
  };

  const filtered = logos.filter(l=>!search||l.name.toLowerCase().includes(search.toLowerCase()));
  const tbS = active=>({padding:'8px 16px',borderRadius:8,border:'none',cursor:'pointer',fontSize:13,fontWeight:700,fontFamily:'Outfit',background:active?'var(--accent)':'var(--surface2)',color:active?'#050c18':'var(--muted)'});

  return (
    <>
      {/* Trigger button */}
      <div onClick={()=>setOpen(true)} style={{cursor:'pointer',border:`2px dashed ${value?'var(--success)':'var(--border2)'}`,borderRadius:12,padding:14,background:'var(--surface2)',transition:'border .2s'}}>
        {value ? (
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <img src={value} style={{width:40,height:40,objectFit:'contain',borderRadius:8,background:'#fff',padding:4,flexShrink:0}} alt="logo"/>
            <div style={{flex:1}}>
              <p style={{fontSize:12,fontWeight:700,color:'var(--success)'}}>✅ Logo selected</p>
              <p style={{fontSize:11,color:'var(--muted)'}}>Tap to change</p>
            </div>
            <button onClick={e=>{e.stopPropagation();onSelect('');}} style={{background:'rgba(248,113,113,.15)',border:'1px solid rgba(248,113,113,.3)',borderRadius:6,color:'var(--danger)',cursor:'pointer',padding:'4px 8px',fontSize:11,fontWeight:700}}>Remove</button>
          </div>
        ):(
          <div style={{textAlign:'center',padding:'8px 0'}}>
            <Ic n="img" s={22} c="var(--dim)"/>
            <p style={{fontSize:13,color:'var(--muted)',marginTop:6,fontWeight:600}}>Tap to select source logo</p>
            <p style={{fontSize:11,color:'var(--dim)',marginTop:2}}>From your logo collection</p>
          </div>
        )}
      </div>

      {/* Modal */}
      {open&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',backdropFilter:'blur(6px)',WebkitBackdropFilter:'blur(6px)',zIndex:200,display:'flex',alignItems:'flex-end',justifyContent:'center'}} onClick={()=>setOpen(false)}>
          <div style={{width:'100%',maxWidth:580,height:'88vh',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'20px 20px 0 0',display:'flex',flexDirection:'column',overflow:'hidden'}} onClick={e=>e.stopPropagation()}>
            {/* Header */}
            <div style={{padding:'16px 20px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
              <p style={{fontWeight:800,fontSize:16}}>🏷 Source Logo</p>
              <button onClick={()=>setOpen(false)} style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--muted)',cursor:'pointer',width:32,height:32,fontSize:18,display:'flex',alignItems:'center',justifyContent:'center'}}>×</button>
            </div>
            {/* Tabs */}
            <div style={{padding:'12px 20px',borderBottom:'1px solid var(--border)',display:'flex',gap:8,flexShrink:0}}>
              <button style={tbS(tab==='select')} onClick={()=>setTab('select')}>🖼 Select Logo</button>
              <button style={tbS(tab==='add')} onClick={()=>setTab('add')}>➕ Add Logo</button>
            </div>
            {/* Body */}
            <div style={{padding:20,overflowY:'auto',flex:1}}>
              {tab==='select'&&(
                <>
                  <div style={{position:'relative',marginBottom:14}}>
                    <input className="inp" value={search} onChange={e=>setSearch(e.target.value)}
                      placeholder="Search by name..." style={{paddingLeft:36}}/>
                    <div style={{position:'absolute',top:'50%',left:12,transform:'translateY(-50%)',pointerEvents:'none'}}><Ic n="search" s={15} c="var(--dim)"/></div>
                  </div>
                  {loading?(
                    <div style={{textAlign:'center',padding:40}}><div className="spinner"></div></div>
                  ):filtered.length===0?(
                    <div style={{textAlign:'center',padding:40}}>
                      <p style={{fontSize:32,marginBottom:10}}>🖼</p>
                      <p style={{fontWeight:700,marginBottom:4}}>No logos yet</p>
                      <p style={{fontSize:12,color:'var(--muted)'}}>Go to "Add Logo" tab to upload your first logo</p>
                    </div>
                  ):(
                    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(110px,1fr))',gap:10}}>
                      {filtered.map(logo=>(
                        <div key={logo.id} onClick={()=>{onSelect(logo.url);setOpen(false);}}
                          style={{cursor:'pointer',border:`2px solid ${value===logo.url?'var(--accent)':'var(--border)'}`,borderRadius:10,padding:'10px 8px',background:value===logo.url?'rgba(245,166,35,.07)':'var(--surface2)',textAlign:'center',position:'relative',transition:'border .15s'}}>
                          {value===logo.url&&<div style={{position:'absolute',top:4,right:4,width:16,height:16,borderRadius:'50%',background:'var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,color:'#050c18',fontWeight:800}}>✓</div>}
                          <img src={logo.url} style={{width:44,height:44,objectFit:'contain',borderRadius:6,background:'#fff',padding:4,display:'block',margin:'0 auto 6px'}} alt={logo.name}/>
                          <p style={{fontSize:10,fontWeight:700,color:'var(--text)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:4}}>{logo.name}</p>
                          <button onClick={e=>deleteLogo(logo.id,e)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--danger)',fontSize:11,padding:'2px 4px'}}>🗑️</button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {tab==='add'&&(
                <div style={{display:'flex',flexDirection:'column',gap:14}}>
                  <ImgUpload value={newUrl} onChange={setNewUrl} label="LOGO IMAGE" accept="image"/>
                  <div>
                    <label style={{fontSize:11,fontWeight:700,color:'var(--muted)',letterSpacing:'.06em',display:'block',marginBottom:6}}>LOGO NAME</label>
                    <input className="inp" value={newName} onChange={e=>setNewName(e.target.value)}
                      placeholder="e.g. BBC News, Al Jazeera, KWT News..."
                      onKeyDown={e=>e.key==='Enter'&&addLogo()}/>
                  </div>
                  {newUrl&&(
                    <div style={{padding:'10px 14px',borderRadius:10,background:'var(--surface2)',border:'1px solid var(--border)',display:'flex',alignItems:'center',gap:12}}>
                      <img src={newUrl} style={{width:36,height:36,objectFit:'contain',background:'#fff',borderRadius:6,padding:3}} alt="preview"/>
                      <div>
                        <p style={{fontSize:11,color:'var(--muted)'}}>Preview</p>
                        <p style={{fontSize:13,fontWeight:700}}>{newName||'(no name yet)'}</p>
                      </div>
                    </div>
                  )}
                  <button className="btn btn-accent" onClick={addLogo} disabled={!newUrl||!newName.trim()||saving} style={{width:'100%',padding:13,fontSize:14}}>
                    {saving?'Saving...':'💾 Add to Collection'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const NewsForm = ({editing, initialForm, onSave, onCancel, toast}) => {
  const [form, setForm] = useState(initialForm || BLANK);
  const [saving, setSaving] = useState(false);
  const F = p => setForm(prev=>({...prev,...p}));

  // Scroll to top when form opens
  useEffect(()=>{ window.scrollTo({top:0,behavior:'smooth'}); },[]);

  const save = async () => {
    if(!form.title.trim()){ toast.add('Title is required','error'); return; }
    if(!form.summary.trim()){ toast.add('Summary is required','error'); return; }
    setSaving(true);
    try{
      if(editing){
        const d={...form};
        delete d.timestamp;
        await db.collection('news').doc(editing).update(d);
        toast.add('Article updated successfully!');
      } else {
        const d={...form, published:true, hidden:false, status:'published', timestamp:firebase.firestore.FieldValue.serverTimestamp(), views:0, likes:0, commentCount:0};
        await db.collection('news').add(d);
        toast.add('Article published successfully!');
      }
      onSave();
    }catch(e){ toast.add(e.message,'error'); }
    finally{ setSaving(false); }
  };

  return (
    <div className="fade-up" style={{maxWidth:860,margin:'0 auto',overflowX:'hidden'}}>

      {/* ── Top Bar ── */}
      <div style={{marginBottom:24}}>
        {/* Row 1: back + save */}
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
          <button onClick={onCancel} style={{display:'flex',alignItems:'center',gap:6,background:'var(--surface2)',border:'1.5px solid var(--border)',borderRadius:10,color:'var(--muted)',cursor:'pointer',padding:'9px 14px',fontFamily:'Outfit',fontWeight:700,fontSize:13,flexShrink:0}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>
          <div style={{flex:1}}>
            <h1 style={{fontFamily:'Outfit',fontSize:20,fontWeight:800,letterSpacing:'-.02em',lineHeight:1.1}}>
              {editing ? '✏️ Edit Article' : '📝 New Article'}
            </h1>
            <p style={{fontSize:11,color:'var(--muted)',marginTop:2}}>{editing ? 'Update fields then save' : 'Fill all fields and publish'}</p>
          </div>
          <button className="btn btn-accent" onClick={save} disabled={saving} style={{flexShrink:0,padding:'10px 18px',fontSize:13}}>
            {saving
              ? <><span className="spinner" style={{width:14,height:14}}/> Saving…</>
              : <><Ic n={editing?'ok':'send'} s={14}/>{editing?'Update':'Publish'}</>
            }
          </button>
        </div>
      </div>

      {/* ── Two-Column Layout on desktop ── */}
      <div style={{display:'grid',gridTemplateColumns:'1fr',gap:16}} className="form-grid">

        {/* LEFT / MAIN COLUMN */}
        <div style={{display:'flex',flexDirection:'column',gap:16}}>

          {/* Headline */}
          <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:20}}>
            <p style={{fontSize:11,fontWeight:800,color:'var(--accent)',letterSpacing:'.08em',marginBottom:14}}>📰 ARTICLE INFO</p>
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              <Field label="Headline / Title" required>
                <input className="inp" value={form.title}
                  onChange={e=>F({title:e.target.value})}
                  placeholder="Enter a compelling news headline…"
                  style={{fontSize:15,fontWeight:600}}/>
                <p style={{fontSize:11,color:'var(--dim)',marginTop:5}}>{form.title.length} / 150 characters</p>
              </Field>
              <Field label="Summary" required>
                <textarea className="inp" value={form.summary}
                  onChange={e=>F({summary:e.target.value})}
                  placeholder="Write a short 2–3 line summary that appears on the news card…"
                  style={{minHeight:100,lineHeight:1.6}}/>
                <p style={{fontSize:11,color:'var(--dim)',marginTop:5}}>{form.summary.length} characters</p>
              </Field>
              <Field label="Full Content (Article Body)">
                <textarea className="inp" value={form.content}
                  onChange={e=>F({content:e.target.value})}
                  placeholder="Write the complete article body here. Supports plain text. Use double line-breaks for paragraphs…"
                  style={{minHeight:200,lineHeight:1.7}}/>
              </Field>
            </div>
          </div>

          {/* Meta Info */}
          <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:20}}>
            <p style={{fontSize:11,fontWeight:800,color:'var(--info)',letterSpacing:'.08em',marginBottom:14}}>⚙️ ARTICLE SETTINGS</p>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
              <Field label="Category" required>
                <select className="inp" value={form.category} onChange={e=>F({category:e.target.value})}>
                  {CATEGORIES.map(c=>(
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Media Type">
                <select className="inp" value={form.mediaType} onChange={e=>F({mediaType:e.target.value})}>
                  <option value="image">🖼 Image</option>
                  <option value="video">🎬 Video</option>
                </select>
              </Field>
              <Field label="Source Name">
                <input className="inp" value={form.source}
                  onChange={e=>F({source:e.target.value})}
                  placeholder="e.g. KWT News, Reuters…"/>
              </Field>
              <Field label="Read Time">
                <input className="inp" value={form.readTime}
                  onChange={e=>F({readTime:e.target.value})}
                  placeholder="e.g. 3 min read"/>
              </Field>
            </div>
          </div>

        </div>

        {/* RIGHT / SIDEBAR COLUMN */}
        <div style={{display:'flex',flexDirection:'column',gap:16}}>

          {/* Breaking Toggle */}
          <div style={{background: form.isBreaking ? 'rgba(248,113,113,.07)' : 'var(--surface)', border:`1.5px solid ${form.isBreaking?'rgba(248,113,113,.4)':'var(--border)'}`,borderRadius:16,padding:20,transition:'all .2s'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
              <div>
                <p style={{fontSize:14,fontWeight:800,color: form.isBreaking ? 'var(--danger)' : 'var(--text)'}}>
                  🚨 Breaking News
                </p>
                <p style={{fontSize:12,color:'var(--muted)',marginTop:4,lineHeight:1.5}}>
                  Pins this article to the top of the feed with a BREAKING badge
                </p>
              </div>
              <button
                className="tog"
                style={{background:form.isBreaking?'var(--danger)':'var(--border2)',flexShrink:0}}
                onClick={()=>F({isBreaking:!form.isBreaking})}>
                <div className="tog-thumb" style={{left:form.isBreaking?'22px':'4px'}}></div>
              </button>
            </div>
            {form.isBreaking && (
              <div style={{marginTop:12,padding:'8px 12px',background:'rgba(248,113,113,.1)',borderRadius:8,fontSize:12,color:'var(--danger)',fontWeight:600}}>
                ⚡ This article will appear as BREAKING in the news feed
              </div>
            )}
          </div>

          {/* Article Image / Video Upload */}
          <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:20}}>
            <p style={{fontSize:11,fontWeight:800,color:'var(--muted)',letterSpacing:'.08em',marginBottom:14}}>
              {form.mediaType === 'video' ? '🎬 ARTICLE VIDEO' : '🖼 ARTICLE IMAGE'}
            </p>
            {form.mediaType === 'video' ? (
              <ImgUpload
                value={form.videoUrl}
                onChange={v=>F({videoUrl:v})}
                label=""
                accept="video"
              />
            ) : (
              <ImgUpload
                value={form.imageUrl}
                onChange={v=>F({imageUrl:v})}
                label=""
                accept="image"
              />
            )}
            {/* Thumbnail for video */}
            {form.mediaType === 'video' && (
              <div style={{marginTop:14}}>
                <p style={{fontSize:11,fontWeight:700,color:'var(--muted)',letterSpacing:'.06em',marginBottom:8}}>
                  🖼 VIDEO THUMBNAIL (Optional)
                </p>
                <ImgUpload
                  value={form.thumbnail}
                  onChange={v=>F({thumbnail:v})}
                  label=""
                  accept="image"
                />
              </div>
            )}
          </div>

          {/* Source Logo */}
          <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:20}}>
            <p style={{fontSize:11,fontWeight:800,color:'var(--muted)',letterSpacing:'.08em',marginBottom:14}}>🏷 SOURCE LOGO</p>
            <LogoPicker value={form.sourceLogo} onSelect={v=>F({sourceLogo:v})}/>
          </div>

          {/* Live Preview Card */}
          {(form.title || form.imageUrl) && (
            <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:20}}>
              <p style={{fontSize:11,fontWeight:800,color:'var(--muted)',letterSpacing:'.08em',marginBottom:14}}>👁 LIVE PREVIEW</p>
              <div style={{background:'var(--surface2)',borderRadius:12,overflow:'hidden',border:'1px solid var(--border)'}}>
                {(form.videoUrl||form.imageUrl) ? (
                  form.mediaType === 'video' ? (
                    <video src={form.videoUrl||form.imageUrl} poster={form.thumbnail} controls
                      style={{width:'100%',height:140,display:'block',background:'#000'}}/>
                  ) : (
                    <img src={form.imageUrl} style={{width:'100%',height:140,objectFit:'cover',display:'block'}} alt=""/>
                  )
                ) : (
                  <div style={{height:80,background:'var(--border)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <Ic n={form.mediaType==='video'?'img':'img'} s={24} c="var(--dim)"/>
                  </div>
                )}
                <div style={{padding:12}}>
                  {form.isBreaking && <span style={{fontSize:9,fontWeight:800,color:'var(--danger)',background:'rgba(248,113,113,.12)',border:'1px solid rgba(248,113,113,.2)',borderRadius:4,padding:'2px 6px',display:'inline-block',marginBottom:6,letterSpacing:'.05em'}}>⚡ BREAKING</span>}
                  <p style={{fontSize:13,fontWeight:700,lineHeight:1.4,marginBottom:4,color:'var(--text)'}}>{form.title || 'Your headline here…'}</p>
                  {form.summary && <p style={{fontSize:11,color:'var(--muted)',lineHeight:1.5,WebkitLineClamp:2,display:'-webkit-box',WebkitBoxOrient:'vertical',overflow:'hidden'}}>{form.summary}</p>}
                  <div style={{display:'flex',alignItems:'center',gap:8,marginTop:8}}>
                    {form.sourceLogo && <img src={form.sourceLogo} style={{width:16,height:16,borderRadius:3,objectFit:'cover'}}/>}
                    <span style={{fontSize:10,color:'var(--dim)'}}>{form.source || 'KWT News'}</span>
                    <span style={{fontSize:10,color:'var(--dim)'}}>· {form.readTime || '3 min read'}</span>
                    <span style={{fontSize:9,color:'var(--dim)',marginLeft:'auto',padding:'2px 6px',background:'var(--border)',borderRadius:4}}>{form.category}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Bottom Save Button (mobile sticky) */}
          <button className="btn btn-accent" onClick={save} disabled={saving}
            style={{width:'100%',padding:'15px',fontSize:15,borderRadius:14,fontWeight:700}}>
            {saving
              ? <><span className="spinner" style={{width:18,height:18}}/> Saving…</>
              : <><Ic n={editing?'ok':'send'} s={16}/>{editing ? 'Update Article' : 'Publish Article'}</>
            }
          </button>

        </div>
      </div>

      {/* Responsive 2-col CSS */}
      <style>{`
        @media(min-width:1024px){
          .form-grid{ grid-template-columns: 1fr 360px !important; }
        }
      `}</style>
    </div>
  );
};

// ── NEWS MANAGER ───────────────────────────────────────────────
const NewsManager = ({toast, initCat='all'}) => {
  const C = window.__newsCache;
  const [news,setNews] = useState(C.list||[]);
  const [loading,setLoading] = useState(!(C.list&&C.list.length));
  const [view,setView] = useState('list'); // 'list' | 'form'
  const [editing,setEditing] = useState(null);
  const [formInit,setFormInit] = useState(BLANK);
  const [confirm,setConfirm] = useState(null);
  const [searchInput,setSearchInput] = useState(''); // raw input (debounced)
  const [search,setSearch] = useState('');           // debounced value used in filter
  const [cat,setCat] = useState(initCat);
  const [statusFilter,setStatusFilter] = useState('all'); // 'published' | 'draft' | 'all'
  const [videoPlayId,setVideoPlayId] = useState(null); // which article video is playing
  const [displayCount,setDisplayCount] = useState(500); // virtual cap for large lists
  const searchDebounceRef = useRef(null);

  useEffect(()=>{
    const t0 = Date.now();
    const finishLoading = ()=>{ setTimeout(()=>setLoading(false), Math.max(0, 150-(Date.now()-t0))); };
    // Unordered fetch + client-side sort. orderBy('timestamp') drops docs
    // missing that field; many legacy/auto-posted docs only have createdAt,
    // so they'd vanish from the list. __docTime() handles every variant.
    const u = db.collection('news').limit(500).onSnapshot(
      s=>{
        const docs = s.docs.map(d=>({id:d.id,...d.data()}))
                           .sort((a,b)=> window.__docTime(b) - window.__docTime(a));
        window.__newsCache.list = docs; window.__newsCache.ts = Date.now();
        setNews(docs); finishLoading();
      },
      err=>{ console.warn('[news] snapshot error:', err?.code||err); finishLoading(); }
    );
    return ()=>u();
  },[]);

  const openAdd=()=>{ setEditing(null); setFormInit(BLANK); setView('form'); };
  const openEdit=n=>{ setEditing(n.id); setFormInit({...BLANK,...n}); setView('form'); };
  const closeForm=()=>{ setView('list'); setEditing(null); setFormInit(BLANK); };

  const del=async id=>{
    try{
      const article = news.find(n=>n.id===id) || {};
      // Delete Cloudinary assets first (best-effort, non-blocking if creds missing)
      deleteCloudinaryAssetsFor(article).catch(()=>{});
      await db.collection('news').doc(id).delete();
      // Remove from local cache so the UI doesn't flash the deleted item back
      if(window.__newsCache){
        window.__newsCache.list = (window.__newsCache.list||[]).filter(n=>n.id!==id);
        window.__newsCache.dashRecent = (window.__newsCache.dashRecent||[]).filter(n=>n.id!==id);
      }
      toast.add('Article deleted (DB + Cloudinary)');
    }
    catch(e){ toast.add(e.message,'error'); }
    setConfirm(null);
  };

  const toggleBreaking=async(id,val)=>{
    try{
      await db.collection('news').doc(id).update({isBreaking:!val});
      toast.add(!val?'Marked as Breaking!':'Breaking removed');
    }catch(e){
      console.error('[toggleBreaking]',e);
      toast.add(`Failed: ${e.message||e}`,'error');
    }
  };

  const toggleHidden=async(id,val)=>{
    try{
      await db.collection('news').doc(id).update({hidden:!val});
      toast.add(!val?'Article hidden':'Article visible');
    }catch(e){
      console.error('[toggleHidden]',e);
      toast.add(`Failed: ${e.message||e}`,'error');
    }
  };

  // Draft detection: a doc is a draft when it's explicitly flagged as such.
  // `hidden:true` = "published but hidden from public feed" (a separate state).
  // Legacy docs missing all three fields are treated as published (autoposted
  // pipeline always writes status='published').
  const isDraftDoc = (n)=> (
    n.status==='draft' ||
    (n.published===false && n.status!=='published') ||
    (!n.status && n.published===undefined && n.hidden===true && n.aiGenerated===true)
  );

  const filtered=useMemo(()=>news.filter(n=>{
    const q=search.toLowerCase();
    const matchQ=!q||n.title?.toLowerCase().includes(q);
    const matchC=cat==='all'||n.category===cat;
    const draft = isDraftDoc(n);
    const matchS = statusFilter==='all' || (statusFilter==='published'&&!draft) || (statusFilter==='draft'&&draft);
    return matchQ&&matchC&&matchS;
  }),[news,search,cat,statusFilter]);

  // ── Full-screen form view ──
  if(view==='form') return (
    <NewsForm
      editing={editing}
      initialForm={formInit}
      onSave={closeForm}
      onCancel={closeForm}
      toast={toast}
    />
  );

  // ── List view ──
  return (
    <div className="fade-up">
      {confirm&&<Confirm msg={`Delete "${confirm.title}"?`} onYes={()=>del(confirm.id)} onNo={()=>setConfirm(null)}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20,gap:12,flexWrap:'wrap'}}>
        <div>
          <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>News</h1>
          <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>
            {news.filter(n=>!isDraftDoc(n)).length} published · {news.filter(n=>isDraftDoc(n)).length} drafts · {news.filter(n=>n.hidden===true).length} hidden
            <span style={{fontSize:10,color:'var(--dim)',marginLeft:8}}>raw: {news.length} · proj: {firebase.app().options.projectId}</span>
          </p>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <button className="btn" style={{padding:'11px 14px',gap:6,fontSize:12,background:'rgba(96,165,250,.1)',border:'1px solid rgba(96,165,250,.35)',color:'#60a5fa',fontWeight:700}}
            title="Wipe local Firestore cache and re-fetch from server. Use this if the dashboard shows fewer articles than the website."
            onClick={()=>{ if(confirm('This will clear the local cache and reload the admin from the server. Continue?')) window.__forceResync(); }}>
            🔄 Force Resync
          </button>
          <button className="btn btn-accent" style={{padding:'11px 20px',gap:8,fontSize:14}} onClick={openAdd}>
            <Ic n="plus" s={16}/> Add Article
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:16}}>
        <div style={{position:'relative'}}>
          <div style={{position:'absolute',left:13,top:'50%',transform:'translateY(-50%)',pointerEvents:'none'}}>
            <Ic n="search" s={15} c="var(--dim)"/>
          </div>
          <input className="inp" placeholder="Search articles by title…" value={searchInput}
            onChange={e=>{
              setSearchInput(e.target.value);
              clearTimeout(searchDebounceRef.current);
              searchDebounceRef.current=setTimeout(()=>{ setSearch(e.target.value); setDisplayCount(40); },220);
            }} style={{paddingLeft:40}}/>
        </div>

        {/* Status filter */}
        <div style={{display:'flex',gap:6,marginBottom:2}}>
          {[{v:'published',label:'✅ Published'},{v:'draft',label:'📝 Drafts'},{v:'all',label:'📋 All'}].map(({v,label})=>(
            <button key={v} onClick={()=>setStatusFilter(v)}
              style={{padding:'6px 14px',borderRadius:8,fontSize:12,fontWeight:700,border:'1.5px solid',cursor:'pointer',transition:'all .15s',whiteSpace:'nowrap',
                background:statusFilter===v?'var(--accent)':'transparent',
                color:statusFilter===v?'#050c18':'var(--muted)',
                borderColor:statusFilter===v?'var(--accent)':'var(--border)'}}>
              {label}
            </button>
          ))}
        </div>

        {/* Category filter */}
        <div style={{display:'flex',gap:8,overflowX:'auto',paddingBottom:2}}>
          {[{v:'all',label:'📋 All'},...CATEGORIES.map(c=>({v:c.value,label:c.label}))].map(({v,label})=>(
            <button key={v} onClick={()=>setCat(v)}
              style={{padding:'7px 14px',borderRadius:8,fontSize:12,fontWeight:600,border:'1px solid',cursor:'pointer',transition:'all .15s',whiteSpace:'nowrap',
                background:cat===v?'var(--accent)':'transparent',
                color:cat===v?'#050c18':'var(--muted)',
                borderColor:cat===v?'var(--accent)':'var(--border)'}}>
              {label}
            </button>
          ))}
        </div>

      </div>

      {/* Articles List */}
      <div className="card">
        {loading ? [1,2,3,4,5,6,7,8].map(i=>(
          <div key={i} style={{padding:'14px 16px',borderBottom:'1px solid var(--border)',display:'flex',gap:12,alignItems:'center'}}>
            <div className="shimmer" style={{width:56,height:56,borderRadius:12,flexShrink:0}}></div>
            <div style={{flex:1}}>
              <div className="shimmer" style={{height:13,borderRadius:6,width:'65%',marginBottom:8}}></div>
              <div className="shimmer" style={{height:10,borderRadius:6,width:'35%'}}></div>
            </div>
            <div style={{display:'flex',gap:6}}>
              <div className="shimmer" style={{width:32,height:32,borderRadius:8}}></div>
              <div className="shimmer" style={{width:32,height:32,borderRadius:8}}></div>
            </div>
          </div>
        )) : filtered.length===0 ? (
          <div style={{padding:56,textAlign:'center',color:'var(--dim)'}}>
            <Ic n="news" s={32} c="var(--border2)"/>
            <p style={{marginTop:14,fontSize:14,fontWeight:600}}>No articles found</p>
            <p style={{fontSize:12,marginTop:4}}>Try changing the filter or add a new article</p>
            <button className="btn btn-accent" style={{marginTop:16,padding:'10px 20px'}} onClick={openAdd}>
              <Ic n="plus" s={14}/> Add Article
            </button>
          </div>
        ) : filtered.slice(0, displayCount).map(n=>(
          <React.Fragment key={n.id}>
          <div className="row"
            style={{padding:'13px 16px',borderBottom:'1px solid rgba(26,45,74,.5)',display:'flex',alignItems:'center',gap:12,
              background:isDraftDoc(n)?'rgba(251,191,36,.03)':(n.hidden===true?'rgba(148,163,184,.04)':'transparent')}}>

            {/* Thumbnail */}
            <div style={{width:56,height:56,borderRadius:12,background:'var(--surface2)',overflow:'hidden',flexShrink:0,border:'1px solid var(--border)',position:'relative'}}>
              {n.imageUrl
                ? <img src={n.imageUrl} style={{width:'100%',height:'100%',objectFit:'cover'}} loading="lazy"/>
                : <div style={{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center'}}><Ic n={n.videoUrl?'video':'img'} s={20} c="var(--dim)"/></div>
              }
              {isDraftDoc(n)&&<div style={{position:'absolute',bottom:0,left:0,right:0,background:'rgba(251,191,36,.85)',fontSize:8,fontWeight:800,textAlign:'center',color:'#050c18',padding:'1px 0'}}>DRAFT</div>}
              {!isDraftDoc(n)&&n.hidden===true&&<div style={{position:'absolute',bottom:0,left:0,right:0,background:'rgba(148,163,184,.85)',fontSize:8,fontWeight:800,textAlign:'center',color:'#050c18',padding:'1px 0'}}>HIDDEN</div>}
            </div>

            {/* Info */}
            <div style={{flex:1,minWidth:0}}>
              <p style={{fontSize:13,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:4,color:'var(--text)'}}>
                {n.title||'Untitled Article'}
              </p>
              <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                <span style={{fontSize:11,color:'var(--dim)'}}>{timeAgo(n.timestamp)}</span>
                <span style={{fontSize:10,color:'var(--muted)',background:'var(--surface2)',padding:'1px 6px',borderRadius:4,border:'1px solid var(--border)'}}>{n.category||'all'}</span>
                {n.isBreaking && <span className="badge" style={{background:'rgba(248,113,113,.12)',color:'var(--danger)',border:'1px solid rgba(248,113,113,.25)',fontSize:9}}>⚡ BREAKING</span>}
                {n.videoUrl && <span className="badge" style={{background:'rgba(96,165,250,.1)',color:'#60a5fa',border:'1px solid rgba(96,165,250,.2)',fontSize:9}}>🎬 VIDEO</span>}
                {isDraftDoc(n) && <span className="badge" style={{background:'rgba(251,191,36,.12)',color:'#fbbf24',border:'1px solid rgba(251,191,36,.25)',fontSize:9}}>📝 DRAFT</span>}
                {!isDraftDoc(n) && n.hidden===true && <span className="badge" style={{background:'rgba(148,163,184,.12)',color:'#94a3b8',border:'1px solid rgba(148,163,184,.25)',fontSize:9}}>🙈 HIDDEN</span>}
                {n.autoPosted && n.socialPostStatus && n.socialPostStatus!=='done' && <span className="badge" style={{background:n.socialPostStatus==='failed'?'rgba(248,113,113,.12)':'rgba(167,139,250,.12)',color:n.socialPostStatus==='failed'?'var(--danger)':'#a78bfa',border:'1px solid currentColor',fontSize:9}}>SOCIAL: {n.socialPostStatus}</span>}
              </div>
            </div>

            {/* Actions */}
            <div style={{display:'flex',gap:5,flexShrink:0,alignItems:'center'}}>
              {/* Publish draft */}
              {isDraftDoc(n)&&(
                <button className="btn btn-icon" title="Publish this draft" style={{borderColor:'rgba(52,211,153,.4)',color:'#34d399'}}
                  onClick={async()=>{
                    try{
                      await db.collection('news').doc(n.id).update({hidden:false,published:true,status:'published'});
                      toast.add('✅ Published!');
                    }catch(e){
                      console.error('[publishDraft]',e);
                      toast.add(`Publish failed: ${e.message||e}`,'error');
                    }
                  }}>
                  <Ic n="send" s={13}/>
                </button>
              )}
              {/* Play video */}
              {n.videoUrl && (
                <button className="btn btn-icon" title="Play Video" style={{borderColor:'rgba(96,165,250,.4)',color:'#60a5fa'}}
                  onClick={()=>setVideoPlayId(videoPlayId===n.id?null:n.id)}>
                  <Ic n="play" s={13}/>
                </button>
              )}
              {/* Download video */}
              {n.videoUrl && (
                <a href={n.videoUrl} download={`kwtnews-${n.id}.mp4`} target="_blank" rel="noopener noreferrer"
                  className="btn btn-icon" title="Download Video" style={{textDecoration:'none',borderColor:'rgba(96,165,250,.4)',color:'#60a5fa'}}>
                  <Ic n="download" s={13}/>
                </a>
              )}
              {/* Breaking toggle */}
              <button className="tog" title={n.isBreaking?'Remove Breaking':'Set Breaking'}
                style={{background:n.isBreaking?'var(--danger)':'var(--border2)'}}
                onClick={()=>toggleBreaking(n.id,n.isBreaking)}>
                <div className="tog-thumb" style={{left:n.isBreaking?'22px':'4px'}}></div>
              </button>
              {/* Edit */}
              <button className="btn btn-icon" title="Edit Article" onClick={()=>openEdit(n)}>
                <Ic n="edit" s={14}/>
              </button>
              {/* Delete */}
              <button className="btn btn-red" title="Delete Article" onClick={()=>setConfirm(n)}>
                <Ic n="trash" s={14}/>
              </button>
            </div>
          </div>
          {/* Inline video player */}
          {videoPlayId===n.id&&n.videoUrl&&(
            <div style={{borderBottom:'1px solid rgba(26,45,74,.5)',background:'#000',padding:'4px 0'}}>
              <video src={n.videoUrl} controls autoPlay playsInline
                style={{width:'100%',maxHeight:280,display:'block',background:'#000'}}
                onError={e=>{ toast.add('Video load failed','error'); setVideoPlayId(null); }}/>
            </div>
          )}
          </React.Fragment>
        ))}
        {/* Load more button when list is capped */}
        {filtered.length > displayCount && (
          <div style={{padding:'16px',textAlign:'center',borderTop:'1px solid var(--border)'}}>
            <button className="btn btn-ghost" style={{fontSize:13,padding:'9px 22px'}}
              onClick={()=>setDisplayCount(c=>c+20)}>
              Load 20 more ({filtered.length - displayCount} remaining)
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ── ADS MANAGER ────────────────────────────────────────────────
const BLANK_AD = {title:'',position:'top_banner',targetUrl:'',imageUrl:'',startDate:'',endDate:'',active:true,impressions:0,clicks:0};

const AdsForm = ({editing, initialForm, onSave, onCancel, toast}) => {
  const [form, setForm] = useState(initialForm || BLANK_AD);
  const [saving, setSaving] = useState(false);
  const F = p => setForm(prev=>({...prev,...p}));

  useEffect(()=>{ window.scrollTo({top:0,behavior:'smooth'}); },[]);

  const save = async () => {
    if(!form.title.trim()){ toast.add('Title required','error'); return; }
    setSaving(true);
    try{
      if(editing){
        const d={...form};
        delete d.createdAt;
        delete d.impressions;
        delete d.clicks;
        await db.collection('ads').doc(editing).update(d);
        toast.add('Ad updated!');
      } else {
        const d={...form, createdAt:firebase.firestore.FieldValue.serverTimestamp(), impressions:0, clicks:0};
        await db.collection('ads').add(d);
        toast.add('Ad created!');
      }
      onSave();
    }catch(e){ toast.add(e.message,'error'); }
    finally{ setSaving(false); }
  };

  return (
    <div className="fade-up" style={{maxWidth:700,margin:'0 auto'}}>
      {/* Top Bar */}
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:28,flexWrap:'wrap'}}>
        <button className="btn btn-ghost" style={{padding:'9px 12px',gap:6,flexShrink:0}} onClick={onCancel}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div style={{flex:1,minWidth:0}}>
          <h1 style={{fontFamily:'Outfit',fontSize:22,fontWeight:800,letterSpacing:'-.02em',lineHeight:1}}>
            {editing ? '✏️ Edit Ad' : '📢 New Ad'}
          </h1>
          <p style={{fontSize:12,color:'var(--muted)',marginTop:3}}>{editing ? 'Update ad details below' : 'Fill in details and create ad'}</p>
        </div>
        <div style={{display:'flex',gap:10,flexShrink:0}}>
          <button className="btn btn-ghost" onClick={onCancel}>Discard</button>
          <button className="btn btn-accent" onClick={save} disabled={saving} style={{minWidth:130,fontSize:14}}>
            {saving
              ? <><span className="spinner" style={{width:16,height:16}}/> Saving…</>
              : <><Ic n={editing?'ok':'send'} s={15}/>{editing?'Update Ad':'Create Ad'}</>
            }
          </button>
        </div>
      </div>

      {/* Form body */}
      <div style={{display:'flex',flexDirection:'column',gap:16}}>

        {/* Basic Info */}
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:20}}>
          <p style={{fontSize:11,fontWeight:800,color:'var(--accent)',letterSpacing:'.08em',marginBottom:14}}>📢 AD INFO</p>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <Field label="Ad Title" required>
              <input className="inp" value={form.title} onChange={e=>F({title:e.target.value})} placeholder="Enter ad title…" style={{fontSize:15,fontWeight:600}}/>
            </Field>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
              <Field label="Position">
                <select className="inp" value={form.position} onChange={e=>F({position:e.target.value})}>
                  {AD_POSITIONS.map(p=><option key={p} value={p}>{posLabel(p)}</option>)}
                </select>
              </Field>
              <Field label="Target URL">
                <input className="inp" value={form.targetUrl} onChange={e=>F({targetUrl:e.target.value})} placeholder="https://…"/>
              </Field>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
              <Field label="Start Date">
                <input className="inp" type="date" value={form.startDate} onChange={e=>F({startDate:e.target.value})}/>
              </Field>
              <Field label="End Date">
                <input className="inp" type="date" value={form.endDate} onChange={e=>F({endDate:e.target.value})}/>
              </Field>
            </div>
          </div>
        </div>

        {/* Banner Image */}
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:20}}>
          <p style={{fontSize:11,fontWeight:800,color:'var(--info)',letterSpacing:'.08em',marginBottom:14}}>🖼 BANNER IMAGE</p>
          <ImgUpload value={form.imageUrl} onChange={v=>F({imageUrl:v})} label="Banner Image" accept="image"/>
        </div>

        {/* Active toggle */}
        <div style={{background:form.active?'rgba(52,211,153,.06)':'var(--surface)',border:`1.5px solid ${form.active?'rgba(52,211,153,.2)':'var(--border)'}`,borderRadius:16,padding:20,transition:'all .2s'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
            <div>
              <p style={{fontSize:14,fontWeight:800,color:form.active?'var(--success)':'var(--text)'}}>Active / Live</p>
              <p style={{fontSize:12,color:'var(--muted)',marginTop:4}}>Visible to users when active</p>
            </div>
            <button className="tog" style={{background:form.active?'var(--success)':'var(--border2)',flexShrink:0}} onClick={()=>F({active:!form.active})}>
              <div className="tog-thumb" style={{left:form.active?'22px':'4px'}}></div>
            </button>
          </div>
        </div>

        {/* Save button (mobile) */}
        <button className="btn btn-accent" onClick={save} disabled={saving} style={{width:'100%',padding:'15px',fontSize:15,borderRadius:14,fontWeight:700}}>
          {saving
            ? <><span className="spinner" style={{width:18,height:18}}/> Saving…</>
            : <><Ic n={editing?'ok':'send'} s={16}/>{editing ? 'Update Ad' : 'Create Ad'}</>
          }
        </button>
      </div>
    </div>
  );
};

const AdsManager = ({toast}) => {
  const [ads,setAds] = useState([]);
  const [loading,setLoading] = useState(true);
  const [view,setView] = useState('list');
  const [editing,setEditing] = useState(null);
  const [formInit,setFormInit] = useState(BLANK_AD);
  const [confirm,setConfirm] = useState(null);

  useEffect(()=>{
    const u=db.collection('ads').orderBy('createdAt','desc').onSnapshot(s=>{
      setAds(s.docs.map(d=>({id:d.id,...d.data()}))); setLoading(false);
    });
    return ()=>u();
  },[]);

  const openAdd=()=>{ setEditing(null); setFormInit(BLANK_AD); setView('form'); };
  const openEdit=ad=>{ setEditing(ad.id); const {impressions,clicks,...rest}=ad; setFormInit({...BLANK_AD,...rest}); setView('form'); };
  const closeForm=()=>{ setView('list'); setEditing(null); setFormInit(BLANK_AD); };

  const del=async id=>{
    try{await db.collection('ads').doc(id).delete();toast.add('Deleted');}
    catch(e){toast.add(e.message,'error');}
    setConfirm(null);
  };

  const toggleActive=async(id,val)=>{
    try{
      await db.collection('ads').doc(id).update({active:!val});
      toast.add(!val?'Ad activated':'Ad paused');
    }catch(e){
      console.error('[toggleActive]',e);
      toast.add(`Failed: ${e.message||e}`,'error');
    }
  };

  // Full-screen form view
  if(view==='form') return (
    <AdsForm
      editing={editing}
      initialForm={formInit}
      onSave={closeForm}
      onCancel={closeForm}
      toast={toast}
    />
  );

  // List view
  return (
    <div className="fade-up">
      {confirm&&<Confirm msg={`Delete ad "${confirm.title}"?`} onYes={()=>del(confirm.id)} onNo={()=>setConfirm(null)}/>}

      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>Ads</h1>
          <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>{ads.length} ads · {ads.filter(a=>a.active).length} live</p>
        </div>
        <button className="btn btn-accent" style={{padding:'11px 20px',gap:8,fontSize:14}} onClick={openAdd}>
          <Ic n="plus" s={16}/> Add Ad
        </button>
      </div>

      {/* Position overview */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:10,marginBottom:20}}>
        {AD_POSITIONS.map(pos=>{
          const cnt=ads.filter(a=>a.position===pos&&a.active).length;
          return (
            <div key={pos} style={{padding:'12px 14px',borderRadius:12,background:cnt>0?'rgba(245,166,35,.08)':'var(--surface)',border:`1px solid ${cnt>0?'rgba(245,166,35,.25)':'var(--border)'}`}}>
              <p style={{fontSize:10,fontWeight:700,color:cnt>0?'var(--accent)':'var(--dim)',marginBottom:4}}>{posLabel(pos)}</p>
              <p style={{fontSize:22,fontWeight:800,color:cnt>0?'var(--accent)':'var(--border2)'}}>{cnt}</p>
              <p style={{fontSize:10,color:'var(--dim)'}}>active</p>
            </div>
          );
        })}
      </div>

      <div className="card">
        {loading?(
          <div style={{padding:40,textAlign:'center'}}><div className="spinner" style={{margin:'0 auto'}}></div></div>
        ):ads.length===0?(
          <div style={{padding:56,textAlign:'center',color:'var(--dim)'}}>
            <Ic n="ads" s={32} c="var(--border2)"/>
            <p style={{marginTop:14,fontSize:14,fontWeight:600}}>No ads yet</p>
            <p style={{fontSize:12,marginTop:4}}>Create your first ad campaign</p>
            <button className="btn btn-accent" style={{marginTop:16,padding:'10px 20px'}} onClick={openAdd}>
              <Ic n="plus" s={14}/> Add Ad
            </button>
          </div>
        ):ads.map(a=>(
          <div key={a.id} className="row" style={{padding:'13px 16px',borderBottom:'1px solid rgba(26,45,74,.5)',display:'flex',alignItems:'center',gap:12}}>
            {/* Thumbnail */}
            <div style={{width:56,height:44,borderRadius:10,background:'var(--surface2)',overflow:'hidden',flexShrink:0,border:'1px solid var(--border)'}}>
              {a.imageUrl
                ? <img src={a.imageUrl} style={{width:'100%',height:'100%',objectFit:'cover'}} loading="lazy"/>
                : <div style={{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center'}}><Ic n="img" s={18} c="var(--dim)"/></div>
              }
            </div>
            {/* Info */}
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3,flexWrap:'wrap'}}>
                <p style={{fontSize:13,fontWeight:700}}>{a.title}</p>
                <span className="badge" style={{background:a.active?'rgba(52,211,153,.1)':'rgba(100,116,139,.1)',color:a.active?'var(--success)':'var(--muted)',border:`1px solid ${a.active?'rgba(52,211,153,.2)':'rgba(100,116,139,.2)'}`,fontSize:9}}>
                  {a.active?'LIVE':'PAUSED'}
                </span>
              </div>
              <p style={{fontSize:11,color:'var(--dim)'}}>{posLabel(a.position)} · 👁 {fmt(a.impressions)} · CTR {ctr(a)}</p>
              {(a.startDate||a.endDate)&&<p style={{fontSize:10,color:'var(--dim)',marginTop:2}}>{a.startDate||'…'} → {a.endDate||'∞'}</p>}
            </div>
            {/* Actions */}
            <div style={{display:'flex',gap:6,flexShrink:0,alignItems:'center'}}>
              <button className="tog" style={{background:a.active?'var(--success)':'var(--border2)'}} title={a.active?'Pause':'Activate'} onClick={()=>toggleActive(a.id,a.active)}>
                <div className="tog-thumb" style={{left:a.active?'22px':'4px'}}></div>
              </button>
              <button className="btn btn-icon" title="Edit Ad" onClick={()=>openEdit(a)}><Ic n="edit" s={14}/></button>
              <button className="btn btn-red" title="Delete Ad" onClick={()=>setConfirm(a)}><Ic n="trash" s={14}/></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── COMMENTS ──────────────────────────────────────────────────
const CommentsManager = ({toast}) => {
  const [comments,setComments] = useState([]);
  const [loading,setLoading] = useState(true);
  const [filter,setFilter] = useState('all');
  const [confirm,setConfirm] = useState(null);
  const [search,setSearch] = useState('');

  useEffect(()=>{
    const u=db.collection('comments').orderBy('timestamp','desc').limit(100).onSnapshot(s=>{
      setComments(s.docs.map(d=>({id:d.id,...d.data()}))); setLoading(false);
    });
    return ()=>u();
  },[]);

  const del=async id=>{
    try{
      await db.collection('comments').doc(id).delete();
      toast.add('Deleted');
    }catch(e){
      console.error('[deleteComment]',e);
      toast.add(`Failed: ${e.message||e}`,'error');
    }finally{
      setConfirm(null);
    }
  };

  const filtered=useMemo(()=>comments.filter(c=>{
    const q=search.toLowerCase();
    const mq=!q||c.content?.toLowerCase().includes(q)||c.authorName?.toLowerCase().includes(q)||c.authorEmail?.toLowerCase().includes(q);
    const mf=filter==='all'||(filter==='reported'&&(c.reportCount||0)>0);
    return mq&&mf;
  }),[comments,search,filter]);

  const reported=comments.filter(c=>c.reportCount>0).length;

  return (
    <div className="fade-up">
      {confirm&&<Confirm msg={`Delete comment by "${confirm.name}"?`} onYes={()=>del(confirm.id)} onNo={()=>setConfirm(null)}/>}
      <div style={{marginBottom:20}}>
        <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>Comments</h1>
        <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>{comments.length} total · <span style={{color:'var(--danger)'}}>{reported} reported</span></p>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:16}}>
        <div style={{position:'relative'}}>
          <div style={{position:'absolute',left:13,top:'50%',transform:'translateY(-50%)',pointerEvents:'none'}}><Ic n="search" s={15} c="var(--dim)"/></div>
          <input className="inp" placeholder="Search comments…" value={search} onChange={e=>setSearch(e.target.value)} style={{paddingLeft:40}}/>
        </div>
        <div style={{display:'flex',gap:8}}>
          {[['all','All'],['reported',`🚨 Reported (${reported})`]].map(([f,l])=>(
            <button key={f} onClick={()=>setFilter(f)} style={{padding:'7px 14px',borderRadius:8,fontSize:12,fontWeight:600,border:'1px solid',cursor:'pointer',transition:'all .15s',background:filter===f?(f==='reported'?'var(--danger)':'var(--accent)'):'transparent',color:filter===f?'#050c18':(f==='reported'?'var(--danger)':'var(--muted)'),borderColor:filter===f?(f==='reported'?'var(--danger)':'var(--accent)'):(f==='reported'?'rgba(248,113,113,.3)':'var(--border)')}}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        {loading?[1,2,3].map(i=>(
          <div key={i} style={{padding:'14px 16px',borderBottom:'1px solid var(--border)',display:'flex',gap:12}}>
            <div className="shimmer" style={{width:38,height:38,borderRadius:'50%',flexShrink:0}}></div>
            <div style={{flex:1}}>
              <div className="shimmer" style={{height:12,borderRadius:6,width:'50%',marginBottom:8}}></div>
              <div className="shimmer" style={{height:11,borderRadius:6,width:'80%'}}></div>
            </div>
          </div>
        )):filtered.length===0?(
          <div style={{padding:48,textAlign:'center',color:'var(--dim)'}}>
            <Ic n="chat" s={28} c="var(--border2)"/>
            <p style={{marginTop:12,fontSize:13}}>No comments found</p>
          </div>
        ):filtered.map(c=>(
          <div key={c.id} className="row" style={{padding:'13px 16px',borderBottom:'1px solid rgba(26,45,74,.5)',display:'flex',alignItems:'flex-start',gap:12}}>
            <img src={c.authorPhoto||`https://ui-avatars.com/api/?name=${encodeURIComponent(c.authorName||'U')}&background=1a2d4a&color=F5A623&size=80`} style={{width:36,height:36,borderRadius:'50%',flexShrink:0,objectFit:'cover'}}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:4,flexWrap:'wrap'}}>
                <span style={{fontSize:13,fontWeight:700}}>{c.authorName||'Anonymous'}</span>
                <span style={{fontSize:11,color:'var(--dim)'}}>{timeAgo(c.timestamp)}</span>
                {(c.reportCount||0)>0&&<span className="badge" style={{background:'rgba(248,113,113,.1)',color:'var(--danger)',border:'1px solid rgba(248,113,113,.2)',fontSize:9}}>⚠ {c.reportCount}</span>}
              </div>
              <p style={{fontSize:13,color:'var(--muted)',lineHeight:1.5,wordBreak:'break-word'}}>{c.content}</p>
            </div>
            <button className="btn btn-red" style={{padding:'6px 8px',flexShrink:0}} onClick={()=>setConfirm({id:c.id,name:c.authorName})}>
              <Ic n="trash" s={14}/>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── USERS ─────────────────────────────────────────────────────
const UsersManager = ({toast}) => {
  const [users,setUsers] = useState([]);
  const [loading,setLoading] = useState(true);
  const [search,setSearch] = useState('');
  const [confirm,setConfirm] = useState(null);
  const [detailUser,setDetailUser] = useState(null);

  useEffect(()=>{
    const u=db.collection('users').orderBy('createdAt','desc').onSnapshot(s=>{
      setUsers(s.docs.map(d=>({id:d.id,...d.data()}))); setLoading(false);
    });
    return ()=>u();
  },[]);

  const toggleBlock=async(id,blocked)=>{
    try{
      await db.collection('users').doc(id).update({blocked:!blocked});
      toast.add(!blocked?'User blocked':'Unblocked');
    }catch(e){
      console.error('[toggleBlock]',e);
      toast.add(`Failed: ${e.message||e}`,'error');
    }
  };

  const filtered=useMemo(()=>users.filter(u=>{
    if(!search.trim())return true;
    const q=search.toLowerCase();
    return u.displayName?.toLowerCase().includes(q)||
           u.email?.toLowerCase().includes(q)||
           u.phoneNumber?.toLowerCase().includes(q)||
           u.phone?.toLowerCase().includes(q);
  }),[users,search]);

  const providerIcon=u=>{
    if(u.providerData?.[0]?.providerId==='google.com')return'🔵';
    if(u.providerData?.[0]?.providerId==='apple.com')return'⚫';
    return'✉️';
  };

  return (
    <div className="fade-up">
      {confirm&&<Confirm msg={`Block user "${confirm.name}"?`} onYes={()=>{toggleBlock(confirm.id,false);setConfirm(null);}} onNo={()=>setConfirm(null)}/>}

      {/* User detail modal */}
      {detailUser&&(
        <div className="modal-bg scale-in" onClick={()=>setDetailUser(null)}>
          <div className="modal slide-up" onClick={e=>e.stopPropagation()} style={{maxWidth:420}}>
            <div style={{padding:'16px 20px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,background:'var(--surface)',zIndex:10}}>
              <h3 style={{fontWeight:800,fontSize:16}}>User Profile</h3>
              <button className="btn btn-ghost" style={{padding:8}} onClick={()=>setDetailUser(null)}><Ic n="x" s={16}/></button>
            </div>
            <div style={{padding:24}}>
              {/* Profile header */}
              <div style={{display:'flex',flexDirection:'column',alignItems:'center',marginBottom:24,textAlign:'center'}}>
                <img src={detailUser.photoURL||`https://ui-avatars.com/api/?name=${encodeURIComponent(detailUser.displayName||'U')}&background=1a2d4a&color=F5A623&size=200`}
                  style={{width:80,height:80,borderRadius:'50%',objectFit:'cover',border:`3px solid ${detailUser.blocked?'var(--danger)':'var(--accent)'}`,marginBottom:12}}/>
                <p style={{fontSize:18,fontWeight:800,marginBottom:4}}>{detailUser.displayName||'Anonymous'}</p>
                {detailUser.blocked&&<span className="badge" style={{background:'rgba(248,113,113,.1)',color:'var(--danger)',border:'1px solid rgba(248,113,113,.2)'}}>BLOCKED</span>}
              </div>
              {/* Details */}
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                {[
                  ['📧 Email', detailUser.email||'—'],
                  ['📱 Phone', detailUser.phoneNumber||detailUser.phone||'—'],
                  ['🔑 Provider', providerIcon(detailUser)+' '+(detailUser.providerData?.[0]?.providerId||'email')],
                  ['📅 Joined', fmtDate(detailUser.createdAt)],
                  ['❤️ Liked Posts', detailUser.likedPosts?.length||0],
                  ['🔖 Saved Posts', detailUser.savedPosts?.length||0],
                ].map(([k,v])=>(
                  <div key={k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:'1px solid var(--border)'}}>
                    <span style={{fontSize:13,color:'var(--muted)',fontWeight:500}}>{k}</span>
                    <span style={{fontSize:13,fontWeight:600,maxWidth:'60%',textAlign:'right',wordBreak:'break-all'}}>{v}</span>
                  </div>
                ))}
              </div>
              {/* Action button */}
              <div style={{marginTop:20}}>
                {detailUser.blocked?(
                  <button className="btn btn-ghost" style={{width:'100%',padding:'11px'}} onClick={()=>{toggleBlock(detailUser.id,true);setDetailUser(null);}}>
                    <Ic n="ok" s={14}/> Unblock User
                  </button>
                ):(
                  <button className="btn btn-red" style={{width:'100%',padding:'11px',justifyContent:'center'}} onClick={()=>{setDetailUser(null);setConfirm({id:detailUser.id,name:detailUser.displayName});}}>
                    <Ic n="ban" s={14}/> Block User
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>Users</h1>
          <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>{users.length} registered · <span style={{color:'var(--danger)'}}>{users.filter(u=>u.blocked).length} blocked</span></p>
        </div>
        <div style={{padding:'8px 14px',borderRadius:10,background:'rgba(245,166,35,.08)',border:'1px solid rgba(245,166,35,.2)',fontSize:12,fontWeight:700,color:'var(--accent)'}}>
          {fmt(users.length)} total
        </div>
      </div>

      {/* Search */}
      <div style={{marginBottom:16}}>
        <div style={{position:'relative'}}>
          <div style={{position:'absolute',left:13,top:'50%',transform:'translateY(-50%)',pointerEvents:'none'}}><Ic n="search" s={15} c="var(--dim)"/></div>
          <input className="inp" placeholder="Search by name, email or phone…" value={search} onChange={e=>setSearch(e.target.value)} style={{paddingLeft:40}}/>
        </div>
        <div style={{display:'flex',gap:10,marginTop:8}}>
          {[['name','By Name'],['email','By Email'],['phone','By Phone']].map(([t,l])=>(
            <div key={t} style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',borderRadius:999,background:'var(--surface2)',border:'1px solid var(--border)',fontSize:11,color:'var(--muted)'}}>
              <Ic n={t==='name'?'users':t==='email'?'mail':'phone'} s={11}/> {l}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        {loading?[1,2,3].map(i=>(
          <div key={i} style={{padding:'14px 16px',borderBottom:'1px solid var(--border)',display:'flex',gap:12,alignItems:'center'}}>
            <div className="shimmer" style={{width:48,height:48,borderRadius:'50%',flexShrink:0}}></div>
            <div style={{flex:1}}>
              <div className="shimmer" style={{height:13,borderRadius:6,width:'40%',marginBottom:8}}></div>
              <div className="shimmer" style={{height:10,borderRadius:6,width:'60%'}}></div>
            </div>
          </div>
        )):filtered.length===0?(
          <div style={{padding:48,textAlign:'center',color:'var(--dim)'}}>
            <Ic n="users" s={28} c="var(--border2)"/>
            <p style={{marginTop:12,fontSize:13}}>No users found</p>
          </div>
        ):filtered.map(u=>(
          <div key={u.id} className="row" style={{padding:'13px 16px',borderBottom:'1px solid rgba(26,45,74,.5)',display:'flex',alignItems:'center',gap:12,cursor:'pointer'}}
            onClick={()=>setDetailUser(u)}>
            <div style={{position:'relative',flexShrink:0}}>
              <img src={u.photoURL||`https://ui-avatars.com/api/?name=${encodeURIComponent(u.displayName||'U')}&background=1a2d4a&color=F5A623&size=80`}
                style={{width:46,height:46,borderRadius:'50%',objectFit:'cover',border:`2px solid ${u.blocked?'var(--danger)':'var(--border)'}`}}/>
              <span style={{position:'absolute',bottom:0,right:-2,fontSize:10,lineHeight:1}}>{providerIcon(u)}</span>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3,flexWrap:'wrap'}}>
                <p style={{fontSize:14,fontWeight:700}}>{u.displayName||'Anonymous'}</p>
                {u.blocked&&<span className="badge" style={{background:'rgba(248,113,113,.1)',color:'var(--danger)',border:'1px solid rgba(248,113,113,.2)',fontSize:9}}>BLOCKED</span>}
              </div>
              <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:2}}>
                <Ic n="mail" s={10} c="var(--dim)"/>
                <p style={{fontSize:11,color:'var(--muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{u.email||'—'}</p>
              </div>
              {(u.phoneNumber||u.phone)&&(
                <div style={{display:'flex',alignItems:'center',gap:5}}>
                  <Ic n="phone" s={10} c="var(--dim)"/>
                  <p style={{fontSize:11,color:'var(--dim)'}}>{u.phoneNumber||u.phone}</p>
                </div>
              )}
            </div>
            <div style={{flexShrink:0,display:'flex',gap:6,alignItems:'center'}}>
              <span style={{fontSize:10,color:'var(--dim)'}}>{timeAgo(u.createdAt)}</span>
              {u.blocked?(
                <button className="btn btn-ghost" style={{padding:'6px 10px',fontSize:11}} onClick={e=>{e.stopPropagation();toggleBlock(u.id,true);}}>Unblock</button>
              ):(
                <button className="btn btn-red" style={{padding:'6px 8px'}} onClick={e=>{e.stopPropagation();setConfirm({id:u.id,name:u.displayName});}}><Ic n="ban" s={14}/></button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
const PushNotifs = ({toast}) => {
  const [title,setTitle] = useState('');
  const [body,setBody] = useState('');
  const [sending,setSending] = useState(false);
  const [serverKey,setServerKey] = useState(()=>{ try{return localStorage.getItem('fcm_sk')||'';}catch(e){return '';} });
  const [tokenCount,setTokenCount] = useState(0);
  const [history,setHistory] = useState([]);
  const [showKey,setShowKey] = useState(false);

  useEffect(()=>{
    db.collection('fcm_tokens').get().then(s=>setTokenCount(s.size));
    db.collection('notification_history').orderBy('sentAt','desc').limit(10).onSnapshot(s=>{
      setHistory(s.docs.map(d=>({id:d.id,...d.data()})));
    });
  },[]);

  const saveKey=()=>{ try{localStorage.setItem('fcm_sk',serverKey);}catch(e){} toast.add('Key saved'); };

  const send=async()=>{
    if(!title.trim()||!body.trim()){toast.add('Title and message required','error');return;}
    setSending(true);
    try{
      const snap=await db.collection('fcm_tokens').get();
      const tokens=snap.docs.map(d=>d.data().token).filter(Boolean);
      if(!tokens.length){toast.add('No subscribers','error');setSending(false);return;}
      await db.collection('notification_history').add({title,body,sentAt:firebase.firestore.FieldValue.serverTimestamp(),tokenCount:tokens.length,status:'sent'});
      if(serverKey){
        const batches=[];
        for(let i=0;i<tokens.length;i+=1000) batches.push(tokens.slice(i,i+1000));
        await Promise.all(batches.map(batch=>fetch('https://fcm.googleapis.com/fcm/send',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'key='+serverKey},body:JSON.stringify({registration_ids:batch,notification:{title,body},android:{priority:'high'},apns:{headers:{'apns-priority':'10'}}})})));
      }
      toast.add(`Sent to ${tokens.length} subscribers!`);
      setTitle(''); setBody('');
    }catch(e){toast.add(e.message,'error');}
    finally{setSending(false);}
  };

  return (
    <div className="fade-up">
      <div style={{marginBottom:20}}>
        <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>Push Alerts</h1>
        <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>{fmt(tokenCount)} subscribers</p>
      </div>

      {/* Compose */}
      <div className="card" style={{padding:20,marginBottom:16}}>
        <p style={{fontWeight:700,fontSize:14,marginBottom:16,display:'flex',alignItems:'center',gap:8}}>
          <Ic n="send" s={15} c="var(--accent)"/> Compose Alert
        </p>
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          <Field label="Title" required>
            <input className="inp" value={title} onChange={e=>setTitle(e.target.value)} placeholder="Breaking: …"/>
          </Field>
          <Field label="Message" required>
            <textarea className="inp" value={body} onChange={e=>setBody(e.target.value)} placeholder="Alert message…" style={{minHeight:100}}/>
          </Field>
          {title&&body&&(
            <div style={{padding:14,background:'var(--surface2)',borderRadius:12,border:'1px solid var(--border)'}}>
              <p style={{fontSize:10,fontWeight:700,color:'var(--dim)',letterSpacing:'.06em',marginBottom:10}}>PREVIEW</p>
              <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                <div style={{width:32,height:32,borderRadius:8,background:'var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <span style={{fontSize:10,fontWeight:900,color:'#050c18'}}>KWT</span>
                </div>
                <div>
                  <p style={{fontSize:13,fontWeight:700,marginBottom:2}}>{title}</p>
                  <p style={{fontSize:12,color:'var(--muted)',lineHeight:1.4}}>{body}</p>
                </div>
              </div>
            </div>
          )}
          <button className="btn btn-accent" style={{width:'100%',padding:'13px',fontSize:14}} onClick={send} disabled={sending||!title||!body}>
            {sending?<><span className="spinner" style={{width:16,height:16}}></span> Sending…</>:<><Ic n="send" s={15}/>Send to {fmt(tokenCount)} Subscribers</>}
          </button>
        </div>
      </div>

      {/* FCM key */}
      <div className="card" style={{padding:20,marginBottom:16}}>
        <p style={{fontWeight:700,fontSize:14,marginBottom:4,display:'flex',alignItems:'center',gap:8}}>
          <Ic n="cog" s={15} c="var(--muted)"/> FCM Server Key
        </p>
        <p style={{fontSize:12,color:'var(--muted)',marginBottom:14,lineHeight:1.6}}>Firebase Console → Project Settings → Cloud Messaging → Legacy server key</p>
        <div style={{display:'flex',gap:8}}>
          <input className="inp" type={showKey?'text':'password'} value={serverKey} onChange={e=>setServerKey(e.target.value)} placeholder="AAAAxxx…" style={{flex:1}}/>
          <button className="btn btn-ghost" style={{padding:'10px 12px',flexShrink:0}} onClick={()=>setShowKey(v=>!v)}><Ic n="eye" s={14}/></button>
          <button className="btn btn-ghost" style={{padding:'10px 14px',flexShrink:0}} onClick={saveKey}>Save</button>
        </div>
        {serverKey&&<p style={{fontSize:11,color:'var(--success)',marginTop:8}}>✓ Saved locally</p>}
      </div>

      {/* History */}
      <div className="card" style={{padding:20}}>
        <p style={{fontWeight:700,fontSize:14,marginBottom:14,display:'flex',alignItems:'center',gap:8}}>
          <Ic n="refresh" s={15} c="var(--muted)"/> History
        </p>
        {history.length===0?(
          <p style={{fontSize:13,color:'var(--dim)',textAlign:'center',padding:'12px 0'}}>No notifications sent yet</p>
        ):history.map(h=>(
          <div key={h.id} style={{padding:'11px 0',borderBottom:'1px solid var(--border)',display:'flex',gap:10,alignItems:'flex-start'}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:'var(--success)',marginTop:5,flexShrink:0}}></div>
            <div style={{flex:1,minWidth:0}}>
              <p style={{fontSize:13,fontWeight:600,marginBottom:2}}>{h.title}</p>
              <p style={{fontSize:11,color:'var(--dim)'}}>{timeAgo(h.sentAt)} · {fmt(h.tokenCount)} devices</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── AUTOMATION ────────────────────────────────────────────────
const AutomationPage = ({toast}) => {
  const CATS = [
    {id:'kuwait',          label:'🇰🇼 Kuwait',       color:'#34d399', schedule:'06:00 & 18:00 KWT', workflow:'auto-kuwait.yml'},
    {id:'world',           label:'🌍 World',          color:'#60a5fa', schedule:'Every 2 hrs (12×)', workflow:'auto-world.yml'},
    {id:'kuwait-jobs',     label:'💼 Kuwait Jobs',    color:'#a78bfa', schedule:'09:00 KWT / 2 days', workflow:'auto-jobs.yml'},
    {id:'kuwait-offers',   label:'🛍️ Kuwait Offers', color:'#f472b6', schedule:'10:00 KWT daily',    workflow:'auto-offers.yml'},
    {id:'funny-news-meme', label:'😂 Funny & Memes', color:'#fbbf24', schedule:'20:00 KWT daily',    workflow:'auto-funny.yml'},
  ];
  const GH_REPO   = 'SQLRIZWAN/Admin-news';
  const GH_BRANCH = 'main';
  const LS_TOKEN  = 'kwt_github_token';
  const LS_PEXELS = 'kwt_pexels_key';

  const [ghToken,       setGhToken]       = useState(localStorage.getItem(LS_TOKEN)||'');
  const [pexelsKey,     setPexelsKey]     = useState(localStorage.getItem(LS_PEXELS)||'');
  const [cldApiKey,     setCldApiKey]     = useState(localStorage.getItem('cld_api_key')||'');
  const [cldApiSecret,  setCldApiSecret]  = useState(localStorage.getItem('cld_api_secret')||'');
  const [showSetup,     setShowSetup]     = useState(!localStorage.getItem(LS_TOKEN));
  const [configs,       setConfigs]       = useState({});
  const [logs,          setLogs]          = useState([]);
  const [showAllLogs,   setShowAllLogs]   = useState(false);
  const [ghRuns,        setGhRuns]        = useState({});
  const [apiStatus,     setApiStatus]     = useState({});
  const [triggering,    setTriggering]    = useState({});
  const [refreshingApi, setRefreshingApi] = useState(false);

  // ── Firestore listeners ──────────────────────────────────────
  useEffect(()=>{
    const us=[];
    CATS.forEach(c=>{
      us.push(db.collection('automation_config').doc(c.id).onSnapshot(s=>{
        setConfigs(p=>({...p,[c.id]:s.exists?s.data():{enabled:true}}));
      }));
    });
    us.push(db.collection('automation_logs').orderBy('timestamp','desc').limit(40).onSnapshot(s=>{
      setLogs(s.docs.map(d=>({id:d.id,...d.data()})));
    }));
    return ()=>us.forEach(u=>u());
  },[]);

  // ── GitHub: fetch last run per workflow ──────────────────────
  const fetchGhRuns = async ()=>{
    const tok = localStorage.getItem(LS_TOKEN);
    if(!tok) return;
    const headers = {'Authorization':`Bearer ${tok}`,'Accept':'application/vnd.github+json'};
    for(const cat of CATS){
      try{
        const r = await fetch(
          `https://api.github.com/repos/${GH_REPO}/actions/workflows/${cat.workflow}/runs?per_page=1`,
          {headers}
        );
        const d = await r.json();
        const run = d.workflow_runs?.[0];
        if(run) setGhRuns(p=>({...p,[cat.id]:{conclusion:run.conclusion,status:run.status,at:run.updated_at}}));
      }catch(_){}
    }
  };

  // ── API health checks ────────────────────────────────────────
  const API_CACHE_KEY = 'kwt_api_status_v1';
  const API_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  const checkApis = async ()=>{
    setRefreshingApi(true);
    const results = {};
    const upd = s=>{ Object.assign(results,s); setApiStatus(p=>({...p,...s})); };
    // Firebase
    try{ await db.collection('news').limit(1).get(); upd({firebase:'ok'}); }
    catch(_){ upd({firebase:'error'}); }
    // Puter.js AI
    try{
      const res=await Promise.race([
        puter.ai.chat('ping',{model:'gpt-4o-mini'}),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),15000))
      ]);
      upd({gemini:res?'ok':'error'});
    }catch(_){ upd({gemini:'error'}); }
    // Pixabay
    try{
      const r=await fetch(`https://pixabay.com/api/?key=${AI_CFG.pixabayKey}&q=test&per_page=3`);
      const d=await r.json(); upd({pixabay:d.hits?'ok':'error'});
    }catch(_){ upd({pixabay:'error'}); }
    // Pexels
    const pk=localStorage.getItem(LS_PEXELS);
    if(!pk){ upd({pexels:'nokey'}); }
    else{
      try{
        const r=await fetch('https://api.pexels.com/videos/search?query=news&per_page=1',{headers:{Authorization:pk}});
        const d=await r.json(); upd({pexels:d.videos?'ok':'error'});
      }catch(_){ upd({pexels:'error'}); }
    }
    setRefreshingApi(false);
    // Save results to cache
    try{ localStorage.setItem(API_CACHE_KEY, JSON.stringify({ts:Date.now(), data:results})); }catch(_){}
  };

  useEffect(()=>{
    // Load cached API status first (avoids slow network calls on every tab switch)
    try{
      const cached = JSON.parse(localStorage.getItem(API_CACHE_KEY)||'null');
      if(cached && (Date.now()-cached.ts) < API_CACHE_TTL){
        setApiStatus(cached.data);
      } else {
        checkApis();
      }
    } catch(_){ checkApis(); }
    fetchGhRuns();
  },[]);

  // ── Save token ───────────────────────────────────────────────
  const saveSetup = ()=>{
    if(!ghToken.trim()){ toast.show('Enter GitHub token','error'); return; }
    localStorage.setItem(LS_TOKEN, ghToken.trim());
    if(pexelsKey.trim())    localStorage.setItem(LS_PEXELS, pexelsKey.trim());
    if(cldApiKey.trim())    localStorage.setItem('cld_api_key', cldApiKey.trim());
    if(cldApiSecret.trim()) localStorage.setItem('cld_api_secret', cldApiSecret.trim());
    setShowSetup(false);
    toast.show('✅ Saved!','success');
    fetchGhRuns(); checkApis();
  };

  // ── Toggle category ──────────────────────────────────────────
  const toggleCat = async (id,cur)=>{
    try{
      await db.collection('automation_config').doc(id).set({enabled:!cur},{merge:true});
      toast.show(!cur?'✅ Automation enabled':'⏸️ Automation paused','success');
    }catch(e){ toast.show('Error: '+e.message,'error'); }
  };

  // ── Trigger workflow via GitHub API ─────────────────────────
  const runNow = async (cat)=>{
    const tok=localStorage.getItem(LS_TOKEN);
    if(!tok){ toast.show('Set GitHub token first','error'); setShowSetup(true); return; }
    setTriggering(p=>({...p,[cat.id]:true}));
    try{
      const r=await fetch(
        `https://api.github.com/repos/${GH_REPO}/actions/workflows/${cat.workflow}/dispatches`,
        {method:'POST',headers:{'Authorization':`Bearer ${tok}`,'Accept':'application/vnd.github+json','Content-Type':'application/json'},
         body:JSON.stringify({ref:GH_BRANCH})}
      );
      if(r.status===204){
        toast.show(`🚀 ${cat.label} — triggered!`,'success');
        setTimeout(fetchGhRuns, 4000);
      } else {
        const d=await r.json(); toast.show('GitHub error: '+(d.message||r.status),'error');
      }
    }catch(e){ toast.show('Trigger failed: '+e.message,'error'); }
    setTriggering(p=>({...p,[cat.id]:false}));
  };

  // ── Run ALL categories at once via run-all.yml ───────────────
  const [runningAll, setRunningAll] = useState(false);
  const runAll = async ()=>{
    const tok=localStorage.getItem(LS_TOKEN);
    if(!tok){ toast.show('Set GitHub token first','error'); setShowSetup(true); return; }
    setRunningAll(true);
    try{
      const r=await fetch(
        `https://api.github.com/repos/${GH_REPO}/actions/workflows/run-all.yml/dispatches`,
        {method:'POST',headers:{'Authorization':`Bearer ${tok}`,'Accept':'application/vnd.github+json','Content-Type':'application/json'},
         body:JSON.stringify({ref:GH_BRANCH})}
      );
      if(r.status===204){
        toast.show('🚀 All 5 categories triggered in parallel!','success');
        setTimeout(fetchGhRuns, 5000);
      } else {
        const d=await r.json(); toast.show('GitHub error: '+(d.message||r.status),'error');
      }
    }catch(e){ toast.show('Trigger failed: '+e.message,'error'); }
    setRunningAll(false);
  };

  // ── Helpers ──────────────────────────────────────────────────
  const timeAgo = ts=>{
    if(!ts) return '—';
    const d=ts.toDate?ts.toDate():new Date(ts);
    const s=(Date.now()-d)/1000;
    if(s<60) return 'Just now';
    if(s<3600) return Math.floor(s/60)+'m ago';
    if(s<86400) return Math.floor(s/3600)+'h ago';
    return Math.floor(s/86400)+'d ago';
  };

  const logBadge = s=>{
    const M={posted:{bg:'rgba(52,211,153,.15)',c:'#34d399',t:'Posted'},skipped:{bg:'rgba(251,191,36,.15)',c:'#fbbf24',t:'Skipped'},error:{bg:'rgba(248,113,113,.15)',c:'#f87171',t:'Error'}};
    const m=M[s]||{bg:'rgba(136,153,180,.15)',c:'#8899b4',t:s||'—'};
    return <span className="badge" style={{background:m.bg,color:m.c,fontSize:10}}>{m.t}</span>;
  };

  const ghBadge = run=>{
    if(!run) return <span className="badge" style={{background:'rgba(136,153,180,.1)',color:'var(--dim)',fontSize:10}}>—</span>;
    const M={success:{bg:'rgba(52,211,153,.15)',c:'#34d399',t:'✅ OK'},failure:{bg:'rgba(248,113,113,.15)',c:'#f87171',t:'❌ Failed'},in_progress:{bg:'rgba(96,165,250,.15)',c:'#60a5fa',t:'⏳ Running'},cancelled:{bg:'rgba(136,153,180,.15)',c:'#8899b4',t:'⊘ Cancelled'}};
    const key=run.conclusion||run.status;
    const m=M[key]||{bg:'rgba(136,153,180,.1)',c:'var(--dim)',t:key};
    return <span className="badge" style={{background:m.bg,color:m.c,fontSize:10}}>{m.t}</span>;
  };

  const apiDot = s=>{
    const M={ok:{c:'#34d399',t:'Live'},error:{c:'#f87171',t:'Error'},nokey:{c:'#8899b4',t:'No key'},checking:{c:'#fbbf24',t:'…'}};
    const m=M[s]||{c:'var(--dim)',t:'—'};
    return <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:11}}>
      <span style={{width:7,height:7,borderRadius:'50%',background:m.c,display:'inline-block',
        ...(s==='checking'?{animation:'pulse 1s ease infinite'}:{boxShadow:`0 0 6px ${m.c}99`})}}/>
      <span style={{color:m.c,fontWeight:600}}>{m.t}</span>
    </span>;
  };

  // ── Render ───────────────────────────────────────────────────
  const hasToken = !!localStorage.getItem(LS_TOKEN);
  return (
    <div className="fade-up">

      {/* ── Header ── */}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
        <div style={{width:40,height:40,borderRadius:13,background:'linear-gradient(135deg,#1a3a5c,#0f2a45)',border:'1.5px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
          <Ic n="bot" s={20} c="var(--accent)"/>
        </div>
        <div style={{flex:1}}>
          <h1 style={{fontSize:20,fontWeight:800,letterSpacing:'-.02em',lineHeight:1}}>Auto News</h1>
          <p style={{fontSize:11,color:'var(--muted)',marginTop:2}}>RSS → Script → TTS → Video → Post  •  Fully automatic</p>
        </div>
        <button className="btn btn-accent" style={{padding:'9px 15px',fontSize:13,fontWeight:700,flexShrink:0,gap:6,display:'flex',alignItems:'center'}}
          onClick={runAll} disabled={runningAll}>
          {runningAll?<><span className="spinner" style={{width:13,height:13}}/> Running…</>:<>🚀 Run All</>}
        </button>
        <button className="btn btn-ghost" style={{padding:'9px 12px',fontSize:12,flexShrink:0}} onClick={()=>setShowSetup(v=>!v)}>
          <Ic n="cog" s={14}/>
        </button>
      </div>

      {/* ── No token warning ── */}
      {!hasToken&&(
        <div onClick={()=>setShowSetup(true)} style={{cursor:'pointer',background:'rgba(245,166,35,.08)',border:'1px solid rgba(245,166,35,.3)',borderRadius:12,padding:'12px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:10}}>
          <Ic n="star" s={16} c="var(--accent)"/>
          <div style={{flex:1}}>
            <p style={{fontSize:13,fontWeight:700,color:'var(--accent)'}}>Setup Required</p>
            <p style={{fontSize:11,color:'var(--muted)',marginTop:2}}>Tap here to add GitHub Token — needed to trigger workflows manually</p>
          </div>
          <span style={{color:'var(--accent)',fontSize:18}}>›</span>
        </div>
      )}

      {/* ── GitHub Setup Panel ── */}
      {showSetup&&(
        <div className="card" style={{padding:18,marginBottom:16,border:'1px solid rgba(245,166,35,.3)'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
            <span style={{fontWeight:700,fontSize:13,display:'flex',alignItems:'center',gap:6}}><Ic n="star" s={14} c="var(--accent)"/> GitHub Setup</span>
            <button onClick={()=>setShowSetup(false)} style={{background:'none',border:'none',color:'var(--muted)',cursor:'pointer',fontSize:18,lineHeight:1}}>×</button>
          </div>
          <p style={{fontSize:11,color:'var(--muted)',marginBottom:12,lineHeight:1.7}}>
            <strong style={{color:'var(--text)'}}>GitHub Token</strong> (for "▶ Run" buttons):<br/>
            Go to <strong>github.com → Settings → Developer settings → Personal access tokens (classic)</strong><br/>
            Create token with <code style={{background:'var(--surface2)',padding:'1px 6px',borderRadius:4,fontSize:10}}>repo</code> scope.
          </p>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <input className="inp" type="password" value={ghToken} onChange={e=>setGhToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxx  (GitHub token)" style={{fontFamily:'DM Mono,monospace',fontSize:12}}/>
            <input className="inp" value={pexelsKey} onChange={e=>setPexelsKey(e.target.value)}
              placeholder="Pexels API key (optional, for status check)" style={{fontSize:12}}/>
            <input className="inp" value={cldApiKey} onChange={e=>setCldApiKey(e.target.value)}
              placeholder="Cloudinary API Key (for full delete from Cloudinary)" style={{fontSize:12}}/>
            <input className="inp" type="password" value={cldApiSecret} onChange={e=>setCldApiSecret(e.target.value)}
              placeholder="Cloudinary API Secret" style={{fontSize:12}}/>
            <button className="btn btn-accent" style={{padding:'11px',fontWeight:700}} onClick={saveSetup}>💾 Save Credentials</button>
          </div>
        </div>
      )}

      {/* ── API Status row ── */}
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
        {[
          {key:'firebase',label:'Firebase',icon:'🔥'},
          {key:'gemini',  label:'Puter.js AI',icon:'🤖'},
          {key:'pixabay', label:'Pixabay',icon:'🖼️'},
          {key:'pexels',  label:'Pexels',icon:'🎬'},
        ].map(({key,label,icon})=>{
          const s=apiStatus[key]||'checking';
          const ok=s==='ok';const err=s==='error';const chk=s==='checking';
          return(
            <div key={key} style={{flex:'1 1 auto',minWidth:90,background:'var(--surface2)',border:`1px solid ${ok?'rgba(52,211,153,.3)':err?'rgba(248,113,113,.25)':'var(--border)'}`,borderRadius:10,padding:'9px 11px',textAlign:'center'}}>
              <div style={{fontSize:16,marginBottom:3}}>{icon}</div>
              <div style={{fontSize:10,color:'var(--muted)',marginBottom:4}}>{label}</div>
              {apiDot(s)}
            </div>
          );
        })}
        <button onClick={checkApis} disabled={refreshingApi}
          style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:10,padding:'9px 13px',cursor:'pointer',color:'var(--muted)',fontSize:12,display:'flex',alignItems:'center',gap:5}}>
          <Ic n="refresh" s={13} c={refreshingApi?'var(--accent)':'var(--muted)'}/>
        </button>
      </div>

      {/* ── Category Cards ── */}
      <p style={{fontSize:11,fontWeight:700,color:'var(--dim)',letterSpacing:'.06em',marginBottom:8}}>CATEGORIES  <span style={{fontWeight:400,color:'var(--dim)'}}>— toggle ON/OFF  •  ▶ run now</span></p>
      <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
        {CATS.map(cat=>{
          const cfg    = configs[cat.id]||{};
          const enabled= cfg.enabled!==false;
          const run    = ghRuns[cat.id];
          const trig   = triggering[cat.id];
          const lastSt = cfg.lastStatus;
          const stColor= lastSt==='posted'?'#34d399':lastSt==='error'?'#f87171':'#fbbf24';
          const ghConcl= run?.conclusion;
          return (
            <div key={cat.id} style={{background:'var(--surface)',border:`1.5px solid ${enabled?cat.color+'33':'var(--border)'}`,borderRadius:14,padding:'13px 14px',opacity:enabled?1:.6,transition:'all .2s'}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                {/* Left color bar */}
                <div style={{width:5,height:38,borderRadius:3,background:cat.color,flexShrink:0}}/>
                {/* Main info */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                    <span style={{fontWeight:700,fontSize:14,color:'var(--text)'}}>{cat.label}</span>
                    {lastSt&&<span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:99,background:stColor+'22',color:stColor}}>
                      {lastSt==='posted'?'✅ Posted':lastSt==='error'?'❌ Error':'⏭️ Skipped'}
                    </span>}
                    {ghConcl&&<span style={{fontSize:10,padding:'2px 7px',borderRadius:99,
                      background:ghConcl==='success'?'rgba(52,211,153,.15)':'rgba(248,113,113,.15)',
                      color:ghConcl==='success'?'#34d399':'#f87171'}}>
                      GH {ghConcl==='success'?'✓':'✗'}
                    </span>}
                  </div>
                  <div style={{display:'flex',gap:12,marginTop:4,flexWrap:'wrap'}}>
                    <span style={{fontSize:10,color:'var(--dim)'}}>⏰ {cat.schedule}</span>
                    <span style={{fontSize:10,color:'var(--muted)'}}>Last run: {timeAgo(cfg.lastRun)}</span>
                  </div>
                </div>
                {/* Run button */}
                <button onClick={()=>runNow(cat)} disabled={trig||!hasToken}
                  title={hasToken?'Trigger this workflow now':'Add GitHub token in Setup first'}
                  style={{flexShrink:0,padding:'7px 13px',borderRadius:9,border:'1.5px solid rgba(96,165,250,.4)',background:'rgba(96,165,250,.08)',color:'#60a5fa',cursor:hasToken?'pointer':'not-allowed',fontSize:12,fontWeight:700,fontFamily:'Outfit',display:'flex',alignItems:'center',gap:5,opacity:hasToken?1:.5}}>
                  {trig?<span className="spinner" style={{width:12,height:12}}/>:<>▶ Run</>}
                </button>
                {/* Toggle */}
                <button onClick={()=>toggleCat(cat.id,enabled)}
                  style={{flexShrink:0,width:44,height:24,borderRadius:99,border:'none',cursor:'pointer',position:'relative',background:enabled?cat.color:'var(--dim)',transition:'background .2s'}}>
                  <div style={{position:'absolute',top:3,left:enabled?22:3,width:18,height:18,borderRadius:'50%',background:'#fff',transition:'left .2s',boxShadow:'0 1px 4px rgba(0,0,0,.3)'}}/>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Refresh button ── */}
      <div style={{display:'flex',gap:8,justifyContent:'center',marginBottom:16}}>
        <button className="btn btn-ghost" style={{fontSize:12,padding:'8px 16px'}} onClick={fetchGhRuns}>
          <Ic n="refresh" s={12}/> Refresh GitHub Status
        </button>
        <button className="btn btn-ghost" style={{fontSize:12,padding:'8px 16px'}} onClick={runAll} disabled={runningAll}>
          {runningAll?'Running…':'🚀 Run All Now'}
        </button>
      </div>

      {/* ── Activity Log ── */}
      <div className="card" style={{padding:16}}>
        <div style={{display:'flex',alignItems:'center',marginBottom:12}}>
          <span style={{fontWeight:700,fontSize:13}}>📋 Activity Log</span>
          <span style={{marginLeft:8,fontSize:11,color:'var(--dim)',background:'var(--surface2)',padding:'2px 8px',borderRadius:99}}>Last 10</span>
          <span style={{marginLeft:'auto',fontSize:11,color:'var(--dim)',background:'var(--surface2)',padding:'2px 8px',borderRadius:99}}>{logs.length} total</span>
        </div>
        {logs.length===0?(
          <div style={{textAlign:'center',padding:'28px 0'}}>
            <div style={{fontSize:28,marginBottom:8}}>🤖</div>
            <p style={{fontSize:13,color:'var(--muted)',fontWeight:600}}>No runs yet</p>
            <p style={{fontSize:11,color:'var(--dim)',marginTop:4}}>Press <strong style={{color:'var(--text)'}}>▶ Run</strong> next to any category above,<br/>or press <strong style={{color:'var(--accent)'}}>🚀 Run All</strong> to start all 5 at once.</p>
          </div>
        ):(
          <div style={{display:'flex',flexDirection:'column',gap:5}}>
            {(showAllLogs?logs:logs.slice(0,10)).map(log=>{
              const cat=CATS.find(c=>c.id===log.category);
              const st=log.status;
              const sc=st==='posted'?'#34d399':st==='error'?'#f87171':'#fbbf24';
              return(
                <div key={log.id} style={{display:'grid',gridTemplateColumns:'70px 1fr auto',alignItems:'center',gap:8,padding:'9px 10px',background:'var(--surface2)',borderRadius:9,border:'1px solid var(--border)'}}>
                  <span style={{fontSize:10,fontWeight:700,padding:'3px 7px',borderRadius:99,background:sc+'18',color:sc,textAlign:'center'}}>
                    {st==='posted'?'✅ Post':st==='error'?'❌ Err':'⏭️ Skip'}
                  </span>
                  <div style={{minWidth:0}}>
                    <span style={{fontSize:11,fontWeight:700,color:'var(--text)'}}>{cat?.label||log.category}</span>
                    <span style={{fontSize:10,color:'var(--muted)',marginLeft:6,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'inline-block',maxWidth:'60%',verticalAlign:'middle'}}>{log.reason||'—'}</span>
                  </div>
                  <span style={{fontSize:10,color:'var(--dim)',whiteSpace:'nowrap'}}>{timeAgo(log.timestamp)}</span>
                </div>
              );
            })}
            {logs.length>10&&(
              <button onClick={()=>setShowAllLogs(p=>!p)}
                style={{marginTop:4,padding:'8px',borderRadius:8,border:'1.5px solid var(--border)',background:'transparent',color:'var(--muted)',cursor:'pointer',fontSize:12,fontWeight:700,fontFamily:'Outfit',width:'100%',transition:'all .15s'}}
                onMouseOver={e=>e.currentTarget.style.color='var(--accent)'}
                onMouseOut={e=>e.currentTarget.style.color='var(--muted)'}>
                {showAllLogs?'▲ Show Less':(`▼ View All (${logs.length} entries)`)}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Publish All Articles ── */}
      {(()=>{
        const [fixing, setFixing] = useState(false);
        const publishAll = async ()=>{
          if(!confirm('This will set published:true and hidden:false on ALL news articles. Continue?')) return;
          setFixing(true);
          try{
            // Get all news articles
            const all = await db.collection('news').get();
            const docs = all.docs;
            // Batch update all in groups of 400
            for(let i=0;i<docs.length;i+=400){
              const batch = db.batch();
              docs.slice(i,i+400).forEach(d=>batch.update(d.ref,{
                hidden:false, published:true, status:'published'
              }));
              await batch.commit();
            }
            toast.show(`✅ Published all ${docs.length} articles!`,'success');
          }catch(e){ toast.show('Error: '+e.message,'error'); }
          setFixing(false);
        };
        return(
          <div style={{marginTop:14,padding:'12px 14px',background:'rgba(52,211,153,.05)',border:'1px solid rgba(52,211,153,.2)',borderRadius:12,display:'flex',alignItems:'center',gap:12}}>
            <div style={{flex:1}}>
              <p style={{fontSize:12,fontWeight:700,color:'#34d399',marginBottom:2}}>📢 Publish All Articles</p>
              <p style={{fontSize:11,color:'var(--muted)'}}>Sets published:true + hidden:false on every article so they appear in your news app.</p>
            </div>
            <button onClick={publishAll} disabled={fixing}
              style={{flexShrink:0,padding:'8px 14px',borderRadius:9,border:'1.5px solid rgba(52,211,153,.4)',background:'rgba(52,211,153,.1)',color:'#34d399',cursor:'pointer',fontSize:12,fontWeight:700,fontFamily:'Outfit',display:'flex',alignItems:'center',gap:5}}>
              {fixing?<><span className="spinner" style={{width:11,height:11}}/> Publishing…</>:'📢 Publish All'}
            </button>
          </div>
        );
      })()}

      {/* ── Database Diagnostic ── */}
      {(()=>{
        const [dbStatus, setDbStatus] = useState(null);
        const [testing, setTesting] = useState(false);

        const testDb = async ()=>{
          setTesting(true);
          const results = [];
          // 1) TRUE total — no filter, no orderBy, no limit. First try SERVER (to
          //    detect rules/network issues), then fall back to CACHE (so we still
          //    get a count even if the server read is blocked).
          let serverOk = false;
          try{
            const s = await db.collection('news').get({source:'server'});
            serverOk = true;
            let withTs=0, withoutTs=0, ai=0, auto=0, hidden=0, drafts=0;
            const cats = {};
            s.docs.forEach(d=>{
              const x = d.data();
              if(x.timestamp) withTs++; else withoutTs++;
              if(x.aiGenerated) ai++;
              if(x.autoPosted) auto++;
              if(x.hidden===true) hidden++;
              if(x.status==='draft' || (x.published===false && x.aiGenerated===true)) drafts++;
              if(x.category) cats[x.category] = (cats[x.category]||0)+1;
            });
            results.push({name:`🔢 Total on SERVER (live Firestore)`, ok:true, count:s.size,
              detail:`timestamp: ${withTs} · missing-timestamp: ${withoutTs} · aiGenerated: ${ai} · autoPosted: ${auto} · hidden: ${hidden} · drafts: ${drafts}`});
            results.push({name:`📂 Server per-category count`, ok:true, count:Object.keys(cats).length,
              detail:Object.entries(cats).map(([k,v])=>`${k}:${v}`).join(' · ')||'(no category field on any doc)'});
          }catch(e){
            results.push({
              name:'🔢 Total on SERVER (BLOCKED)', ok:false, count:0,
              err:`Server read failed. Reason: (a) Firestore security rules deny read for your account, or (b) no network. Fix rules: allow read:if request.auth != null;  — ${e.message?.slice(0,160)}`,
              indexUrl:'https://console.firebase.google.com/project/kwt-news/firestore/rules'
            });
          }
          // 2) Fallback: cache read (shows what the UI actually has locally).
          try{
            const s = await db.collection('news').get({source:'cache'});
            results.push({name:`💾 Total in LOCAL CACHE`, ok:true, count:s.size,
              detail: serverOk ? 'Same as server (good).' : 'Cache-only read — real count could be higher on server.'});
          }catch(_){
            results.push({name:'💾 Total in LOCAL CACHE', ok:true, count:0, detail:'Cache empty.'});
          }
          // 3) Write probe — confirms whether the admin client can write at all.
          try{
            const ref = await db.collection('_diagnostic').add({
              ts: firebase.firestore.FieldValue.serverTimestamp(),
              at: Date.now(),
              note: 'admin write probe'
            });
            results.push({name:`✍️ Write probe (_diagnostic collection)`, ok:true, count:1, detail:`OK — doc id: ${ref.id}. Writes allowed.`});
            // Clean up — don't leave probe docs behind.
            try{ await ref.delete(); }catch(_){}
          }catch(e){
            results.push({name:'✍️ Write probe (BLOCKED)', ok:false, count:0,
              err:`Writes denied. Security rules block this authenticated user. — ${e.message?.slice(0,160)}`,
              indexUrl:'https://console.firebase.google.com/project/kwt-news/firestore/rules'});
          }
          // 4) Filter-specific probes (these DO use orderBy / where — they show whether
          //    composite indexes exist and whether the filtered subset is non-empty).
          const tests = [
            {name:'orderBy timestamp (silent drops if field missing)', fn:()=>db.collection('news').orderBy('timestamp','desc').limit(5).get()},
            {name:'hidden==false + timestamp',                         fn:()=>db.collection('news').where('hidden','==',false).orderBy('timestamp','desc').limit(5).get()},
            {name:'published==true + timestamp',                       fn:()=>db.collection('news').where('published','==',true).orderBy('timestamp','desc').limit(5).get()},
            {name:'category==world + timestamp',                       fn:()=>db.collection('news').where('category','==','world').orderBy('timestamp','desc').limit(3).get()},
          ];
          for(const t of tests){
            try{
              const s = await t.fn();
              results.push({name:t.name, ok:true, count:s.size, err:null});
            }catch(e){
              // Firestore's missing-index error embeds a console URL. Strip
              // trailing punctuation so the <a href> isn't broken, and
              // swap the `_` placeholder project for the real one.
              let indexUrl = e.message?.match(/https:\/\/console\.firebase\.google\.com\/[^\s"')\]]+/)?.[0] || null;
              if(indexUrl){
                indexUrl = indexUrl.replace(/[.,;:!?)\]]+$/,'').replace('/project/_/','/project/kwt-news/');
              }
              results.push({name:t.name, ok:false, count:0, err:e.message?.slice(0,120), indexUrl});
            }
          }
          // 5) Automation log status breakdown — reveals whether the pipeline is
          //    actually posting, or just skipping/erroring every run.
          try{
            const s = await db.collection('automation_logs').orderBy('timestamp','desc').limit(40).get();
            const by = {posted:0, skipped:0, error:0, other:0};
            const reasons = [];
            s.docs.forEach(d=>{
              const x = d.data();
              if(by[x.status]!==undefined) by[x.status]++; else by.other++;
              if(x.status!=='posted' && reasons.length<3 && x.reason) reasons.push(`[${x.status}] ${x.category||'?'}: ${(x.reason||'').slice(0,80)}`);
            });
            results.push({name:`📊 Last 40 automation runs`, ok:true, count:s.size,
              detail:`posted: ${by.posted} · skipped: ${by.skipped} · error: ${by.error}${reasons.length? ' · Recent: '+reasons.join(' | '):''}`});
          }catch(e){
            results.push({name:'📊 Last 40 automation runs', ok:false, count:0, err:e.message?.slice(0,120)});
          }
          setDbStatus(results);
          setTesting(false);
        };

        // Parse server vs cache counts from results so we can auto-warn when they mismatch.
        const server = dbStatus?.find(r=>r.name?.startsWith('🔢 Total on SERVER') && r.ok);
        const cache  = dbStatus?.find(r=>r.name?.startsWith('💾 Total in LOCAL CACHE') && r.ok);
        const cacheStale = server && cache && server.count > cache.count;

        return(
          <div style={{marginTop:14,padding:'14px',background:'var(--surface)',border:'1px solid var(--border2)',borderRadius:12}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,flexWrap:'wrap'}}>
              <p style={{fontSize:12,fontWeight:700,color:'var(--text)',flex:1}}>🔬 Database Query Test</p>
              <button onClick={()=>{ if(confirm('Clear local Firestore cache and reload?')) window.__forceResync(); }}
                style={{padding:'6px 12px',borderRadius:8,border:'1.5px solid rgba(96,165,250,.35)',background:'rgba(96,165,250,.1)',color:'#60a5fa',cursor:'pointer',fontSize:11,fontWeight:700,fontFamily:'Outfit'}}>
                🔄 Force Resync
              </button>
              <button onClick={testDb} disabled={testing}
                style={{padding:'6px 14px',borderRadius:8,border:'1.5px solid var(--border2)',background:'var(--surface2)',color:'var(--muted)',cursor:'pointer',fontSize:11,fontWeight:700,fontFamily:'Outfit',display:'flex',alignItems:'center',gap:5}}>
                {testing?<><span className="spinner" style={{width:10,height:10}}/> Testing…</>:'▶ Run Test'}
              </button>
            </div>
            <p style={{fontSize:11,color:'var(--dim)',marginBottom:dbStatus?10:0}}>Tests the Firestore queries your news app uses. If server count &gt; cache count, tap <strong>Force Resync</strong>.</p>
            {cacheStale&&(
              <div style={{marginBottom:10,padding:'10px 12px',borderRadius:8,background:'rgba(245,166,35,.12)',border:'1px solid rgba(245,166,35,.4)'}}>
                <p style={{fontSize:11,fontWeight:800,color:'var(--accent)',marginBottom:4}}>⚠️ Local cache is stale — server has {server.count} docs, cache has {cache.count}.</p>
                <p style={{fontSize:10.5,color:'var(--muted)',lineHeight:1.6,marginBottom:8}}>Your browser is showing old data from before the Firestore rules were fixed. Tap the button below to wipe the cache and re-fetch from the server.</p>
                <button onClick={()=>window.__forceResync()} style={{padding:'8px 14px',borderRadius:8,border:'1.5px solid var(--accent)',background:'var(--accent)',color:'#000',cursor:'pointer',fontSize:11,fontWeight:800,fontFamily:'Outfit'}}>
                  🔄 Clear Cache & Reload Now
                </button>
              </div>
            )}
            {dbStatus&&(
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {dbStatus.map((r,i)=>(
                  <div key={i} style={{padding:'8px 10px',borderRadius:8,background:'var(--surface2)',border:`1px solid ${r.ok?'rgba(52,211,153,.3)':'rgba(248,113,113,.3)'}`}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:14}}>{r.ok?'✅':'❌'}</span>
                      <span style={{fontSize:11,fontWeight:700,flex:1,color:'var(--text)'}}>{r.name}</span>
                      {r.ok&&<span style={{fontSize:10,color:'#34d399',background:'rgba(52,211,153,.1)',padding:'2px 7px',borderRadius:99}}>{r.count} docs</span>}
                    </div>
                    {r.ok&&r.detail&&(
                      <p style={{fontSize:10,color:'var(--dim)',marginTop:4,lineHeight:1.5,wordBreak:'break-word'}}>{r.detail}</p>
                    )}
                    {!r.ok&&(
                      <div style={{marginTop:5}}>
                        {r.err&&<p style={{fontSize:10,color:'#f87171',lineHeight:1.5}}>{r.err}</p>}
                        {r.indexUrl?(
                          <a href={r.indexUrl} target="_blank" rel="noreferrer"
                            style={{display:'inline-block',marginTop:4,fontSize:11,fontWeight:700,color:'var(--accent)',background:'rgba(245,166,35,.1)',border:'1px solid rgba(245,166,35,.3)',borderRadius:6,padding:'4px 10px',textDecoration:'none'}}>
                            🔧 Create Index in Firebase Console →
                          </a>
                        ):(
                          <a href="https://console.firebase.google.com/project/kwt-news/firestore/indexes" target="_blank" rel="noreferrer"
                            style={{display:'inline-block',marginTop:4,fontSize:11,fontWeight:700,color:'var(--accent)',background:'rgba(245,166,35,.1)',border:'1px solid rgba(245,166,35,.3)',borderRadius:6,padding:'4px 10px',textDecoration:'none'}}>
                            🔧 Open Firestore Indexes →
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {dbStatus.every(r=>r.ok)&&(
                  <div style={{padding:'10px',background:'rgba(52,211,153,.08)',borderRadius:8,textAlign:'center'}}>
                    <p style={{fontSize:12,color:'#34d399',fontWeight:700}}>✅ All queries work! If news still doesn't show, run "📢 Publish All" above.</p>
                  </div>
                )}
                {dbStatus.some(r=>!r.ok)&&(
                  <div style={{padding:'10px',background:'rgba(248,113,113,.06)',borderRadius:8}}>
                    <p style={{fontSize:11,color:'#f87171',fontWeight:700,marginBottom:4}}>⚠️ Some queries require Firestore indexes</p>
                    <p style={{fontSize:11,color:'var(--muted)',lineHeight:1.7}}>
                      1. Tap each "🔧 Create Index" link above → creates index automatically<br/>
                      2. Wait ~2 minutes for index to build<br/>
                      3. Run this test again to confirm ✅
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── How it works ── */}
      <div style={{marginTop:14,padding:'12px 14px',background:'rgba(96,165,250,.05)',border:'1px solid rgba(96,165,250,.15)',borderRadius:12}}>
        <p style={{fontSize:11,fontWeight:700,color:'#60a5fa',marginBottom:6}}>ℹ️ How it works</p>
        <p style={{fontSize:11,color:'var(--muted)',lineHeight:1.8}}>
          <strong style={{color:'var(--text)'}}>Auto:</strong> GitHub Actions runs on schedule (no action needed from you).<br/>
          <strong style={{color:'var(--text)'}}>Manual:</strong> Press <strong>▶ Run</strong> beside a category or <strong>🚀 Run All</strong> to trigger now.<br/>
          <strong style={{color:'var(--text)'}}>Toggle:</strong> Green = ON (will post). Grey = OFF (skips that category).<br/>
          <strong style={{color:'var(--text)'}}>Voice:</strong> Hindi (Devanagari) script with hi-IN Edge TTS voices.<br/>
          <strong style={{color:'var(--text)'}}>Flow:</strong> RSS feed → AI Hindi script → TTS audio → video clips → final MP4 → Firebase
        </p>
      </div>
    </div>
  );
};

// ── SETTINGS ──────────────────────────────────────────────────
const SettingsPage = ({user,toast}) => (
  <div className="fade-up">
    <div style={{marginBottom:20}}>
      <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>Settings</h1>
      <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>Account & configuration</p>
    </div>
    <div className="card" style={{padding:20,marginBottom:16}}>
      <p style={{fontWeight:700,fontSize:14,marginBottom:14,display:'flex',alignItems:'center',gap:8}}>
        <Ic n="star" s={15} c="var(--accent)"/> Your Account
      </p>
      <div style={{display:'flex',gap:14,alignItems:'center',padding:'16px',background:'var(--surface2)',borderRadius:12,border:'1px solid var(--border)'}}>
        <img src={user.photoURL||`https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName||'A')}&background=F5A623&color=050c18&size=100`} style={{width:52,height:52,borderRadius:'50%',objectFit:'cover',border:'2px solid var(--accent)',flexShrink:0}}/>
        <div>
          <p style={{fontWeight:700,fontSize:15}}>{user.displayName||'Admin'}</p>
          <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>{user.email}</p>
          <p style={{fontSize:11,color:'var(--success)',marginTop:4,fontWeight:600}}>✓ Logged in</p>
        </div>
      </div>
    </div>
    <div className="card" style={{padding:20}}>
      <p style={{fontWeight:700,fontSize:14,marginBottom:4,display:'flex',alignItems:'center',gap:8}}>
        <Ic n="cog" s={15} c="var(--muted)"/> App Info
      </p>
      <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:14}}>
        {[['Project','KWT News'],['Firebase','kwt-news'],['Version','2.0.0'],['Build','2026']].map(([k,v])=>(
          <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'10px 0',borderBottom:'1px solid var(--border)'}}>
            <span style={{fontSize:13,color:'var(--muted)'}}>{k}</span>
            <span style={{fontSize:13,fontWeight:600,fontFamily:'DM Mono,monospace'}}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// ── LOGOS MANAGER ────────────────────────────────────────────
const LogosManager = ({toast}) => {
  const [logos,        setLogos]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [form,         setForm]         = useState({name:'',url:''});
  const [saving,       setSaving]       = useState(false);
  const [preview,      setPreview]      = useState('');
  const [domainInput,  setDomainInput]  = useState('');
  const [tab,          setTab]          = useState('domain'); // 'domain'|'pixabay'|'url'|'phone'
  const [galleryQ,     setGalleryQ]     = useState('');
  const [gallery,      setGallery]      = useState([]);
  const [searching,    setSearching]    = useState(false);
  const [phoneUploading, setPhoneUploading] = useState(false);
  const phoneInputRef = useRef(null);

  useEffect(()=>{
    // Logos change rarely — one-time get() avoids a persistent WebSocket listener
    db.collection('logos').orderBy('name').get()
      .then(s=>{ setLogos(s.docs.map(d=>({id:d.id,...d.data()}))); setLoading(false); })
      .catch(()=>setLoading(false));
  },[]);

  // ── Domain → Clearbit logo ──────────────────────────────────
  const applyDomain = ()=>{
    const raw = domainInput.trim().toLowerCase()
      .replace(/^https?:\/\//,'').replace(/\/.*$/,'');
    if(!raw){ toast.show('Enter a domain name e.g. bbc.com','error'); return; }
    const url = `https://logo.clearbit.com/${raw}`;
    setForm(p=>({...p, url, name:p.name||raw.replace(/\.(com|net|org|kw|ae|co|uk)$/,'').replace(/\./g,' ')}));
    setPreview(url);
    toast.show('Logo loaded — verify preview then save','success');
  };

  // ── Pixabay gallery search ──────────────────────────────────
  const searchGallery = async ()=>{
    if(!galleryQ.trim()){ toast.show('Enter search term','error'); return; }
    setSearching(true);
    try{
      const r=await fetch(`https://pixabay.com/api/?key=${AI_CFG.pixabayKey}&q=${encodeURIComponent(galleryQ)}&image_type=vector&safesearch=true&per_page=18&min_width=80`);
      const d=await r.json();
      setGallery(d.hits||[]);
      if(!d.hits?.length) toast.show('No images found — try different keywords','error');
    }catch(e){ toast.show('Search error: '+e.message,'error'); }
    setSearching(false);
  };

  const pickImage = url=>{
    setForm(p=>({...p,url})); setPreview(url);
    toast.show('Image selected — enter name and save','success');
  };

  // ── Phone gallery upload to Cloudinary ──────────────────────
  const handlePhoneFile = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    // Show local preview immediately
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);
    setPhoneUploading(true);
    try{
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', CLOUDINARY.uploadPreset);
      fd.append('folder', 'logos');
      const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/image/upload`, {method:'POST', body:fd});
      const data = await res.json();
      if(data.error) throw new Error(data.error.message);
      const cloudUrl = data.secure_url;
      setForm(p=>({...p, url:cloudUrl}));
      setPreview(cloudUrl);
      toast.show('✅ Image uploaded — enter name and save','success');
    }catch(err){
      toast.show('Upload failed: '+err.message,'error');
    }
    setPhoneUploading(false);
    // Reset file input so same file can be re-selected
    if(phoneInputRef.current) phoneInputRef.current.value='';
  };

  const add = async()=>{
    const name=form.name.trim(), url=form.url.trim();
    if(!name||!url){ toast.show('Both name and URL required','error'); return; }
    if(!url.startsWith('http')){ toast.show('URL must start with http','error'); return; }
    setSaving(true);
    try{
      await db.collection('logos').add({name,url,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
      setForm({name:'',url:''}); setPreview(''); setDomainInput('');
      toast.show('✅ Logo added!','success');
    }catch(e){ toast.show('Error: '+e.message,'error'); }
    setSaving(false);
  };

  const del = async(id,name)=>{
    if(!confirm(`Delete logo for "${name}"?`)) return;
    try{
      await db.collection('logos').doc(id).delete();
      toast.show('Deleted','success');
    }catch(e){ toast.show('Error: '+e.message,'error'); }
  };

  const TAB_BTN = (id,label)=>(
    <button onClick={()=>setTab(id)}
      style={{padding:'7px 13px',borderRadius:8,border:`1.5px solid ${tab===id?'var(--accent)':'var(--border)'}`,
        background:tab===id?'rgba(245,166,35,.12)':'var(--surface2)',color:tab===id?'var(--accent)':'var(--muted)',
        cursor:'pointer',fontSize:12,fontWeight:700,fontFamily:'Outfit'}}>
      {label}
    </button>
  );

  return (
    <div className="fade-up">
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
        <div style={{width:38,height:38,borderRadius:12,background:'linear-gradient(135deg,#1a2d4a,#243a59)',border:'1px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
          <span style={{fontSize:18}}>🏷️</span>
        </div>
        <div>
          <h1 style={{fontSize:20,fontWeight:800,letterSpacing:'-.02em',lineHeight:1}}>Source Logos</h1>
          <p style={{fontSize:11,color:'var(--muted)',marginTop:2}}>Logo images for news sources — used in auto-posted articles</p>
        </div>
      </div>

      {/* ── Add card ── */}
      <div className="card" style={{padding:18,marginBottom:16}}>
        <p style={{fontWeight:700,fontSize:13,marginBottom:12}}>➕ Add Source Logo</p>

        {/* Tab selector */}
        <div style={{display:'flex',gap:6,marginBottom:14,flexWrap:'wrap'}}>
          {TAB_BTN('domain','🌐 Domain Auto')}
          {TAB_BTN('pixabay','🖼️ Image Search')}
          {TAB_BTN('phone','📱 Phone Gallery')}
          {TAB_BTN('url','🔗 Paste URL')}
        </div>

        {/* Domain tab */}
        {tab==='domain'&&(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <p style={{fontSize:11,color:'var(--muted)'}}>Enter the news site domain — logo fetched automatically via Clearbit.</p>
            <div style={{display:'flex',gap:8}}>
              <input className="inp" style={{flex:1}} value={domainInput}
                onChange={e=>setDomainInput(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&applyDomain()}
                placeholder="e.g.  bbc.com  /  aljazeera.com  /  reuters.com"/>
              <button className="btn btn-accent" onClick={applyDomain} style={{padding:'10px 16px',fontWeight:700,flexShrink:0}}>Fetch</button>
            </div>
            <p style={{fontSize:10,color:'var(--dim)'}}>Works best with major news sites. If logo doesn't load, switch to Image Search.</p>
          </div>
        )}

        {/* Pixabay gallery tab */}
        {tab==='pixabay'&&(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <p style={{fontSize:11,color:'var(--muted)'}}>Search Pixabay for a logo image and click to select it.</p>
            <div style={{display:'flex',gap:8}}>
              <input className="inp" style={{flex:1}} value={galleryQ}
                onChange={e=>setGalleryQ(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&searchGallery()}
                placeholder="Search images e.g. BBC logo, newspaper icon, TV news"/>
              <button className="btn btn-accent" onClick={searchGallery} disabled={searching}
                style={{padding:'10px 16px',fontWeight:700,flexShrink:0}}>
                {searching?<span className="spinner" style={{width:13,height:13}}/>:'Search'}
              </button>
            </div>
            {gallery.length>0&&(
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(72px,1fr))',gap:6,maxHeight:220,overflowY:'auto',padding:4}}>
                {gallery.map(hit=>(
                  <div key={hit.id} onClick={()=>pickImage(hit.webformatURL)}
                    style={{cursor:'pointer',borderRadius:8,overflow:'hidden',border:`2px solid ${form.url===hit.webformatURL?'var(--accent)':'var(--border)'}`,aspectRatio:'1',background:'#fff',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <img src={hit.previewURL} alt="" style={{width:'100%',height:'100%',objectFit:'contain'}}/>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Phone gallery tab */}
        {tab==='phone'&&(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <p style={{fontSize:11,color:'var(--muted)'}}>Select an image from your phone or computer. It will be uploaded to cloud and saved as logo.</p>
            <input ref={phoneInputRef} type="file" accept="image/*" style={{display:'none'}} onChange={handlePhoneFile}/>
            <button className="btn btn-accent" onClick={()=>phoneInputRef.current?.click()} disabled={phoneUploading}
              style={{padding:'12px 20px',fontWeight:700,fontSize:13,display:'flex',alignItems:'center',gap:8,justifyContent:'center'}}>
              {phoneUploading
                ?<><span className="spinner" style={{width:14,height:14}}/> Uploading...</>
                :<>📱 Choose from Gallery</>}
            </button>
            {preview&&(
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'var(--surface2)',borderRadius:10,border:'1px solid var(--border)'}}>
                <img src={preview} alt="preview" style={{width:48,height:48,borderRadius:8,objectFit:'contain',background:'#fff',border:'1px solid var(--border)',flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <p style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>Uploaded ✅</p>
                  <p style={{fontSize:10,color:'var(--dim)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{form.url}</p>
                </div>
              </div>
            )}
            <p style={{fontSize:10,color:'var(--dim)'}}>Supports JPG, PNG, SVG, WebP. Max 10MB.</p>
          </div>
        )}

        {/* Manual URL tab */}
        {tab==='url'&&(
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <p style={{fontSize:11,color:'var(--muted)'}}>Paste a direct image URL for the logo.</p>
            <div style={{display:'flex',gap:8}}>
              <input className="inp" style={{flex:1}} value={form.url}
                onChange={e=>{ setForm(p=>({...p,url:e.target.value})); setPreview(e.target.value.trim()); }}
                placeholder="https://example.com/logo.png"/>
              {preview&&<img src={preview} alt="preview"
                style={{width:44,height:44,borderRadius:8,objectFit:'contain',border:'1px solid var(--border)',background:'#fff',flexShrink:0}}
                onError={e=>e.target.style.display='none'}/>}
            </div>
          </div>
        )}

        {/* Preview + name + save (shared) */}
        <div style={{marginTop:12,display:'flex',flexDirection:'column',gap:8}}>
          {preview&&(
            <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'var(--surface2)',borderRadius:10,border:'1px solid var(--border)'}}>
              <img src={preview} alt="preview"
                style={{width:44,height:44,borderRadius:8,objectFit:'contain',background:'#fff',border:'1px solid var(--border)',flexShrink:0}}
                onError={e=>{e.target.style.display='none';}}/>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:11,color:'var(--muted)'}}>Preview</p>
                <p style={{fontSize:10,color:'var(--dim)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{form.url}</p>
              </div>
            </div>
          )}
          <input className="inp" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))}
            placeholder="Source name  e.g. BBC News, Al Jazeera, Reuters"/>
          <button className="btn btn-accent" onClick={add} disabled={saving||!form.url||!form.name} style={{padding:'11px',fontWeight:700}}>
            {saving?'Saving…':'💾 Save Logo'}
          </button>
        </div>
      </div>

      {/* ── Logos list ── */}
      <div className="card" style={{padding:18}}>
        <div style={{display:'flex',alignItems:'center',marginBottom:14}}>
          <p style={{fontWeight:700,fontSize:13}}>📋 All Logos ({logos.length})</p>
        </div>
        {loading?(
          <div style={{textAlign:'center',padding:24}}><span className="spinner" style={{width:20,height:20}}/></div>
        ):logos.length===0?(
          <div style={{textAlign:'center',padding:28}}>
            <div style={{fontSize:32,marginBottom:8}}>🖼️</div>
            <p style={{fontSize:13,color:'var(--muted)'}}>No logos yet</p>
            <p style={{fontSize:11,color:'var(--dim)',marginTop:4}}>Add logos above — matched to source names in auto-posts</p>
            <div style={{marginTop:14,textAlign:'left',background:'var(--surface2)',borderRadius:10,padding:'12px 14px',fontSize:11,color:'var(--dim)',lineHeight:1.8}}>
              <strong style={{color:'var(--muted)'}}>Common sources to add:</strong><br/>
              BBC News (bbc.com) • Al Jazeera (aljazeera.com) • Reuters (reuters.com)<br/>
              Arab Times Online (arabtimesonline.com) • Kuwait Times (kuwaittimes.com)
            </div>
          </div>
        ):(
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {logos.map(logo=>(
              <div key={logo.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'var(--surface2)',borderRadius:10,border:'1px solid var(--border)'}}>
                {/* Logo image with letter-avatar fallback */}
                <div style={{width:36,height:36,borderRadius:8,background:'var(--surface)',border:'1px solid var(--border)',flexShrink:0,overflow:'hidden',display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <img src={logo.url} alt={logo.name}
                    style={{width:'100%',height:'100%',objectFit:'contain',background:'#fff'}}
                    onError={e=>{
                      e.target.style.display='none';
                      e.target.nextSibling.style.display='flex';
                    }}/>
                  <span style={{display:'none',width:'100%',height:'100%',alignItems:'center',justifyContent:'center',fontSize:16,fontWeight:800,color:'var(--accent)',background:'rgba(245,166,35,.1)'}}>
                    {(logo.name||'?')[0].toUpperCase()}
                  </span>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <p style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>{logo.name}</p>
                  <p style={{fontSize:10,color:'var(--dim)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{logo.url}</p>
                </div>
                <button onClick={()=>del(logo.id,logo.name)}
                  style={{background:'rgba(248,113,113,.12)',border:'1px solid rgba(248,113,113,.3)',color:'#f87171',borderRadius:8,padding:'5px 10px',cursor:'pointer',fontSize:11,fontWeight:700,fontFamily:'Outfit',flexShrink:0}}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ── CATEGORY MANAGER ─────────────────────────────────────────
const CategoryManager = ({toast, onNavigate}) => {
  const [counts,setCounts] = useState({});
  const [loading,setLoading] = useState(true);

  useEffect(()=>{
    // Reuse Dashboard's cached per-category counts when available; only open a
    // listener if cache is empty. Avoids downloading the entire collection here.
    const cached = window.__newsCache && window.__newsCache.catCounts;
    if(cached && Object.keys(cached).length){
      const c={}; CATEGORIES.forEach(cat=>{ c[cat.value] = cached[cat.value]||0; });
      setCounts(c); setLoading(false);
      return ()=>{};
    }
    const u=db.collection('news').limit(500).onSnapshot(s=>{
      const c={};
      CATEGORIES.forEach(cat=>{ c[cat.value]=0; });
      s.docs.forEach(d=>{
        const cat=d.data().category;
        if(cat) c[cat]=(c[cat]||0)+1;
      });
      setCounts(c);
      setLoading(false);
    });
    return ()=>u();
  },[]);

  return (
    <div className="fade-up">
      <div style={{marginBottom:24}}>
        <h1 style={{fontFamily:'Outfit',fontSize:24,fontWeight:800,letterSpacing:'-.02em'}}>Categories</h1>
        <p style={{fontSize:12,color:'var(--muted)',marginTop:3}}>Manage the 5 news categories. Home feed hides special categories.</p>
      </div>

      {/* Info banner */}
      <div style={{padding:'14px 16px',borderRadius:12,background:'rgba(96,165,250,.07)',border:'1px solid rgba(96,165,250,.18)',marginBottom:20,display:'flex',gap:12,alignItems:'flex-start'}}>
        <span style={{fontSize:18,flexShrink:0}}>ℹ️</span>
        <div>
          <p style={{fontSize:13,fontWeight:700,color:'var(--info)',marginBottom:3}}>Category Rules</p>
          <p style={{fontSize:12,color:'var(--muted)',lineHeight:1.6}}>
            <strong style={{color:'var(--text)'}}>🏠 Kuwait &amp; 🌍 World</strong> appear on the Home feed.<br/>
            <strong style={{color:'var(--accent)'}}>💼 Kuwait Jobs · 🛍️ Kuwait Offers · 😂 Funny &amp; Memes</strong> are <strong style={{color:'var(--danger)'}}>hidden from Home</strong> — they show only on their own tab/page.
          </p>
        </div>
      </div>

      {/* Category cards grid */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:14}}>
        {CATEGORIES.map(cat=>{
          const count=counts[cat.value]||0;
          const isSpecial=['kuwait-jobs','kuwait-offers','funny-news-meme'].includes(cat.value);
          return (
            <div key={cat.value} style={{background:'var(--surface)',border:`1.5px solid ${isSpecial?'rgba(245,166,35,.25)':'var(--border)'}`,borderRadius:16,padding:18,transition:'transform .15s'}}
              onMouseEnter={e=>e.currentTarget.style.transform='translateY(-2px)'}
              onMouseLeave={e=>e.currentTarget.style.transform=''}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                <span style={{fontSize:28}}>{cat.label.split(' ')[0]}</span>
                {isSpecial
                  ? <span style={{fontSize:9,fontWeight:800,padding:'3px 8px',borderRadius:999,background:'rgba(245,166,35,.12)',color:'var(--accent)',border:'1px solid rgba(245,166,35,.25)',letterSpacing:'.04em'}}>SPECIAL</span>
                  : <span style={{fontSize:9,fontWeight:800,padding:'3px 8px',borderRadius:999,background:'rgba(52,211,153,.1)',color:'var(--success)',border:'1px solid rgba(52,211,153,.2)',letterSpacing:'.04em'}}>HOME</span>
                }
              </div>
              <p style={{fontSize:14,fontWeight:700,marginBottom:3}}>{cat.label.replace(/^\S+\s/,'')}</p>
              <p style={{fontSize:10,color:'var(--dim)',marginBottom:12,fontFamily:'DM Mono,monospace'}}>slug: {cat.value}</p>
              <div style={{borderTop:'1px solid var(--border)',paddingTop:12,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <div>
                  {loading
                    ? <div className="shimmer" style={{width:32,height:22,borderRadius:6}}></div>
                    : <p style={{fontSize:26,fontWeight:800,color:cat.color,letterSpacing:'-.03em',lineHeight:1}}>{count}</p>
                  }
                  <p style={{fontSize:10,color:'var(--dim)',marginTop:2}}>articles</p>
                </div>
                <button className="btn btn-accent" style={{padding:'8px 14px',fontSize:12,gap:5}}
                  onClick={()=>{ onNavigate&&onNavigate('news',cat.value); }}>
                  <Ic n="news" s={12}/> View
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Total summary */}
      <div style={{marginTop:20,padding:'14px 18px',borderRadius:12,background:'var(--surface2)',border:'1px solid var(--border)',display:'flex',gap:16,flexWrap:'wrap'}}>
        <div>
          <p style={{fontSize:22,fontWeight:800,color:'var(--accent)'}}>{Object.values(counts).reduce((a,b)=>a+b,0)}</p>
          <p style={{fontSize:11,color:'var(--dim)'}}>Total Articles</p>
        </div>
        {CATEGORIES.map(c=>(
          <div key={c.value} style={{display:'flex',flexDirection:'column',alignItems:'center',minWidth:60}}>
            <p style={{fontSize:18,fontWeight:800,color:c.color}}>{counts[c.value]||0}</p>
            <p style={{fontSize:9,color:'var(--dim)',textAlign:'center',lineHeight:1.3}}>{c.label.replace(/^\S+\s/,'')}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── AI NEWS MANAGER ───────────────────────────────────────────
// ── Canvas text helper ────────────────────────────────────────
const wrapTxt = (ctx, txt, x, y, maxW, lh) => {
  const words = (txt||'').split(' ');
  let line = '', cy = y;
  for(const w of words){
    const t = line + w + ' ';
    if(ctx.measureText(t).width > maxW && line){ ctx.fillText(line.trim(),x,cy); line=w+' '; cy+=lh; }
    else line = t;
  }
  if(line.trim()) ctx.fillText(line.trim(),x,cy);
  return cy;
};

// ── News Video Generator (Canvas + MediaRecorder) ─────────────
const makeNewsVideo = (article, durSecs=20) => new Promise((resolve,reject) => {
  const W=1280, H=720;
  const cv = document.createElement('canvas');
  cv.width=W; cv.height=H;
  const ctx = cv.getContext('2d');
  const catInfo = CATEGORIES.find(c=>c.value===article.category)||{label:'World News',color:'#60a5fa'};
  const accent = catInfo.color||'#F5A623';
  const dateStr = new Date().toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
  const title = (article.title||'Latest News').trim();
  const summary = (article.summary||'').trim();
  const source = article.source||'KWT News';
  const easeOut = t => 1 - Math.pow(1-Math.min(1,t), 3);
  const easeIn  = t => Math.min(1,t)*Math.min(1,t);
  const lerp    = (a,b,t) => a+(b-a)*Math.min(1,Math.max(0,t));

  // Pre-wrap title lines for left panel
  const titleLines = (()=>{
    ctx.font='bold 50px Arial'; const maxW=W*0.51;
    const words=title.split(' '); let line='', lines=[];
    for(const w of words){
      const t=line+w+' ';
      if(ctx.measureText(t).width>maxW&&line){lines.push(line.trim());line=w+' ';}else line=t;
    }
    if(line.trim())lines.push(line.trim());
    return lines.slice(0,3);
  })();

  const tickerFull = `${title}  •  ${catInfo.label.replace(/^\S+\s/,'')}  •  ${source}  •  KWT News  •  ${dateStr}  •  `;
  let tickerX = W;

  const render = (bgImg, logoImg, audioStream=null) => {
    const videoStream = cv.captureStream(25);
    const recStream = audioStream
      ? new MediaStream([...videoStream.getVideoTracks(),...audioStream.getAudioTracks()])
      : videoStream;
    const mimes = audioStream
      ? ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']
      : ['video/webm;codecs=vp9','video/webm'];
    const mime = mimes.find(m=>MediaRecorder.isTypeSupported(m))||'video/webm';
    let rec;
    try{ rec = new MediaRecorder(recStream,{mimeType:mime,videoBitsPerSecond:3500000}); }
    catch(e){ return reject(new Error('MediaRecorder not supported: '+e.message)); }
    const chunks=[];
    rec.ondataavailable=e=>{ if(e.data.size>0)chunks.push(e.data); };
    rec.onstop=()=>{ const blob=new Blob(chunks,{type:'video/webm'}); resolve({url:URL.createObjectURL(blob),blob}); };
    rec.start(200);
    const t0=performance.now();

    const frame=()=>{
      const el=performance.now()-t0;
      if(el>=durSecs*1000){ rec.stop(); return; }
      const sec=el/1000, prog=el/(durSecs*1000);

      // ─── BACKGROUND ───────────────────────────────────────
      if(bgImg){
        const zoom=1+prog*0.06;
        ctx.filter='blur(6px) brightness(0.3) saturate(1.3)';
        ctx.drawImage(bgImg,(W-W*zoom)/2-10,(H-H*zoom)/2-10,W*zoom+20,H*zoom+20);
        ctx.filter='none';
        // Dark gradient overlay
        const ov=ctx.createLinearGradient(0,0,W,0);
        ov.addColorStop(0,'rgba(5,12,24,0.92)'); ov.addColorStop(0.55,'rgba(5,12,24,0.75)'); ov.addColorStop(1,'rgba(5,12,24,0.15)');
        ctx.fillStyle=ov; ctx.fillRect(0,0,W,H);
      } else {
        const bg=ctx.createLinearGradient(0,0,W,H);
        bg.addColorStop(0,'#020810'); bg.addColorStop(1,'#0c1a30');
        ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
        // Grid lines
        ctx.strokeStyle='rgba(255,255,255,0.025)'; ctx.lineWidth=1;
        for(let x=0;x<W;x+=80){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
        for(let y=0;y<H;y+=80){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
      }

      // ─── RIGHT IMAGE PANEL (slides from right at 0.4s) ────
      if(bgImg && sec>0.3){
        const t=easeOut((sec-0.3)/0.7);
        const imgW=W*0.46, imgX=lerp(W,W-imgW,t);
        ctx.save();
        ctx.beginPath(); ctx.rect(W/2+20,72,imgW+100,H-72-48); ctx.clip();
        ctx.drawImage(bgImg,imgX,72,imgW,H-72-48);
        // Gradient fade left edge of image
        const ig=ctx.createLinearGradient(W/2+20,0,W/2+160,0);
        ig.addColorStop(0,'rgba(5,12,24,1)'); ig.addColorStop(1,'rgba(5,12,24,0)');
        ctx.fillStyle=ig; ctx.fillRect(W/2+20,72,140,H-120);
        ctx.restore();
      }

      // ─── TOP HEADER BAR ────────────────────────────────────
      const hg=ctx.createLinearGradient(0,0,0,68);
      hg.addColorStop(0,'rgba(5,12,24,0.98)'); hg.addColorStop(1,'rgba(5,12,24,0.9)');
      ctx.fillStyle=hg; ctx.fillRect(0,0,W,68);
      ctx.fillStyle='#F5A623'; ctx.fillRect(0,66,W,3); // accent line
      // KWT NEWS wordmark
      ctx.fillStyle='#ffffff'; ctx.font='bold 30px Arial';
      ctx.fillText('KWT',22,45);
      ctx.fillStyle='#F5A623'; ctx.fillText(' NEWS',78,45);
      // Separator
      ctx.strokeStyle='rgba(255,255,255,0.18)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(170,16); ctx.lineTo(170,52); ctx.stroke();
      // LIVE badge
      if(Math.floor(sec*2)%2===0) ctx.fillStyle='rgba(239,68,68,0.95)'; else ctx.fillStyle='rgba(180,40,40,0.95)';
      ctx.beginPath(); ctx.roundRect(182,22,66,26,5); ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='bold 12px Arial'; ctx.fillText('● LIVE',190,39);
      // Date (right)
      ctx.textAlign='right';
      ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.font='13px Arial';
      ctx.fillText(dateStr,W-20,42); ctx.textAlign='left';

      // ─── CATEGORY BADGE (appears at 0.3s) ──────────────────
      if(sec>0.3){
        const t=easeOut((sec-0.3)/0.4);
        ctx.globalAlpha=t;
        ctx.fillStyle=accent;
        ctx.beginPath(); ctx.roundRect(22,80,200,30,6); ctx.fill();
        ctx.fillStyle='#050c18'; ctx.font='bold 13px Arial';
        ctx.fillText(catInfo.label.replace(/^\S+\s/,'').toUpperCase(),30,100);
        if(article.isBreaking){
          ctx.fillStyle='#ef4444';
          ctx.beginPath(); ctx.roundRect(232,80,150,30,6); ctx.fill();
          ctx.fillStyle='#fff'; ctx.font='bold 13px Arial';
          ctx.fillText('⚡ BREAKING NEWS',240,100);
        }
        ctx.globalAlpha=1;
      }

      // ─── HEADLINE (slides from left at 0.6s) ───────────────
      if(sec>0.6){
        const t=easeOut((sec-0.6)/0.6);
        ctx.save();
        ctx.beginPath(); ctx.rect(0,115,W*0.54+30,H-115-48); ctx.clip();
        ctx.shadowColor='rgba(0,0,0,0.95)'; ctx.shadowBlur=18; ctx.shadowOffsetX=2; ctx.shadowOffsetY=2;
        let ty=165;
        titleLines.forEach((ln,idx)=>{
          const lineDelay=idx*0.12;
          const lt=easeOut(Math.max(0,(sec-0.6-lineDelay)/0.5));
          ctx.globalAlpha=lt;
          ctx.fillStyle='#ffffff'; ctx.font='bold 50px Arial';
          const lx=lerp(-900,22,easeOut(Math.max(0,(sec-0.6-lineDelay)/0.45)));
          ctx.fillText(ln,lx,ty); ty+=64;
        });
        ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0; ctx.globalAlpha=1; ctx.restore();
      }

      // ─── ACCENT LINE LEFT (animates at 1.2s) ───────────────
      if(sec>1.2){
        const t=easeOut((sec-1.2)/0.4);
        const lineH=lerp(0,Math.min(titleLines.length*64+10,H-250),t);
        ctx.fillStyle=accent; ctx.fillRect(8,165-40,4,lineH);
      }

      // ─── SUMMARY (fades in at 4.5s) ────────────────────────
      if(sec>4.2 && summary){
        const t=easeOut((sec-4.2)/0.8);
        ctx.globalAlpha=t;
        // Subtle separator
        ctx.fillStyle='rgba(255,255,255,0.12)'; ctx.fillRect(22,titleLines.length*64+165-20,W*0.52-44,1);
        ctx.fillStyle='rgba(210,225,245,0.88)'; ctx.font='21px Arial';
        ctx.shadowColor='rgba(0,0,0,0.8)'; ctx.shadowBlur=10;
        wrapTxt(ctx, summary, 22, titleLines.length*64+165+8, W*0.52-44, 32);
        ctx.shadowBlur=0; ctx.globalAlpha=1;
      }

      // ─── LOWER-THIRD (slides up at 3s) ─────────────────────
      if(sec>2.8){
        const t=easeOut((sec-2.8)/0.5);
        const ltY=lerp(H,H-170,t);
        ctx.fillStyle='rgba(5,12,24,0.94)'; ctx.fillRect(0,ltY,W*0.54,90);
        ctx.fillStyle=accent; ctx.fillRect(0,ltY,5,90);
        // Source logo circle
        if(logoImg){
          ctx.save();
          ctx.beginPath(); ctx.arc(28,ltY+30,18,0,Math.PI*2); ctx.closePath();
          ctx.clip(); ctx.drawImage(logoImg,10,ltY+12,36,36); ctx.restore();
        }
        const ltx = logoImg?52:14;
        ctx.fillStyle=accent; ctx.font='bold 11px Arial'; ctx.letterSpacing='1px';
        ctx.fillText('SOURCE',ltx,ltY+20); ctx.letterSpacing='0px';
        ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.font='bold 16px Arial';
        ctx.fillText(source,ltx,ltY+42);
        ctx.fillStyle='rgba(255,255,255,0.2)'; ctx.fillRect(ltx,ltY+52,W*0.54-ltx-14,1);
        ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.font='12px Arial';
        ctx.fillText(article.readTime||'3 min read',ltx,ltY+70);
      }

      // ─── TICKER BAR (bottom) ────────────────────────────────
      ctx.fillStyle='rgba(5,12,24,0.97)'; ctx.fillRect(0,H-46,W,46);
      ctx.fillStyle=accent; ctx.fillRect(0,H-47,W,2);
      ctx.fillStyle=accent; ctx.fillRect(0,H-46,108,46);
      ctx.fillStyle='#050c18'; ctx.font='bold 12px Arial'; ctx.letterSpacing='0.5px';
      ctx.fillText('LATEST',10,H-26); ctx.fillText('NEWS',18,H-11); ctx.letterSpacing='0px';
      ctx.save();
      ctx.beginPath(); ctx.rect(112,H-46,W-112,46); ctx.clip();
      ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.font='13px Arial';
      ctx.fillText(tickerFull.repeat(3),tickerX,H-17);
      ctx.restore();
      ctx.measureText(tickerFull);
      tickerX-=2.2; if(tickerX<-ctx.measureText(tickerFull).width) tickerX=W;

      // ─── PROGRESS LINE (top edge) ──────────────────────────
      ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.fillRect(0,0,W,3);
      ctx.fillStyle=accent; ctx.fillRect(0,0,W*prog,3);

      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  // Load logo image
  const loadLogoThen = (bgImg) => {
    if(article.sourceLogo){
      const li=new Image(); li.crossOrigin='anonymous';
      li.onload=()=>render(bgImg,li);
      li.onerror=()=>render(bgImg,null);
      li.src=article.sourceLogo;
    } else render(bgImg,null);
  };

  if(article.imageUrl){
    const img=new Image(); img.crossOrigin='anonymous';
    img.onload=()=>loadLogoThen(img);
    img.onerror=()=>loadLogoThen(null);
    img.src=article.imageUrl;
  } else loadLogoThen(null);
});

// ── Voice + Multi-Image Documentary News Video ───────────────
const makeNewsVideoWithVoice = async (article, durSecs=28) => {
  const script = (article.isBreaking?'Breaking news! ':'')+article.title+'. '+(article.summary||'');
  let audioEl=null, audioStream=null, audioBlobUrl=null;

  // ── TTS audio — HTMLAudioElement.captureStream() approach ────
  // More reliable than AudioContext: browser handles format decoding internally
  try{
    const ttsText = script.slice(0,500);
    // Try multiple TTS endpoints for reliability
    const ttsUrls = [
      'https://text.pollinations.ai/'+encodeURIComponent(ttsText)+'?model=openai-audio&voice=alloy&seed=1',
      'https://text.pollinations.ai/'+encodeURIComponent(ttsText)+'?model=openai-audio&voice=nova&seed=42',
    ];
    for(const ttsUrl of ttsUrls){
      try{
        const resp=await Promise.race([
          fetch(ttsUrl,{headers:{'Accept':'audio/mpeg,audio/*'}}),
          new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),20000))
        ]);
        if(!resp.ok) continue;
        const buf=await resp.arrayBuffer();
        if(buf.byteLength<2000) continue;
        // Test if audio can be decoded using a temporary Audio element
        audioBlobUrl=URL.createObjectURL(new Blob([buf],{type:'audio/mpeg'}));
        const testEl=new Audio(audioBlobUrl);
        const canPlay=await new Promise(res=>{
          testEl.oncanplaythrough=()=>res(true);
          testEl.onerror=()=>res(false);
          testEl.load();
          setTimeout(()=>res(false),5000);
        });
        if(!canPlay){ URL.revokeObjectURL(audioBlobUrl); audioBlobUrl=null; continue; }
        const audioDur=testEl.duration||0;
        if(audioDur>0.5) durSecs=Math.max(durSecs,Math.ceil(audioDur)+4);
        // Use a fresh Audio element for capture (not the test one)
        audioEl=new Audio(audioBlobUrl);
        audioEl.crossOrigin='anonymous';
        const capStream=audioEl.captureStream?audioEl.captureStream()
          :(audioEl.mozCaptureStream?audioEl.mozCaptureStream():null);
        if(capStream&&capStream.getAudioTracks().length>0){
          audioStream={element:audioEl,stream:capStream};
          break;
        }
      }catch(e){ if(audioBlobUrl){URL.revokeObjectURL(audioBlobUrl);audioBlobUrl=null;} }
    }
  }catch(e){}

  // ── Preload all images (deduplicated) ─────────────────────────
  const seenUrls=new Set();
  const allUrls=[article.imageUrl,...(article.extraImages||[])].filter(u=>{
    if(!u||seenUrls.has(u)) return false; seenUrls.add(u); return true;
  });
  const loadImg=src=>new Promise(res=>{const i=new Image();i.crossOrigin='anonymous';i.onload=()=>res(i);i.onerror=()=>res(null);i.src=src;});
  const [bgImgs,logoImg]=await Promise.all([
    Promise.all(allUrls.map(loadImg)),
    article.sourceLogo?loadImg(article.sourceLogo):Promise.resolve(null)
  ]);
  const imgs=bgImgs.filter(Boolean);

  // ── Canvas render ─────────────────────────────────────────────
  return new Promise((resolve,reject)=>{
    const W=1280,H=720;
    const cv=document.createElement('canvas');cv.width=W;cv.height=H;
    const ctx=cv.getContext('2d');
    if(!ctx.roundRect)ctx.roundRect=function(x,y,w,h,r){const R=Math.min(r,w/2,h/2);this.moveTo(x+R,y);this.lineTo(x+w-R,y);this.arcTo(x+w,y,x+w,y+R,R);this.lineTo(x+w,y+h-R);this.arcTo(x+w,y+h,x+w-R,y+h,R);this.lineTo(x+R,y+h);this.arcTo(x,y+h,x,y+h-R,R);this.lineTo(x,y+R);this.arcTo(x,y,x+R,y,R);this.closePath();};
    const catInfo=CATEGORIES.find(c=>c.value===article.category)||{label:'World News',color:'#60a5fa'};
    const accent=catInfo.color||'#F5A623';
    const dateStr=new Date().toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
    const title=(article.title||'').trim(),summary=(article.summary||'').trim(),source=article.source||'KWT News';
    const easeOut=t=>1-Math.pow(1-Math.min(1,t),3),lerp=(a,b,t)=>a+(b-a)*Math.min(1,Math.max(0,t));
    ctx.font='bold 50px Arial';
    const titleLines=(()=>{const mW=W*0.51,words=title.split(' ');let ln='',ls=[];for(const w of words){const t=ln+w+' ';if(ctx.measureText(t).width>mW&&ln){ls.push(ln.trim());ln=w+' ';}else ln=t;}if(ln.trim())ls.push(ln.trim());return ls.slice(0,3);})();
    const tickerFull=`${title}  •  ${catInfo.label.replace(/^\S+\s/,'')}  •  KwtNews.com  •  ${dateStr}  •  `;
    let tickerX=W;
    const IMG_SWITCH=Math.max(6,Math.floor(durSecs/Math.max(1,imgs.length)));

    // MediaRecorder — mix video + audio streams
    const videoStream=cv.captureStream(30); // 30fps for smoother output
    const audioMediaStream=audioStream?audioStream.stream:null;
    const recStream=audioMediaStream
      ?new MediaStream([...videoStream.getVideoTracks(),...audioMediaStream.getAudioTracks()])
      :videoStream;
    const mimes=audioMediaStream
      ?['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']
      :['video/webm;codecs=vp9','video/webm'];
    const mime=mimes.find(m=>MediaRecorder.isTypeSupported(m))||'video/webm';
    let rec;
    try{rec=new MediaRecorder(recStream,{mimeType:mime,videoBitsPerSecond:6000000});}
    catch(e){return reject(new Error('MediaRecorder: '+e.message));}
    const chunks=[];
    rec.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
    rec.onstop=()=>{
      if(audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
      const blob=new Blob(chunks,{type:'video/webm'});
      resolve({url:URL.createObjectURL(blob),blob});
    };
    rec.start(100);
    // Start audio 1.5s after recording — HTMLAudioElement is more reliable than AudioContext
    if(audioStream){
      setTimeout(()=>{ try{audioStream.element.play().catch(()=>{});}catch(e){} },1500);
    }
    // Fallback stop timeout
    const stopAt=setTimeout(()=>{try{rec.stop();}catch(e){}},durSecs*1000+800);

    const t0=performance.now();
    const frame=()=>{
      const el=performance.now()-t0;
      if(el>=durSecs*1000){clearTimeout(stopAt);try{rec.stop();}catch(e){}return;}
      const sec=el/1000,prog=el/(durSecs*1000);
      // Image slot: cycle through images
      const slot=imgs.length>0?Math.min(Math.floor(sec/IMG_SWITCH),imgs.length-1):0;
      const bgImg=imgs[slot]||null;
      const slotSec=sec%IMG_SWITCH;
      const kbZoom=1+(slotSec/IMG_SWITCH)*0.07;
      const panDir=slot%2===0?1:-1;

      // Background (blurred + darkened)
      if(bgImg){
        ctx.save();ctx.filter='blur(8px) brightness(0.25) saturate(1.4)';
        ctx.translate(W/2,H/2);ctx.scale(kbZoom,kbZoom);
        ctx.translate(panDir*(slotSec/IMG_SWITCH)*30,0);
        ctx.drawImage(bgImg,-W/2,-H/2,W,H);
        ctx.restore();ctx.filter='none';
        const ov=ctx.createLinearGradient(0,0,W,0);
        ov.addColorStop(0,'rgba(5,12,24,0.95)');ov.addColorStop(0.52,'rgba(5,12,24,0.8)');ov.addColorStop(1,'rgba(5,12,24,0.15)');
        ctx.fillStyle=ov;ctx.fillRect(0,0,W,H);
      }else{
        const bg=ctx.createLinearGradient(0,0,W,H);bg.addColorStop(0,'#020810');bg.addColorStop(1,'#0c1a30');
        ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
      }

      // Right image panel — Ken Burns + crossfade on slot change
      if(bgImg&&sec>0.2){
        const initT=easeOut(Math.min(1,(sec-0.2)/0.7));
        const fadeIn=slotSec<0.5?easeOut(slotSec/0.4):1;
        ctx.save();ctx.globalAlpha=Math.min(initT,fadeIn);
        ctx.beginPath();ctx.rect(W/2+14,72,W*0.46+100,H-72-48);ctx.clip();
        ctx.save();ctx.translate(W-W*0.23,72+(H-72-48)/2);ctx.scale(kbZoom,kbZoom);
        ctx.translate(panDir*(slotSec/IMG_SWITCH)*20,0);
        ctx.drawImage(bgImg,-W*0.23,-(H-72-48)/2,W*0.46,H-72-48);ctx.restore();
        const ig=ctx.createLinearGradient(W/2+14,0,W/2+140,0);
        ig.addColorStop(0,'rgba(5,12,24,1)');ig.addColorStop(1,'rgba(5,12,24,0)');
        ctx.fillStyle=ig;ctx.fillRect(W/2+14,72,130,H-120);
        ctx.globalAlpha=1;ctx.restore();
      }

      // Header bar — KwtNews.com branding
      const hGrad=ctx.createLinearGradient(0,0,W,0);
      hGrad.addColorStop(0,'rgba(3,8,18,0.98)');hGrad.addColorStop(1,'rgba(8,16,36,0.95)');
      ctx.fillStyle=hGrad;ctx.fillRect(0,0,W,70);
      ctx.fillStyle='#F5A623';ctx.fillRect(0,68,W,3);
      // Logo: KwtNews (white) + .com (orange)
      ctx.fillStyle='#fff';ctx.font='bold 32px Arial';ctx.fillText('KwtNews',18,46);
      ctx.fillStyle='#F5A623';ctx.font='bold 32px Arial';ctx.fillText('.com',158,46);
      // Separator
      ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(270,16);ctx.lineTo(270,54);ctx.stroke();
      // LIVE badge (blinking)
      if(Math.floor(sec*2)%2===0)ctx.fillStyle='rgba(239,68,68,0.95)';else ctx.fillStyle='rgba(180,40,40,0.85)';
      ctx.beginPath();ctx.roundRect(282,22,68,28,6);ctx.fill();
      ctx.fillStyle='#fff';ctx.font='bold 12px Arial';ctx.fillText('● LIVE',290,40);
      ctx.textAlign='right';ctx.fillStyle='rgba(255,255,255,0.45)';ctx.font='13px Arial';ctx.fillText(dateStr,W-18,42);ctx.textAlign='left';

      // Category badge + breaking badge
      if(sec>0.3){
        const t=easeOut((sec-0.3)/0.4);ctx.globalAlpha=t;
        ctx.fillStyle=accent;ctx.beginPath();ctx.roundRect(22,80,220,32,7);ctx.fill();
        ctx.fillStyle='#050c18';ctx.font='bold 13px Arial';ctx.fillText(catInfo.label.replace(/^\S+\s/,'').toUpperCase(),32,102);
        if(article.isBreaking){
          const bGrad=ctx.createLinearGradient(244,80,394,80);bGrad.addColorStop(0,'#ef4444');bGrad.addColorStop(1,'#dc2626');
          ctx.fillStyle=bGrad;ctx.beginPath();ctx.roundRect(244,80,160,32,7);ctx.fill();
          ctx.fillStyle='#fff';ctx.font='bold 13px Arial';ctx.fillText('⚡ BREAKING NEWS',252,102);
        }
        ctx.globalAlpha=1;
      }

      // Left accent bar (documentary style)
      if(sec>1.0){
        const lH=lerp(0,Math.min(titleLines.length*62+20,H-280),easeOut((sec-1.0)/0.5));
        // Gradient bar
        const bGrad=ctx.createLinearGradient(0,125,0,125+lH);
        bGrad.addColorStop(0,accent);bGrad.addColorStop(1,accent+'88');
        ctx.fillStyle=bGrad;ctx.fillRect(6,125,5,lH);
      }

      // Title — staggered slide-in with glow
      if(sec>0.6){
        ctx.save();ctx.beginPath();ctx.rect(14,115,W*0.52+20,H-115-50);ctx.clip();
        ctx.shadowColor='rgba(0,0,0,0.95)';ctx.shadowBlur=24;ctx.shadowOffsetX=2;ctx.shadowOffsetY=3;
        let ty=170;
        titleLines.forEach((ln,idx)=>{
          const ld=idx*0.15,lt=easeOut(Math.max(0,(sec-0.6-ld)/0.5));
          ctx.globalAlpha=lt;ctx.fillStyle='#ffffff';ctx.font='bold 52px Arial';
          const lx=lerp(-1000,22,easeOut(Math.max(0,(sec-0.6-ld)/0.45)));
          ctx.fillText(ln,lx,ty);ty+=68;
        });
        ctx.shadowBlur=0;ctx.globalAlpha=1;ctx.restore();
      }

      // Summary text (documentary info panel)
      if(sec>3.5&&summary){
        const t=easeOut((sec-3.5)/0.9);ctx.globalAlpha=t*0.9;
        // Subtle separator line
        const sepG=ctx.createLinearGradient(22,0,W*0.52-20,0);
        sepG.addColorStop(0,accent);sepG.addColorStop(1,'transparent');
        ctx.fillStyle=sepG;ctx.fillRect(22,titleLines.length*68+140,W*0.52-40,1.5);
        ctx.fillStyle='rgba(200,220,245,0.88)';ctx.font='19px Arial';
        ctx.shadowColor='rgba(0,0,0,0.9)';ctx.shadowBlur=12;
        wrapTxt(ctx,summary,22,titleLines.length*68+158,W*0.52-40,30);
        ctx.shadowBlur=0;ctx.globalAlpha=1;
      }

      // ── News Anchor Visual (right side circle frame) ─────────
      if(bgImg&&sec>1.5){
        const ancX=W*0.75,ancY=H*0.45,ancR=120;
        const ancT=easeOut(Math.min(1,(sec-1.5)/0.8));
        ctx.save();ctx.globalAlpha=ancT;
        // Outer glow ring
        const ringGrad=ctx.createRadialGradient(ancX,ancY,ancR-8,ancX,ancY,ancR+12);
        ringGrad.addColorStop(0,accent+'cc');ringGrad.addColorStop(1,'transparent');
        ctx.fillStyle=ringGrad;ctx.beginPath();ctx.arc(ancX,ancY,ancR+12,0,Math.PI*2);ctx.fill();
        // Circular clip
        ctx.beginPath();ctx.arc(ancX,ancY,ancR,0,Math.PI*2);ctx.clip();
        // Ken Burns on anchor image
        const aZoom=1+slotSec/IMG_SWITCH*0.05;
        ctx.save();ctx.translate(ancX,ancY);ctx.scale(aZoom,aZoom);
        ctx.drawImage(bgImg,-ancR,-ancR,ancR*2,ancR*2);
        ctx.restore();
        // Overlay gradient to make it look like a studio anchor shot
        const ancOv=ctx.createLinearGradient(ancX-ancR,ancY,ancX+ancR,ancY);
        ancOv.addColorStop(0,'rgba(5,12,24,0.3)');ancOv.addColorStop(0.5,'rgba(5,12,24,0)');ancOv.addColorStop(1,'rgba(5,12,24,0.2)');
        ctx.fillStyle=ancOv;ctx.fillRect(ancX-ancR,ancY-ancR,ancR*2,ancR*2);
        ctx.restore();
        // "REPORTER" label under circle
        ctx.save();ctx.globalAlpha=ancT;
        ctx.fillStyle='rgba(5,12,24,0.85)';ctx.beginPath();ctx.roundRect(ancX-70,ancY+ancR+8,140,24,5);ctx.fill();
        ctx.fillStyle=accent;ctx.font='bold 11px Arial';ctx.textAlign='center';ctx.fillText('KWT NEWS CORRESPONDENT',ancX,ancY+ancR+24);ctx.textAlign='left';
        ctx.restore();
      }

      // Lower third — source + branding
      if(sec>2.5){
        const t=easeOut((sec-2.5)/0.6),ltY=lerp(H+50,H-175,t);
        // Panel background with gradient
        const ltGrad=ctx.createLinearGradient(0,ltY,W*0.56,ltY);
        ltGrad.addColorStop(0,'rgba(3,8,18,0.97)');ltGrad.addColorStop(1,'rgba(5,14,28,0.85)');
        ctx.fillStyle=ltGrad;ctx.fillRect(0,ltY,W*0.56,95);
        ctx.fillStyle=accent;ctx.fillRect(0,ltY,6,95);
        // Logo circle
        if(logoImg){
          ctx.save();ctx.beginPath();ctx.arc(30,ltY+32,20,0,Math.PI*2);ctx.closePath();
          ctx.fillStyle='rgba(255,255,255,0.1)';ctx.fill();
          ctx.clip();ctx.drawImage(logoImg,10,ltY+12,40,40);ctx.restore();
        }
        const ltx=logoImg?60:16;
        ctx.fillStyle=accent;ctx.font='bold 10px Arial';ctx.letterSpacing='1.5px';
        ctx.fillText('REPORTED BY',ltx,ltY+18);ctx.letterSpacing='0px';
        ctx.fillStyle='rgba(255,255,255,0.92)';ctx.font='bold 17px Arial';ctx.fillText(source,ltx,ltY+40);
        ctx.fillStyle='rgba(255,255,255,0.15)';ctx.fillRect(ltx,ltY+50,W*0.56-ltx-16,1);
        ctx.fillStyle='rgba(180,200,230,0.55)';ctx.font='12px Arial';
        ctx.fillText('kwtnews.com  •  '+article.readTime,ltx,ltY+70);
      }

      // Ticker bar — scrolling news
      ctx.fillStyle='rgba(3,8,18,0.97)';ctx.fillRect(0,H-50,W,50);
      ctx.fillStyle=accent;ctx.fillRect(0,H-51,W,2.5);
      const tkGrad=ctx.createLinearGradient(0,H-50,120,H);
      tkGrad.addColorStop(0,accent);tkGrad.addColorStop(1,accent+'cc');
      ctx.fillStyle=tkGrad;ctx.fillRect(0,H-50,120,50);
      ctx.fillStyle='#050c18';ctx.font='bold 12px Arial';ctx.textAlign='center';
      ctx.fillText('BREAKING',60,H-32);ctx.fillText('NEWS',60,H-15);ctx.textAlign='left';
      ctx.save();ctx.beginPath();ctx.rect(124,H-50,W-124,50);ctx.clip();
      ctx.fillStyle='rgba(230,240,255,0.88)';ctx.font='14px Arial';
      ctx.fillText(tickerFull.repeat(4),tickerX,H-18);
      ctx.restore();tickerX-=2.5;if(tickerX<-ctx.measureText(tickerFull).width)tickerX=W;

      // Progress bar at top
      ctx.fillStyle='rgba(255,255,255,0.05)';ctx.fillRect(0,0,W,3.5);
      ctx.fillStyle=accent;ctx.fillRect(0,0,W*prog,3.5);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
};

// ── Source logo helpers ───────────────────────────────────────
const SOURCE_DOMAINS = {
  bbc:'bbc.com', reuters:'reuters.com', cnn:'cnn.com', ap:'apnews.com',
  aljazeera:'aljazeera.com', bloomberg:'bloomberg.com', guardian:'theguardian.com',
  nytimes:'nytimes.com', foxnews:'foxnews.com', nbc:'nbcnews.com',
  abc:'abcnews.go.com', gulf:'gulfnews.com', arab:'arabtimesonline.com',
  kuwait:'kuwaittimes.com', times:'timesofkuwait.com', sky:'sky.com',
};
const guessSourceDomain = (name) => {
  const lower = name.toLowerCase().replace(/[^a-z]/g,' ');
  for(const [k,v] of Object.entries(SOURCE_DOMAINS)){
    if(lower.includes(k)) return v;
  }
  const word = lower.trim().split(/\s+/)[0];
  return word.length>2 ? word+'.com' : null;
};
const shortSourceName = (name) => (name||'KWT').split(/[\s,&]+/)[0].slice(0,10);

// Module-level logo cache to avoid repeated full-collection reads
const _logoCache = new Map();

const getOrCreateSourceLogo = async (sourceName) => {
  // Return from cache if available
  const cacheKey = (sourceName||'').toLowerCase().trim();
  if(_logoCache.has(cacheKey)) return _logoCache.get(cacheKey);

  // 1. Check existing Firestore logos
  try{
    const snap = await db.collection('logos').get();
    const lower = sourceName.toLowerCase();
    // Pre-cache all logos to avoid future reads
    snap.docs.forEach(d=>{ const k=(d.data().name||'').toLowerCase(); if(k) _logoCache.set(k,d.data().url); });
    const found = snap.docs.find(d=>{
      const n=(d.data().name||'').toLowerCase();
      return lower.includes(n)||n.includes(lower.split(/\s+/)[0]);
    });
    if(found){ _logoCache.set(cacheKey,found.data().url); return found.data().url; }
  }catch(e){}
  // 2. Try Clearbit
  const domain = guessSourceDomain(sourceName);
  if(domain){
    const url = 'https://logo.clearbit.com/'+domain;
    const ok = await new Promise(res=>{
      const i=new Image(); i.onload=()=>res(true); i.onerror=()=>res(false);
      i.src=url+'?size=64';
    });
    if(ok){
      const short = shortSourceName(sourceName);
      _logoCache.set(cacheKey,url);
      try{ await db.collection('logos').add({url,name:short,createdAt:firebase.firestore.FieldValue.serverTimestamp()}); }catch(e){}
      return url;
    }
  }
  // 3. Generate AI logo via Pollinations
  const q = encodeURIComponent(sourceName+' news logo icon minimal');
  const genUrl = `https://image.pollinations.ai/prompt/${q}?width=128&height=128&seed=7&nologo=true`;
  const short = shortSourceName(sourceName);
  _logoCache.set(cacheKey,genUrl);
  try{ await db.collection('logos').add({url:genUrl,name:short,createdAt:firebase.firestore.FieldValue.serverTimestamp()}); }catch(e){}
  return genUrl;
};

const AINewsManager = ({toast, onBack}) => {
  const [tab,setTab] = useState('chat');
  // Chat
  const [msgs,setMsgs] = useState([{role:'ai',text:'👋 Hi! I\'m your AI news assistant powered by Puter.js AI.\n\nI can:\n• Search the web for latest breaking news\n• Write complete professional articles\n• Generate relevant images\n• Save drafts for your review\n\nType what kind of news you want, or click a suggestion below!'}]);
  const [chatInput,setChatInput] = useState('');
  const [chatBusy,setChatBusy] = useState(false);
  const chatEndRef = useRef(null);
  // Generate
  const [genCat,setGenCat] = useState('kuwait');
  const [genTopic,setGenTopic] = useState('');
  const [genBusy,setGenBusy] = useState(false);
  const [preview,setPreview] = useState(null);
  // Drafts
  const [drafts,setDrafts] = useState([]);
  const [draftsLoading,setDraftsLoading] = useState(true);
  const [actionId,setActionId] = useState(null);
  // Draft inline edit
  const [draftEdit,setDraftEdit] = useState(null); // {id, form}
  const [draftSaving,setDraftSaving] = useState(false);
  // Video generation
  const [videoBusy,setVideoBusy] = useState(false);
  const [videoProgress,setVideoProgress] = useState(0);
  const [videoStatus,setVideoStatus] = useState(''); // 'rendering' | 'uploading' | ''
  const [videoResult,setVideoResult] = useState(null); // {url, blob, article}
  const [videoDur,setVideoDur] = useState(20);
  const videoTimerRef = useRef(null);

  // ── Video generation ──────────────────────────────────────────
  const uploadVideoBlob = async (blob) => {
    const fd = new FormData();
    fd.append('file', blob, 'kwt-news-'+Date.now()+'.webm');
    fd.append('upload_preset', CLOUDINARY.uploadPreset);
    fd.append('folder', 'sql_users');
    // Use explicit video endpoint (auto/upload may reject .webm depending on preset)
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/video/upload`, {method:'POST', body:fd});
    const data = await res.json();
    if(data.error) throw new Error('Cloudinary: '+data.error.message);
    return data.secure_url;
  };

  const genVideo = async (article) => {
    if(videoBusy) return;
    setVideoBusy(true); setVideoResult(null); setVideoProgress(0); setVideoStatus('rendering');
    let prog = 0;
    videoTimerRef.current = setInterval(()=>{
      prog = Math.min(prog + (100/(videoDur*4)), 95);
      setVideoProgress(Math.round(prog));
    }, 250);
    try{
      const result = await makeNewsVideo(article, videoDur);
      clearInterval(videoTimerRef.current);
      setVideoProgress(100); setVideoStatus('');
      setVideoResult({url: result.url, blob: result.blob, article, articleTitle: article.title});
      toast.add('🎬 Video ready!','ok');
    } catch(e){
      clearInterval(videoTimerRef.current);
      setVideoStatus('');
      toast.add('Video error: '+e.message,'error');
    }
    setVideoBusy(false);
  };

  const downloadVideo = () => {
    if(!videoResult) return;
    const a = document.createElement('a');
    a.href = videoResult.url;
    a.download = 'kwt-news-'+Date.now()+'.webm';
    a.click();
  };

  // ── Draft inline edit ─────────────────────────────────────────
  const openDraftEdit = (d) => {
    setDraftEdit({id:d.id, form:{
      title:d.title||'', summary:d.summary||'', content:d.content||'',
      category:d.category||'kuwait', isBreaking:d.isBreaking||false,
      imageUrl:d.imageUrl||'', source:d.source||'KWT News AI', readTime:d.readTime||'3 min read',
    }});
  };

  const saveDraftEdit = async () => {
    if(!draftEdit) return;
    setDraftSaving(true);
    try{
      await db.collection('news').doc(draftEdit.id).update(draftEdit.form);
      toast.add('Draft updated!','ok');
      setDraftEdit(null);
      fetchDrafts();
    } catch(e){ toast.add('Update failed','error'); }
    setDraftSaving(false);
  };

  useEffect(()=>{
    if(tab==='drafts') fetchDrafts();
  },[tab]);

  useEffect(()=>{
    chatEndRef.current?.scrollIntoView({behavior:'smooth'});
  },[msgs]);

  const fetchDrafts = async()=>{
    setDraftsLoading(true);
    try{
      // Unordered fetch + client sort so AI drafts without `timestamp` still appear.
      const snap=await db.collection('news').limit(500).get();
      const docs=snap.docs.map(d=>({id:d.id,...d.data()}))
                         .filter(d=>d.aiGenerated)
                         .sort((a,b)=> window.__docTime(b) - window.__docTime(a));
      setDrafts(docs);
    }catch(e){ console.error(e); }
    setDraftsLoading(false);
  };

  const getImg = async(query,forceAI=false)=>{
    if(!forceAI){
      try{ const u=await fetchPixabay(query); if(u)return u; }catch(e){}
    }
    return pollinationsUrl(query);
  };

  const saveDraft = async(article)=>{
    const isVideo = !!(article.videoUrl);
    await db.collection('news').add({
      title:article.title||'',
      summary:article.summary||'',
      content:article.content||'',
      imageUrl:isVideo ? '' : (article.imageUrl||''),
      videoUrl:isVideo ? article.videoUrl : '',
      thumbnail:'',
      category:article.category||'world',
      source:article.source||'KWT News AI',
      sourceLogo:article.sourceLogo||'',
      readTime:article.readTime||'3 min read',
      isBreaking:article.isBreaking||false,
      mediaType:isVideo ? 'video' : 'image',
      hidden:true,
      aiGenerated:true,
      timestamp:firebase.firestore.FieldValue.serverTimestamp(),
      views:0,likes:0,commentCount:0,
    });
  };

  // ── Chat ─────────────────────────────────────────────
  const sendChat = async()=>{
    if(!chatInput.trim()||chatBusy)return;
    const userText=chatInput.trim();
    setChatInput('');
    setMsgs(p=>[...p,{role:'user',text:userText}]);
    setChatBusy(true);
    try{
      const isArticleReq=/generat|creat|writ|make|news|article|draft|cover|find|search|latest|today|break/i.test(userText);
      const prompt=isArticleReq
        ?`You are a professional journalist for KWT News (Kuwait & world news platform).
The user wants: "${userText}"
Write a realistic, professional news article based on your knowledge of current world events and recent news trends. Today's date context: ${new Date().toDateString()}.

IMPORTANT: Write as a real journalist would. Use your training knowledge about real events, real places, real facts. Do NOT say you cannot access the internet — just write the best article you can.

Return ONLY valid JSON (no markdown, no code blocks):
{
  "reply": "Brief 1-sentence description of the article you wrote",
  "article": {
    "title": "Professional headline max 120 chars",
    "summary": "2-3 sentence news summary",
    "content": "Full article 4-6 paragraphs with facts, context, background",
    "imageQuery": "3-5 word image search term",
    "category": "kuwait OR world OR kuwait-jobs OR kuwait-offers OR funny-news-meme",
    "readTime": "X min read",
    "source": "Relevant news source name (e.g. KWT News, Reuters, BBC)",
    "isBreaking": false
  }
}`
        :`You are an AI news assistant for KWT News admin panel.
User: "${userText}"
Answer helpfully and concisely based on your knowledge. Never say you cannot access the internet.
Return ONLY JSON: {"reply": "your helpful response max 300 chars", "article": null}`;

      const responseText=await callAI(prompt);
      const parsed=parseJsonFromText(responseText);
      // Never show raw JSON — if parse failed, show a clean fallback
      const replyText = parsed?.reply
        || (parsed ? 'Article generated! Click the button below to save it as a video draft.'
            : responseText.replace(/^\s*\{[\s\S]*\}\s*$/,'').trim().slice(0,400) || '✅ Article ready! Click "Generate Video & Save Draft" below.');
      const article=parsed?.article||null;
      setMsgs(p=>[...p,{role:'ai',text:replyText,article}]);
    }catch(e){
      setMsgs(p=>[...p,{role:'ai',text:'Sorry, error: '+e.message+'. Please try again.'}]);
    }
    setChatBusy(false);
  };

  const saveChatDraft = async(article)=>{
    if(videoBusy) return;
    setVideoBusy(true); setVideoResult(null); setVideoProgress(0);
    try{
      // 1. Fetch source logo
      setVideoStatus('logo'); toast.add('Finding source logo...','info');
      let sourceLogo='';
      const src = shortSourceName(article.source||'KWT News');
      try{ sourceLogo = await getOrCreateSourceLogo(article.source||'KWT News'); }catch(e){}

      // 2. Fetch distinct background images for video transitions (deduplicated)
      setVideoStatus('image'); toast.add('Fetching images...','info');
      const titleWords=(article.title||'').split(' ').slice(0,4).join(' ');
      const [img1,img2,img3]=await Promise.all([
        getImg(article.imageQuery||article.title,false).catch(()=>''),
        getImg(titleWords+' news event',false).catch(()=>''),
        getImg((article.category||'world')+' news',false).catch(()=>''),
      ]);
      // Remove duplicates from extra images
      const seenImgUrls=new Set([img1].filter(Boolean));
      const extraImages=[img2,img3].filter(u=>u&&!seenImgUrls.has(u)&&seenImgUrls.add(u));

      // 3. Save text+logo draft immediately so something always saves
      setVideoStatus('saving'); toast.add('💾 Saving draft...','info');
      const fullArticle={...article,imageUrl:img1||'',extraImages,sourceLogo,source:src};
      let docRef;
      try{ docRef = await db.collection('news').add({
        title: fullArticle.title||'',
        summary: fullArticle.summary||'',
        content: fullArticle.content||'',
        category: fullArticle.category||'general',
        source: fullArticle.source||'KWT News',
        sourceLogo: fullArticle.sourceLogo||'',
        imageUrl: img1||'',
        thumbnail: img1||'',
        videoUrl: '',
        mediaType: 'article',
        readTime: fullArticle.readTime||'3 min read',
        isBreaking: fullArticle.isBreaking||false,
        hidden: true,
        published: false,
        status: 'draft',
        aiGenerated: true,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        views:0, likes:0, commentCount:0,
      }); }catch(e2){ throw new Error('Draft save failed: '+e2.message); }

      // 4. Render video with voice-over
      setVideoStatus('rendering'); setVideoProgress(5);
      toast.add('🎬 Rendering video with voice-over...','info');
      let prog=5;
      videoTimerRef.current=setInterval(()=>{
        prog=Math.min(prog+1,82); setVideoProgress(prog);
      },500);
      let videoUrl='';
      try{
        const result = await makeNewsVideoWithVoice(fullArticle, videoDur);
        clearInterval(videoTimerRef.current);
        setVideoProgress(85);
        setVideoResult({url:result.url, blob:result.blob, article:fullArticle, articleTitle:article.title});

        // 5. Upload to Cloudinary
        setVideoStatus('uploading'); toast.add('☁️ Uploading to cloud...','info');
        videoUrl = await uploadVideoBlob(result.blob);
        setVideoProgress(100);

        // 6. Update draft with videoUrl
        await db.collection('news').doc(docRef.id).update({videoUrl, mediaType:'article'});
        setVideoStatus(''); setVideoBusy(false);
        toast.add('✅ Video draft saved with voice & logo!','ok');
        setMsgs(p=>[...p,{role:'ai',text:'✅ Video draft saved! Go to the Drafts tab to review and publish.'}]);
      }catch(e2){
        clearInterval(videoTimerRef.current);
        // Video failed but text draft already saved — still show success
        setVideoStatus(''); setVideoBusy(false);
        toast.add('⚠️ Text draft saved but video failed. Check Drafts tab.','error');
        setMsgs(p=>[...p,{role:'ai',text:'⚠️ Draft saved (text+logo only). Video rendering failed — check Drafts tab.'}]);
      }
      fetchDrafts();
    }catch(e){
      clearInterval(videoTimerRef.current);
      setVideoStatus(''); setVideoBusy(false);
      toast.add('Failed: '+e.message,'error');
    }
  };

  // ── Auto Generate ─────────────────────────────────────
  const generate = async()=>{
    if(genBusy)return;
    setGenBusy(true);setPreview(null);
    try{
      const catInfo=CATEGORIES.find(c=>c.value===genCat);
      const topicPart=genTopic.trim()?`Topic: ${genTopic.trim()}`:`Write about the most significant recent news for this category`;
      const prompt=`You are a professional journalist for KWT News.
Category: ${catInfo?.label||genCat}
${topicPart}
Date context: ${new Date().toDateString()}

Write a complete, realistic professional news article based on your knowledge of real world events, facts, and news trends. Do NOT say you cannot access the internet — use your training knowledge and write confidently as a journalist would.

Return ONLY valid JSON (no markdown, no code blocks):
{
  "title": "Compelling professional headline max 120 chars",
  "summary": "2-3 sentence news summary",
  "content": "Full article 4-6 paragraphs with facts, background, and context",
  "imageQuery": "3-5 word image search term",
  "category": "${genCat}",
  "readTime": "X min read",
  "source": "Appropriate news source (e.g. KWT News, Reuters, Gulf News)",
  "isBreaking": false,
  "newsFoundAbout": "1 sentence describing what this article covers"
}`;
      const text=await callAI(prompt);
      const article=parseJsonFromText(text);
      if(!article||!article.title)throw new Error('Could not parse AI response. Please try again.');
      const imageUrl=await getImg(article.imageQuery||article.title,imgSrc==='ai');
      setPreview({...article,imageUrl});
    }catch(e){ toast.add('Error: '+e.message,'error'); }
    setGenBusy(false);
  };

  const savePreview = async()=>{
    if(!preview)return;
    try{ await saveDraft(preview); toast.add('Saved to drafts!','ok'); setPreview(null); }
    catch(e){ toast.add('Save failed','error'); }
  };

  const regenImage = async()=>{
    if(!preview)return;
    try{
      const imageUrl=await getImg(preview.imageQuery||preview.title,imgSrc!=='ai');
      setPreview(p=>({...p,imageUrl}));
      toast.add('Image updated!','ok');
    }catch(e){ toast.add('Image failed','error'); }
  };

  // ── Drafts ───────────────────────────────────────────
  const publishDraft = async(id)=>{
    setActionId(id+'-pub');
    try{
      await db.collection('news').doc(id).update({hidden:false, published:true, status:'published'});
      toast.add('Published! Article is now live.','ok');
      fetchDrafts();
    }catch(e){ toast.add('Publish failed','error'); }
    setActionId(null);
  };

  const delDraft = async(id)=>{
    setActionId(id+'-del');
    try{
      await db.collection('news').doc(id).delete();
      toast.add('Draft deleted','ok');
      setDrafts(p=>p.filter(d=>d.id!==id));
    }catch(e){ toast.add('Delete failed','error'); }
    setActionId(null);
  };

  const tbStyle = t=>({
    padding:'8px 16px',borderRadius:8,border:'none',cursor:'pointer',
    fontSize:13,fontWeight:700,fontFamily:'Outfit',transition:'all .15s',
    background:tab===t?'var(--accent)':'var(--surface2)',
    color:tab===t?'#050c18':'var(--muted)',
  });

  return (
    <div className="fade-up">
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:20}}>
        {onBack&&(
          <button onClick={onBack} style={{display:'flex',alignItems:'center',gap:5,background:'var(--surface2)',border:'1.5px solid var(--border)',borderRadius:10,color:'var(--muted)',cursor:'pointer',padding:'9px 13px',fontFamily:'Outfit',fontWeight:700,fontSize:13,flexShrink:0}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>
        )}
        <div style={{width:36,height:36,borderRadius:11,background:'linear-gradient(135deg,#6366f1,#8b5cf6)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
          <Ic n="sparkle" s={18} c="#fff"/>
        </div>
        <div style={{flex:1}}>
          <h1 style={{fontSize:18,fontWeight:800,lineHeight:1}}>AI News Studio</h1>
          <p style={{fontSize:11,color:'var(--muted)',marginTop:2}}>Puter.js AI · Video · Voice-over</p>
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{display:'flex',gap:8,marginBottom:20,flexWrap:'wrap'}}>
        <button style={tbStyle('chat')} onClick={()=>setTab('chat')}>💬 AI Chat</button>
        <button style={tbStyle('drafts')} onClick={()=>setTab('drafts')}>
          📝 Drafts{drafts.length>0?` (${drafts.length})`:''}
        </button>
      </div>

      {/* ─── CHAT TAB ─── */}
      {tab==='chat'&&(
        <div className="card" style={{display:'flex',flexDirection:'column',height:'72vh',minHeight:420}}>
          {/* Header bar */}
          <div style={{padding:'9px 14px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:10,flexShrink:0,background:'var(--surface2)'}}>
            <span style={{fontSize:12,fontWeight:700,color:'#6366f1'}}>🎬 Video News Mode</span>
            <span style={{fontSize:11,color:'var(--dim)',flex:1}}>AI generates article → voice-over → animated video → saved to drafts</span>
            <div style={{display:'flex',alignItems:'center',gap:5}}>
              <span style={{fontSize:11,color:'var(--muted)'}}>Duration:</span>
              <select value={videoDur} onChange={e=>setVideoDur(+e.target.value)}
                style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontSize:11,padding:'3px 6px',fontFamily:'Outfit'}}>
                <option value={15}>15s</option><option value={20}>20s</option><option value={25}>25s</option><option value={30}>30s</option>
              </select>
            </div>
          </div>
          {/* Messages */}
          <div style={{flex:1,overflowY:'auto',padding:16,display:'flex',flexDirection:'column',gap:12}}>
            {msgs.map((m,i)=>(
              <div key={i} style={{display:'flex',flexDirection:'column',alignItems:m.role==='user'?'flex-end':'flex-start',gap:8}}>
                <div style={{
                  maxWidth:'85%',padding:'11px 14px',
                  borderRadius:m.role==='user'?'16px 16px 4px 16px':'16px 16px 16px 4px',
                  background:m.role==='user'?'var(--accent)':'var(--surface2)',
                  color:m.role==='user'?'#050c18':'var(--text)',
                  fontSize:13,lineHeight:1.65,whiteSpace:'pre-wrap',wordBreak:'break-word',
                  border:m.role==='ai'?'1px solid var(--border)':'none',
                }}>{m.text}</div>
                {m.article&&(
                  <div className="card-sm fade-up" style={{maxWidth:'90%',overflow:'hidden'}}>
                    {/* Article image */}
                    {m.article.imageUrl&&(
                      <div style={{position:'relative'}}>
                        <img src={m.article.imageUrl} alt="" style={{width:'100%',height:160,objectFit:'cover',display:'block'}} onError={e=>e.target.style.display='none'}/>
                        {m.article.isBreaking&&<span className="badge" style={{position:'absolute',top:8,left:8,background:'#ef4444',color:'#fff',fontSize:10,padding:'3px 8px'}}>⚡ BREAKING</span>}
                        <span className="badge" style={{position:'absolute',top:8,right:8,background:'rgba(99,102,241,.9)',color:'#fff',fontSize:9}}>AI</span>
                      </div>
                    )}
                    <div style={{padding:14}}>
                      {/* Category + readtime */}
                      <div style={{display:'flex',gap:8,marginBottom:8,flexWrap:'wrap'}}>
                        <span style={{fontSize:10,color:'var(--accent)',fontWeight:700}}>{CATEGORIES.find(c=>c.value===m.article.category)?.label||'News'}</span>
                        <span style={{fontSize:10,color:'var(--dim)'}}>· {m.article.readTime||'3 min read'}</span>
                        <span style={{fontSize:10,color:'var(--dim)'}}>· {m.article.source||'KWT News'}</span>
                      </div>
                      <p style={{fontWeight:800,fontSize:14,lineHeight:1.4,marginBottom:6}}>{m.article.title}</p>
                      <p style={{fontSize:12,color:'var(--muted)',lineHeight:1.55,marginBottom:10}}>{m.article.summary}</p>
                      {/* Save button */}
                      <button className="btn" disabled={videoBusy||chatBusy}
                        style={{fontSize:13,padding:'11px',width:'100%',background:'linear-gradient(135deg,#6366f1,#8b5cf6)',color:'#fff',fontWeight:700,borderRadius:10,border:'none',cursor:videoBusy?'not-allowed':'pointer',opacity:videoBusy?0.6:1}}
                        onClick={()=>saveChatDraft(m.article)}>
                        🎬 Generate Video &amp; Save Draft
                      </button>
                    </div>
                    {/* Progress bar */}
                    {videoBusy&&(
                      <div style={{borderTop:'1px solid var(--border)',padding:'10px 14px',background:'rgba(99,102,241,.04)'}}>
                        <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                          <span style={{fontSize:11,color:'var(--muted)'}}>
                            {videoStatus==='logo'?'🏷 Finding source logo...'
                            :videoStatus==='image'?'🖼 Fetching background image...'
                            :videoStatus==='rendering'?'🎬 Rendering video + voice-over...'
                            :videoStatus==='uploading'?'☁️ Uploading to cloud...'
                            :'⏳ Processing...'}
                          </span>
                          <span style={{fontSize:11,color:'#6366f1',fontWeight:700}}>{videoProgress}%</span>
                        </div>
                        <div style={{height:4,borderRadius:2,background:'var(--border)',overflow:'hidden'}}>
                          <div style={{height:'100%',width:videoProgress+'%',background:'linear-gradient(90deg,#6366f1,#8b5cf6)',transition:'width .4s',borderRadius:2}}></div>
                        </div>
                      </div>
                    )}
                    {/* Video ready preview */}
                    {videoResult&&videoResult.articleTitle===m.article.title&&!videoBusy&&(
                      <div style={{borderTop:'1px solid var(--border)',padding:12,background:'rgba(99,102,241,.05)'}}>
                        <p style={{fontSize:11,fontWeight:700,color:'#6366f1',marginBottom:8}}>🎬 Video Preview (saved to Drafts)</p>
                        <video src={videoResult.url} controls style={{width:'100%',borderRadius:8,background:'#000',maxHeight:200}} playsInline/>
                        <button className="btn btn-ghost" onClick={downloadVideo} style={{width:'100%',marginTop:8,fontSize:12,padding:'8px'}}>⬇️ Download .webm</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {chatBusy&&(
              <div style={{display:'flex',gap:10,alignItems:'center',padding:'4px 0'}}>
                <div className="spinner" style={{width:18,height:18,flexShrink:0}}></div>
                <span style={{fontSize:12,color:'var(--muted)'}}>AI is searching the web &amp; writing...</span>
              </div>
            )}
            <div ref={chatEndRef}></div>
          </div>
          {/* Quick Suggestions */}
          {msgs.length<=1&&(
            <div style={{padding:'0 16px 10px',display:'flex',gap:8,flexWrap:'wrap'}}>
              {['🇰🇼 Latest Kuwait news today','🌍 Top world news now','💼 Kuwait job market news','⚡ Generate breaking news'].map((s,i)=>(
                <button key={i} onClick={()=>setChatInput(s)}
                  style={{padding:'6px 12px',borderRadius:999,background:'var(--surface2)',border:'1px solid var(--border)',color:'var(--muted)',fontSize:12,cursor:'pointer',fontFamily:'Outfit'}}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {/* Input */}
          <div style={{padding:12,borderTop:'1px solid var(--border)',display:'flex',gap:10,alignItems:'flex-end'}}>
            <textarea className="inp" value={chatInput} onChange={e=>setChatInput(e.target.value)}
              onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}}}
              placeholder="Tell AI what news to generate... (Enter to send, Shift+Enter for new line)"
              style={{flex:1,minHeight:44,maxHeight:120,resize:'none'}} disabled={chatBusy}/>
            <button className="btn btn-accent" onClick={sendChat} disabled={chatBusy||!chatInput.trim()} style={{padding:'11px 14px',flexShrink:0}}>
              <Ic n="send" s={16}/>
            </button>
          </div>
        </div>
      )}


      {/* ─── DRAFTS TAB ─── */}
      {tab==='drafts'&&(
        <div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
            <p style={{fontSize:13,color:'var(--muted)'}}>
              {draftsLoading?'Loading...':`${drafts.length} AI article${drafts.length!==1?'s':''} · ${drafts.filter(d=>d.hidden).length} pending review`}
            </p>
            <button className="btn btn-ghost" onClick={fetchDrafts} style={{fontSize:12,padding:'6px 12px'}}>
              <Ic n="refresh" s={14}/> Refresh
            </button>
          </div>
          {draftsLoading?(
            <div style={{display:'flex',justifyContent:'center',padding:48}}><div className="spinner"></div></div>
          ):drafts.length===0?(
            <div className="card" style={{padding:48,textAlign:'center'}}>
              <p style={{fontSize:36,marginBottom:12}}>📝</p>
              <p style={{fontWeight:700,marginBottom:6}}>No AI drafts yet</p>
              <p style={{fontSize:13,color:'var(--muted)'}}>Use AI Chat or Auto Generate to create articles, then save them as drafts.</p>
            </div>
          ):(
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {drafts.map(d=>(
                <div key={d.id} className="card" style={{overflow:'hidden'}}>
                  <div style={{display:'flex',gap:0}}>
                    {d.videoUrl
                      ?<div style={{width:96,height:96,background:'#000',flexShrink:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:2}}>
                         <span style={{fontSize:28}}>🎬</span>
                         <span style={{fontSize:9,color:'#aaa',letterSpacing:'.05em'}}>VIDEO</span>
                       </div>
                      :d.imageUrl&&<img src={d.imageUrl} alt="" style={{width:96,height:96,objectFit:'cover',flexShrink:0}} onError={e=>e.target.style.display='none'}/>}
                    <div style={{padding:'12px 14px',flex:1,minWidth:0}}>
                      <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:6}}>
                        <span className="badge" style={{background:'rgba(99,102,241,.15)',color:'#818cf8',border:'1px solid rgba(99,102,241,.3)',fontSize:9}}>AI</span>
                        {d.hidden
                          ?<span className="badge" style={{background:'rgba(250,200,40,.12)',color:'#fbbf24',border:'1px solid rgba(250,200,40,.3)',fontSize:9}}>DRAFT</span>
                          :<span className="badge" style={{background:'rgba(52,211,153,.12)',color:'#34d399',border:'1px solid rgba(52,211,153,.3)',fontSize:9}}>PUBLISHED</span>}
                        {d.isBreaking&&<span className="badge" style={{background:'rgba(239,68,68,.15)',color:'#f87171',border:'1px solid rgba(239,68,68,.3)',fontSize:9}}>⚡BREAKING</span>}
                        <span style={{fontSize:10,color:'var(--dim)'}}>{CATEGORIES.find(c=>c.value===d.category)?.label||d.category}</span>
                        <span style={{fontSize:10,color:'var(--dim)'}}>{timeAgo(d.timestamp)}</span>
                      </div>
                      <p style={{fontWeight:700,fontSize:13,lineHeight:1.4,marginBottom:4,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{d.title}</p>
                      <p style={{fontSize:11,color:'var(--muted)',overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',lineHeight:1.4}}>{d.summary}</p>
                    </div>
                  </div>
                  <div style={{padding:'10px 14px',borderTop:'1px solid var(--border)',display:'flex',gap:8}}>
                    {d.hidden
                      ?<button className="btn btn-accent" style={{flex:2,fontSize:12,padding:'8px 10px'}}
                          disabled={actionId===d.id+'-pub'} onClick={()=>publishDraft(d.id)}>
                          {actionId===d.id+'-pub'?'...':'🚀 Publish'}
                        </button>
                      :<span style={{flex:2,display:'flex',alignItems:'center',fontSize:12,color:'#34d399',fontWeight:700,paddingLeft:4}}>✅ Live</span>
                    }
                    <button className="btn btn-ghost" style={{flex:1,fontSize:12,padding:'8px 10px'}}
                      onClick={()=>openDraftEdit(d)}>
                      ✏️ Edit
                    </button>
                    <button className="btn btn-ghost" style={{padding:'8px 10px',fontSize:12}}
                      onClick={()=>genVideo(d)}>
                      🎬
                    </button>
                    <button className="btn btn-red" style={{padding:'8px 10px',fontSize:12}}
                      disabled={actionId===d.id+'-del'} onClick={()=>delDraft(d.id)}>
                      {actionId===d.id+'-del'?'...':'🗑️'}
                    </button>
                  </div>
                  {/* Inline Edit Form */}
                  {draftEdit?.id===d.id&&(
                    <div style={{padding:'14px',borderTop:'1px solid var(--border)',background:'var(--surface2)',display:'flex',flexDirection:'column',gap:10}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                        <p style={{fontSize:12,fontWeight:700,color:'var(--accent)'}}>✏️ Edit Draft</p>
                        <button style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted)',fontSize:18,lineHeight:1}} onClick={()=>setDraftEdit(null)}>×</button>
                      </div>
                      <div>
                        <p style={{fontSize:10,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>TITLE</p>
                        <input className="inp" value={draftEdit.form.title}
                          onChange={e=>setDraftEdit(p=>({...p,form:{...p.form,title:e.target.value}}))}
                          style={{fontSize:13}}/>
                      </div>
                      <div>
                        <p style={{fontSize:10,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>SUMMARY</p>
                        <textarea className="inp" value={draftEdit.form.summary} rows={3}
                          onChange={e=>setDraftEdit(p=>({...p,form:{...p.form,summary:e.target.value}}))}
                          style={{fontSize:13,minHeight:72}}/>
                      </div>
                      <div>
                        <p style={{fontSize:10,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>CONTENT</p>
                        <textarea className="inp" value={draftEdit.form.content} rows={5}
                          onChange={e=>setDraftEdit(p=>({...p,form:{...p.form,content:e.target.value}}))}
                          style={{fontSize:13,minHeight:110}}/>
                      </div>
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                        <div>
                          <p style={{fontSize:10,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>CATEGORY</p>
                          <select className="inp" style={{fontSize:13}} value={draftEdit.form.category}
                            onChange={e=>setDraftEdit(p=>({...p,form:{...p.form,category:e.target.value}}))}>
                            {CATEGORIES.map(c=><option key={c.value} value={c.value}>{c.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <p style={{fontSize:10,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>SOURCE</p>
                          <input className="inp" style={{fontSize:13}} value={draftEdit.form.source}
                            onChange={e=>setDraftEdit(p=>({...p,form:{...p.form,source:e.target.value}}))}/>
                        </div>
                      </div>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        <button className={`tog`} style={{background:draftEdit.form.isBreaking?'#ef4444':'var(--border2)'}}
                          onClick={()=>setDraftEdit(p=>({...p,form:{...p.form,isBreaking:!p.form.isBreaking}}))}>
                          <div className="tog-thumb" style={{left:draftEdit.form.isBreaking?22:4}}></div>
                        </button>
                        <span style={{fontSize:12,fontWeight:600}}>⚡ Breaking News</span>
                      </div>
                      <div style={{display:'flex',gap:8}}>
                        <button className="btn btn-accent" style={{flex:1,fontSize:13,padding:'10px'}}
                          onClick={saveDraftEdit} disabled={draftSaving}>
                          {draftSaving?'Saving...':'💾 Save Changes'}
                        </button>
                        <button className="btn btn-ghost" style={{fontSize:13,padding:'10px'}} onClick={()=>setDraftEdit(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {/* Video result for this draft */}
                  {videoResult?.article?.id===d.id&&!videoBusy&&(
                    <div style={{padding:'10px 14px',borderTop:'1px solid var(--border)',background:'rgba(245,166,35,.05)'}}>
                      <button className="btn btn-accent" onClick={downloadVideo} style={{width:'100%',fontSize:12}}>
                        ⬇️ Download Video
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── MEDIA MANAGER (Social Media Hub) ─────────────────────────
const MediaManager = ({toast}) => {
  const PLATFORMS = [
    {id:'instagram', label:'Instagram', color:'#E1306C', bg:'rgba(225,48,108,.1)', border:'rgba(225,48,108,.25)',
     icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>,
     tokenLabel:'Session Cookie (JSON)', tokenHelp:'Open Instagram in Chrome → DevTools → Application → Cookies → copy sessionid cookie value as JSON: {"sessionid":"..."}',
     tokenField:'cookieData', hasPageId:false},
    {id:'youtube', label:'YouTube', color:'#FF0000', bg:'rgba(255,0,0,.08)', border:'rgba(255,0,0,.22)',
     icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 0 0-1.95 1.96A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.96A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02"/></svg>,
     tokenLabel:'OAuth Refresh Token', tokenHelp:'Go to Google OAuth Playground → authorize YouTube Data API v3 → copy Refresh Token here',
     tokenField:'accessToken', hasPageId:false},
    {id:'facebook', label:'Facebook', color:'#1877F2', bg:'rgba(24,119,242,.08)', border:'rgba(24,119,242,.22)',
     icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>,
     tokenLabel:'Page Access Token', tokenHelp:'Go to Facebook Developers → Graph API Explorer → select your page → generate Page Access Token',
     tokenField:'accessToken', hasPageId:true},
    {id:'tiktok', label:'TikTok', color:'#69C9D0', bg:'rgba(105,201,208,.08)', border:'rgba(105,201,208,.22)',
     icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/></svg>,
     tokenLabel:'Session Cookies (JSON)', tokenHelp:'Open TikTok in Chrome → DevTools → Application → Cookies → export as JSON using Cookie Editor extension',
     tokenField:'cookieData', hasPageId:false},
    {id:'x', label:'X (Twitter)', color:'#888', bg:'rgba(136,136,136,.08)', border:'rgba(136,136,136,.22)',
     icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>,
     tokenLabel:'API Tokens (key|secret|access|access_secret)', tokenHelp:'Go to developer.twitter.com → your app → Keys and Tokens → paste as: API_KEY|API_SECRET|ACCESS_TOKEN|ACCESS_SECRET',
     tokenField:'accessToken', hasPageId:false},
  ];

  const [activeTab, setActiveTab] = useState('accounts');
  const [accounts, setAccounts]   = useState({});
  const [queue, setQueue]         = useState([]);
  const [loadingAcc, setLoadingAcc] = useState(true);
  const [loadingQ,   setLoadingQ]   = useState(true);
  const [editing,    setEditing]    = useState(null); // platform id
  const [editForm,   setEditForm]   = useState({});
  const [saving,     setSaving]     = useState(false);
  const [videos,     setVideos]     = useState([]);
  const [loadingVid, setLoadingVid] = useState(true);

  // ── Firestore: social accounts ───────────────────────────────
  useEffect(()=>{
    const unsub = db.collection('social_accounts').onSnapshot(snap=>{
      const map={};
      snap.docs.forEach(d=>{ map[d.id]={id:d.id,...d.data()}; });
      setAccounts(map);
      setLoadingAcc(false);
    }, ()=>setLoadingAcc(false));
    return ()=>unsub();
  },[]);

  // ── Firestore: auto-posted videos ────────────────────────────
  // Unordered fetch + client-side sort + filter. Avoids needing a composite
  // index AND avoids dropping autoPosted docs that happen to lack `timestamp`.
  useEffect(()=>{
    const unsub = db.collection('news').limit(500)
      .onSnapshot(snap=>{
        const auto = snap.docs
          .map(d=>({id:d.id,...d.data()}))
          .filter(n=>n.autoPosted===true)
          .sort((a,b)=> window.__docTime(b) - window.__docTime(a))
          .slice(0,30);
        setVideos(auto);
        setLoadingVid(false);
      }, ()=>setLoadingVid(false));
    return ()=>unsub();
  },[]);

  // ── Firestore: social media queue ────────────────────────────
  useEffect(()=>{
    if(activeTab!=='queue') return;
    const unsub = db.collection('social_media_queue')
      .orderBy('createdAt','desc').limit(30)
      .onSnapshot(snap=>{
        setQueue(snap.docs.map(d=>({id:d.id,...d.data()})));
        setLoadingQ(false);
      }, ()=>setLoadingQ(false));
    return ()=>unsub();
  },[activeTab]);

  const openEdit = (p) => {
    const acc = accounts[p.id] || {};
    setEditForm({
      username: acc.username||'',
      accessToken: acc.accessToken||'',
      cookieData: typeof acc.cookieData==='object'&&acc.cookieData
        ? JSON.stringify(acc.cookieData,null,2)
        : (acc.cookieData||''),
      pageId: acc.pageId||'',
      notes: acc.notes||'',
    });
    setEditing(p.id);
  };

  const saveAccount = async (platformId, plat) => {
    setSaving(true);
    try {
      const fd = editForm;
      let cookieData = null;
      if(plat.tokenField==='cookieData' && fd.cookieData.trim()){
        try{ cookieData = JSON.parse(fd.cookieData); }
        catch{ cookieData = fd.cookieData; } // store as string if not valid JSON
      }
      await db.collection('social_accounts').doc(platformId).set({
        platform: platformId,
        connected: true,
        username: fd.username.trim(),
        accessToken: plat.tokenField==='accessToken' ? fd.accessToken.trim() : (accounts[platformId]?.accessToken||''),
        cookieData: cookieData,
        pageId: fd.pageId.trim()||null,
        notes: fd.notes.trim(),
        connectedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      },{merge:true});
      toast.add(`${plat.label} connected!`,'ok');
      setEditing(null);
    } catch(e){ toast.add('Save failed: '+e.message,'error'); }
    setSaving(false);
  };

  const disconnectAccount = async (platformId, label) => {
    try{
      await db.collection('social_accounts').doc(platformId).set({
        connected: false, accessToken:'', cookieData:null,
        disconnectedAt: firebase.firestore.FieldValue.serverTimestamp(),
      },{merge:true});
      toast.add(`${label} disconnected`,'ok');
    }catch(e){ toast.add('Error: '+e.message,'error'); }
  };

  const fmtStatus = (results, plat) => {
    if(!results) return null;
    const r = results[plat];
    if(!r) return null;
    return r.success
      ? <span style={{color:'var(--success)',fontWeight:700,fontSize:11}}>✓ Posted</span>
      : <span style={{color:'var(--danger)',fontWeight:700,fontSize:11}}>✗ Failed</span>;
  };

  return (
    <div>
      <div style={{marginBottom:20}}>
        <p style={{fontFamily:'Outfit',fontWeight:800,fontSize:20,marginBottom:4}}>Media Hub</p>
        <p style={{color:'var(--muted)',fontSize:13}}>Connect social accounts &amp; track auto-uploads</p>
      </div>

      {/* Tab bar */}
      <div style={{display:'flex',gap:8,marginBottom:20,borderBottom:'1px solid var(--border)',paddingBottom:12}}>
        {['accounts','queue','videos'].map(t=>(
          <button key={t} onClick={()=>setActiveTab(t)}
            style={{padding:'7px 16px',borderRadius:8,border:'none',cursor:'pointer',fontFamily:'Outfit',fontWeight:600,fontSize:13,
              background:activeTab===t?'var(--accent)':'var(--surface2)',
              color:activeTab===t?'#050c18':'var(--text)'}}>
            {t==='accounts'?'🔗 Accounts':t==='queue'?'📤 Upload Queue':'🎬 Videos'}
          </button>
        ))}
      </div>

      {/* ── ACCOUNTS TAB ─────────────────────────────────────── */}
      {activeTab==='accounts'&&(
        <div>
          <div style={{display:'grid',gap:14}}>
            {PLATFORMS.map(p=>{
              const acc = accounts[p.id]||{};
              const connected = acc.connected && (acc.accessToken||acc.cookieData);
              const isEditing = editing===p.id;
              return (
                <div key={p.id} className="card" style={{padding:0,overflow:'hidden',border:`1px solid ${connected?p.border:'var(--border)'}`,borderRadius:14}}>
                  {/* Platform header */}
                  <div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 16px',background:connected?p.bg:'transparent'}}>
                    <div style={{width:42,height:42,borderRadius:12,background:connected?p.bg:'var(--surface2)',
                      display:'flex',alignItems:'center',justifyContent:'center',color:connected?p.color:'var(--muted)',
                      border:`1.5px solid ${connected?p.border:'var(--border)'}`}}>
                      {p.icon}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <p style={{fontWeight:700,fontSize:15}}>{p.label}</p>
                        <div style={{width:7,height:7,borderRadius:'50%',background:connected?'var(--success)':'var(--danger)',flexShrink:0}}></div>
                        <span style={{fontSize:11,fontWeight:600,color:connected?'var(--success)':'var(--danger)'}}>
                          {connected?'Connected':'Disconnected'}
                        </span>
                      </div>
                      {connected&&acc.username&&(
                        <p style={{fontSize:12,color:'var(--muted)',marginTop:2}}>@{acc.username}</p>
                      )}
                      {connected&&acc.lastPostedAt&&(
                        <p style={{fontSize:11,color:'var(--dim)',marginTop:1}}>Last post: {timeAgo(acc.lastPostedAt)}</p>
                      )}
                    </div>
                    <div style={{display:'flex',gap:8,flexShrink:0}}>
                      {connected&&(
                        <button className="btn btn-ghost" style={{fontSize:12,padding:'6px 12px',color:'var(--danger)'}}
                          onClick={()=>disconnectAccount(p.id,p.label)}>Disconnect</button>
                      )}
                      <button className="btn btn-accent" style={{fontSize:12,padding:'6px 14px'}}
                        onClick={()=>isEditing?setEditing(null):openEdit(p)}>
                        {isEditing?'Cancel':connected?'Edit':'Connect'}
                      </button>
                    </div>
                  </div>

                  {/* Edit form */}
                  {isEditing&&(
                    <div style={{padding:'14px 16px',borderTop:'1px solid var(--border)',display:'flex',flexDirection:'column',gap:12}}>
                      <div>
                        <p style={{fontSize:11,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>USERNAME / HANDLE</p>
                        <input className="inp" style={{fontSize:13}} placeholder={`@${p.id}account`}
                          value={editForm.username} onChange={e=>setEditForm(f=>({...f,username:e.target.value}))}/>
                      </div>
                      {p.hasPageId&&(
                        <div>
                          <p style={{fontSize:11,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>PAGE ID (Facebook)</p>
                          <input className="inp" style={{fontSize:13}} placeholder="123456789..."
                            value={editForm.pageId} onChange={e=>setEditForm(f=>({...f,pageId:e.target.value}))}/>
                        </div>
                      )}
                      <div>
                        <p style={{fontSize:11,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>{p.tokenLabel.toUpperCase()}</p>
                        <textarea className="inp" rows={3} style={{fontSize:12,fontFamily:'monospace',resize:'vertical'}}
                          placeholder={p.tokenField==='cookieData'?'{"sessionid":"abc123..."}':'paste token here...'}
                          value={p.tokenField==='cookieData'?editForm.cookieData:editForm.accessToken}
                          onChange={e=>setEditForm(f=>({...f,[p.tokenField==='cookieData'?'cookieData':'accessToken']:e.target.value}))}/>
                        <p style={{fontSize:11,color:'var(--dim)',marginTop:4,lineHeight:1.4}}>{p.tokenHelp}</p>
                      </div>
                      <div>
                        <p style={{fontSize:11,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:4}}>NOTES (optional)</p>
                        <input className="inp" style={{fontSize:13}} placeholder="e.g. refresh every 30 days..."
                          value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))}/>
                      </div>
                      <div style={{display:'flex',gap:8}}>
                        <button className="btn btn-accent" style={{flex:1,fontSize:13}} onClick={()=>saveAccount(p.id,p)} disabled={saving}>
                          {saving?'Saving...':'💾 Save & Connect'}
                        </button>
                        <button className="btn btn-ghost" style={{fontSize:13}} onClick={()=>setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Status overview */}
          <div className="card" style={{marginTop:16,padding:'12px 16px'}}>
            <p style={{fontSize:12,fontWeight:700,color:'var(--dim)',letterSpacing:'.05em',marginBottom:10}}>CONNECTION STATUS</p>
            <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
              {PLATFORMS.map(p=>{
                const acc=accounts[p.id]||{};
                const ok=acc.connected&&(acc.accessToken||acc.cookieData);
                return(
                  <div key={p.id} style={{display:'flex',alignItems:'center',gap:6,padding:'5px 12px',borderRadius:999,
                    background:ok?'rgba(52,211,153,.08)':'rgba(248,113,113,.08)',
                    border:`1px solid ${ok?'rgba(52,211,153,.25)':'rgba(248,113,113,.25)'}`}}>
                    <div style={{width:6,height:6,borderRadius:'50%',background:ok?'var(--success)':'var(--danger)'}}></div>
                    <span style={{fontSize:12,fontWeight:600,color:ok?'var(--success)':'var(--danger)'}}>{p.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── VIDEOS TAB ───────────────────────────────────────── */}
      {activeTab==='videos'&&(
        <div>
          {loadingVid?(
            <div style={{textAlign:'center',padding:40,color:'var(--muted)'}}>Loading videos...</div>
          ):videos.length===0?(
            <div style={{textAlign:'center',padding:40,color:'var(--muted)'}}>
              <Ic n="video" s={40} c="var(--border2)"/>
              <p style={{marginTop:12,fontSize:14}}>No auto-published videos yet</p>
              <p style={{fontSize:12,color:'var(--dim)',marginTop:4}}>Run automation to generate news videos</p>
            </div>
          ):(
            <div style={{display:'grid',gap:14}}>
              {videos.map(v=>{
                const qEntry = queue.find(q=>q.newsId===v.id);
                return (
                  <div key={v.id} className="card" style={{padding:0,overflow:'hidden'}}>
                    <div style={{display:'flex',gap:12,padding:14}}>
                      {v.thumbnail&&(
                        <img src={v.thumbnail} alt="" loading="lazy"
                          style={{width:100,height:64,objectFit:'cover',borderRadius:8,flexShrink:0,background:'var(--surface2)'}}/>
                      )}
                      <div style={{flex:1,minWidth:0}}>
                        <p style={{fontWeight:600,fontSize:13,lineHeight:1.4,marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.title}</p>
                        <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                          <span style={{fontSize:11,color:'var(--muted)'}}>{timeAgo(v.timestamp)}</span>
                          <span style={{fontSize:11,color:'var(--muted)'}}>·</span>
                          <span style={{fontSize:11,color:'var(--muted)'}}>{v.category}</span>
                          {v.videoUrl&&(
                            <a href={v.videoUrl} target="_blank" rel="noopener noreferrer"
                              style={{fontSize:11,color:'var(--accent)',fontWeight:600}}>▶ View</a>
                          )}
                        </div>
                        {/* Social status chips */}
                        {qEntry?.results&&(
                          <div style={{display:'flex',gap:5,marginTop:6,flexWrap:'wrap'}}>
                            {PLATFORMS.map(p=>{
                              const r=qEntry.results[p.id];
                              if(!r) return null;
                              return(
                                <span key={p.id} style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:999,
                                  background:r.success?'rgba(52,211,153,.12)':'rgba(248,113,113,.12)',
                                  color:r.success?'var(--success)':'var(--danger)',
                                  border:`1px solid ${r.success?'rgba(52,211,153,.3)':'rgba(248,113,113,.3)'}`}}>
                                  {r.success?'✓':'✗'} {p.label}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── QUEUE TAB ────────────────────────────────────────── */}
      {activeTab==='queue'&&(
        <div>
          {loadingQ?(
            <div style={{textAlign:'center',padding:40,color:'var(--muted)'}}>Loading queue...</div>
          ):queue.length===0?(
            <div style={{textAlign:'center',padding:40,color:'var(--muted)'}}>
              <Ic n="send" s={40} c="var(--border2)"/>
              <p style={{marginTop:12,fontSize:14}}>Upload queue is empty</p>
              <p style={{fontSize:12,color:'var(--dim)',marginTop:4}}>Social uploads will appear here after automation runs</p>
            </div>
          ):(
            <div style={{display:'grid',gap:12}}>
              {queue.map(q=>{
                const statusColor = q.status==='completed'?'var(--success)':q.status==='processing'?'var(--accent)':'var(--muted)';
                const successCount = q.results?Object.values(q.results).filter(r=>r?.success).length:0;
                const totalCount = q.platforms?.length||0;
                return(
                  <div key={q.id} className="card" style={{padding:'12px 14px'}}>
                    <div style={{display:'flex',alignItems:'flex-start',gap:10,marginBottom:8}}>
                      <div style={{flex:1,minWidth:0}}>
                        <p style={{fontWeight:600,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{q.newsTitle||'Untitled'}</p>
                        <p style={{fontSize:11,color:'var(--muted)',marginTop:2}}>{fmtDate(q.createdAt)}</p>
                      </div>
                      <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
                        <div style={{width:7,height:7,borderRadius:'50%',background:statusColor}}></div>
                        <span style={{fontSize:11,fontWeight:700,color:statusColor,textTransform:'capitalize'}}>{q.status}</span>
                      </div>
                    </div>
                    <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                      {(q.platforms||[]).map(pid=>{
                        const plat = PLATFORMS.find(p=>p.id===pid);
                        const r = q.results?.[pid];
                        if(!plat) return null;
                        return(
                          <div key={pid} style={{display:'flex',alignItems:'center',gap:4,padding:'3px 9px',borderRadius:999,
                            background:r?.success?'rgba(52,211,153,.1)':r?'rgba(248,113,113,.1)':'var(--surface2)',
                            border:`1px solid ${r?.success?'rgba(52,211,153,.3)':r?'rgba(248,113,113,.3)':'var(--border)'}`}}>
                            <span style={{fontSize:10,fontWeight:700,color:r?.success?'var(--success)':r?'var(--danger)':'var(--muted)'}}>
                              {r?.success?'✓':r?'✗':'⏳'} {plat.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {q.status==='completed'&&(
                      <p style={{fontSize:11,color:'var(--dim)',marginTop:6}}>{successCount}/{totalCount} platforms posted successfully</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── PAGES CONFIG ──────────────────────────────────────────────
const PAGES = [
  {id:'dashboard',label:'Home',icon:'grid'},
  {id:'news',label:'News',icon:'news'},
  {id:'ai',label:'AI',icon:'sparkle'},
  {id:'automation',label:'Auto',icon:'bot'},
  {id:'media',label:'Media',icon:'video'},
  {id:'logos',label:'Logos',icon:'tag'},
  {id:'categories',label:'Categories',icon:'tag'},
  {id:'ads',label:'Ads',icon:'ads'},
  {id:'users',label:'Users',icon:'users'},
  {id:'comments',label:'Comments',icon:'chat'},
  {id:'notifications',label:'Alerts',icon:'bell'},
  {id:'settings',label:'Settings',icon:'cog'},
];

// ── ADMIN LAYOUT ──────────────────────────────────────────────
const Layout = ({user,onLogout}) => {
  const [page,setPage] = useState('dashboard');
  const [menuOpen,setMenuOpen] = useState(false);
  const [navCat,setNavCat] = useState('all');
  const toast = useToast();
  const pg = PAGES.find(p=>p.id===page)||PAGES[0];

  // Navigate from category to news with filter
  const navigate = (pg, cat='all') => { setNavCat(cat); setPage(pg); };
  // Direct nav (reset category filter)
  const goPage = (id) => { setNavCat('all'); setPage(id); setMenuOpen(false); };

  // Bottom nav pages (5 visible)
  const bottomPages = PAGES.slice(0,5);

  const renderPage = () => {
    const p={toast};
    switch(page){
      case 'dashboard': return <Dashboard/>;
      case 'news': return <NewsManager {...p} initCat={navCat}/>;
      case 'ai': return <AINewsManager {...p} onBack={()=>goPage('dashboard')}/>;
      case 'categories': return <CategoryManager {...p} onNavigate={navigate}/>;
      case 'ads': return <AdsManager {...p}/>;
      case 'comments': return <CommentsManager {...p}/>;
      case 'users': return <UsersManager {...p}/>;
      case 'notifications': return <PushNotifs {...p}/>;
      case 'automation': return <AutomationPage {...p}/>;
      case 'logos': return <LogosManager {...p}/>;
      case 'media': return <MediaManager {...p}/>;
      case 'settings': return <SettingsPage user={user} {...p}/>;
      default: return <Dashboard/>;
    }
  };

  return (
    <div>
      {/* Mobile slide-out menu overlay */}
      {menuOpen&&(
        <div style={{position:'fixed',inset:0,zIndex:200}} onClick={()=>setMenuOpen(false)}>
          <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,.6)',backdropFilter:'blur(4px)'}}></div>
          <div className="slide-up" onClick={e=>e.stopPropagation()}
            style={{position:'absolute',bottom:0,left:0,right:0,background:'var(--surface)',borderRadius:'20px 20px 0 0',border:'1px solid var(--border)',padding:'8px 0 calc(env(safe-area-inset-bottom) + 16px)',zIndex:201}}>
            {/* Handle bar */}
            <div style={{width:36,height:4,borderRadius:2,background:'var(--border2)',margin:'0 auto 16px'}}></div>
            <p style={{padding:'0 20px 10px',fontSize:11,fontWeight:700,color:'var(--dim)',letterSpacing:'.06em'}}>MENU</p>
            {PAGES.map(p=>(
              <button key={p.id} onClick={()=>goPage(p.id)}
                style={{display:'flex',alignItems:'center',gap:12,padding:'13px 20px',width:'100%',background:'transparent',border:'none',cursor:'pointer',
                  color:page===p.id?'var(--accent)':'var(--text)',fontFamily:'Outfit',fontWeight:page===p.id?700:500,fontSize:15,borderLeft:page===p.id?'3px solid var(--accent)':'3px solid transparent'}}>
                <Ic n={p.icon} s={18} c={page===p.id?'var(--accent)':'var(--muted)'}/>
                {p.label}
                {page===p.id&&<div style={{marginLeft:'auto',width:6,height:6,borderRadius:'50%',background:'var(--accent)'}}></div>}
              </button>
            ))}
            <div style={{margin:'10px 16px 0',borderTop:'1px solid var(--border)',paddingTop:10}}>
              <button onClick={()=>{setMenuOpen(false);onLogout();}}
                style={{display:'flex',alignItems:'center',gap:12,padding:'13px 4px',width:'100%',background:'transparent',border:'none',cursor:'pointer',
                  color:'var(--danger)',fontFamily:'Outfit',fontWeight:600,fontSize:15}}>
                <Ic n="out" s={18} c="var(--danger)"/>
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Desktop Sidebar */}
      <aside className="sidebar">
        <div style={{padding:'18px 16px 14px',borderBottom:'1px solid var(--border)',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:36,height:36,borderRadius:10,background:'var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
              <span style={{fontFamily:'Outfit',fontWeight:900,fontSize:12,color:'#050c18'}}>KWT</span>
            </div>
            <div>
              <p style={{fontFamily:'Outfit',fontWeight:800,fontSize:14,lineHeight:1}}>KWT News</p>
              <p style={{fontSize:10,color:'var(--dim)',marginTop:2}}>Admin Panel</p>
            </div>
          </div>
        </div>
        <nav style={{padding:'10px 8px',flex:1,overflowY:'auto'}}>
          {PAGES.map(p=>(
            <button key={p.id} className={`nav-btn ${page===p.id?'active':''}`} onClick={()=>goPage(p.id)}>
              <Ic n={p.icon} s={15}/>
              {p.label}
              {page===p.id&&<div style={{marginLeft:'auto',width:5,height:5,borderRadius:'50%',background:'var(--accent)'}}></div>}
            </button>
          ))}
        </nav>
        <div style={{padding:'10px 8px',borderTop:'1px solid var(--border)',flexShrink:0}}>
          <div style={{padding:'10px 12px',borderRadius:10,display:'flex',gap:8,alignItems:'center',marginBottom:6}}>
            <img src={user.photoURL||`https://ui-avatars.com/api/?name=A&background=F5A623&color=050c18`} style={{width:28,height:28,borderRadius:'50%',objectFit:'cover',border:'1.5px solid var(--border2)',flexShrink:0}}/>
            <div style={{minWidth:0,flex:1}}>
              <p style={{fontSize:12,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user.displayName||'Admin'}</p>
              <p style={{fontSize:10,color:'var(--dim)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user.email}</p>
            </div>
          </div>
          <button className="nav-btn" style={{color:'var(--danger)'}} onClick={onLogout}>
            <Ic n="out" s={14} c="var(--danger)"/> Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="main-wrap">
        {/* Top bar */}
        <div style={{position:'sticky',top:0,background:'rgba(5,12,24,.92)',backdropFilter:'blur(16px)',WebkitBackdropFilter:'blur(16px)',borderBottom:'1px solid var(--border)',padding:'0 16px',height:52,display:'flex',alignItems:'center',justifyContent:'space-between',zIndex:30,flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            {/* Mobile logo */}
            <div style={{display:'flex',alignItems:'center',gap:8}} className="mobile-logo">
              <div style={{width:28,height:28,borderRadius:8,background:'var(--accent)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                <span style={{fontFamily:'Outfit',fontWeight:900,fontSize:10,color:'#050c18'}}>K</span>
              </div>
              <span style={{fontFamily:'Outfit',fontWeight:700,fontSize:15}}>{pg.label}</span>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <div style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',borderRadius:999,background:'rgba(52,211,153,.07)',border:'1px solid rgba(52,211,153,.18)'}}>
              <div className="pulse" style={{width:5,height:5,borderRadius:'50%',background:'var(--success)'}}></div>
              <span style={{fontSize:10,color:'var(--success)',fontWeight:700,letterSpacing:'.04em'}}>LIVE</span>
            </div>
            {/* Mobile hamburger menu button */}
            <button className="btn btn-icon" id="mob-menu" style={{display:'none'}} onClick={()=>setMenuOpen(v=>!v)}>
              <Ic n="menu" s={18}/>
            </button>
          </div>
        </div>
        <style>{`@media(max-width:767px){#mob-menu{display:inline-flex!important}}`}</style>

        {/* Page content */}
        <div style={{padding:'20px 16px 24px',maxWidth:900,margin:'0 auto',overflowX:'hidden'}}>
          {renderPage()}
        </div>
      </div>

      {/* Bottom Nav (mobile) */}
      <nav className="bnav">
        <div style={{display:'flex',alignItems:'stretch'}}>
          {PAGES.slice(0,5).map(p=>(
            <button key={p.id} className={`bnav-item ${page===p.id?'active':''}`} onClick={()=>goPage(p.id)}>
              <Ic n={p.icon} s={20}/>
              <span>{p.label}</span>
              <div className="dot"></div>
            </button>
          ))}
        </div>
      </nav>

      <toast.Toast/>
    </div>
  );
};

// ── ROOT APP ──────────────────────────────────────────────────
const App = () => {
  const [user,setUser] = useState(null);
  const [checking,setChecking] = useState(true);

  useEffect(()=>{
    const u=auth.onAuthStateChanged(u=>{
      setUser(u||null); setChecking(false);
    });
    return ()=>u();
  },[]);

  const logout=()=>{ auth.signOut(); setUser(null); };

  if(checking) return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:16}}>
      <div style={{width:48,height:48,borderRadius:14,background:'var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 8px 32px rgba(245,166,35,.3)'}}>
        <span style={{fontFamily:'Outfit',fontWeight:900,fontSize:13,color:'#050c18'}}>KWT</span>
      </div>
      <div className="spinner"></div>
    </div>
  );

  if(!user) return <Login onLogin={setUser}/>;
  return <Layout user={user} onLogout={logout}/>;
};

createRoot(document.getElementById('root')).render(<App/>);
