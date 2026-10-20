"use strict";

// Independent WCAG relative-luminance check for rendered RGB or hex colours.
function luminance(color) {
  const channels = color.startsWith("#") ? color.slice(1).match(/../g).map((part) => parseInt(part, 16)) : color.match(/[\d.]+/g).slice(0, 3).map(Number);
  return channels.reduce((sum, channel, index) => {
    const value = channel / 255;
    return sum + [0.2126, 0.7152, 0.0722][index] * (value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92);
  }, 0);
}
function contrastRatio(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
module.exports = { contrastRatio };
