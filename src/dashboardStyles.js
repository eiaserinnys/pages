'use strict';

const DASHBOARD_STYLES = `
  :root {
    color-scheme: light;
    --bg: #f5f5f7;
    --surface: rgba(255, 255, 255, 0.94);
    --surface-strong: #ffffff;
    --text: #1d1d1f;
    --muted: #6e6e73;
    --line: rgba(0, 0, 0, 0.11);
    --line-strong: rgba(0, 0, 0, 0.18);
    --blue: #006edb;
    --blue-soft: rgba(0, 113, 227, 0.10);
    --red: #d70015;
    --shadow: 0 12px 34px rgba(0, 0, 0, 0.08);
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  }
  body.dashboard-page { height: 100vh; overflow: hidden; }
  button, input { font: inherit; }
  button { color: inherit; }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1, h2, h3, p { margin: 0; }
  code {
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.055);
    padding: 2px 6px;
    font-family: "SF Mono", Consolas, monospace;
    font-size: 0.92em;
  }
  .dashboard-shell {
    display: flex;
    flex-direction: column;
    width: min(1440px, 100%);
    height: 100vh;
    margin: 0 auto;
    padding: 0 24px 24px;
  }
  .dashboard-controls {
    position: sticky;
    z-index: 20;
    top: 0;
    flex: 0 0 auto;
    padding: 24px 0 0;
    background: linear-gradient(180deg, var(--bg) 82%, rgba(245, 245, 247, 0));
  }
  .dashboard-topbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
  }
  .brand-line {
    color: var(--muted);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .dashboard-topbar h1 {
    margin-top: 5px;
    font-size: clamp(28px, 3vw, 40px);
    line-height: 1.05;
    letter-spacing: -0.035em;
  }
  .lede {
    margin-top: 8px;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.5;
  }
  .toolbar {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) auto;
    gap: 16px;
    margin-top: 20px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 16px 16px 0 0;
    background: var(--surface);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.045);
    backdrop-filter: blur(18px);
  }
  .search-wrap { position: relative; min-width: 0; }
  .search-wrap::before {
    position: absolute;
    top: 50%;
    left: 14px;
    color: var(--muted);
    content: "⌕";
    font-size: 21px;
    transform: translateY(-53%);
    pointer-events: none;
  }
  .search-input {
    width: 100%;
    min-height: 42px;
    padding: 0 42px;
    border: 1px solid var(--line);
    border-radius: 12px;
    outline: none;
    background: rgba(255, 255, 255, 0.88);
    color: var(--text);
    font-size: 15px;
  }
  .search-input:focus {
    border-color: rgba(0, 113, 227, 0.5);
    box-shadow: 0 0 0 4px var(--blue-soft);
  }
  .search-clear {
    position: absolute;
    top: 50%;
    right: 8px;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.06);
    color: var(--muted);
    cursor: pointer;
    transform: translateY(-50%);
  }
  .search-clear[hidden] { display: none; }
  .tabs {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.055);
  }
  .tab {
    min-height: 34px;
    padding: 0 15px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
  }
  .tab[aria-selected="true"] {
    background: var(--surface-strong);
    color: var(--text);
    box-shadow: 0 1px 5px rgba(0, 0, 0, 0.12);
  }
  .tab-count {
    margin-left: 5px;
    color: inherit;
    font-variant-numeric: tabular-nums;
  }
  .dashboard-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid var(--line);
    border-top: 0;
    border-radius: 0 0 16px 16px;
    overflow: hidden;
    background: var(--surface-strong);
    box-shadow: var(--shadow);
  }
  .dashboard-workspace.detail-open {
    grid-template-columns: minmax(0, 1fr) minmax(340px, 430px);
  }
  .list-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-strong);
  }
  .list-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 46px;
    padding: 0 18px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 13px;
  }
  .result-count { font-weight: 650; }
  .load-state { min-height: 1em; }
  .item-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .list-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
    min-height: 82px;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.07);
    background: #fff;
  }
  .list-item:hover, .list-item.selected { background: rgba(0, 113, 227, 0.055); }
  .item-select {
    display: grid;
    gap: 6px;
    min-width: 0;
    padding: 4px 2px;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .item-title {
    min-width: 0;
    overflow: hidden;
    font-size: 15px;
    font-weight: 750;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-subtitle {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-actions {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    white-space: nowrap;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    min-height: 25px;
    padding: 0 9px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.06);
    color: var(--muted);
    font-size: 11px;
    font-weight: 750;
  }
  .status-pill.private { background: rgba(215, 0, 21, 0.08); color: var(--red); }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: var(--blue);
    color: #fff;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }
  .button:hover { text-decoration: none; }
  .button.secondary { border-color: var(--line); background: #fff; color: var(--text); }
  .button.danger { border-color: rgba(215, 0, 21, 0.2); background: rgba(215, 0, 21, 0.07); color: var(--red); }
  .button.compact { min-height: 30px; padding: 0 9px; }
  .load-sentinel {
    display: grid;
    min-height: 52px;
    place-items: center;
    color: var(--muted);
    font-size: 12px;
  }
  .empty-state {
    display: grid;
    min-height: 220px;
    place-items: center;
    padding: 28px;
    color: var(--muted);
    font-size: 14px;
    text-align: center;
  }
  .detail-panel {
    display: none;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    border-left: 1px solid var(--line);
    background: #fbfbfc;
  }
  .detail-panel.open { display: block; }
  .detail-placeholder {
    display: grid;
    min-height: 100%;
    place-items: center;
    padding: 32px;
    color: var(--muted);
    text-align: center;
  }
  .detail-content { padding: 22px; }
  .detail-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .detail-kicker { color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
  .detail-title { margin-top: 5px; font-size: 22px; line-height: 1.18; overflow-wrap: anywhere; }
  .icon-button {
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: #fff;
    cursor: pointer;
  }
  .detail-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .unfurl-card {
    display: block;
    margin-top: 20px;
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
    background: #fff;
    color: inherit;
  }
  .unfurl-card:hover { border-color: var(--line-strong); text-decoration: none; }
  .unfurl-image { display: block; width: 100%; aspect-ratio: 1.9 / 1; object-fit: cover; background: #ececf0; }
  .unfurl-body { padding: 14px; }
  .unfurl-title { font-size: 15px; font-weight: 750; line-height: 1.35; }
  .unfurl-description { margin-top: 7px; color: var(--muted); font-size: 13px; line-height: 1.45; }
  .unfurl-url { display: block; margin-top: 10px; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .detail-meta { display: grid; gap: 0; margin: 20px 0 0; }
  .detail-meta div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.07); }
  .detail-meta dt { color: var(--muted); font-size: 12px; font-weight: 700; }
  .detail-meta dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 13px; }
  .revision-heading { margin-top: 24px; font-size: 15px; }
  .revision-list { display: grid; gap: 8px; margin-top: 10px; }
  .revision-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: #fff; font-size: 12px; }
  .revision-meta { min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notice { padding: 18px; color: var(--red); font-size: 13px; }
  .page-shell { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 40px 0 56px; }
  .topbar, .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
  .topbar { margin-bottom: 24px; }
  .eyebrow { margin-bottom: 8px; color: var(--muted); font-size: 12px; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
  .dashboard-section { margin-top: 16px; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
  .section-heading { margin-bottom: 14px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; white-space: nowrap; }
  th { color: var(--muted); background: rgba(0, 0, 0, 0.03); font-size: 11px; text-transform: uppercase; }
  tr:last-child td { border-bottom: 0; }
  .comment-row td { background: rgba(0, 0, 0, 0.025); white-space: normal; }
  .comment { margin: 10px 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  .comment-meta, .meta { display: grid; grid-template-columns: minmax(110px, max-content) 1fr; gap: 8px 12px; padding: 0; }
  .comment-meta div, .meta div { display: contents; }
  .muted { color: var(--muted); }
  @media (max-width: 900px) {
    .dashboard-shell { padding: 0 12px 12px; }
    .dashboard-workspace.detail-open { grid-template-columns: minmax(0, 1fr); }
    .detail-panel {
      position: fixed;
      z-index: 40;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(430px, 94vw);
      border-left: 1px solid var(--line);
      box-shadow: -18px 0 44px rgba(0, 0, 0, 0.17);
    }
  }
  @media (max-width: 640px) {
    .dashboard-controls { padding-top: 14px; }
    .dashboard-topbar { align-items: center; }
    .dashboard-topbar .lede { display: none; }
    .toolbar { grid-template-columns: 1fr; gap: 10px; margin-top: 14px; }
    .tabs { width: 100%; }
    .tab { flex: 1; }
    .list-item { grid-template-columns: minmax(0, 1fr); align-items: start; }
    .item-actions { justify-content: flex-start; overflow-x: auto; }
    .button.compact { min-height: 28px; }
    .page-shell { width: min(100vw - 20px, 1180px); padding-top: 24px; }
    .topbar, .section-heading { align-items: stretch; flex-direction: column; }
  }
`;

module.exports = {
  DASHBOARD_STYLES,
};
