'use strict';
const labels = {
  ko:['Allradione 열기','재생 / 일시 정지','종료'], en:['Open Allradione','Play / Pause','Quit'],
  ja:['Allradione を開く','再生 / 一時停止','終了'], 'zh-CN':['打开 Allradione','播放 / 暂停','退出'],
  'yue-HK':['打開 Allradione','播放 / 暫停','離開'], 'zh-TW':['開啟 Allradione','播放 / 暫停','結束'],
  'nan-TW':['拍開 Allradione','播放 / 暫停','離開'], la:['Aperi Allradione','Cane / Siste','Exi']
};
function trayMenu(language,show,play,quit) {
  const [open,toggle,exit] = labels[language] || labels.ko;
  return [{label:open,click:show},{label:toggle,click:play},{type:'separator'},{label:exit,click:quit}];
}
module.exports = {trayMenu};
