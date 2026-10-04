# 시작하기

## 요구 사항

- Node.js 22 이상(`package.json` `engines`).
- 런타임 의존성은 `package.json`에 고정되어 있습니다. 브라우저는 `playwright-core`, Bedrock·Vertex 인증은 공식 AWS·Google 라이브러리를 사용합니다. ZWF2 구현은 MIT 라이선스 [`zukuapp/zwf`](https://github.com/zukuapp/zwf) 0.1.1을 고지와 함께 포함(vendored)했습니다.
- `@zukujs/cli` 0.3.1은 npm 배포 후보입니다. 게시 확인 전에는 아래 소스 설치 방법을 사용하세요.

## 소스 체크아웃에서 설치

```sh
git clone https://github.com/zukuapp/zukujs-cli.git
cd zukujs-cli
npm install
npm link            # 로컬 체크아웃을 가리키는 zukujs 명령 생성
zukujs --help
zukujs version --json
```

링크를 지우려면 `npm unlink -g @zukujs/cli`를 실행하세요.

## 첫 프로젝트 (네트워크 없음)

```sh
zukujs create catch-game
cd catch-game
zukujs validate .
zukujs package . --format zwf
zukujs validate dist/*.zwf
```

`create`는 플레이 가능한 캔버스 받기(catch) 게임을 만듭니다. 기본 출력 파일은 `dist/<name>-<version>.<format>`이며 `name`과 `version`은 `zukujs.json`에서 가져옵니다. 세 명령은 네트워크를 사용하지 않습니다. 자세한 내용은 [프로젝트 작업 흐름](project-workflow.md)을 보세요.

## 초안 업로드 (네트워크, 사용자 토큰 필요)

```sh
zukujs upload . --verify
```

업로드에는 사용자 bearer 토큰이 필요합니다([인증](authentication.md)). `upload`는 운영 서비스 `https://www.zuzunza.com/api/v1`에 실제로 파일을 올리고 **초안**을 만듭니다. 초안은 공개 목록에 나타나지 않지만 업로드된 `/uploads/...` 파일 URL은 공개 주소이므로, 공개 배포해도 되는 소스만 올리세요.

## 로컬 상태 확인

```sh
zukujs status --json
```

`--check-api` 없이는 네트워크를 사용하지 않지만 자격 증명은 읽습니다. 지정한 자격 증명 파일이 없거나 규칙을 어기면 오프라인에서도 실패합니다.
