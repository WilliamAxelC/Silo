import { detectUprightRotation } from '../receiptText';

// A line's corners in reading order (top-left, top-right, bottom-right, bottom-left of the text),
// for text whose reading direction is `angle` degrees in image coordinates (y down).
const line = (text: string, angle: number) => {
  const r = (angle * Math.PI) / 180;
  const dx = Math.cos(r) * 100;
  const dy = Math.sin(r) * 100;
  return { text, cornerPoints: [{ x: 0, y: 0 }, { x: dx, y: dy }, { x: dx - dy / 5, y: dy + dx / 5 }, { x: -dy / 5, y: dx / 5 }] };
};
const receipt = (angle: number) => ['TOTAL BELANJA 13,000', 'QRIS CPM LAWSON', 'LW S CARB TRFLE 15,000'].map((t) => line(t, angle));

describe('detectUprightRotation', () => {
  it('reads the needed clockwise turn from the text direction', () => {
    expect(detectUprightRotation(receipt(0))).toBe(0);
    expect(detectUprightRotation(receipt(3))).toBe(0);
    expect(detectUprightRotation(receipt(90))).toBe(270); // text reads downward: photo turned clockwise
    expect(detectUprightRotation(receipt(-90))).toBe(90); // text reads upward
    expect(detectUprightRotation(receipt(180))).toBe(180); // upside down
  });

  it('stays out of it with too little text, no corner points, or mixed directions', () => {
    expect(detectUprightRotation([line('Rp', 180)])).toBeUndefined();
    expect(detectUprightRotation([{ text: 'TOTAL BELANJA 13,000 QRIS LAWSON' }])).toBeUndefined();
    expect(detectUprightRotation([...receipt(0), ...receipt(180)])).toBeUndefined();
  });
});
