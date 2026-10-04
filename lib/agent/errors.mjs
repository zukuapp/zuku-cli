import { CommandError } from '../errors.mjs';

// Agent-local error codes. Messages are fixed Korean text; model, provider, browser and API
// response text is never copied into a message. `details` only carries locally computed,
// allowlisted values (codes, counts, safe ids, paths this CLI created).
const MESSAGES = Object.freeze({
  AGENT_REQUEST_REQUIRED: '만들 게임 설명이 필요합니다. zukujs agent "게임 설명" 형식으로 실행하세요.',
  AGENT_REQUEST_INVALID: '게임 설명은 4000자 이하의 일반 텍스트여야 하며 토큰·키 같은 비밀 값을 포함할 수 없습니다.',
  AGENT_PROJECT_EXISTS: '같은 이름의 경로가 이미 있습니다. 기존 프로젝트는 바꾸지 않았습니다. --name으로 다른 이름을 지정하세요.',
  AGENT_BUSY: '이 디렉터리에서 다른 zukujs agent 실행이 진행 중입니다. 끝난 뒤 다시 실행하세요.',
  AGENT_STATE_UNSAFE: '.zukujs/agent 상태 디렉터리가 링크이거나 안전하지 않습니다.',
  AGENT_PROVIDER_UNAVAILABLE: 'Codex 연동(Experimental·비공식 연동)을 사용할 수 없습니다. zukujs login codex --experimental로 먼저 로그인하세요.',
  AGENT_PROVIDER_FAILED: '모델 단계 응답을 받지 못했습니다. 잠시 후 다시 실행하세요.',
  AGENT_STAGE_OUTPUT_INVALID: '모델 단계 결과가 허용된 구조가 아니어서 사용하지 않았습니다.',
  AGENT_BUDGET_EXCEEDED: '실행 예산(모델 호출 수·토큰·출력 크기)을 넘어 중단했습니다.',
  AGENT_SKILL_INTEGRITY: '필수 게임 스킬 팩이 바뀌었거나 손상되었습니다. CLI를 다시 설치하세요.',
  AGENT_GATE_FAILED: '게임 계획 또는 구현이 필수 품질 게이트를 통과하지 못했습니다. error.details.codes를 확인하세요.',
  AGENT_ARTIFACT_UNSAFE: '생성 결과에 허용되지 않은 경로·명령·네트워크·비밀 값이 있어 쓰지 않았습니다.',
  AGENT_ENGINE_UNAVAILABLE: '선택한 게임 엔진 번들을 CLI에서 찾지 못했습니다.',
  AGENT_PLAYTEST_UNAVAILABLE: '실제 브라우저 플레이테스트를 시작할 수 없습니다. --browser로 Chromium 실행 파일을 지정하거나 docs/game-agent.md를 확인하세요.',
  AGENT_PLAYTEST_SANDBOX: '브라우저 샌드박스를 켤 수 없는 환경(root 실행 등)이라 플레이테스트를 중단했습니다. 일반 사용자로 실행하세요.',
  AGENT_PLAYTEST_FAILED: '실제 브라우저 플레이테스트를 통과하지 못해 패키지·업로드·게시를 하지 않았습니다.',
  AGENT_SOURCE_CHANGED: '검증·플레이테스트 이후 프로젝트 파일이 바뀌어 진행하지 않았습니다.',
  AGENT_DEPLOY_UNAVAILABLE: 'ZUKU 계정 게시 연결을 사용할 수 없습니다. zukujs login zuku로 먼저 로그인하세요.',
  DEPLOY_QUOTA_EXCEEDED: '게시 한도(계정당 6시간에 성공 3회)를 모두 사용했습니다. error.details.retry_after 이후 다시 시도하세요.',
  AGENT_PUBLISH_REJECTED: '서버가 게시를 거부했습니다. 거부된 게시는 한도를 소모하지 않습니다.',
  AGENT_PUBLISH_OUTCOME_UNKNOWN: '게시 결과를 확인하지 못했습니다. 자동으로 다시 시도하지 않습니다. 영수증의 run_id로 --resume 해 상태를 먼저 조회하세요.',
  AGENT_RESUME_INVALID: '재개할 실행 기록을 찾지 못했거나 이 상태에서는 재개할 수 없습니다.',
  AGENT_RECOVERY_REQUIRED: '이전 게시 결과가 불확실합니다. 서버 상태 조회로 복구하기 전에는 다시 게시하지 않습니다.',
});
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE = /^[A-Za-z0-9_.:/@ -]{0,512}$/;

function safeDetails(details) {
  if (!details || typeof details !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-z_]{1,40}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && SAFE.test(value)) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.filter(item => typeof item === 'string' && CODE.test(item)).slice(0, 32);
  }
  return Object.keys(out).length ? out : undefined;
}

export class AgentError extends CommandError {
  constructor(code, details) {
    super(code);
    if (Object.hasOwn(MESSAGES, code)) { this.code = code; this.message = MESSAGES[code]; }
    this.details = safeDetails(details);
  }
  toJSON() { return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message }; }
}

export const AGENT_ERROR_CODES = Object.freeze(Object.keys(MESSAGES));
export const isAgentCode = code => Object.hasOwn(MESSAGES, code);
