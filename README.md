<a href="https://zukuapp.github.io/docs/">
  <img src="https://raw.githubusercontent.com/zukuapp/.github/main/profile/assets/developer-hero.png" alt="Trecillo × ZUKU 개발자 문서" width="760">
</a>

# zuku-cli: Jump CLI 시제품

이 저장소는 ZUKU Jump 프로젝트용 명령 구조를 담은 **시제품**입니다. 현재 `create`, `validate`, `package`, `upload`는 실제 작업을 수행하지 않습니다. 명령이 성공 문구를 출력해도 프로젝트가 생성·검증·압축·업로드된 것은 아닙니다.

> **배포 상태:** `zuku-cli`은 npm 레지스트리에 게시되지 않았습니다. `npm install -g zuku-cli`을 설치 절차로 사용하지 마세요.

## 현재 동작

| 명령 | 현재 구현 | 작업에 사용할 수 있나요? |
| --- | --- | --- |
| `create <name>` | 이름을 출력하고 종료 | 아니요. 디렉터리나 파일을 만들지 않습니다. |
| `validate <path>` | 경로와 성공 문구를 출력 | 아니요. 매니페스트나 파일을 읽지 않습니다. |
| `package <path>` | 경로와 성공 문구를 출력 | 아니요. ZIP을 만들지 않습니다. |
| `upload <path>` | 경로와 성공 문구를 출력 | 아니요. 네트워크 요청을 보내지 않습니다. |

상태는 [`commands/`](commands/)의 구현을 기준으로 합니다. [`lib/api-client.mjs`](lib/api-client.mjs)에는 범용 `fetch` 보조 함수가 있지만, 업로드 명령과 연결돼 있지 않습니다.

## 로컬에서 살펴보기

Node.js 18 이상에서 저장소를 내려받아 도움말을 확인할 수 있습니다.

```sh
git clone https://github.com/zukuapp/zuku-cli.git
cd zuku-cli
node index.mjs --help
```

`npm run lint`는 현재 일곱 소스 파일의 구문을 검사합니다. `npm test` 스크립트는 정의되어 있지만 테스트 파일은 아직 없습니다. 구문 검사나 빈 테스트 실행을 CLI 기능 검증으로 해석하지 마세요.

## 지금 사용할 수 있는 공개 도구

- **HTML5 ZIP → ZWF2 `.zwf`:** [`zwf`](https://github.com/zukuapp/zwf)의 컴파일·검사 명령을 사용하세요.
- **Jump ZIP 메타데이터:** [`zuku-engine-next2d`](https://github.com/zukuapp/zuku-engine-next2d)의 [매니페스트 스키마](https://github.com/zukuapp/zuku-engine-next2d/blob/main/schemas/jump-manifest.schema.json)와 패키지 검증기를 확인하세요.
- **API 모델:** [`zuku-api`](https://github.com/zukuapp/zuku-api)의 OpenAPI 계약을 읽으세요. 계약 문서만으로 인증·업로드 서비스가 제공된다고 가정하지 마세요.

`zwf`의 ZWF2 매니페스트와 Jump ZIP의 `jump.manifest.json`은 서로 다른 형식입니다. 한 도구의 필드를 다른 형식에 그대로 사용하지 마세요.

## 구현에 기여하기

명령을 구현할 때는 실제 입출력과 실패 조건을 먼저 정하고 테스트를 추가해 주세요. 특히 검증 실패나 업로드 실패를 성공으로 보고하지 않도록 해야 합니다. Jump 패키지 계약을 바꾸면 소유 저장소의 스키마와 테스트도 함께 검토하세요.

공개 문서의 시작점은 [ZUKU 개발자 허브](https://github.com/zukuapp/.github/blob/main/docs/README.md)입니다.
