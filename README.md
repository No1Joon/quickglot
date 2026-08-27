# QuickGlot

Safari 확장 — 텍스트를 선택하면 그 자리에서 번역한다. 번역은 Apple Translation framework로 **온디바이스·오프라인**에서 돌아가고, API 키도 서버도 없다.

- macOS: 드래그해서 마우스를 떼면 바로 번역 팝업
- iOS/iPadOS: 선택하면 칩이 뜨고, 탭하면 번역 패널

## 보안·프라이버시

서버가 없다. 번역은 전부 Apple Translation framework 로 기기 안에서 끝나고, 확장은 **네트워크 호출을 하나도 하지 않는다** — 백엔드·애널리틱스·크래시 리포터·서드파티 SDK 어느 것도 없다. 선택한 텍스트는 기기를 떠나지 않는다.

- 저장하는 것은 대상 언어 설정 하나뿐(`browser.storage.local`).
- 입력 필드·contenteditable 안의 선택은 무시한다.
- 진단 로그에는 글자 수와 언어쌍만 남고 텍스트는 안 남는다.
- 패널은 closed shadow root 에 그려서 페이지 스크립트가 내용을 못 읽는다.
- 권한은 `nativeMessaging`·`storage` 둘뿐이다. `host_permissions` 는 쓰지 않으므로 요청하지 않는다.

전문은 [PRIVACY.md](PRIVACY.md).

## 요구사항

- macOS 26+ / iOS 26+ (`TranslationSession(installedSource:target:)` 가 26.0 부터)
- Xcode 26+
- Node 22+
- iOS는 **실기기 필수** — 시뮬레이터에는 번역 모델이 없다

## 구조

```
extension/          웹 확장 소스 (TypeScript)
  manifest.json     MV3
  icons/            생성된 플레이스홀더 아이콘 (교체 필요)
  src/content/      선택 감지 + Shadow DOM 팝업
  src/background/   service worker: 네이티브 메시징 + 캐시
  src/popup/        툴바 팝업: 대상 언어 설정
  src/shared/       content ↔ background ↔ Swift 공용 메시지 타입
scripts/            esbuild 빌드, 아이콘 생성
dist/               빌드 산출물 — Xcode가 상대경로로 참조한다 (gitignored)
apple/QuickGlot/    Xcode 프로젝트 (macOS + iOS 앱 · 확장 타깃)
  Shared (App)/ViewController.swift            컨테이너 앱: 언어팩 다운로드 온보딩
  Shared (Extension)/SafariWebExtensionHandler.swift   네이티브 번역 핸들러
DECISIONS.md        설계 결정
docs/               app-info/policy 에서 생성된 GitHub Pages 사이트 (직접 편집 금지)
```

## 개발

```sh
npm install
npm run build          # dist/ 생성 — Xcode 빌드 전에 항상 먼저
npm run dev            # watch
npm run typecheck
node scripts/gen-icons.mjs
```

`dist/` 는 Xcode 프로젝트가 `../../../dist/` 로 참조하므로, 기존 파일 수정은 `npm run build` 후 Xcode 빌드만 하면 반영된다.

**dist/ 에 파일이 늘거나 줄면 `./scripts/regen-xcode.sh` 를 돌려야 한다.** 프로젝트가 파일을 하나씩 참조해서, 등록 안 된 새 파일은 .appex 에 안 들어가고 Safari 가 "Unable to find <파일> in the extension's resources" 를 띄운다. 스크립트는 프로젝트를 다시 생성한 뒤 Swift 소스·배포 타깃·팀 ID 를 되돌려놓는다.

```sh
cd apple/QuickGlot
xcodebuild -scheme "QuickGlot (macOS)" -destination 'platform=macOS' build
```

서명이 필요하면 Apple Team ID 를 넘긴다 — 리포에는 커밋하지 않는다.

```sh
export QUICKGLOT_TEAM_ID=XXXXXXXXXX     # regen-xcode.sh 가 읽는다
xcodebuild ... DEVELOPMENT_TEAM=$QUICKGLOT_TEAM_ID build
```

⚠️ Xcode GUI 의 Signing & Capabilities 에서 팀을 고르면 `project.pbxproj` 에 팀 ID 가 다시 기록된다. 커밋 전에 `git diff` 로 확인할 것.

## macOS에서 처음 실행하기

1. `npm run build` 후 Xcode에서 `QuickGlot (macOS)` 실행
2. 앱에서 읽고 싶은 언어의 **Download** 를 눌러 언어팩 설치 (시스템 동의 시트가 뜬다)
3. Safari → 설정 → 개발자 → **서명되지 않은 확장 프로그램 허용** 체크 (Safari 재시작 시 풀린다)
4. Safari → 설정 → 확장 프로그램 → QuickGlot 켜기 → 사이트 권한 허용
5. 아무 페이지에서 영문 텍스트를 드래그

## iOS에서 처음 실행하기

1. 실기기로 `QuickGlot (iOS)` 실행 (시뮬레이터 불가)
2. 앱에서 언어팩 다운로드
3. 설정 → 앱 → Safari → 확장 프로그램 → QuickGlot 켜기 → 사이트 권한 허용

## 아직 안 한 것

- 실기기 end-to-end 검증 (빌드와 네이티브 번역 경로까지만 확인됨)
- 진짜 아이콘 (`extension/icons/` 는 생성된 플레이스홀더)
- 사이트별 on/off, 트리거 방식 선택
- 번역 결과 복사 버튼, 원문 토글
- 앱 스토어 제출용 메타데이터
