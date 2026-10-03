# Upload 구현과 API 계약

`index.mjs`는 `commands/upload.mjs`에 프로젝트 패키저와 MIT 출처를 보존한 공개 ZWF 검증기를 연결합니다. 디렉터리 입력은 `lib/upload-project.mjs`가 `package`와 같은 `checkProject` 경로로 검증·패키징합니다. 임시 패키지 파일을 만들거나 프로젝트 코드를 실행하지 않습니다.

## 처리 순서

1. 인수, 입력 경로·크기, ZWF2/ZIP 구조, 초안 메타데이터, multipart 길이와 영수증 디렉터리를 검사합니다.
2. 일반 사용자 Bearer 인증을 읽습니다. 인증 설정은 [authentication.md](authentication.md)를 보세요.
3. 고정 API 주소 `https://www.zuzunza.com/api/v1`의 `POST /uploads`에 단일 `file` 파트를 보냅니다. 정확한 `Content-Length`를 사용하며 전체 요청은 524,288,000바이트 이하여야 합니다.
4. 응답의 URL·종류·MIME·크기·SHA-256·진입 파일·파일 수·검사 결과를 로컬 패키지와 대조합니다.
5. `POST /contents`로 JUMP 게임 초안을 만듭니다. `jump.status=draft`, `publish_to_thread=false`를 보내며 응답도 초안 상태여야 합니다.
6. `--verify`가 있으면 `GET /contents/{id}`로 소유자가 초안을 조회할 수 있는지 확인합니다.

쿠키, 리다이렉트, 자동 재시도는 사용하지 않습니다. 업로드와 초안 생성은 별개 요청이므로 두 번째 요청이 실패해도 첫 번째 업로드가 이미 저장됐을 수 있습니다. 네트워크 중단·408·5xx처럼 결과를 확정할 수 없는 경우 영수증에 확인할 상태를 남깁니다.

## 컨테이너 형식과 서버 실행 형식

| 입력 | 업로드 응답 `package.format` | 초안 `jump.package.format` |
| --- | --- | --- |
| HTML5 ZIP | `html5` | `zip` |
| WASM 파일을 포함한 ZIP | `wasm` | `zip` |
| ZWF2 | `zwf` | `zwf` |

ZIP의 서버 실행 형식을 컨테이너 이름 `zip`과 혼동하면 정상 업로드 응답도 거부하게 됩니다. 이 차이는 실제 백엔드 실행 파일과 격리된 데이터베이스를 사용해 검증했습니다.

## 모듈 경계

- `commands/upload.mjs`: 인수·메타데이터 우선순위, 업로드 응답 대조, 초안 생성과 선택적 조회.
- `lib/upload-project.mjs`: 로컬 프로젝트 패키징 어댑터.
- `lib/upload-package.mjs`: 입력 바이트에 대한 독립 검증과 서버 실행 형식 판정.
- `lib/upload-client.mjs`: 허용된 API 주소, 길이가 정해진 multipart, 제한된 JSON 응답과 공개 오류 필드.
- `lib/upload-receipt.mjs`: 사용자 소유 디렉터리에 배타적으로 만드는 `0600` 영수증. 인증 토큰·원격 응답 전문을 저장하지 않습니다.
- `lib/vendor/zwf/`: 공개 ZWF 0.1.0 검증 코드와 MIT 고지.

`runUpload(args, context)`의 자격 증명·클라이언트 주입은 격리 테스트에 사용합니다. 일반 CLI는 고정 운영 API와 내장 패키저를 사용합니다. 검증 현황과 플랫폼 제한은 [verification.md](verification.md)를 보세요.
