# 방송 국가와 운영자 표시 기준

앱은 국가별로 방송사의 주소, 개인·독립 방송, 운영 미확인 항목을 구분합니다. 팟캐스트 표시는 프로그램 형식을 뜻하며 방송사와 독립 제작자 모두에 붙을 수 있습니다.

## 국가

방송사의 자체 송출 주소 또는 직접 공개한 채널 주소로 제작 국가를 확인할 수 있으면 해당 국가에 표시합니다. 그 밖에는 Radio Browser의 국가 코드를 사용합니다. 언어, 음악 장르, 서버 위치로 국가를 정하지 않습니다. 등록 국가가 비어 있거나 국가를 가리키지 않는 코드는 ‘국가 미확인’에 모읍니다.

남북한 목록은 두 나라의 등록 자료를 모두 조회한 뒤 방송 출처로 다시 나눕니다. 조선중앙방송과 조선의 소리를 전달하는 intchoson의 운영자는 일본의 자원활동가들이며 프로그램의 출처는 북한입니다. 미국 AM1660은 한국어로 송출해도 미국에 표시합니다. [intchoson 운영진과 중계 채널](https://www.intchoson.com/) · [조선의 소리](https://www.vok.rep.kp/index.php/home/main/en) · [K-RADIO 미국 본사](https://kradio.us/about-us/)

세계 목록 점검에서 찾은 국가 오류는 방송 ID로 기록합니다. 나라를 열면 등록소에서 해당 항목을 다시 받아 최신 주소를 확인합니다. 사용 중 새로 발견한 정정도 다음 목적지 조회에 포함합니다. 국가별 조회는 마지막 페이지까지 이어지며 해당 국가에서 실제 표시할 수 있는 항목을 셉니다. 등록소 자체의 국가 통계는 최신 목록과 달라질 수 있습니다. [Radio Browser API](https://docs.radio-browser.info/)

## 운영 정보

| 표시 | 사용하는 근거 |
| --- | --- |
| 방송사 | 방송사 자체의 송출 도메인, 방송사나 협력사가 공식 플레이어에 공개한 채널 주소, 또는 방송국 자료에 기록된 자체 도메인·송출 주소 |
| 개인·독립 방송 | 제작팀의 운영 소개, 확인한 자원활동 중계, 또는 직접 개설하는 라디오 서비스의 송출 주소. 개설자의 이름을 확인할 수 없으면 서비스 이름은 중계 정보에만 표시 |
| 운영 미확인 | 실제 송출 운영자를 식별할 자료가 부족한 경우. 확인된 프로그램이나 중계 서비스가 있으면 별도로 표시 |

기관 기록은 방송사·방송국 이름, 근거 주소, 확인된 중계 서비스, 프로그램 출처를 구분해 보관합니다. 홈페이지에 적힌 방송사 이름, 장르, 인기 순위만으로 운영자를 확정하지 않습니다. 송출 주소와 출처가 확인된 기록은 국가 코드가 잘못되어 있어도 적용합니다.

Radio Browser는 방송명, 홈페이지, 원래 주소, 접속 후 도착한 주소를 제공합니다. 공개 자료에는 운영 법인을 식별하는 항목이 없습니다. 방송사의 주소가 공동 송출 서버로 연결될 때 Allradione는 방송사가 실제로 제공한 채널 경로와 대조합니다. 방송사의 이름을 붙인 개인 중계나 같은 서버의 다른 채널에는 이 표시를 적용하지 않습니다. 오픈소스 iptv-org도 방송 채널의 소유자와 개별 송출 주소를 별도 자료로 관리합니다. [Radio Browser의 방송 자료 항목](https://docs.radio-browser.info/) · [iptv-org의 채널·송출 자료](https://github.com/iptv-org/api) · [방송별 확인 근거](network-operators.md)

한국 방송사 자체 사이트, 유럽·아시아태평양·카리브 방송 연합의 회원 명단, 각 방송사의 서비스 사이트를 참고했습니다. 방송사 소유 도메인 및 개별 채널 주소는 앱에 포함한 목록으로 대조합니다. 독일 민영 방송은 주 미디어 당국이 공개한 FM·DAB 방송 목록 및 방송 그룹의 채널 자료도 사용합니다. [EBU](https://www.ebu.ch/about/members) · [ABU](https://www.abu.org.my/membership/) · [CBU](https://www.caribroadcastunion.org/membership/our-members/) · [독일 주 미디어 당국 목록](https://www.die-medienanstalten.de/fileadmin/user_upload/die_medienanstalten/Aufgaben/Vielfaltssicherung/Public_Value/Listungen_2025/Public-Value-Audio_Gebietslisten_V2.pdf) · [REGIOCAST](https://www.regiocast.de/uber-uns)

Wikidata의 CC0 방송국 자료도 사용했습니다. 2026년 11월 13일 기준으로 방송국 및 그 하위 분류 가운데 주파수, 호출 부호 또는 미국 FCC 시설 번호가 있고 공식 웹사이트와 국가가 기록된 항목을 조회했습니다. 현재 목록의 송출 도메인이 한 방송국의 전용 웹사이트와 일치하거나 공개된 송출 주소가 정확히 일치하는 경우 방송국을 연결했습니다. 근거 링크는 각 방송국의 개별 Wikidata 항목입니다. [Wikidata 데이터 이용 안내](https://www.wikidata.org/wiki/Wikidata:Licensing) · [QLever Wikidata 조회 서비스](https://qlever.dev/wikidata)

공용 중계망의 주소만 남아 있는 경우, 등록된 홈페이지와 방송국 이름 또는 호출 부호까지 함께 일치하면 해당 방송국을 **프로그램 출처**로 표시합니다. 이 근거는 방송국의 실재와 프로그램 관계를 설명하며 중계자의 신원은 별도로 확인합니다.

국악방송, 요조숙남, Big B Radio 등은 운영자가 공개한 플레이어 주소와 대조했습니다. 개인 방송 개설 서비스와 전문 중계망을 사용한 방송에서는 플랫폼 이름과 실제 운영자를 구분합니다. [국악방송](https://www.igbf.kr/gugak_web/main/) · [요조숙남 라디오](https://music.yojosuknam.com/radio/) · [Big B Radio](https://bigbradio.net/servers) · [인라이브](https://www.inlive.co.kr/customer/faq) · [laut.fm](https://laut.fm/pages/apply)

공식 운영자와 실제 송출 주소를 확인할 수 없는 방송이 상당수 남아 있습니다. 방송사가 바뀌거나 주소가 변경되면 다음 조회에서는 현재 자료에 맞춰 표시합니다. 즐겨찾기와 최근 들은 방송에도 동일한 규칙을 적용합니다.
