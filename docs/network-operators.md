# 방송사와 운영 주체를 확인한 자료

2026년 11월 13일 방송사가 공개한 채널 목록에서 실제 재생 주소를 대조했다. 한 서버에 여러 방송국이 입점하는 경우 채널마다 주소를 따로 대조한다. 미국·멕시코 방송은 송출 지역과 방송국이 등록한 주파수도 확인했다.

| 자료 | 확인한 내용 |
| --- | --- |
| [iHeartRadio 방송 목록](https://api2.iheart.com/api/v2/content/liveStations?countryCode=US&limit=5&offset=0)과 [미국 FCC 공개 기록](https://publicfiles.fcc.gov/) | 실제 AM·FM 방송과 동일한 재생 주소, 방송 식별 부호와 지역을 대조했다. 미국 내 면허 보유 단체는 FCC의 현재 면허 상태, 주파수, 식별 부호가 일치할 때 기록했다. iHeartRadio는 송출 서비스로 표시한다. |
| [Global의 방송 채널](https://global.com/radio/ways-to-listen/)과 [영국 공식 송출 목록](https://epg.musicradio.com/radiodns/spi/3.1/SI.xml) | 영국 FM·DAB 채널에 연결된 재생 경로를 확인했다. |
| [NRJ Group 공식 송출 목록](https://players.nrjaudio.fm/radiodns/spi/3.1/SI.xml)과 [NRJ Belgique의 공개 주소](https://www.nrj.be/comment-ecouter-flux-streams) | 프랑스와 벨기에 채널을 각각 발행자가 지정한 개별 재생 주소로 확인했다. |
| [인도 Akashvani 공식 플레이어](https://akashvani.gov.in/radio/live.php) | 방송사가 직접 제공한 재생 주소로 Akashvani와 운영 단체 Prasar Bharati를 확인했다. |

한국의 [KBS](https://onair.kbs.co.kr/), [MBC](https://mini.imbc.com/), [SBS](https://web.gorealra.sbs.co.kr/), [YTN](https://radio.ytn.co.kr/) 채널은 각 방송사의 공식 플레이어 또는 송출 서버에 연결한다. KBS·MBC·SBS의 유효기간이 있는 주소는 재생할 때 새로 받는다.

[JTV 매직FM](https://www.jtv.co.kr/page/00029.php)은 전주방송의 플레이어에 게시된 송출 주소를 사용한다.

## 외부 송출 서비스를 사용하는 방송사

2026년 11월 13일에 방송사 플레이어가 공개한 주소, 방송사가 제공한 재생 목록의 도착 주소, 중계 서비스의 채널별 주소를 대조했다. 아카마이, 스트림더월드, 토론토캐스트처럼 여러 방송이 함께 쓰는 서버에서는 확인된 채널 경로만 연결했다.

| 방송 | 확인한 자료 |
| --- | --- |
| 아리랑 라디오 | [국제방송교류재단 플레이어](https://www.arirang.com/radio)의 라디오 채널이 아카마이의 `arirang_3ch` 목록을 제공한다. 기존 주소도 같은 세부 송출 목록을 반환했다. [iptv-org 방송 기록](https://iptv-org.github.io/channels/kr/ArirangRadio)에서도 해당 채널과 운영 재단을 대조했다. |
| MBC충북·안동MBC | [MBC충북 라디오](https://mbccb.co.kr/rb/custom/onair2.php?md=fm1)의 FM4U·표준FM 주소는 등록된 IP로 연결되며 두 채널의 경로가 서로 다르다. [안동MBC 제1FM](https://andongmbc.co.kr/main/onair/live_am.php)은 기존 중계 주소와 현재 송출 주소를 함께 기록한다. |
| 전주FM·부산영어방송 | [전주FM 홈페이지](https://jcfm.kr/)가 `jcfm1`을 공개하고 [방송국 소개](https://jcfm.kr/about)가 운영 법인을 명시한다. [부산영어방송 플레이어](https://www.befm.or.kr/aod/live.php)와 기존 SmileCDN 주소는 같은 음원 조각 번호를 송출했다. |
| 일본 지역방송 | [FM세타가야 공지](https://fmsetagaya.com/archives/10064)와 [면허인 정보](https://fmsetagaya.com/aboutus), [쇼난 비치FM 청취 안내](https://www.beachfm.co.jp/about/help/)와 [법인 정보](https://www.beachfm.co.jp/about/), [FM가호쿠 운영 정보](https://fm.kahoku.net/annai/)와 [자체 플레이어](https://fm.kahoku.net/)를 대조했다. |
| 영국·캐나다·벨기에·네덜란드 | BBC는 [제조사가 공개한 BBC 채널별 송출 목록](https://support1.bluesound.com/hc/en-us/article_attachments/20796381399319)의 전용 서버와 방송 식별자가 일치하는 경우만 연결했다. [CBC 플레이어](https://www.cbc.ca/listen/live-radio), [VRT 청취 주소](https://www.vrt.be/nl/ons-aanbod/streamingslinks-radio), [NPO Klassiek 청취 안내](https://www.npoklassiek.nl/streams), [Radio 538](https://www.538.nl/), [Sky Radio](https://www.skyradio.nl/), [Radio 10](https://www.radio10.nl/)은 방송사 페이지에 명시된 개별 주소를 사용한다. |
| 독일·호주·노르웨이 | 방송사가 공개한 기존 주소를 직접 따라갔다. [FluxFM](https://www.fluxfm.de/), [RADIO BOB!](https://www.radiobob.de/), [ABC NewsRadio 재생 목록](https://www.abc.net.au/res/streaming/audio/aac/news_radio.pls), [NRK](https://radio.nrk.no/) 등의 외부 서버에서 등록 주소와 같은 채널 경로를 확인했다. |
| 프랑스 REPLAY NEWS | [편집 법인 정보](https://www.replaynews.net/mentions-legales.php)는 프랑스 CONTROL CHANNEL을, [공식 플레이어](https://www.replaynews.net/)는 한국어·일본어를 포함한 각 언어 채널의 Infomaniak 주소를 공개한다. 제작 국가를 프랑스로 표시한다. |

개인·독립 방송에서도 확인된 운영 주체와 중계 서비스를 따로 표시한다. [NFRS](https://www.nfrsradio.com/about)는 오사카의 인터넷 방송팀이며 [FMわぃわぃ](https://tcc117.jp/fmyy/company/)는 고베의 비영리 단체다. [asia DREAM radio의 송출 목록](https://asiadreamradio.torontocast.stream/stations/newstream.html)은 재즈 사쿠라 등이 쓰는 개별 포트를 공개한다. [Radio Art](https://www.radioart.com/aboutus)는 운영자의 이름을 공개한다. [Gensokyo Radio](https://gensokyoradio.net/about/)는 팬 음악 방송팀이 운영한다.

등록 이름과 홈페이지가 `NHK-FM`인 외부 중계 주소에서는 NHK 프로그램 정보만 표시한다. [NHK의 공식 플레이어](https://www.nhk.or.jp/radio/)에서 해당 중계 주소의 운영자를 확인할 수 없었다. [OTTAVA](https://ottava.jp/company)도 회사 정보와 현재 플레이어를 대조했으나 등록된 옛 주소의 운영 주체까지 확인되지 않아 제작처를 별도로 표시한다.
