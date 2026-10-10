# Context Tracker
대화를 보낼 때 AI에게 전달되는 입력이 얼마나 쌓였는지 확인하는 SillyTavern 확장입니다. 입력량을 원형 게이지로 보여 주고, 옵션에서 `컨텍스트 크기 대비 사용량`, `챗 히스토리 대비 사용량`을 전환할 수 있습니다.

## 미리보기

### 표시 방식
| 입력 예산 표시 | 챗 히스토리 표시 |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/Budget.png" width="300"> | <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/History.png" width="300"> |

### 배치 영역
| 입력 영역 좌측 | 입력 영역 우측 |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/leftSendForm.png" width="300"> | <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/rightSendForm.png" width="300"> |
| **좌측 상단** | **우측 상단** |
| <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/sendformLeft.png" width="300"> | <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/sendformRight.png" width="300"> |

## 설치

SillyTavern **확장(Extensions)** 메뉴에 아래 주소를 붙여 넣어 설치하세요.
```
https://github.com/st-chd/ContextTracker
```

## 크레딧 및 라이선스

이 확장은 [Wanichka의 Context Tracker](https://github.com/Wanichka/sillytavern-context-tracker)를 포크하여 수정했으며, 모든 수정에는 GPT(codex)를 사용했습니다.\
원본 확장의 MIT 라이선스를 따르며, 자세한 내용은 [LICENSE](LICENSE) 파일을 확인해 주세요.

**호환성을 위해 참고한 확장 프로그램**\
`#form_sheld` 안에 위치해야하는 특성상 호환을 위해 아래 확장 프로그램의 코드를 확인했으며, 해당 프로젝트의 코드를 복사하지 않았습니다.
- [Samueras의 GuidedGenerations-Extension](https://github.com/Samueras/GuidedGenerations-Extension/) (GPL-3.0)
- [IceFog72의 SillyTavern-SimpleQRBarToggle](https://github.com/IceFog72/SillyTavern-SimpleQRBarToggle) (MIT)

## 주요 기능 및 변경 사항

- 입력창에 컨텍스트 사용량을 원형 게이지로 표시합니다.
- 게이지를 누르면 총 토큰, 컨텍스트 크기, 최대 응답 길이, 입력 예산, 잔여량을 보여 줍니다.
- 답변 생성 뒤 메시지 수정 등으로 입력이 바뀌면 집계 결과도 갱신합니다.
- 확장 설정에서 게이지를 입력창 왼쪽이나 오른쪽, 전송 버튼 왼쪽이나 오른쪽에 배치할 수 있습니다.
- **챗 히스토리 예산으로 계산**을 켜면 대화 기록만 설정한 상한선과 비교합니다. 기본 상한선은 50,000 토큰입니다.
- **사용량 상세보기**를 켜면 프롬프트, 월드 인포(before), 페르소나 시트, 캐릭터 시트, 고급정의, 월드 인포(after), 챗 히스토리의 토큰 수를 추가로 보여 줍니다.

## 참고 사항

### 1. 사용 환경

이 확장은 Chat Completion 방식에서 동작합니다. 다른 API를 사용 중이거나 SillyTavern 업데이트로 필요한 기능이 바뀌면 집계가 표시되지 않을 수 있습니다. 현재 SillyTavern 1.19.0 기준으로 작동합니다.

### 2. 패널 구성
- **컨텍스트 크기:** AI응답 구성 패널의 `컨텍스트 크기 (토큰)` 설정량을 표시합니다.
- **최대 응답 길이:** AI응답 구성 패널의 `최대 응답 길이 (토큰)` 설정량을 표시합니다.
- **입력 예산:** `컨텍스트 크기 - 최대 응답 길이 = 입력 예산` 공식을 사용하여 표시합니다.
- **잔여량:** 입력 예산에서 사용량을 뺀 잔여량을 표시합니다.

확장 프로그램이 임의로 사용량을 정하지 않습니다.
사용자가 설정한 입력량을 가져오고, 토큰은 SillyTavern 본체와 동일하게 계산합니다.

### 3. 표시된 토큰 수와 청구량

이 확장은 SillyTavern이 계산한 입력 토큰 수를 표시합니다. 서비스에 실제로 전송되거나 청구되는 수와는 다를 수 있습니다.

### 4. 챗 히스토리 예산 모드

확장 설정에서 **챗 히스토리 예산으로 계산** 옵션을 켜고 상한선을 입력하세요.

상한선이 80,000이고 챗 히스토리가 60,000 토큰이면 75% 사용, 잔여량 20,000으로 표시합니다. 이 모드의 패널에는 **챗 히스토리(n개)**, 구분선, **입력 예산**, **히스토리 예산**, **잔여량**이 표시됩니다. `n개`는 이번 입력에 포함된 대화 메시지 수이며, 새 대화 표시·그룹 지시문·대화예시는 제외합니다. 메시지 수를 아직 집계하지 못했거나 추적되지 않은 집계에서는 괄호 없이 **챗 히스토리**만 표시합니다.

**적용되는 히스토리 예산은 입력 예산을 넘지 않습니다.** 입력 예산이 120,000인데 상한선으로 150,000을 새로 입력하면, 입력을 마칠 때 120,000으로 자동 보정하고 안내를 표시합니다. 이후 컨텍스트 크기나 최대 응답 길이, 프리셋 변경으로 입력 예산이 줄어들어도 입력된 상한선은 유지되며, 현재 적용되는 값만 제한됩니다. 입력 예산이 다시 커지면 입력된 상한선까지 자동으로 복원됩니다.

표시되는 사용량은 토큰 추정값입니다. 실제 생성 중 입력 설정이 바뀌면 생성에 사용된 예산을 표시하고 안내를 덧붙입니다. 추적되지 않은 결과의 전역 집계를 표시하는 경우에도 별도 안내를 표시합니다.

상한선을 넘으면 게이지가 가득 차고 잔여량이 0으로 표시되지만, **확장이 대화를 자르지는 않습니다.**

### 5. 그룹 채팅

마지막으로 집계된 발화 캐릭터의 입력을 보여 줍니다. 그룹의 모든 캐릭터 입력을 더한 값은 아닙니다.

### 6. 사용량 상세보기

`Default` 프리셋의 항목을 기준으로 이번 입력에 포함된 토큰을 분류합니다. 각 항목의 합계는 총 토큰과 같습니다.

- **프롬프트:** 메인·보조·후처리 지시문과 기타 프롬프트의 토큰입니다.
- **월드 인포(before/after):** 이번 조립에서 활성화되어 해당 위치에 포함된 월드 인포의 토큰입니다. 다른 위치에 주입된 월드 인포는 해당 프롬프트 또는 히스토리 집계에 포함됩니다.
- **페르소나 시트 / 캐릭터 시트:** 기본 시트 항목과, 매크로가 하나만 들어간 사용자 프롬프트를 집계합니다. `{{persona}}`는 페르소나, `{{description}}`·`{{charDescription}}`은 캐릭터 시트로 분류합니다. 프롬프트의 설명·구분자 등도 그 프롬프트의 토큰에 포함됩니다.
- **고급정의:** 캐릭터 성격·시나리오·이번 입력에 포함된 대화예시와 해당 단일 매크로 프롬프트의 토큰입니다. Enhance Definitions의 지시문은 프롬프트로 분류합니다.
- **챗 히스토리:** 본체가 집계한 챗 히스토리 토큰입니다.

한 프롬프트에 여러 매크로를 함께 쓰거나 같은 매크로를 반복하거나 중첩하면 그 프롬프트 전체를 **프롬프트**로 분류합니다. 예를 들어 `{{persona}} {{charDescription}}`은 시트 토큰으로 분리하지 않습니다. 상세보기 옵션은 기본적으로 꺼져 있으며, 표시를 전환해도 추가 토큰 계산을 요청하지 않습니다.
