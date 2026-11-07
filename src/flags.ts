// All country flags are bundled assets, including on Windows without emoji flags.
const sources = import.meta.glob<string>('/node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true, query: '?url&no-inline', import: 'default',
});
const flags = new Map(Object.entries(sources).map(([path, url]) => [path.split('/').pop()!.slice(0, -4), url]));

export function flagUrl(code: string): string | undefined {
  const normalized = String(code || '').trim().toLowerCase();
  return flags.get(normalized === 'uk' ? 'gb' : normalized);
}

export function flagMarkup(code: string, className = ''): string {
  const url = flagUrl(code);
  if (!url) return '';
  const classes = className.replace(/[^a-zA-Z0-9_ -]/g, '');
  return `<img class="country-flag ${classes}" src="${url}" alt="" aria-hidden="true" loading="lazy" decoding="async">`;
}
