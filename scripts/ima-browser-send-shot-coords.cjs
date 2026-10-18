#!/usr/bin/env node
/** Print screenshot click coords for send btn: {shotX,shotY} from CDP rect fields. */
const vw = Number(process.argv[2] || 648);
const vh = Number(process.argv[3] || 609);
const shotW = Number(process.argv[4] || 752);
const shotH = Number(process.argv[5] || 707);
const cx = Number(process.argv[6]);
const cy = Number(process.argv[7]);
if (!cx || !cy) {
  console.error('usage: ima-browser-send-shot-coords.cjs [vw vh shotW shotH] cx cy');
  process.exit(1);
}
const shotX = Math.round(cx * (shotW / vw));
const shotY = Math.round(cy * (shotH / vh));
console.log(JSON.stringify({ shotX, shotY, cx, cy }));
