import { CommandError } from './errors.mjs';

// Local ZukuJS project/package codes. Shared lib/errors.mjs is owned elsewhere; these subclass
// CommandError so index.mjs emits the canonical zuku-command/1 error envelope.
const MESSAGES = Object.freeze({
  PROJECT_EXISTS: '같은 이름의 경로가 이미 있습니다. 기존 파일을 덮어쓰지 않았습니다.',
  PROJECT_NOT_FOUND: '프로젝트 디렉터리나 패키지 파일을 찾지 못했습니다.',
  PROJECT_INVALID: 'ZukuJS 프로젝트 검증에 실패했습니다. error.details.diagnostics를 확인하세요.',
  PACKAGE_INVALID: 'ZWF2/ZIP 패키지 검증에 실패했습니다. error.details.diagnostics를 확인하세요.',
  PATH_UNSAFE: '심볼릭 링크, 특수 파일 또는 안전하지 않은 경로는 사용할 수 없습니다.',
  OUTPUT_EXISTS: '출력 파일이 이미 있습니다. 교체하려면 --force를 사용하세요.',
  OUTPUT_INVALID: '출력 경로는 소스 디렉터리 밖의 기존 디렉터리에 있고, 형식에 맞는 .zwf 또는 .zip 파일이어야 합니다.',
  OUTPUT_LINK_UNSUPPORTED: '이 파일 시스템에서는 덮어쓰지 않는 원자적 생성을 할 수 없습니다. 출력 경로를 확인한 뒤 --force로 다시 실행하세요.',
  PROJECT_CHANGED: '패키징 중 프로젝트 파일이 바뀌었습니다. 다시 실행하세요.',
});
const MAX_DETAILS = 100;

export class ProjectError extends CommandError {
  constructor(code, diagnostics) {
    super(code);
    if (Object.hasOwn(MESSAGES, code)) { this.code = code; this.message = MESSAGES[code]; }
    if (Array.isArray(diagnostics)) {
      const errors = diagnostics.filter(item => item.severity === 'error');
      this.details = { error_count: errors.length, truncated: errors.length > MAX_DETAILS, diagnostics: errors.slice(0, MAX_DETAILS) };
      if (errors.length) this.message += ` (${errors.length}: ${[...new Set(errors.map(item => item.code))].slice(0, 3).join(', ')})`;
    }
  }
  toJSON() { return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message }; }
}
