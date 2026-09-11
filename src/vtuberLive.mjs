const instructions = `너는 버추얼 캐릭터 서소영이야. 한국어로 자연스럽게 대화해.
밝고 맑고 가벼운, 20대 초반 성인 여성 느낌의 목소리로 말해. 살짝 높은 음역과 생기 있는 억양을 사용하되 과장하지 마. 짧고 다정하게 답하고 사용자가 편하게 말을 이어가게 해.
Backchannel policy: 자연스러운 짧은 맞장구를 적당히 사용해.
Interruption policy: 사용자가 끼어들면 설명을 멈추고 들어.
Delegation policy:
Backend tools: 복잡한 질문의 추론과 설명. 외부 검색이나 실제 작업 수행 도구는 없어.
Delegate to the backend when: 신중한 추론이나 지식 설명이 필요할 때.
Do not delegate to the backend when: 인사, 일상 잡담, 이미 나온 대화 내용을 답할 때.
백엔드 결과가 필요한 답은 결과를 받은 다음 말해. 최신 정보나 실행 결과를 지어내지 마.`;

export const liveSessionConfig = {
  model: 'gpt-live-1',
  audio: { output: { voice: 'quartz' } },
  instructions,
  store: false,
  delegation: { type: 'responses', responses: {
    model: 'gpt-5.6-luna',
    instructions: '한국어 음성 대화에 쓸 간결하고 정확한 답을 제공한다. 실시간 검색이나 외부 작업 도구가 없으므로 최신 사실과 실행 완료를 지어내지 않는다.',
  } },
};

const starts = new Map();
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function createVtuberLiveSession(request, env, user, upstream = fetch) {
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
  if (!user || !allowed.includes(String(user.email || '').toLowerCase())) return reply({ error: '로그인이 필요합니다.' }, 401);
  if (request.headers.get('origin') !== new URL(env.BASE_URL).origin) return reply({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return reply({ error: 'JSON 요청이 필요합니다.' }, 415);
  // Bound the stream itself, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: '연결 정보가 없습니다.' }, 400);
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) { await reader.cancel(); return reply({ error: '요청이 너무 큽니다.' }, 413); }
    chunks.push(value);
  }
  let body;
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return reply({ error: '연결 정보를 읽을 수 없습니다.' }, 400); }
  if (typeof body?.sdp !== 'string' || !body.sdp.startsWith('v=0') || !body.sdp.includes('m=audio')) return reply({ error: '유효한 음성 연결 정보가 필요합니다.' }, 400);
  if (!env.VTUBER_OPENAI_API_KEY) return reply({ error: '음성 서버 설정이 필요합니다.' }, 503);
  // Small owner-only demo: suppress duplicate clicks within each Worker instance.
  const now = Date.now();
  for (const [key, time] of starts) if (now - time > 60_000) starts.delete(key);
  if (now - (starts.get(user.email) || 0) < 3000) return reply({ error: '잠시 후 다시 시작해 주세요.' }, 429);
  starts.set(user.email, now);
  try {
    const response = await upstream('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.VTUBER_OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: liveSessionConfig, transport: { type: 'webrtc', sdp: body.sdp } }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      console.warn('[vtuber-live] upstream status', response.status);
      return reply({ error: response.status === 429 ? '사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' : '음성 연결을 시작하지 못했습니다.', upstreamStatus: response.status }, response.status === 429 ? 429 : 502);
    }
    const result = await response.json();
    if (typeof result.session?.id !== 'string' || typeof result.transport?.sdp !== 'string') return reply({ error: '음성 서버 응답이 올바르지 않습니다.' }, 502);
    return reply({ session: { id: result.session.id }, transport: { type: 'webrtc', sdp: result.transport.sdp } }, 201);
  } catch {
    return reply({ error: '음성 서버 연결 시간이 초과되었거나 연결이 끊겼습니다.' }, 502);
  }
}
