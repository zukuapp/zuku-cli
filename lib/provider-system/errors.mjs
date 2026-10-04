import { CommandError } from '../errors.mjs';

// Fixed, user-safe messages. Provider/remote text, paths, URLs, headers and
// credential values never reach these messages.
const MESSAGES = Object.freeze({
  PROVIDER_NOT_FOUND: '등록되지 않은 제공자입니다. zuku provider list로 확인하세요.',
  PROVIDER_EXISTS: '같은 ID의 제공자가 이미 있습니다.',
  PROVIDER_BUILTIN_PROTECTED: '기본 제공자는 삭제할 수 없습니다. zuku provider disable을 사용하세요.',
  PROVIDER_DISABLED: '비활성화된 제공자입니다. zuku provider enable로 다시 켜세요.',
  PROVIDER_ACTIVE: '현재 선택된 제공자는 비활성화할 수 없습니다. 먼저 다른 제공자를 선택하세요.',
  PROVIDER_CONFIG_INVALID: '제공자 설정 형식이 올바르지 않습니다.',
  PROVIDER_CONFIG_UNSAFE: '제공자 설정 파일은 현재 사용자 소유의 일반 파일(심볼릭·하드 링크 아님)이어야 합니다.',
  PROVIDER_CONFIG_LOCKED: '다른 명령이 제공자 설정을 변경하고 있습니다. 잠시 후 다시 시도하세요.',
  PROVIDER_SECRET_IN_CONFIG: '공개 설정에는 API 키나 비밀 헤더 값을 넣을 수 없습니다. zuku auth login을 사용하세요.',
  PROVIDER_ENDPOINT_REJECTED: 'HTTPS 주소 또는 로컬 루프백 HTTP 주소만 사용할 수 있습니다(사용자 정보·쿼리·프래그먼트 금지).',
  PROVIDER_ENDPOINT_FIXED: '이 제공자는 공식 고정 주소만 사용합니다.',
  PROVIDER_OPTION_REQUIRED: '이 제공자에 필요한 설정이 빠졌습니다. zuku provider configure로 설정하세요.',
  MODEL_ADDRESS_INVALID: '모델 주소는 <provider>/<model> 형식이어야 합니다.',
  MODEL_NOT_FOUND: '해당 제공자에서 모델을 찾지 못했습니다. zuku model list --refresh로 확인하세요.',
  MODEL_UNAVAILABLE: '모델 목록을 조회할 수 없는 제공자입니다. zuku provider configure <id> --model <model>로 모델을 등록하세요.',
  MODEL_NOT_SELECTED: '선택된 모델이 없습니다. zuku model use <provider/model>로 선택하세요.',
  MODEL_DISCOVERY_FAILED: '모델 목록을 가져오지 못했습니다. 인증과 연결을 확인하세요.',
  AUTH_METHOD_UNSUPPORTED: '이 제공자에서 지원하지 않는 인증 방식입니다.',
  AUTH_INPUT_REQUIRED: '비대화형 실행에서는 --api-key-stdin 또는 --api-key-env <VAR>로 키를 전달하세요.',
  AUTH_SECRET_ARGUMENT: '비밀 값은 명령 인수로 받지 않습니다. 대화형 입력, --api-key-stdin 또는 --api-key-env를 사용하세요.',
  AUTH_SECRET_INVALID: '키 형식이 올바르지 않습니다(제어 문자·줄바꿈 금지, 최대 16 KiB).',
  AUTH_REQUIRED: '선택한 제공자의 인증 정보가 없습니다. zuku auth login --provider <id>로 연결하세요.',
  AUTH_SESSION_CHANGED: '진행 중 제공자의 인증이나 연결 설정이 변경되었습니다. 새 작업을 시작하세요.',
  AUTH_EXPERIMENTAL_OPT_IN: 'Experimental·비공식 인증은 --experimental을 명시해야 합니다.',
  AUTH_DELEGATE_UNAVAILABLE: '이 계정 연결 기능은 현재 설치본에서 사용할 수 없습니다.',
  SECRET_STORE_UNAVAILABLE: '이 플랫폼에서 보호된 비밀 저장소를 사용할 수 없습니다. 환경 변수 참조를 사용하세요.',
  SECRET_STORE_UNSAFE: '비밀 저장소 파일은 현재 사용자 전용(0600)의 일반 파일이어야 합니다.',
  CREDENTIAL_IN_MODEL_INPUT: '모델 입력에 자격 증명이 포함되어 요청을 차단했습니다.',
  ADAPTER_UNAVAILABLE: '이 제공자의 프로토콜 어댑터가 아직 설치되지 않았습니다.',
  ADAPTER_INVALID: '제공자 어댑터 응답이 계약과 맞지 않습니다.',
  STAGE_SCHEMA_REJECTED: '게임 단계 출력 스키마나 처리 한도가 허용된 계약과 맞지 않습니다.',
  STAGE_OUTPUT_INVALID: '게임 단계 결과가 검증된 출력 계약과 일치하지 않습니다.',
  NATIVE_STAGE_UNAVAILABLE: '현재 설치본에서 ZUKU AI 게임 단계 연결을 사용할 수 없습니다. 설치와 제공자 구성을 확인하세요.',
});

export class ProviderError extends CommandError {
  constructor(code) {
    super('COMMAND_FAILED');
    if (Object.hasOwn(MESSAGES, code)) { this.code = code; this.message = MESSAGES[code]; }
    this.name = 'ZukuProviderError';
  }
}
export const PROVIDER_ERROR_CODES = Object.freeze(Object.keys(MESSAGES));
export const invalidInput = () => new CommandError('INVALID_INPUT');
export const cancelled = () => new CommandError('COMMAND_CANCELLED');

class SanitizedAdapterError extends CommandError {
  constructor(source) {
    super('COMMAND_FAILED');
    this.code = source.code;
    this.message = source.message;
    if (source.status !== undefined) this.status = source.status;
  }
  toJSON() { return { ...super.toJSON(), ...(this.status !== undefined ? { status: this.status } : {}) }; }
}

/** Recognize the installed adapter class, then recreate only its fixed safe fields. */
export async function safeAdapterError(error, fallback = 'ADAPTER_INVALID') {
  if (error instanceof CommandError) return error;
  try {
    const { AdapterError, ADAPTER_ERROR_CODES } = await import('./adapters/errors.mjs');
    if (error instanceof AdapterError && ADAPTER_ERROR_CODES.includes(error.code)) {
      return new SanitizedAdapterError(new AdapterError(error.code, { status: error.status }));
    }
  } catch { /* Optional protocol module absence never exposes the foreign error. */ }
  return new ProviderError(fallback);
}
/** Map any thrown value onto a fixed code; foreign messages/stacks are dropped. */
export function safeError(error, fallback = 'COMMAND_FAILED') {
  if (error instanceof CommandError) return error;
  if (error?.name === 'AbortError') return cancelled();
  return Object.hasOwn(MESSAGES, fallback) ? new ProviderError(fallback) : new CommandError(fallback);
}
