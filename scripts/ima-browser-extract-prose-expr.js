(() => {
  const b = document.body.innerText;
  let s = b.lastIndexOf('我整理一下');
  if (s < 0) {
    const batch = nextBatchMarker(b);
    s = batch >= 0 ? batch : b.lastIndexOf('据该文件');
  }
  function nextBatchMarker(text) {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^花旗-|^瑞银-|^伯恩斯坦-|^高盛-|^摩根/.test(lines[i]) && lines[i].includes('：')) return text.indexOf(lines[i]);
    }
    return -1;
  }
  const stopMarkers = ['请严格按我上一轮', 'DS 快速', '内容由AI生成仅供参考'];
  let e = -1;
  for (const m of stopMarkers) {
    const x = b.indexOf(m, s > 0 ? s : 0);
    if (x > s && (e < 0 || x < e)) e = x;
  }
  const slice = s >= 0 ? b.slice(s, e > s ? e : undefined) : '';
  return JSON.stringify({ len: slice.length, b64: slice ? btoa(unescape(encodeURIComponent(slice))) : '' });
})()
