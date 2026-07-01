/**
 * GPX 1.1 导出 — 从 app.js 拆出的独立模块 (#18)
 * =============================================
 * 将轨迹点序列化为 GPX XML 并触发下载
 * 已移除退役 schema 域名 (#7)
 */

class GpxExport {
  /**
   * 导出轨迹为 GPX 文件并触发下载
   * @param {Array<{lat:number,lng:number,wgsLat?:number,wgsLng?:number,time?:number,accuracy?:number,speed?:number,heading?:number}>} positions
   * @returns {boolean} 是否成功导出（至少需要 2 个点）
   */
  static export(positions) {
    if (positions.length < 2) return false;

    let trkptXml = '';
    for (let i = 0; i < positions.length; i++) {
      const pt = positions[i];
      const lat = typeof pt.wgsLat === 'number' ? pt.wgsLat.toFixed(6) : pt.lat.toFixed(6);
      const lng = typeof pt.wgsLng === 'number' ? pt.wgsLng.toFixed(6) : pt.lng.toFixed(6);
      const ts = pt.time ? new Date(pt.time).toISOString() : new Date().toISOString();

      let extra = '';
      if (pt.accuracy) {
        const hdop = Math.max(0.5, pt.accuracy / 5);
        extra += `      <hdop>${hdop.toFixed(1)}</hdop>\n`;
      }
      if (pt.speed != null || pt.heading != null) {
        let extXml = '';
        if (pt.speed != null) extXml += `          <gpxtpx:speed>${pt.speed.toFixed(2)}</gpxtpx:speed>\n`;
        if (pt.heading != null) extXml += `          <gpxtpx:course>${pt.heading.toFixed(1)}</gpxtpx:course>\n`;
        extra += `      <extensions>\n        <gpxtpx:TrackPointExtension>\n${extXml}        </gpxtpx:TrackPointExtension>\n      </extensions>\n`;
      }

      trkptXml += `      <trkpt lat="${lat}" lon="${lng}">
        <time>${ts}</time>
${extra}      </trkpt>\n`;
    }

    const now = new Date().toISOString();
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx
  version="1.1"
  creator="Circlemap"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">
  <metadata>
    <name>Circlemap GPS Trail</name>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>Circlemap Trail</name>
    <type>track</type>
    <trkseg>
${trkptXml}    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `circlemap-trail-${now.slice(0, 10)}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), CONFIG.GPX_URL_REVOKE_DELAY);
    return true;
  }
}
