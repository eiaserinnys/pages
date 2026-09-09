// Browser source stays literal so Worker bundling cannot introduce server-side helpers.
export const reviewClientSource = `
(function mountReview() {
  const config = window.__PAGES_REVIEW__;
  if (!config || document.getElementById('pages-review')) return;
  const host = document.createElement('div');
  host.id = 'pages-review';
  host.style.cssText = 'position:fixed;inset:auto 16px 16px auto;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = \`<style>
    :host{font:15px/1.5 system-ui,sans-serif;color:#202124;color-scheme:light}
    *{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #c7cbd1;border-radius:8px;padding:9px 14px;background:#fff;color:#202124}
    button:disabled{opacity:.6;cursor:wait}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #4788ef}
    #toggle,#submit{background:#245dcc;color:white}#panel{width:min(380px,calc(100vw - 32px));max-height:calc(100dvh - 90px);overflow:auto;background:white;border:1px solid #d2d6dc;border-radius:12px;padding:16px;box-shadow:0 8px 40px #0003;margin-bottom:8px}
    [hidden]{display:none!important}header{display:flex;align-items:center;justify-content:space-between}h2{font-size:18px;margin:0}p{margin:8px 0}label{display:block;margin-top:10px}input,textarea{display:block;width:100%;padding:8px;border:1px solid #aaa;border-radius:6px;background:white;color:#202124}textarea{min-height:90px;resize:vertical}#messages{padding:0;list-style:none}li{border-bottom:1px solid #ddd;padding:10px 0;overflow-wrap:anywhere;white-space:pre-wrap}blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #c7cbd1}small{color:#555}#status{min-height:24px}#submit{margin-top:10px}
  </style>
  <section id="panel" hidden aria-label="페이지 댓글">
    <header><h2>댓글</h2><button id="close" type="button" aria-label="댓글 닫기">닫기</button></header>
    <p>이 판에 남긴 댓글입니다. 본문을 선택하면 해당 문장을 함께 남길 수 있습니다.</p>
    <button id="refresh" type="button">새로고침</button>
    <p id="status" role="status" aria-live="polite"></p><ul id="messages"></ul>
    <form><label>이름 (선택)<input id="author" maxlength="100" autocomplete="name"></label>
    <blockquote id="quote" hidden></blockquote>
    <label>댓글<textarea id="body" required maxlength="10000"></textarea></label>
    <button id="submit" type="submit">댓글 남기기</button></form>
  </section><button id="toggle" type="button" aria-expanded="false">댓글</button>\`;
  document.body.append(host);
  const el = (id) => root.getElementById(id);
  let quote = '';
  let pending = null;
  let loadId = 0;
  const message = (text) => { el('status').textContent = text; };
  async function request(options) {
    const response = await fetch(config.annotationsUrl, { cache: 'no-store', ...options,
      headers: { 'Content-Type': 'application/json', [config.tokenHeader]: config.capabilityToken } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? '권한이 만료되었습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.'
      : '댓글을 불러오거나 저장하지 못했습니다. 다시 시도해 주세요.');
    return response.json();
  }
  async function load() {
    const currentLoad = ++loadId;
    message('댓글을 불러오는 중입니다.');
    try {
      const data = await request();
      if (currentLoad !== loadId) return;
      el('messages').replaceChildren();
      for (const comment of data.comments) {
        const item = document.createElement('li');
        const author = document.createElement('small');
        author.textContent = comment.author || '익명';
        item.append(author);
        if (comment.selected_text) {
          const selected = document.createElement('blockquote');
          selected.textContent = comment.selected_text;
          item.append(selected);
        }
        const body = document.createElement('p');
        body.textContent = comment.comment ?? comment.body ?? '';
        item.append(body);
        el('messages').append(item);
      }
      message(data.comments.length ? \`댓글 \${data.comments.length}개\` : '아직 댓글이 없습니다.');
    } catch (error) { if (currentLoad === loadId) message(error.message); }
  }
  function close() { el('panel').hidden = true; el('toggle').setAttribute('aria-expanded', 'false'); el('toggle').focus(); }
  el('toggle').onclick = () => {
    if (!el('panel').hidden) return close();
    quote = String(window.getSelection() || '').trim().slice(0, 2000);
    el('quote').textContent = quote;
    el('quote').hidden = !quote;
    el('panel').hidden = false;
    el('toggle').setAttribute('aria-expanded', 'true');
    load();
    el('body').focus();
  };
  el('close').onclick = close;
  el('refresh').onclick = load;
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  root.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const body = el('body').value.trim();
    if (!body || el('submit').disabled) return;
    const author = el('author').value.trim();
    if (!pending || pending.comment !== body || pending.author !== author || pending.selected_text !== quote) {
      pending = { id: crypto.randomUUID(), comment: body, author, selected_text: quote };
    }
    el('submit').disabled = true;
    el('body').disabled = true;
    el('author').disabled = true;
    message('댓글을 저장하는 중입니다.');
    try {
      await request({ method: 'POST', body: JSON.stringify(pending) });
      el('body').value = '';
      pending = null;
      quote = '';
      el('quote').hidden = true;
      await load();
    } catch (error) { message(error.message); }
    finally { el('submit').disabled = false; el('body').disabled = false; el('author').disabled = false; }
  };
})();
`;
