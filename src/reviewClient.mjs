// Browser source stays literal so Worker bundling cannot introduce server-side helpers.
export const reviewClientSource = `
(function mountReview() {
  const config = window.__PAGES_REVIEW__;
  if (!config || document.getElementById('pages-review')) return;
  const host = document.createElement('div');
  host.id = 'pages-review';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = \`<style>
    :host{font:15px/1.5 system-ui,sans-serif;color:#202124;color-scheme:light}*{box-sizing:border-box}
    [hidden]{display:none!important}button,input,textarea{font:inherit;color:#202124}button{cursor:pointer;background:white;border:1px solid #bbc2cf;border-radius:8px;padding:8px 12px;pointer-events:auto}button:disabled{opacity:.5}
    button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #4788ef}
    #trigger{position:fixed;background:#245dcc;color:white;box-shadow:0 3px 12px #0003}#toggle{position:fixed;right:16px;bottom:16px;background:#245dcc;color:white}
    #panel{position:fixed;right:16px;bottom:64px;width:min(380px,calc(100vw - 32px));max-height:calc(100dvh - 88px);overflow:auto;pointer-events:auto;background:white;border:1px solid #ccd2dc;border-radius:12px;padding:16px;box-shadow:0 8px 40px #0003}
    header{display:flex;justify-content:space-between;align-items:center}h2{font-size:18px;margin:0}p{margin:8px 0}label{display:block;margin-top:10px}input,textarea{width:100%;display:block;background:white;border:1px solid #aaa;border-radius:6px;padding:8px}textarea{min-height:90px;resize:vertical}blockquote{margin:10px 0;padding-left:10px;border-left:3px solid #e9b447;overflow-wrap:anywhere;white-space:pre-wrap}
    #messages{list-style:none;padding:0}li{border-bottom:1px solid #ddd;padding:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#555}#submit{margin-top:10px;background:#245dcc;color:white}
    .highlight{position:fixed;background:#ffca284d;border-bottom:2px solid #e7b12c;pointer-events:none}.draft{background:#438bf333;border-color:#438bf3}.marker{position:fixed;padding:0;width:24px;height:24px;font-size:13px;background:#ffe19b;border-color:#d3a129}
  </style><div id="highlights"></div><button id="trigger" hidden>코멘트 남기기</button>
  <section id="panel" hidden role="dialog" aria-label="본문 코멘트"><header><h2>코멘트</h2><button id="close" aria-label="코멘트 닫기">닫기</button></header>
  <p id="status" role="status" aria-live="polite"></p><blockquote id="quote" hidden></blockquote><ul id="messages"></ul>
  <form hidden><label>이름 (선택)<input id="author" maxlength="100" autocomplete="name"></label><label>코멘트<textarea id="body" required maxlength="10000"></textarea></label><button id="submit">댓글 남기기</button></form></section>
  <button id="toggle" aria-expanded="false">코멘트</button>\`;
  document.body.append(host);
  const el = id => root.getElementById(id);
  const form = root.querySelector('form');
  let comments = [], locations = [], candidate = null, active = null, frame = 0, loadId = 0;
  const drafts = new Map();
  const excluded = 'script,style,noscript,template,input,textarea,select,[contenteditable],#pages-review';
  function indexText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const entries = []; let text = '', node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest(excluded)) continue;
      entries.push({node,start:text.length,end:text.length + node.length}); text += node.data;
    }
    return {text,entries};
  }
  function makeRange(index,start,end) {
    const first = index.entries.find(e => e.end > start && e.start <= start);
    const last = index.entries.find(e => e.end >= end && e.start < end);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node,start-first.start); range.setEnd(last.node,end-last.start); return range;
  }
  function resolve(anchor,index) {
    if (!anchor.selected_text || (anchor.asset_path ? anchor.asset_path !== config.assetPath : !config.isEntrypoint)) return null;
    const quote = anchor.selected_text;
    const contextMatches = start => (!anchor.prefix || index.text.slice(Math.max(0,start-anchor.prefix.length),start) === anchor.prefix) && (!anchor.suffix || index.text.slice(start+quote.length,start+quote.length+anchor.suffix.length) === anchor.suffix);
    const blockMatches = start => {
      if (!anchor.block_id) return true;
      const entry = index.entries.find(e=>e.start<=start && e.end>start);
      let node = entry?.node.parentElement;
      while(node && node !== document.body) {
        if (node.id === anchor.block_id || node.getAttribute('data-block-id') === anchor.block_id) return true;
        node=node.parentElement;
      }
      return false;
    };
    const position = anchor.text_position;
    if (position && index.text.slice(position.start,position.end) === quote && contextMatches(position.start) && blockMatches(position.start)) return makeRange(index,position.start,position.end);
    const matches=[]; let start = index.text.indexOf(quote);
    while(start !== -1) {
      if(contextMatches(start) && blockMatches(start)) matches.push(start);
      start=index.text.indexOf(quote,start+1);
    }
    return matches.length===1 ? makeRange(index,matches[0],matches[0]+quote.length) : null;
  }
  function capture() {
    const selection=window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) { candidate=null; el('trigger').hidden=true; return; }
    const range=selection.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer) || host.contains(range.commonAncestorContainer)) return;
    const index=indexText(); let start=null,end=null;
    for(const entry of index.entries) {
      if(!range.intersectsNode(entry.node)) continue;
      const from=range.startContainer===entry.node ? range.startOffset : 0;
      const to=range.endContainer===entry.node ? range.endOffset : entry.node.length;
      if(to>from){ if(start===null) start=entry.start+from; end=entry.start+to; }
    }
    if(start===null || end-start>2000 || !index.text.slice(start,end).trim()) {el('trigger').hidden=true;return;}
    const captured=makeRange(index,start,end);
    let block=captured.commonAncestorContainer.nodeType===3 ? captured.commonAncestorContainer.parentElement : captured.commonAncestorContainer;
    block=block.closest('[id],[data-block-id]');
    candidate={selected_text:index.text.slice(start,end),prefix:index.text.slice(Math.max(0,start-48),start),suffix:index.text.slice(end,end+48),block_id:block===document.body?'':(block?.id || block?.getAttribute('data-block-id') || ''),asset_path:config.assetPath,text_position:{start,end}};
    const rect=captured.getBoundingClientRect();
    el('trigger').hidden=false;
    el('trigger').style.left=Math.max(8,Math.min(innerWidth-160,rect.right-80))+'px';
    el('trigger').style.top=Math.max(8,Math.min(innerHeight-48,rect.bottom+6))+'px';
  }
  function draftFor(view) {
    if(!drafts.has(view.key)) drafts.set(view.key,{body:'',author:'',pending:null,busy:false});
    return drafts.get(view.key);
  }
  function saveDraft() { if(active?.key){const d=draftFor(active); d.body=el('body').value;d.author=el('author').value;} }
  function item(comment) {
    const li=document.createElement('li'), author=document.createElement('small'), body=document.createElement('p');
    author.textContent=comment.author || '익명';body.textContent=comment.comment ?? comment.body ?? '';li.append(author,body);return li;
  }
  function show(view) {
    saveDraft();active=view;el('panel').hidden=false;el('toggle').setAttribute('aria-expanded','true');el('trigger').hidden=true;renderPanel();schedule();
  }
  function renderPanel() {
    el('messages').replaceChildren();el('quote').hidden=true;form.hidden=!active?.key;el('status').textContent='';
    if(!active?.key) {
      el('status').textContent=comments.length ? '본문 하이라이트나 목록에서 스레드를 열 수 있습니다.' : '본문을 드래그하거나 키보드로 선택해 코멘트를 남기세요.';
      for(const comment of comments){const li=item(comment),button=document.createElement('button');button.textContent=comment.selected_text || '위치 없는 코멘트';button.onclick=()=>showThread(comment);li.prepend(button);el('messages').append(li);}return;
    }
    const anchor=active.anchor;el('quote').hidden=false;el('quote').textContent=anchor.selected_text || '선택 위치 정보 없음';
    if(active.id){const comment=comments.find(c=>c.id===active.id);if(comment){el('messages').append(item(comment));for(const reply of comment.replies || []) el('messages').append(item(reply));}if(!resolve(anchor,indexText())) el('status').textContent='원문 위치를 확인할 수 없습니다. 코멘트와 답글은 보존되어 있습니다.';}
    const d=draftFor(active);el('body').value=d.body;el('author').value=d.author;el('submit').disabled=d.busy;el('body').disabled=d.busy;el('author').disabled=d.busy;el('submit').textContent=active.id?'답글 남기기':'코멘트 남기기';
  }
  function showThread(comment){show({key:'thread:'+comment.id,id:comment.id,anchor:comment});}
  function close(){saveDraft();active=null;el('panel').hidden=true;el('toggle').setAttribute('aria-expanded','false');el('toggle').focus();schedule();}
  async function request(options={},suffix='') {
    const response=await fetch(config.annotationsUrl+suffix,{cache:'no-store',...options,headers:{'Content-Type':'application/json',[config.tokenHeader]:config.capabilityToken}});
    if(!response.ok) throw new Error(response.status===401 || response.status===403 ? '권한이 만료되었습니다. 페이지를 새로고침해 주세요.' : '저장하거나 불러오지 못했습니다. 다시 시도해 주세요.');
    return response.json();
  }
  async function load(){const ticket=++loadId;const data=await request();if(ticket!==loadId)return;comments=data.comments;el('toggle').textContent='코멘트 '+comments.length;if(active){saveDraft();renderPanel();}schedule();}
  function paint() {
    frame=0;const index=indexText();el('highlights').replaceChildren();locations=[];
    function draw(anchor,id,draft=false) {
      const range=resolve(anchor,index);if(!range)return;
      let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
      let ancestor=range.commonAncestorContainer.nodeType===3?range.commonAncestorContainer.parentElement:range.commonAncestorContainer;
      while(ancestor && ancestor!==document.body){const style=getComputedStyle(ancestor),box=ancestor.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(style.overflowX)){clip.left=Math.max(clip.left,box.left);clip.right=Math.min(clip.right,box.right);}if(/hidden|clip|auto|scroll/.test(style.overflowY)){clip.top=Math.max(clip.top,box.top);clip.bottom=Math.min(clip.bottom,box.bottom);}ancestor=ancestor.parentElement;}
      const rects=Array.from(range.getClientRects()).map(r=>{const left=Math.max(r.left,clip.left),top=Math.max(r.top,clip.top),right=Math.min(r.right,clip.right),bottom=Math.min(r.bottom,clip.bottom);return {left,top,right,bottom,width:right-left,height:bottom-top};}).filter(r=>r.width>0 && r.height>0);
      for(const rect of rects){const span=document.createElement('span');span.className='highlight'+(draft?' draft':'');span.dataset.commentId=id || '';span.style.cssText='left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;height:'+rect.height+'px';el('highlights').append(span);}
      if(id && rects.length){locations.push({id,rects});const last=rects[rects.length-1],button=document.createElement('button');button.className='marker';button.dataset.commentId=id;button.textContent='💬';button.setAttribute('aria-label','선택한 본문의 코멘트 열기');button.style.left=Math.min(innerWidth-26,Math.max(0,last.right+3))+'px';button.style.top=Math.max(0,last.bottom-20)+'px';button.onclick=()=>showThread(comments.find(c=>c.id===id));el('highlights').append(button);}
    }
    for(const comment of comments)draw(comment,comment.id);
    if(active?.key && !active.id)draw(active.anchor,null,true);
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(paint);}
  el('trigger').onpointerdown=e=>e.preventDefault();
  el('trigger').onclick=()=>{if(!candidate)return;const anchor=candidate;const existing=comments.find(c=>c.asset_path===anchor.asset_path && c.selected_text===anchor.selected_text && c.text_position?.start===anchor.text_position.start);show(existing?{key:'thread:'+existing.id,id:existing.id,anchor:existing}:{key:'new:'+JSON.stringify(anchor),anchor});el('body').focus();};
  el('toggle').onclick=()=>el('panel').hidden?show({}):close();el('close').onclick=close;
  root.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
  document.addEventListener('selectionchange',()=>{if(root.activeElement)return;capture();});
  document.addEventListener('pointerup',e=>{if(e.composedPath().includes(host))return;setTimeout(capture,0);});
  document.addEventListener('keyup',e=>{if(!e.composedPath().includes(host))capture();});
  document.addEventListener('click',e=>{if(e.composedPath().includes(host) || !window.getSelection()?.isCollapsed)return;const location=locations.find(l=>l.rects.some(r=>e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom));if(location){e.preventDefault();showThread(comments.find(c=>c.id===location.id));}},true);
  window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
  new ResizeObserver(schedule).observe(document.body);
  new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
  document.fonts?.ready.then(schedule);
  form.onsubmit=async e=>{
    e.preventDefault();if(!active?.key)return;saveDraft();const view=active,d=draftFor(view);if(d.busy || !d.body.trim())return;
    const payload={comment:d.body.trim(),author:d.author.trim(),...(!view.id?view.anchor:{})};
    if(!d.pending || JSON.stringify(d.pending.payload)!==JSON.stringify(payload))d.pending={id:crypto.randomUUID(),payload};
    d.busy=true;renderPanel();el('status').textContent='저장 중입니다.';
    try{const id=d.pending.id;await request({method:'POST',body:JSON.stringify({id,...payload})},view.id?'/'+encodeURIComponent(view.id)+'/replies':'');d.body='';d.pending=null;d.busy=false;if(active===view)el('body').value='';
      if(!view.id){const saved={id,...payload,replies:[]};if(!comments.some(c=>c.id===id))comments.push(saved);if(active===view)showThread(saved);}
      else {const thread=comments.find(c=>c.id===view.id);if(thread){thread.replies=thread.replies || [];if(!thread.replies.some(r=>r.id===id))thread.replies.push({id,...payload});}if(active===view)renderPanel();}
      schedule();await load();}
    catch(error){if(active===view)el('status').textContent=error.message;}
    finally{d.busy=false;if(active===view){el('submit').disabled=false;el('body').disabled=false;el('author').disabled=false;}}
  };
  load().catch(error=>{el('status').textContent=error.message;});
})();
`;
