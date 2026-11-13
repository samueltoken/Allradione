'use strict';
// Usage: node scripts/station-audit-report.cjs <audit directory> [--release]
const fs = require('node:fs');
const path = require('node:path');
const { readLines } = require('./review-station-failures.cjs');
const { addressSignature } = require('../electron/station-health.mjs');

const reasons = {
  media: '송출 데이터 확인', ineligible: '직접 점검 제외', webpage: '웹페이지 응답', empty: '빈 응답',
  unrecognized: '미디어 형식 미확인', unconfirmed: '재생 주소 미확인', timeout: '응답 시간 초과',
  ENOTFOUND: '서버 주소 조회 실패', ECONNREFUSED: '연결 거부', ECONNRESET: '연결 끊김',
  ENETUNREACH: '네트워크 경로 없음', EHOSTUNREACH: '서버 경로 없음', ETIMEDOUT: '응답 시간 초과',
  'connection-error': '연결 또는 보안 인증 오류', 'tls-error': '보안 인증 오류', 'legacy-icy': '구형 ICY 응답',
  unresolved: '직접 점검 대기'
};
const operatorLabels = { broadcaster: '방송사', independent: '개인·독립 방송', unknown: '운영자 미확인' };
function sourceDomain(station) {
  if (!station?.operatorSource) return '';
  try {
    const source = new URL(station.operatorSource);
    return ['https:', 'http:'].includes(source.protocol) ? source.hostname : '';
  } catch { return ''; }
}
function describe(value) {
  if (!value) return '';
  if (reasons[value]) return reasons[value];
  if (value.startsWith('playlist-')) return '재생 목록 안쪽 주소 · ' + describe(value.slice(9));
  if (value.startsWith('http-')) return 'HTTP ' + value.slice(5);
  return value;
}
function csvCell(value) {
  let text = String(value ?? '').replace(/https?:\/\/[^\s]+/gi, '[주소 생략]').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (/^[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function csv(file, rows) {
  const data = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  fs.writeFileSync(file, '\uFEFF' + data + '\r\n');
}
function generate(dir, release) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'stations.json'), 'utf8'));
  const first = readLines(path.join(dir, 'results.ndjson'));
  const reviews = readLines(path.join(dir, 'review.ndjson'));
  const checked = new Map(first.flatMap(row => row.ids.map(id => [id, row])));
  const byId = new Map(reviews.map(row => [row.id, row]));
  const dates = [...first.map(row => row.time), ...reviews.map(row => row.checkedAt)].sort();
  const alternateRecoveries = [...byId.values()].filter(review => review.alternate === 'media').length;
  if (release) {
    if (snapshot.length !== checked.size) throw new Error('First pass incomplete');
    const pending = snapshot.filter(s => !['media', 'ineligible'].includes(checked.get(s.stationuuid).outcome) && !byId.has(s.stationuuid));
    if (pending.length) throw new Error('Second pass still pending for ' + pending.length + ' stations');
    if ([...byId.values()].some(row => !row.icySupport && [row.retry, row.alternate].some(value => ['legacy-icy','connection-error'].includes(value)))) {
      throw new Error('Remaining legacy responses need a repeat check with the updated player');
    }
    const map = Object.fromEntries(snapshot.filter(s => s.lastcheckok === 1 && byId.get(s.stationuuid)?.suppress)
      .map(s => [s.stationuuid, addressSignature(s)]).sort(([a],[b]) => a.localeCompare(b)));
    const denied = Object.fromEntries(snapshot.filter(s => {
      const review = byId.get(s.stationuuid);
      return review && /^(?:playlist-)?http-(?:401|403|451)$/.test(review.retry) &&
        review.retry === review.outcome && (!review.alternate || review.alternate === review.retry);
    }).map(s => [s.stationuuid, addressSignature(s)]).sort(([a],[b]) => a.localeCompare(b)));
    fs.writeFileSync(path.join(__dirname, '../electron/station-health-results.mjs'),
      '// Dated, address-specific results from the v0.2.3 station audit.\n' +
      'export const checkedAt = ' + JSON.stringify(dates.at(-1)) + ';\n' +
      'export const failedStationAddresses = ' + JSON.stringify(map, null, 2) + ';\n' +
      'export const deniedStationAddresses = ' + JSON.stringify(denied, null, 2) + ';\n');
  }
  const { cleanStation } = require('../electron/station-catalog.mjs');
  const locales = new Intl.DisplayNames(['ko'], {type:'region'});
  const countries = new Map();
  const totals = { rows: snapshot.length, directoryGood: 0, noCountry: 0, primary: 0, recovered: 0, failed: 0,
    skipped: 0, pending: 0, suppressed: 0, directCountries: 0, broadcaster: 0, independent: 0, unknown: 0, adjustedCountry: 0,
    resolvedMissingCountry: 0, namedOperators: 0, namedRelays: 0, namedProgrammeOrigins: 0, operatorSources: 0, alternateRecoveries };
  const rows = [['방송 ID','방송명','목록 원본 국가코드','앱 국가코드','앱 운영자 구분','팟캐스트 표시','목록 제공처 점검','목록 제공처 점검시각(UTC)',
    '직접 점검 결과','첫 접속','재접속','등록 원본 주소 접속','최근 직접 점검시각(UTC)','현재 주소 일시 제외 근거',
    '확인한 운영자','재송출 운영자','프로그램 원 제작처','운영자 확인 출처(도메인)','목록 원본 방송명']];
  for (const station of snapshot) {
    const entry = checked.get(station.stationuuid);
    const review = byId.get(station.stationuuid);
    const clean = cleanStation(station);
    const code = clean?.countrycode?.toUpperCase() || '';
    const kind = clean?.operatorKind || 'unknown';
    const firstResult = entry?.outcome || 'unresolved';
    const dirOk = Number(station.lastcheckok) === 1;
    const secondOk = review?.alternate === 'media' || review?.retry === 'media';
    const suppressed = Boolean(dirOk && review?.suppress);
    let bucket;
    if (firstResult === 'unresolved') bucket = 'pending';
    else if (firstResult === 'ineligible') bucket = 'skipped';
    else if (firstResult === 'media') bucket = 'primary';
    else if (secondOk) bucket = 'recovered';
    else bucket = 'failed';
    const label = {primary:'송출 데이터 확인', recovered:'재점검에서 송출 데이터 확인', failed:'송출 데이터 미확인', skipped:'직접 점검 제외', pending:'직접 점검 대기'}[bucket];
    rows.push([station.stationuuid,clean?.name || station.name,station.countrycode,code,operatorLabels[kind],clean?.isPodcast ? '예' : '',
      dirOk ? '정상' : '실패',station.lastchecktime_iso8601,label,describe(firstResult),describe(review?.retry),describe(review?.alternate),
      review?.checkedAt || entry?.time,suppressed ? '웹페이지 또는 HTTP 404/410 반복 응답' : '',
      clean?.operatorName,clean?.relayName,clean?.programmeOriginName,sourceDomain(clean),station.name]);
    if (!countries.has(code)) countries.set(code, {rows:0, directoryGood:0, primary:0, recovered:0, failed:0, skipped:0, pending:0, suppressed:0, broadcaster:0, independent:0, unknown:0});
    const counts = countries.get(code);
    for (const object of [totals, counts]) {
      object[bucket]++; object.directoryGood += Number(dirOk); object.suppressed += Number(suppressed); object[kind]++;
    }
    counts.rows++;
    if (!station.countrycode) totals.noCountry++;
    const originalCountry = String(station.countrycode || '').trim().toUpperCase();
    if (!originalCountry || originalCountry === 'ZZ' || originalCountry === 'UN') {
      if (code && code !== 'ZZ') totals.resolvedMissingCountry++;
    } else if (code !== originalCountry) totals.adjustedCountry++;
    if (clean?.operatorName) totals.namedOperators++;
    if (clean?.relayName) totals.namedRelays++;
    if (clean?.programmeOriginName) totals.namedProgrammeOrigins++;
    if (sourceDomain(clean)) totals.operatorSources++;
  }
  const summary = [['앱 국가코드','국가·지역','전체','제공처 정상','제공처 실패','첫 접속 송출 데이터 확인','재점검 송출 데이터 확인',
    '송출 데이터 미확인','직접 점검 제외','점검 대기','주소 일시 제외 근거 있음','방송사','개인·독립 방송','운영자 미확인']];
  for (const [code, c] of [...countries].sort(([a],[b]) => a.localeCompare(b))) {
    if (code && code !== 'ZZ' && c.primary+c.recovered+c.failed) totals.directCountries++;
    summary.push([code,code && code !== 'ZZ' ? locales.of(code) : '국가 미확인',c.rows,c.directoryGood,c.rows-c.directoryGood,c.primary,c.recovered,c.failed,c.skipped,c.pending,c.suppressed,c.broadcaster,c.independent,c.unknown]);
  }
  const reportDir = path.join(dir,'보고서');
  fs.mkdirSync(reportDir, {recursive:true});
  csv(path.join(reportDir,'방송별-점검.csv'), rows);
  csv(path.join(reportDir,'국가별-요약.csv'), summary);
  const officialFile = path.join(dir,'official-checks.json');
  const official = fs.existsSync(officialFile) ? JSON.parse(fs.readFileSync(officialFile, 'utf8')) : [];
  if (release && official.length !== require('../electron/korean-stations.mjs').koreanStations.length) {
    throw new Error('Bundled Korean station checks are incomplete');
  }
  if (official.length) {
    const directById = new Map(require('../electron/korean-stations.mjs').koreanStations.map(s => [s.stationuuid,cleanStation(s)]));
    csv(path.join(reportDir,'한국-방송사-직결.csv'),
      [['방송 ID','방송명','국가','직접 점검 결과','점검시각(UTC)','확인한 운영자','운영자 확인 출처(도메인)'],
        ...official.map(s => [s.id,s.name,'KR',describe(s.outcome),s.time,directById.get(s.id)?.operatorName,sourceDomain(directById.get(s.id))])]);
  }
  const number = n => n.toLocaleString('ko-KR');
  const notes = [
    'Allradione 0.2.3 전 세계 방송 점검', '',
    '목록 출처  Radio Browser (de1.api.radio-browser.info), 2026-11-13 다운로드',
    '목록 수집 범위  국가 코드가 비어 있는 방송과 제공처 점검 실패 방송을 포함한 전체 등록 항목',
    '직접 점검 기간(UTC)  ' + dates[0] + ' ~ ' + dates.at(-1),
    '직접 점검 위치  대한민국의 단일 인터넷 연결', '',
    '등록 방송 ' + number(totals.rows) + '건. 제공처 점검 정상 ' + number(totals.directoryGood) + '건, 실패 ' + number(totals.rows-totals.directoryGood) + '건.',
    '첫 접속 송출 데이터 확인 ' + number(totals.primary) + '건, 재점검에서 추가 확인 ' + number(totals.recovered) + '건.',
    '재점검 성공 중 다른 등록 원본 주소에서 송출을 확인한 항목 ' + number(totals.alternateRecoveries) + '건.',
    '송출 데이터 미확인 ' + number(totals.failed) + '건, 직접 점검 제외 ' + number(totals.skipped) + '건, 점검 대기 ' + number(totals.pending) + '건.',
    '직접 점검한 국가·지역 ' + number(totals.directCountries) + '곳. 원본 국가 코드가 비어 있는 방송 ' + number(totals.noCountry) + '건.',
    '원본 국가 코드 변경 ' + number(totals.adjustedCountry) + '건, 국가 미상에서 송출 국가를 확인한 방송 ' + number(totals.resolvedMissingCountry) + '건.',
    '운영자 구분은 방송사 ' + number(totals.broadcaster) + '건, 개인·독립 방송 ' + number(totals.independent) + '건, 운영자 미확인 ' + number(totals.unknown) + '건입니다. 운영자 이름을 확인한 항목은 ' + number(totals.namedOperators) + '건입니다.',
    '목록 제공처가 정상으로 표시했지만 재접속 때도 웹페이지나 HTTP 404/410으로 응답한 항목 중 일시 제외 근거가 있는 방송 ' + number(totals.suppressed) + '건.',
    '', '파일 설명', '방송별-점검.csv에는 목록 원본 분류와 앱의 방송 국가 및 운영자 분류를 함께 적었습니다. 공식 편성 채널과 별도로 앱에서 직접 추가한 한국 방송사의 채널은 원본 목록의 집계에 포함하지 않았습니다.',
    '방송명은 앱이 표시하는 이름입니다. 등록 당시 이름이 달랐던 방송은 마지막 열의 목록 원본 방송명에서 찾을 수 있습니다.',
    '국가별-요약.csv는 앱 기준의 국가코드로 방송별 결과를 합산했습니다. 국가 미상 항목은 별도 행에 있습니다.',
    '확인한 운영자, 재송출 운영자, 프로그램 원 제작처는 앱에서 확인한 사실만 적었습니다. 근거가 없는 항목은 비어 있습니다. 출처는 확인에 사용한 공개 자료의 도메인입니다.',
    '한국-방송사-직결.csv는 앱에 직접 추가한 국내 방송사 채널 ' + official.length + '개의 별도 점검표입니다. 방송사의 현재 재생 주소를 받아 ' + official.filter(s => s.outcome === 'media').length + '개 채널에서 송출 데이터를 확인했습니다.',
    '', '직접 점검 방법', '앱이 이용하는 HTTP/HTTPS 연결로 각 응답 앞부분을 최대 32 KiB까지 확인했습니다. 첫 점검에서는 같은 재생 주소의 결과를 공유했습니다.',
    '제공처가 풀어 놓은 재생 주소부터 접속했습니다. 실패 항목은 등록 원본 주소가 다르면 원본도 확인하고, 원본에서 송출을 확인하지 못하면 최초 주소도 다시 접속했습니다.',
    'HLS는 재생 목록 안쪽의 미디어까지 확인했습니다. 재생 목록만 받거나 페이지가 HTTP 200으로 응답했다는 이유만으로 정상 처리하지 않았습니다.',
    '송출 데이터 확인은 MP3/AAC 프레임 연속성 또는 알려진 미디어 컨테이너 표식을 확인한 결과입니다. 실제 청취, 서비스 내용, 음량, 긴 시간 동안의 안정성은 별도로 확인해야 합니다.',
    '직접 점검 제외에는 사설망 주소, DNS가 사설망을 가리키는 주소, 일반 웹페이지나 소셜 사이트 주소, 방송용으로 확인할 수 없는 주소가 포함됩니다.',
    '구형 ICY 응답, 보안 인증 오류, 접근 제한, 지역 제한 가능성, 응답 지연 등은 영구 폐국 근거로 취급하지 않았습니다. 404/410 또는 웹페이지가 반복된 항목은 주소가 바뀌거나 제공처가 새로 정상 판정하면 다시 표시합니다. 일시 제외는 최대 7일입니다.',
    '', '점검 결과는 해당 시각과 지역 기준입니다. 같은 방송에 대한 디렉터리 측정과 국내 접속의 시점 및 경로가 다를 수 있습니다.'
  ];
  fs.writeFileSync(path.join(reportDir,'읽어주세요.txt'), '\uFEFF' + notes.join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(dir,'metrics.json'), JSON.stringify(totals, null, 2));
  console.log(totals);
}
if (require.main === module) generate(process.argv[2], process.argv.includes('--release'));
