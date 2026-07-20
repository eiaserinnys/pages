'use strict';

const DASHBOARD_CLIENT_SCRIPT = `
  (function () {
    const seed = readJson('dashboard-initial-state');
    const state = {
      activeKind: 'documents',
      query: '',
      selected: null,
      detailRequest: 0,
      collections: {
        documents: normalizeCollection(seed.documents, '/api/dashboard/documents'),
        pages: normalizeCollection(seed.pages, '/api/dashboard/pages'),
      },
    };
    const elements = {
      workspace: document.querySelector('[data-dashboard-workspace]'),
      viewport: document.querySelector('[data-item-list]'),
      items: document.querySelector('[data-list-items]'),
      sentinel: document.querySelector('[data-load-sentinel]'),
      count: document.querySelector('[data-result-count]'),
      loadState: document.querySelector('[data-load-state]'),
      search: document.querySelector('[data-search-input]'),
      clear: document.querySelector('[data-search-clear]'),
      tabs: Array.from(document.querySelectorAll('[data-tab]')),
      detail: document.querySelector('[data-detail-panel]'),
      detailContent: document.querySelector('[data-detail-content]'),
    };
    let searchTimer = null;

    elements.tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { switchTab(tab.dataset.tab); });
    });
    elements.search.addEventListener('input', handleSearchInput);
    elements.clear.addEventListener('click', clearSearch);
    elements.viewport.addEventListener('scroll', maybeLoadMore, { passive: true });
    elements.items.addEventListener('click', handleListClick);
    elements.detail.addEventListener('click', handleDetailClick);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.selected) closeDetail();
    });

    updateChrome();
    renderActiveList();
    prefetchNext(activeCollection());
    requestAnimationFrame(maybeLoadMore);

    function normalizeCollection(value, endpoint) {
      const collection = value && typeof value === 'object' ? value : {};
      return {
        endpoint: endpoint,
        items: Array.isArray(collection.items) ? collection.items : [],
        total: Number(collection.total || 0),
        cursor: Number(collection.cursor || 0),
        limit: Number(collection.limit || 24),
        nextCursor: collection.nextCursor == null ? null : Number(collection.nextCursor),
        hasMore: collection.hasMore === true,
        query: typeof collection.query === 'string' ? collection.query : '',
        loading: false,
        appending: false,
        requestToken: 0,
        prefetchCursor: null,
        prefetchPage: null,
        prefetchPromise: null,
      };
    }

    function switchTab(kind) {
      if (!state.collections[kind] || kind === state.activeKind) return;
      state.activeKind = kind;
      closeDetail();
      updateChrome();
      const collection = activeCollection();
      elements.viewport.scrollTop = 0;
      renderActiveList();
      prefetchNext(collection);
      requestAnimationFrame(maybeLoadMore);
    }

    function handleSearchInput() {
      state.query = elements.search.value.trim();
      elements.clear.hidden = !elements.search.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(resetCollectionsForSearch, 250);
    }

    function clearSearch() {
      clearTimeout(searchTimer);
      elements.search.value = '';
      state.query = '';
      elements.clear.hidden = true;
      elements.search.focus();
      resetCollectionsForSearch();
    }

    async function resetCollectionsForSearch() {
      closeDetail();
      elements.viewport.scrollTop = 0;
      await Promise.allSettled(Object.keys(state.collections).map(function (kind) {
        return resetCollection(kind, state.query);
      }));
    }

    async function resetCollection(kind, query) {
      const collection = state.collections[kind];
      const token = ++collection.requestToken;
      clearPrefetch(collection);
      collection.loading = true;
      collection.items = [];
      collection.total = 0;
      collection.cursor = 0;
      collection.nextCursor = null;
      collection.hasMore = false;
      collection.query = query;
      if (kind === state.activeKind) renderActiveList();
      else updateChrome();
      try {
        const page = await fetchCollection(collection, 0, query);
        if (token !== collection.requestToken) return;
        assignPage(collection, page, false);
        if (kind === state.activeKind) {
          renderActiveList();
          prefetchNext(collection);
          requestAnimationFrame(maybeLoadMore);
        } else updateChrome();
      } catch (error) {
        if (token === collection.requestToken && kind === state.activeKind) showListError(error);
      } finally {
        if (token === collection.requestToken) {
          collection.loading = false;
          if (kind === state.activeKind) updateLoadState();
        }
      }
    }

    async function loadMore() {
      const collection = activeCollection();
      if (collection.loading || collection.appending || !collection.hasMore || collection.nextCursor == null) return;
      const token = collection.requestToken;
      const cursor = collection.nextCursor;
      const query = collection.query;
      collection.appending = true;
      try {
        let page = collection.prefetchCursor === cursor ? collection.prefetchPage : null;
        if (!page && collection.prefetchCursor === cursor && collection.prefetchPromise) {
          page = await collection.prefetchPromise;
        }
        if (!page) page = await fetchCollection(collection, cursor, query);
        if (token !== collection.requestToken || cursor !== collection.nextCursor || query !== collection.query) return;
        collection.prefetchCursor = null;
        collection.prefetchPage = null;
        assignPage(collection, page, true);
        if (collection === activeCollection()) {
          renderActiveList();
          requestAnimationFrame(maybeLoadMore);
        }
      } catch (error) {
        if (token === collection.requestToken) showListError(error);
      } finally {
        if (token === collection.requestToken) {
          collection.appending = false;
          if (collection === activeCollection()) {
            updateLoadState();
            prefetchNext(collection);
          }
        }
      }
    }

    function maybeLoadMore() {
      const remaining = elements.viewport.scrollHeight - elements.viewport.scrollTop - elements.viewport.clientHeight;
      if (remaining < Math.max(320, elements.viewport.clientHeight * 1.5)) loadMore();
    }

    function prefetchNext(collection) {
      const cursor = collection.nextCursor;
      if (collection.loading || collection.appending || !collection.hasMore || cursor == null) return null;
      if (collection.prefetchCursor === cursor) return collection.prefetchPromise;
      const token = collection.requestToken;
      const query = collection.query;
      collection.prefetchCursor = cursor;
      const promise = fetchCollection(collection, cursor, query).then(function (page) {
        if (token !== collection.requestToken || cursor !== collection.nextCursor || query !== collection.query) return null;
        collection.prefetchPage = page;
        return page;
      }).catch(function () {
        return null;
      }).finally(function () {
        if (collection.prefetchPromise === promise) collection.prefetchPromise = null;
        if (!collection.prefetchPage && collection.prefetchCursor === cursor) collection.prefetchCursor = null;
      });
      collection.prefetchPromise = promise;
      return promise;
    }

    function clearPrefetch(collection) {
      collection.appending = false;
      collection.prefetchCursor = null;
      collection.prefetchPage = null;
      collection.prefetchPromise = null;
    }

    async function fetchCollection(collection, cursor, query) {
      const url = collection.endpoint + '?cursor=' + encodeURIComponent(cursor) +
        '&limit=' + encodeURIComponent(collection.limit) + '&q=' + encodeURIComponent(query);
      return fetchJson(url);
    }

    function assignPage(collection, page, append) {
      const nextItems = Array.isArray(page.items) ? page.items : [];
      collection.items = append ? collection.items.concat(nextItems) : nextItems;
      collection.total = Number(page.total || 0);
      collection.cursor = Number(page.cursor || 0);
      collection.limit = Number(page.limit || collection.limit);
      collection.nextCursor = page.nextCursor == null ? null : Number(page.nextCursor);
      collection.hasMore = page.hasMore === true;
      collection.query = typeof page.query === 'string' ? page.query : '';
    }

    function renderActiveList() {
      const collection = activeCollection();
      const renderItem = state.activeKind === 'documents' ? renderDocumentItem : renderPageItem;
      if (!collection.items.length) {
        const label = state.query ? '검색 결과가 없습니다.' :
          (state.activeKind === 'documents' ? '아직 문서가 없습니다.' : '아직 단발 게시가 없습니다.');
        elements.items.innerHTML = '<div class="empty-state">' + escapeHtml(label) + '</div>';
      } else {
        elements.items.innerHTML = collection.items.map(renderItem).join('');
      }
      elements.count.textContent = collection.total.toLocaleString('ko-KR') + '개';
      elements.sentinel.textContent = collection.hasMore ? '아래로 스크롤해 더 보기' :
        (collection.items.length ? '목록의 끝입니다' : '');
      updateChrome();
      updateLoadState();
    }

    function renderDocumentItem(item) {
      const id = String(item.slug || '');
      const selected = isSelected('documents', id) ? ' selected' : '';
      const statusClass = item.private === true ? ' private' : '';
      const latest = item.latestRevNumber ? 'r' + item.latestRevNumber : '리비전 없음';
      return '<article class="list-item' + selected + '" data-kind="documents" data-item-id="' + escapeAttr(id) + '">' +
        '<button class="item-select" type="button" data-select-item data-kind="documents" data-item-id="' + escapeAttr(id) + '">' +
          '<span class="item-title">' + escapeHtml(item.title || id) + '</span>' +
          '<span class="item-subtitle">' + escapeHtml(id + ' · ' + latest + ' · ' + formatDate(item.updatedAt)) + '</span>' +
        '</button>' +
        '<div class="item-actions">' +
          '<span class="status-pill' + statusClass + '">' + (item.private ? '비공개' : '공개') + '</span>' +
          '<span class="status-pill">' + escapeHtml(String(item.revisionCount || 0) + ' revisions') + '</span>' +
          '<button class="button secondary compact" type="button" data-kind="documents" data-item-id="' + escapeAttr(id) + '" data-action="toggle-visibility" data-private="' + (item.private ? 'false' : 'true') + '">' + (item.private ? '공개 전환' : '비공개 전환') + '</button>' +
          '<a class="button secondary compact" href="' + escapeAttr(seed.baseUrl + '/d/' + encodeURIComponent(id) + '/') + '" target="_blank" rel="noreferrer">열기</a>' +
        '</div>' +
      '</article>';
    }

    function renderPageItem(item) {
      const id = String(item.id || '');
      const selected = isSelected('pages', id) ? ' selected' : '';
      const statusClass = item.private === true ? ' private' : '';
      return '<article class="list-item' + selected + '" data-kind="pages" data-item-id="' + escapeAttr(id) + '">' +
        '<button class="item-select" type="button" data-select-item data-kind="pages" data-item-id="' + escapeAttr(id) + '">' +
          '<span class="item-title">' + escapeHtml(item.title || '(제목 없음)') + '</span>' +
          '<span class="item-subtitle">' + escapeHtml(id + ' · ' + formatDate(item.createdAt)) + '</span>' +
        '</button>' +
        '<div class="item-actions">' +
          '<span class="status-pill' + statusClass + '">' + (item.private ? '비공개' : '공개') + '</span>' +
          '<button class="button secondary compact" type="button" data-kind="pages" data-item-id="' + escapeAttr(id) + '" data-action="toggle-visibility" data-private="' + (item.private ? 'false' : 'true') + '">' + (item.private ? '공개 전환' : '비공개 전환') + '</button>' +
          '<button class="button danger compact" type="button" data-kind="pages" data-item-id="' + escapeAttr(id) + '" data-action="delete-page">삭제</button>' +
        '</div>' +
      '</article>';
    }

    function handleListClick(event) {
      const action = event.target.closest('[data-action]');
      if (action) return handleItemAction(action);
      const selector = event.target.closest('[data-select-item]');
      if (selector) showDetail(selector.dataset.kind, selector.dataset.itemId);
    }

    function handleDetailClick(event) {
      const close = event.target.closest('[data-close-detail]');
      if (close) return closeDetail();
      const action = event.target.closest('[data-action]');
      if (action) handleItemAction(action);
    }

    async function handleItemAction(button) {
      const kind = button.dataset.kind;
      const id = button.dataset.itemId;
      if (!state.collections[kind] || !id) return;
      if (button.dataset.action === 'toggle-visibility') {
        button.disabled = true;
        try {
          const endpoint = kind === 'documents'
            ? '/api/dashboard/documents/' + encodeURIComponent(id) + '/visibility'
            : '/api/pages/' + encodeURIComponent(id) + '/visibility';
          const response = await fetch(endpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ private: button.dataset.private === 'true' }),
          });
          if (!response.ok) throw new Error('공개 상태를 바꾸지 못했습니다 (' + response.status + ')');
          const payload = await response.json();
          const item = state.collections[kind].items.find(function (candidate) {
            return collectionItemId(kind, candidate) === id;
          });
          if (item) item.private = payload.private === true;
          renderActiveList();
          if (isSelected(kind, id)) showDetail(kind, id);
        } catch (error) {
          alert(error.message);
        } finally {
          button.disabled = false;
        }
      }
      if (button.dataset.action === 'delete-page' && kind === 'pages') {
        if (!confirm('정말 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
        button.disabled = true;
        try {
          const response = await fetch('/api/pages/' + encodeURIComponent(id), { method: 'DELETE' });
          if (!response.ok) throw new Error('삭제하지 못했습니다 (' + response.status + ')');
          if (isSelected('pages', id)) closeDetail();
          await resetCollection('pages', state.query);
        } catch (error) {
          alert(error.message);
          button.disabled = false;
        }
      }
    }

    async function showDetail(kind, id) {
      state.selected = { kind: kind, id: id };
      state.detailRequest += 1;
      const requestId = state.detailRequest;
      elements.workspace.classList.add('detail-open');
      elements.detail.classList.add('open');
      elements.detail.setAttribute('aria-hidden', 'false');
      elements.detailContent.innerHTML = '<div class="detail-placeholder">상세 정보를 불러오는 중…</div>';
      renderActiveList();
      try {
        const endpoint = kind === 'documents' ? '/api/dashboard/documents/' : '/api/dashboard/pages/';
        const detail = await fetchJson(endpoint + encodeURIComponent(id));
        if (requestId !== state.detailRequest || !isSelected(kind, id)) return;
        elements.detailContent.innerHTML = renderDetail(detail);
      } catch (error) {
        if (requestId === state.detailRequest) {
          elements.detailContent.innerHTML = '<p class="notice">' + escapeHtml(error.message) + '</p>';
        }
      }
    }

    function closeDetail() {
      state.selected = null;
      state.detailRequest += 1;
      elements.workspace.classList.remove('detail-open');
      elements.detail.classList.remove('open');
      elements.detail.setAttribute('aria-hidden', 'true');
      elements.detailContent.innerHTML = '<div class="detail-placeholder">항목을 선택하면 상세 정보가 표시됩니다.</div>';
      renderActiveList();
    }

    function renderDetail(detail) {
      const isPage = detail.kind === 'pages';
      const id = isPage ? detail.id : detail.slug;
      const kicker = isPage ? '단발 게시' : '문서';
      const statusClass = detail.private ? ' private' : '';
      const kind = isPage ? 'pages' : 'documents';
      const visibilityAction = '<button class="button secondary" type="button" data-kind="' + kind + '" data-item-id="' + escapeAttr(id) + '" data-action="toggle-visibility" data-private="' + (detail.private ? 'false' : 'true') + '">' + (detail.private ? '공개로 전환' : '비공개로 전환') + '</button>';
      const deleteAction = isPage ? '<button class="button danger" type="button" data-kind="pages" data-item-id="' + escapeAttr(id) + '" data-action="delete-page">삭제</button>' : '';
      const revisions = Array.isArray(detail.revisions) && detail.revisions.length ?
        '<h3 class="revision-heading">리비전 이력</h3><div class="revision-list">' + detail.revisions.map(renderRevision).join('') + '</div>' : '';
      return '<div class="detail-content">' +
        '<header class="detail-header"><div>' +
          '<p class="detail-kicker">' + kicker + '</p>' +
          '<h2 class="detail-title">' + escapeHtml(detail.title || id) + '</h2>' +
        '</div><button class="icon-button" type="button" data-close-detail aria-label="상세 패널 닫기">×</button></header>' +
        '<div class="detail-actions">' +
          '<span class="status-pill' + statusClass + '">' + (detail.private ? '비공개' : '공개') + '</span>' +
          '<a class="button" href="' + escapeAttr(safeHttpUrl(detail.url)) + '" target="_blank" rel="noreferrer">페이지 열기</a>' + visibilityAction + deleteAction +
        '</div>' +
        renderUnfurl(detail.unfurl || { title: detail.title, url: detail.url }) +
        '<dl class="detail-meta">' +
          metaRow(isPage ? 'ID' : 'Slug', id) +
          (!isPage ? metaRow('Owner', detail.owner || '-') : '') +
          metaRow('생성일', formatDate(detail.createdAt)) +
          (!isPage ? metaRow('수정일', formatDate(detail.updatedAt)) : '') +
          metaRow('URL', detail.url || '-') +
        '</dl>' + revisions +
      '</div>';
    }

    function renderUnfurl(unfurl) {
      const url = safeHttpUrl(unfurl.url);
      const image = safeHttpUrl(unfurl.image);
      const imageMarkup = image ? '<img class="unfurl-image" src="' + escapeAttr(image) + '" alt="" loading="lazy" onerror="this.remove()">' : '';
      return '<a class="unfurl-card" href="' + escapeAttr(url) + '" target="_blank" rel="noreferrer">' + imageMarkup +
        '<div class="unfurl-body"><p class="unfurl-title">' + escapeHtml(unfurl.title || '(제목 없음)') + '</p>' +
        (unfurl.description ? '<p class="unfurl-description">' + escapeHtml(unfurl.description) + '</p>' : '') +
        '<span class="unfurl-url">' + escapeHtml(url) + '</span></div></a>';
    }

    function renderRevision(revision) {
      return '<article class="revision-item"><strong>r' + escapeHtml(revision.revNumber) + '</strong>' +
        '<span class="revision-meta">' + escapeHtml(formatDate(revision.createdAt) + ' · ' + (revision.private ? '비공개' : '공개') + ' · 댓글 ' + (revision.commentCount || 0)) + '</span>' +
        '<a href="' + escapeAttr(safeHttpUrl(revision.url)) + '" target="_blank" rel="noreferrer">열기</a></article>';
    }

    function metaRow(label, value) {
      return '<div><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value == null ? '-' : value) + '</dd></div>';
    }

    function updateChrome() {
      elements.tabs.forEach(function (tab) {
        const selected = tab.dataset.tab === state.activeKind;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
        const count = tab.querySelector('[data-tab-count]');
        if (count) count.textContent = state.collections[tab.dataset.tab].total.toLocaleString('ko-KR');
      });
      elements.search.placeholder = state.activeKind === 'documents' ? '문서 제목 또는 slug 검색' : '단발 게시 제목 검색';
    }

    function updateLoadState() {
      elements.loadState.textContent = activeCollection().loading ? '불러오는 중…' : '';
    }

    function showListError(error) {
      elements.loadState.textContent = error.message;
    }

    function activeCollection() { return state.collections[state.activeKind]; }
    function collectionItemId(kind, item) { return String(kind === 'documents' ? item.slug || '' : item.id || ''); }
    function isSelected(kind, id) { return state.selected && state.selected.kind === kind && state.selected.id === id; }

    async function fetchJson(url) {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('데이터를 불러오지 못했습니다 (' + response.status + ')');
      return response.json();
    }

    function readJson(id) {
      const element = document.getElementById(id);
      return element ? JSON.parse(element.textContent) : {};
    }

    function safeHttpUrl(value) {
      try {
        const url = new URL(String(value || ''), window.location.origin);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '#';
      } catch {
        return '#';
      }
    }

    function formatDate(value) {
      if (!value) return '-';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }
  })();
`;

module.exports = {
  DASHBOARD_CLIENT_SCRIPT,
};
