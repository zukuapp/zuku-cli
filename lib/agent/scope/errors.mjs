import { CommandError } from '../../errors.mjs';

// Fixed, user-safe messages. Remote/provider/model text, stacks and paths outside the
// project are never placed in a ScopeError. `code` is always a protocol-safe code
// (lib/agent-protocol safeError vocabulary); `scopeCode` keeps the precise internal reason.
export const SCOPE_REJECTED_MESSAGE = 'This agent is restricted to ZUKU/ZUKUJS game-development tasks.';
const TABLE = Object.freeze({
  SCOPE_REJECTED: ['AGENT_REQUEST_OUT_OF_SCOPE', SCOPE_REJECTED_MESSAGE],
  SCOPE_CLASSIFICATION_INVALID: ['AGENT_REQUEST_OUT_OF_SCOPE', SCOPE_REJECTED_MESSAGE],
  SCOPE_WORKSPACE_UNSAFE: ['PROJECT_CHANGED', '작업 공간은 링크가 아닌 사용자 소유 일반 디렉터리여야 합니다.'],
  SCOPE_TOOL_DENIED: ['TOOL_UNAVAILABLE', '허용되지 않은 도구 요청입니다.'],
  SCOPE_INVALID_INPUT: ['INVALID_INPUT', '도구 입력이 허용된 형식이 아닙니다.'],
  SCOPE_PATH_DENIED: ['PERMISSION_REQUIRED', '프로젝트 밖, 링크, 비공개·인증 파일 경로는 사용할 수 없습니다.'],
  SCOPE_SOURCE_CHANGED: ['AGENT_SOURCE_CHANGED', '검증 이후 프로젝트 소스가 바뀌었습니다. 다시 실행하세요.'],
  SCOPE_CONFLICT: ['REQUEST_CONFLICT', '파일이 예상한 SHA-256과 다릅니다. 다시 읽은 뒤 수정하세요.'],
  SCOPE_LIMIT: ['REQUEST_LIMIT', '에이전트 실행 한도(호출·시간·출력·파일 수)에 도달했습니다.'],
  SCOPE_LOCKED: ['SESSION_BUSY', '이 프로젝트에서 다른 에이전트 실행이 진행 중입니다.'],
  SCOPE_PROVIDER_INVALID: ['AGENT_GATE_FAILED', '모델 응답이 허용된 JSON 형식이 아닙니다.'],
  SCOPE_PROVIDER_UNAVAILABLE: ['AGENT_PROVIDER_UNAVAILABLE', '모델 공급자 단계 실행기를 사용할 수 없습니다.'],
  SCOPE_SKILLS_INVALID: ['CORE_STATE_UNSAFE', '필수 게임 스킬 5개의 해시를 확인하지 못했습니다.'],
  SCOPE_STATE_UNSAFE: ['CORE_STATE_UNSAFE', '.zukujs/agent 상태 디렉터리가 안전하지 않습니다.'],
  SCOPE_VERIFY_FAILED: ['AGENT_GATE_FAILED', '실제 검증을 통과하지 못했습니다. 변경 내역은 .zukujs/agent 아래에 보존했습니다.'],
  SCOPE_PUBLISH_BLOCKED: ['AGENT_PLAYTEST_UNAVAILABLE', '검증·패키지 바인딩·플레이테스트 썸네일이 없어 배포하지 않았습니다.'],
  SCOPE_PUBLISH_UNKNOWN: ['AGENT_PUBLISH_OUTCOME_UNKNOWN', '배포 결과를 확인하지 못했습니다. 자동으로 다시 시도하지 않습니다.'],
  SANDBOX_UNAVAILABLE: ['TOOL_UNAVAILABLE', '이 플랫폼에서는 격리된 빌드·테스트 실행 기능을 사용할 수 없습니다.'],
  DOCS_UNAVAILABLE: ['TOOL_UNAVAILABLE', '공식 문서 조회를 사용할 수 없습니다.'],
  COMMAND_CANCELLED: ['COMMAND_CANCELLED', '명령을 취소했습니다.'],
});
const SAFE_DETAIL = /^[A-Za-z0-9_.:/ -]{0,200}$/;

export class ScopeError extends CommandError {
  constructor(scopeCode, details) {
    super('COMMAND_FAILED');
    const [code, message] = TABLE[scopeCode] ?? ['CORE_OPERATION_FAILED', '명령을 완료하지 못했습니다.'];
    this.name = 'ZukuScopeError';
    this.code = code;
    this.scopeCode = Object.hasOwn(TABLE, scopeCode) ? scopeCode : 'SCOPE_FAILED';
    this.message = message;
    if (details && typeof details === 'object') {
      const safe = Object.fromEntries(Object.entries(details).filter(([key, value]) => /^[a-z_]{1,40}$/.test(key) && (typeof value === 'boolean' || Number.isFinite(value) || (typeof value === 'string' && SAFE_DETAIL.test(value)))));
      if (Object.keys(safe).length) this.details = safe;
    }
  }
  toJSON() { return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) }; }
}

export const cancelled = signal => { if (signal?.aborted) throw new ScopeError('COMMAND_CANCELLED'); };
