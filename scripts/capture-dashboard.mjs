// Captures the Worker dashboard for the README with fabricated sample data.
// Usage: node scripts/capture-dashboard.mjs <output.png>
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';
import { createDatabase, createBucket, d1 } from '../test/helpers/workerFixture.mjs';

const { default: worker } = await import('../src/worker.mjs');

const BASE_URL = 'https://pages.example.test';
const SESSION_SECRET = 'capture-session-secret';
const VIEWPORT = { width: 1440, height: 900 };
const SELECTED_SLUG = 'quarterly-retro';

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('usage: node scripts/capture-dashboard.mjs <output.png>');
  process.exit(1);
}

// Titles, bodies, and dates below are invented for the screenshot only.
const documents = [
  {
    docId: 'doc-retro',
    slug: SELECTED_SLUG,
    title: '3분기 회고 — 결제 팀',
    createdAt: '2026-10-27T01:00:00.000Z',
    updatedAt: '2026-11-14T07:20:00.000Z',
    private: false,
    description: '결제 팀의 3분기 실험 결과와 다음 분기 우선순위를 정리했습니다.',
    revisions: [
      { revId: 'a10000000001', createdAt: '2026-10-27T01:00:00.000Z', comments: [] },
      {
        revId: 'a10000000002',
        createdAt: '2026-11-04T03:30:00.000Z',
        comments: ['표의 수치마다 근거 링크를 붙여 주세요.'],
      },
      {
        revId: 'a10000000003',
        createdAt: '2026-11-14T07:20:00.000Z',
        comments: ['다음 분기 우선순위를 두 개로 줄이면 좋겠습니다.', '이 항목은 배포 후에 다시 확인합시다.'],
      },
    ],
  },
  {
    docId: 'doc-offline',
    slug: 'offline-sync-design',
    title: '오프라인 동기화 설계 메모',
    createdAt: '2026-11-02T02:00:00.000Z',
    updatedAt: '2026-11-13T02:10:00.000Z',
    private: true,
    description: '오프라인 편집과 충돌 해소 규칙을 정리한 초안입니다.',
    revisions: [
      { revId: 'b20000000001', createdAt: '2026-11-02T02:00:00.000Z', comments: [] },
      {
        revId: 'b20000000002',
        createdAt: '2026-11-13T02:10:00.000Z',
        comments: ['충돌 해소 순서를 그림으로 보여 주세요.'],
      },
    ],
  },
  {
    docId: 'doc-onboarding',
    slug: 'onboarding-guide',
    title: '신규 입사자 온보딩 초안',
    createdAt: '2026-11-05T04:00:00.000Z',
    updatedAt: '2026-11-12T09:45:00.000Z',
    private: false,
    description: '첫 주에 확인할 계정, 문서, 교육 일정을 모았습니다.',
    revisions: [
      {
        revId: 'c30000000001',
        createdAt: '2026-11-12T09:45:00.000Z',
        comments: ['계정 신청 절차 링크가 빠졌습니다.', '교육 일정 표를 추가해 주세요.', '첫 주 체크리스트 분량이 적당합니다.'],
      },
    ],
  },
  {
    docId: 'doc-release',
    slug: 'release-notes-4',
    title: '4분기 릴리스 노트',
    createdAt: '2026-10-08T00:30:00.000Z',
    updatedAt: '2026-11-11T05:30:00.000Z',
    private: false,
    description: '4분기에 배포한 변경 사항을 릴리스마다 기록합니다.',
    revisions: [
      { revId: 'd40000000001', createdAt: '2026-10-08T00:30:00.000Z', comments: [] },
      { revId: 'd40000000002', createdAt: '2026-10-21T06:00:00.000Z', comments: [] },
      { revId: 'd40000000003', createdAt: '2026-11-01T01:15:00.000Z', comments: [] },
      { revId: 'd40000000004', createdAt: '2026-11-11T05:30:00.000Z', comments: [] },
    ],
  },
  {
    docId: 'doc-interviews',
    slug: 'customer-interviews',
    title: '고객 인터뷰 정리 — 11월',
    createdAt: '2026-11-03T05:00:00.000Z',
    updatedAt: '2026-11-09T03:00:00.000Z',
    private: true,
    description: '이번 달 인터뷰에서 나온 요청과 불편 사항을 묶었습니다.',
    revisions: [
      { revId: 'e50000000001', createdAt: '2026-11-03T05:00:00.000Z', comments: [] },
      { revId: 'e50000000002', createdAt: '2026-11-09T03:00:00.000Z', comments: ['인용문은 동의 범위를 함께 적어 주세요.'] },
    ],
  },
  {
    docId: 'doc-perf',
    slug: 'performance-log',
    title: '응답 시간 측정 기록',
    createdAt: '2026-11-07T06:15:00.000Z',
    updatedAt: '2026-11-07T06:15:00.000Z',
    private: false,
    description: '주요 화면의 응답 시간을 측정 조건과 함께 남깁니다.',
    revisions: [{ revId: 'f60000000001', createdAt: '2026-11-07T06:15:00.000Z', comments: [] }],
  },
  {
    docId: 'doc-api',
    slug: 'api-changelog',
    title: '공개 API 변경 정리',
    createdAt: '2026-10-30T02:40:00.000Z',
    updatedAt: '2026-11-05T00:20:00.000Z',
    private: false,
    description: '공개 API의 추가와 변경, 폐기 예정 항목을 정리합니다.',
    revisions: [
      { revId: '070000000001', createdAt: '2026-10-30T02:40:00.000Z', comments: [] },
      { revId: '070000000002', createdAt: '2026-11-05T00:20:00.000Z', comments: [] },
    ],
  },
];

const pages = [
  {
    id: '110000000001',
    title: '일일 배포 체크리스트',
    createdAt: '2026-11-15T08:00:00.000Z',
    private: false,
    description: '배포 전후로 확인하는 항목을 한 장으로 정리했습니다.',
  },
  {
    id: '110000000002',
    title: '주간 지표 스냅숏',
    createdAt: '2026-11-14T23:30:00.000Z',
    private: true,
    description: '이번 주 핵심 지표와 지난주 대비 변화입니다.',
  },
  {
    id: '110000000003',
    title: '회의실 예약 안내',
    createdAt: '2026-11-10T04:00:00.000Z',
    private: false,
    description: '층별 회의실과 예약 규칙을 안내합니다.',
  },
];

function previewHtml(title, description) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta property="og:description" content="${description}"></head><body><h1>${title}</h1></body></html>`;
}

function seed(database, bucket) {
  const insertDocument = database.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertRevision = database.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?)');
  const insertComment = database.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  for (const document of documents) {
    const latest = document.revisions[document.revisions.length - 1];
    insertDocument.run(
      document.docId,
      document.slug,
      document.title,
      'tester',
      latest.revId,
      document.createdAt,
      document.updatedAt,
    );
    document.revisions.forEach((revision, index) => {
      const revNumber = index + 1;
      insertRevision.run(revision.revId, document.docId, revNumber, 'published', revision.createdAt);
      bucket.putJson(`pages/${revision.revId}.json`, {
        id: revision.revId,
        title: document.title,
        createdAt: revision.createdAt,
        private: document.private,
        reviewable: revision.comments.length > 0,
      });
      revision.comments.forEach((body, commentIndex) => {
        const commentId = `${revision.revId}-c${commentIndex + 1}`;
        const createdAt = revision.createdAt;
        insertComment.run(
          commentId,
          revision.revId,
          '{}',
          body,
          'tester',
          createdAt,
          0,
          JSON.stringify({ id: commentId, body, author: 'tester' }),
          createdAt,
        );
      });
    });
    bucket.putText(`pages/${latest.revId}.html`, previewHtml(document.title, document.description));
  }

  for (const page of pages) {
    insertDocument.run(`page-${page.id}`, null, page.title, 'api', page.id, page.createdAt, page.createdAt);
    insertRevision.run(page.id, `page-${page.id}`, 1, 'published', page.createdAt);
    bucket.putJson(`pages/${page.id}.json`, {
      id: page.id,
      title: page.title,
      createdAt: page.createdAt,
      private: page.private,
    });
    bucket.putText(`pages/${page.id}.html`, previewHtml(page.title, page.description));
  }
}

function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

const database = createDatabase();
const bucket = createBucket();
seed(database, bucket);
const env = {
  PAGES_DB: d1(database),
  PAGES_BUCKET: bucket,
  PAGES_API_TOKEN: 'test-token',
  SESSION_SECRET,
  BASE_URL,
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  ALLOWED_EMAILS: 'tester@example.com',
};

const absoluteOutput = resolve(outputPath);
await mkdir(dirname(absoluteOutput), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addCookies([{
    name: 'pages.session',
    value: signSession({ email: 'tester@example.com', exp: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET),
    url: BASE_URL,
  }]);
  await context.route(`${BASE_URL}/**`, async (route) => {
    const request = route.request();
    const response = await worker.fetch(new Request(request.url(), {
      method: request.method(),
      headers: request.headers(),
      body: request.postData() || undefined,
    }), env, { waitUntil() {} });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'load' });
  await page.locator('[data-list-items] .list-item').first().waitFor();
  const documentCount = await page.locator('[data-list-items] .list-item[data-kind="documents"]').count();
  if (documentCount < 5) throw new Error(`expected at least 5 documents in the list, found ${documentCount}`);

  await page.locator(`[data-select-item][data-kind="documents"][data-item-id="${SELECTED_SLUG}"]`).click();
  await page.locator('[data-detail-panel] .detail-title').waitFor();
  const detailTitle = (await page.locator('[data-detail-panel] .detail-title').textContent()) || '';
  if (detailTitle !== '3분기 회고 — 결제 팀') throw new Error(`unexpected detail title: ${detailTitle}`);
  const revisionCount = await page.locator('[data-detail-panel] .revision-item').count();
  if (revisionCount < 3) throw new Error(`expected the detail panel to list revisions, found ${revisionCount}`);
  if (!(await page.locator('[data-detail-panel]').isVisible())) throw new Error('detail panel is not visible');
  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join('; ')}`);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: absoluteOutput, animations: 'disabled' });
  console.log(`PASS dashboard screenshot: ${documentCount} documents listed, "${detailTitle}" selected, ${revisionCount} revisions shown`);
} finally {
  await browser.close();
  database.close();
}
